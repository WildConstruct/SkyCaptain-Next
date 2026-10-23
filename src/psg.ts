// Sky graphs: a Prompt Spaghetti graph (.psg) evaluated with a seed drives settings and
// shape layers. See docs/psg-weather.md for the variables read here.
// Graph-made shapes carry psgSlot; rerolls replace them and never touch hand-made shapes
// or paint. Locks hold a slot (or the sky) exactly as it is now, including hand edits.

import { evaluatePsg } from '../vendor/psg-eval.browser.js';
import type { Settings } from './settings';
import { MAX_SHAPES, ShapeKind, ShapeLayer, ShapeStore, createShape } from './shapes';
import type { GroundStore } from './ground';
import { TERRAIN_TYPES, type TerrainRecipe } from './terrain';

type Value = string | number | boolean;

export interface PsgPick {
  name?: string;
  text: string;
  optionId?: string;
}

export interface PsgRoll {
  seed: number;
  caption: string;
  graphSha256: string;
  variables: Record<string, Value>;
  picks: Record<string, PsgPick>;
  warnings: string[];
}

export interface SkyGraphState {
  name: string;
  text: string;
  roll: PsgRoll;
  holds: { choices: string[]; slots: number[]; sky: boolean };
}

const KINDS: ShapeKind[] = ['cumulus_field', 'storm_cell', 'front', 'clear_hole', 'haze_sheet'];

/** Graph variable -> settings key. */
const SETTINGS_VARS: Record<string, keyof Settings> = {
  'sky.sun_elevation': 'sunElevation',
  'sky.sun_azimuth': 'sunAzimuth',
  'sky.haze': 'haze',
  'clouds.coverage': 'coverage',
  'clouds.type': 'typeBias',
  'clouds.density': 'density',
  'clouds.erosion': 'erosion',
  'clouds.base_km': 'cloudBottom',
  'clouds.thickness_km': 'cloudThickness',
  'clouds.background': 'baseWeather',
};

export class SkyGraph {
  name = '';
  private text = '';
  last: PsgRoll | null = null;
  /** WeightedChoice node ids whose current pick is held. */
  lockedChoices = new Set<string>();
  /** shape.N slots held as they are now. */
  lockedSlots = new Set<number>();
  /** Holds sun and atmosphere (sky.*). */
  lockSky = false;
  private listeners = new Set<() => void>();

  constructor(
    private settings: Settings,
    private store: ShapeStore,
    private setSetting: (key: keyof Settings, value: number) => void,
    private ground?: GroundStore,
    /** A ground graph applies only ground.* and never touches the sky or shapes. */
    private groundOnly = false,
  ) {}

  get loaded(): boolean {
    return this.text.length > 0;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Graph state for documents: the graph text travels with the sky. */
  snapshot(): SkyGraphState | null {
    if (!this.loaded || !this.last) return null;
    return {
      name: this.name,
      text: this.text,
      roll: this.last,
      holds: { choices: [...this.lockedChoices], slots: [...this.lockedSlots], sky: this.lockSky },
    };
  }

  /** Restores a saved graph and its roll without re-evaluating (saved skies never drift). */
  restore(state: SkyGraphState | null): void {
    this.name = state?.name ?? '';
    this.text = state?.text ?? '';
    this.last = state?.roll ?? null;
    this.lockedChoices = new Set(state?.holds.choices ?? []);
    this.lockedSlots = new Set(state?.holds.slots ?? []);
    this.lockSky = state?.holds.sky ?? false;
    this.emit();
  }

  async load(name: string, text: string): Promise<void> {
    JSON.parse(text); // fail early on a non-JSON file
    this.name = name;
    this.text = text;
    this.lockedChoices.clear();
    this.lockedSlots.clear();
    this.lockSky = false;
    await this.roll(this.last?.seed ?? 1);
  }

  async reroll(): Promise<void> {
    await this.roll(Math.floor(Math.random() * 1_000_000));
  }

  /** Evaluates the graph with a seed, honouring locks, and applies the result. */
  async roll(seed: number): Promise<PsgRoll> {
    const choiceLocks: Record<string, string> = {};
    for (const id of this.lockedChoices) {
      const optionId = this.last?.picks[id]?.optionId;
      if (optionId) choiceLocks[id] = optionId;
    }
    const result = await evaluatePsg(this.text, { seed, locks: this.currentLocks(), choiceLocks });
    if (!result.success) throw new Error(result.errors.join('; ') || 'sky graph failed');
    this.last = {
      seed,
      caption: result.output.trim(),
      graphSha256: result.graphSha256,
      variables: result.variables as Record<string, Value>,
      picks: result.picks as Record<string, PsgPick>,
      warnings: result.warnings,
    };
    this.apply(this.last.variables);
    this.emit();
    return this.last;
  }

  /** Value locks built from what is on screen now, so hand edits to a locked layer survive. */
  private currentLocks(): Record<string, Value> {
    const locks: Record<string, Value> = {};
    if (this.lockSky) {
      locks['sky.sun_elevation'] = this.settings.sunElevation;
      locks['sky.sun_azimuth'] = this.settings.sunAzimuth;
      locks['sky.haze'] = this.settings.haze;
    }
    for (const slot of this.lockedSlots) {
      const shape = this.store.shapes.find((s) => s.psgSlot === slot);
      if (!shape) continue;
      const wx = shape.x - this.settings.windX;
      const wz = shape.z - this.settings.windZ;
      Object.assign(locks, {
        [`shape.${slot}.kind`]: shape.kind,
        [`shape.${slot}.azimuth`]: (Math.atan2(wx, wz) * 180) / Math.PI,
        [`shape.${slot}.distance_km`]: Math.hypot(wx, wz),
        [`shape.${slot}.size_km`]: shape.size,
        [`shape.${slot}.aspect`]: shape.aspect,
        [`shape.${slot}.rotation`]: shape.rotation,
        [`shape.${slot}.strength`]: shape.strength,
        [`shape.${slot}.seed`]: shape.seed,
      });
      if (shape.type !== null) locks[`shape.${slot}.type`] = shape.type;
    }
    return locks;
  }

  private apply(vars: Record<string, Value>): void {
    if (this.ground) applyGroundVars(vars, this.ground, this.last?.seed ?? 1);
    if (this.groundOnly) return;
    for (const [name, key] of Object.entries(SETTINGS_VARS)) {
      const v = vars[name];
      if (typeof v === 'number' && Number.isFinite(v)) this.setSetting(key, v);
    }
    if (typeof vars['clouds.wind_dir'] === 'number' && typeof vars['clouds.wind_km'] === 'number') {
      const a = (vars['clouds.wind_dir'] * Math.PI) / 180;
      this.setSetting('windX', Math.sin(a) * vars['clouds.wind_km']);
      this.setSetting('windZ', Math.cos(a) * vars['clouds.wind_km']);
    }

    const shapes: ShapeLayer[] = [];
    for (let slot = 0; slot < MAX_SHAPES; slot++) {
      const kind = vars[`shape.${slot}.kind`];
      if (typeof kind !== 'string' || !KINDS.includes(kind as ShapeKind)) continue;
      const num = (field: string, fallback: number) => {
        const v = vars[`shape.${slot}.${field}`];
        return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
      };
      const az = (num('azimuth', 0) * Math.PI) / 180;
      const d = num('distance_km', 20);
      const base = createShape(kind as ShapeKind, 0, 0, Math.round(num('seed', (this.last?.seed ?? 0) * 31 + slot * 7)) % 10000);
      const typeVar = vars[`shape.${slot}.type`];
      shapes.push({
        ...base,
        x: Math.sin(az) * d + this.settings.windX,
        z: Math.cos(az) * d + this.settings.windZ,
        size: num('size_km', base.size),
        aspect: num('aspect', base.aspect),
        rotation: num('rotation', base.rotation),
        strength: num('strength', 1),
        type: typeof typeVar === 'number' ? typeVar : null,
        psgSlot: slot,
      });
    }
    // Graph layers sit below hand-made ones so manual shapes still composite on top.
    const manual = this.store.shapes.filter((s) => s.psgSlot === undefined);
    this.store.checkpoint();
    this.store.replaceAll([...shapes, ...manual].slice(0, MAX_SHAPES));
    for (const slot of [...this.lockedSlots]) {
      if (!shapes.some((s) => s.psgSlot === slot)) this.lockedSlots.delete(slot);
    }
  }
}

/** "#rrggbb" (sRGB) to linear albedo, or null. */
function linearColour(v: Value | undefined): [number, number, number] | null {
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) return null;
  return [1, 3, 5].map((i) => {
    const c = parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

/**
 * Ground terrain from graph variables (docs/psg-weather.md): ground.water, .geography,
 * .patch_km, .tile_km, .seed (default: the roll's), .weight.<type> and .colour.<type>
 * ("#rrggbb"). Any ground.*
 * variable turns terrain on; a graph without them leaves the ground alone.
 */
export function applyGroundVars(vars: Record<string, Value>, ground: GroundStore, rollSeed: number): void {
  if (!Object.keys(vars).some((k) => k.startsWith('ground.'))) return;
  const num = (name: string) => {
    const v = vars[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const changes: Partial<TerrainRecipe> = {};
  const set = <K extends keyof TerrainRecipe>(key: K, v: TerrainRecipe[K] | undefined) => { if (v !== undefined) changes[key] = v; };
  set('waterLevel', num('ground.water'));
  set('relief', num('ground.geography'));
  set('patchKm', num('ground.patch_km'));
  set('tileKm', num('ground.tile_km'));
  set('heightKm', num('ground.height_km'));
  set('ridges', num('ground.ridges'));
  set('snowKm', num('ground.snow_km'));
  set('waveWindMs', num('ground.wave_wind'));
  set('waveFetchKm', num('ground.fetch_km'));
  // Without ground.seed the layout follows the roll, so a reroll lays out new ground.
  changes.seed = Math.round(num('ground.seed') ?? rollSeed);
  const weights = { ...ground.recipe.weights };
  const palette = { ...ground.recipe.palette };
  for (const t of TERRAIN_TYPES) {
    const w = num(`ground.weight.${t}`);
    if (w !== undefined) weights[t] = w;
    const c = linearColour(vars[`ground.colour.${t}`] ?? vars[`ground.color.${t}`]);
    if (c) palette[t] = c;
  }
  ground.enabled = true;
  ground.update({ ...changes, weights, palette });
}

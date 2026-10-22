// Look presets: sun, atmosphere, light and cloud character, as .wcx files in the same
// shape Lumen uses. Names are suggested by Moniker (skycaptain-look.moniker) and are
// always the artist's to change. Factory looks are the vibes; user looks live in
// localStorage and download as .wcx. Composition (shapes, paint, graph) is never part of
// a look: that is what .sky.json is for.

import lookVocabulary from './moniker/skycaptain-look.moniker?raw';
import { describeLook, monikerBlock, type MonikerBlock } from './moniker/skycaptain';
import { DEFAULTS, type Settings } from './settings';
import { VIBES } from './vibes';

export const LOOK_VOCABULARY = JSON.parse(lookVocabulary);

/** Settings a look carries. View, quality and the composition of the sky are left out. */
export const LOOK_KEYS = (Object.keys(DEFAULTS) as (keyof Settings)[]).filter(
  (k) => !['ev', 'fov', 'yaw', 'pitch', 'quality', 'seed', 'weatherScale', 'baseWeather'].includes(k),
);

export interface LookPreset {
  _format: 'wcx';
  _plugin: 'skycaptain';
  _wcxVersion: 1;
  kind: 'look';
  name: string;
  category: string;
  created: string;
  moniker: MonikerBlock;
  params: { id: keyof Settings; value: number }[];
}

const USER_KEY = 'skycaptain.lookPresets.v1';
export const PRESET_EXTENSION = '.wcx';

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `look-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function build(name: string, category: string, values: Partial<Settings>, keys: (keyof Settings)[]): LookPreset {
  const full = { ...DEFAULTS, ...values } as Settings;
  return {
    _format: 'wcx',
    _plugin: 'skycaptain',
    _wcxVersion: 1,
    kind: 'look',
    name,
    category,
    created: new Date().toISOString().slice(0, 10),
    moniker: monikerBlock(newId(), describeLook(full, LOOK_VOCABULARY)),
    params: keys.map((id) => ({ id, value: full[id] as number })),
  };
}

/** Factory looks: the vibes, carrying only the settings each one changes. */
export const FACTORY: LookPreset[] = VIBES.map((v) =>
  build(v.name, 'Factory', v.settings, Object.keys(v.settings) as (keyof Settings)[]));

export function userPresets(): LookPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(USER_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((p) => !presetError(p)) : [];
  } catch {
    return [];
  }
}

function writeUser(presets: LookPreset[]): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(presets));
  } catch {
    // Storage can be unavailable (private windows); the downloaded .wcx is still the file.
  }
}

export function list(): LookPreset[] {
  return [...FACTORY, ...userPresets()];
}

/** What the Save dialog offers: Moniker's name for this look, unique among saved looks. */
export function suggestName(settings: Settings): string {
  return describeLook(settings, LOOK_VOCABULARY, list().map((p) => p.name)).suggestion;
}

/** A new look from the current settings. A new save is a new preset with a new identity. */
export function capture(settings: Settings, name: string): LookPreset {
  return build(name.trim() || suggestName(settings), 'My looks', settings, LOOK_KEYS);
}

/** Keeps a look in the browser; the same name replaces the older entry. */
export function remember(preset: LookPreset): void {
  writeUser([...userPresets().filter((p) => p.name !== preset.name), preset]);
}

export function forget(name: string): void {
  writeUser(userPresets().filter((p) => p.name !== name));
}

function presetError(p: unknown): string | null {
  const preset = p as Partial<LookPreset> | null;
  if (!preset || typeof preset !== 'object') return 'not a preset';
  if (preset._format !== 'wcx') return 'not a .wcx preset';
  if (preset._plugin !== 'skycaptain') return `a ${String(preset._plugin ?? 'unknown')} preset, not a skyCaptain look`;
  if (!Array.isArray(preset.params)) return 'preset has no parameters';
  return null;
}

/** Reads untrusted .wcx text. Returns an error string instead of throwing. */
export function parse(text: string, fallbackName = 'Imported look'): { preset: LookPreset | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { preset: null, error: 'preset file is not valid JSON' };
  }
  const error = presetError(parsed);
  if (error) return { preset: null, error };
  const p = parsed as LookPreset;
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : fallbackName;
  return { preset: { ...p, name, category: 'My looks' }, error: null };
}

/** Applies a look through the host's setter. Returns ids it could not apply. */
export function apply(preset: LookPreset, set: (key: keyof Settings, value: number) => void): string[] {
  const skipped: string[] = [];
  for (const { id, value } of preset.params) {
    if (LOOK_KEYS.includes(id) && typeof value === 'number' && Number.isFinite(value)) set(id, value);
    else skipped.push(String(id));
  }
  return skipped;
}

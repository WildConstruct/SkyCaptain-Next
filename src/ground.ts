// Ground state: whether terrain is on, its recipe and painted tiles, and the layout they
// collapse to. Every change recollapses (about 50 ms) and notifies subscribers; main.ts
// hands the result to the renderer.

import { DEFAULT_TERRAIN, HeightField, Standpoint, TERRAIN_GRID, TerrainMap, TerrainRecipe, generateTerrain, heightField, parseTerrain, standpoint } from './terrain';

export class GroundStore {
  enabled = false;
  recipe: TerrainRecipe = structuredClone(DEFAULT_TERRAIN);
  /** Painted tiles: a type index, or -1 where the collapse decides. */
  readonly constraints = new Int8Array(TERRAIN_GRID * TERRAIN_GRID).fill(-1);
  map: TerrainMap;
  /** Relief over the same period (flat when the recipe's height is 0). */
  height: HeightField;
  /** Where the eye stands on relief (the origin on flat ground). */
  place: Standpoint;
  private listeners = new Set<() => void>();

  constructor() {
    this.map = generateTerrain(this.recipe, this.constraints);
    this.height = heightField(this.map, this.recipe);
    this.place = standpoint(this.map, this.height, this.recipe);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(regenerate: boolean, keepPlace = false): void {
    if (regenerate) {
      this.map = generateTerrain(this.recipe, this.constraints);
      this.height = heightField(this.map, this.recipe);
      if (!keepPlace) this.place = standpoint(this.map, this.height, this.recipe);
    }
    for (const fn of this.listeners) fn();
  }

  /**
   * Paints a disc of tiles (radius in tiles, wrapping) with a type index, or -1 to hand
   * them back to the collapse. Nothing recollapses until commitPaint().
   */
  paintTiles(tx: number, ty: number, radius: number, type: number): void {
    const n = TERRAIN_GRID;
    const r = Math.max(0, radius);
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy > r * r + 0.25) continue;
        const x = (((tx + dx) % n) + n) % n;
        const y = (((ty + dy) % n) + n) % n;
        this.constraints[y * n + x] = type;
      }
    }
  }

  /** Recollapses around the painted tiles. The eye stays where it stands while painting. */
  commitPaint(): void {
    this.enabled = true;
    this.changed(true, true);
  }

  /** Hands every painted tile back to the collapse. */
  clearPaint(): void {
    this.constraints.fill(-1);
    this.changed(true, true);
  }

  /** How many tiles are painted. */
  get paintedCount(): number {
    let n = 0;
    for (const v of this.constraints) if (v >= 0) n++;
    return n;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.changed(false);
  }

  /** Merges recipe changes (untrusted values are clamped) and recollapses. */
  update(changes: Partial<TerrainRecipe>): void {
    this.recipe = parseTerrain({ ...this.recipe, ...changes });
    this.changed(true);
  }

  /** Compass bearing (degrees) of the most prominent range from where the eye stands, or null on flat ground. */
  reliefBearing(): number | null {
    return this.enabled && this.recipe.heightKm > 0 ? this.place.bearing : null;
  }

  /** A new layout from the same recipe. */
  reroll(): void {
    this.update({ seed: Math.floor(Math.random() * 1_000_000) });
  }

  /** For documents: the recipe and the painted tiles, run-length encoded. */
  snapshot(): { enabled: boolean; recipe: TerrainRecipe; paint: [number, number][] } {
    const paint: [number, number][] = [];
    for (let i = 0; i < this.constraints.length; i++) {
      const v = this.constraints[i];
      if (paint.length && paint[paint.length - 1][0] === v) paint[paint.length - 1][1]++;
      else paint.push([v, 1]);
    }
    return { enabled: this.enabled, recipe: structuredClone(this.recipe), paint };
  }

  restore(raw: unknown): void {
    const r = (raw ?? {}) as { enabled?: unknown; recipe?: unknown; paint?: unknown };
    this.enabled = r.enabled === true;
    this.recipe = parseTerrain(r.recipe);
    this.constraints.fill(-1);
    if (Array.isArray(r.paint)) {
      let i = 0;
      for (const run of r.paint as unknown[]) {
        if (!Array.isArray(run)) continue;
        const [v, n] = run as [unknown, unknown];
        if (typeof v !== 'number' || typeof n !== 'number') continue;
        const type = Number.isInteger(v) && v >= -1 && v < 6 ? v : -1;
        for (let k = 0; k < n && i < this.constraints.length; k++) this.constraints[i++] = type;
      }
    }
    this.changed(true);
  }
}

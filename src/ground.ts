// Ground state: whether terrain is on, its recipe and painted tiles, and the layout they
// collapse to. Every change recollapses (about 50 ms) and notifies subscribers; main.ts
// hands the result to the renderer.

import { DEFAULT_TERRAIN, TERRAIN_GRID, TerrainMap, TerrainRecipe, generateTerrain, parseTerrain } from './terrain';

export class GroundStore {
  enabled = false;
  recipe: TerrainRecipe = structuredClone(DEFAULT_TERRAIN);
  /** Painted tiles: a type index, or -1 where the collapse decides. */
  readonly constraints = new Int8Array(TERRAIN_GRID * TERRAIN_GRID).fill(-1);
  map: TerrainMap;
  private listeners = new Set<() => void>();

  constructor() {
    this.map = generateTerrain(this.recipe, this.constraints);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(regenerate: boolean): void {
    if (regenerate) this.map = generateTerrain(this.recipe, this.constraints);
    for (const fn of this.listeners) fn();
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

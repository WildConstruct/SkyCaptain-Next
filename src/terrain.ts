// Ground terrain: a land-cover map built by wave function collapse, the ground's
// counterpart of the weather map. A square grid of tiles (one land-cover type each) wraps
// seamlessly, so the ground continues to any horizon. Adjacency rules keep the layout
// plausible (water meets land through sand, rock rises out of forest or meadow), a smooth
// elevation field biases which types collapse where (low ground floods, high ground turns
// to rock), and painted cells are fixed before the collapse so the rest grows around them.
// The renderer shades each type procedurally (clouds.wgsl ground_surface); this module
// only decides the layout. A recipe is plain data so sky graphs (ground.* variables) and
// sky files can carry it.

export const TERRAIN_TYPES = ['water', 'sand', 'meadow', 'fields', 'forest', 'rock'] as const;
export type TerrainType = (typeof TERRAIN_TYPES)[number];
export const TYPE_COUNT = TERRAIN_TYPES.length;

/** Which types may touch (symmetric). Every type may touch itself. */
const ADJACENT: [TerrainType, TerrainType][] = [
  ['water', 'sand'],
  ['sand', 'meadow'],
  ['sand', 'rock'],
  ['meadow', 'fields'],
  ['meadow', 'forest'],
  ['meadow', 'rock'],
  ['fields', 'forest'],
  ['forest', 'rock'],
];

/** Elevation (0..1) each type prefers, as a band centre. Water sits under the water level. */
const BAND: Record<TerrainType, number> = { water: 0.1, sand: 0.3, meadow: 0.45, fields: 0.5, forest: 0.62, rock: 0.85 };

export interface TerrainRecipe {
  seed: number;
  /** Tile size, km: the scale of the land-cover patchwork. */
  tileKm: number;
  /** Relative frequency of each type. */
  weights: Record<TerrainType, number>;
  /** Elevation below which the ground floods (0 = no water from elevation, 1 = mostly sea). */
  waterLevel: number;
  /** How strongly elevation decides the type (0 = pure patchwork, 1 = geography). */
  relief: number;
  /** Typical size of a land-use patch (a forest, a block of fields), km. */
  patchKm: number;
  /** How much a tile follows the tiles already settled around it (tidies stray tiles). */
  cohesion: number;
  /** Linear albedo per type. */
  palette: Record<TerrainType, [number, number, number]>;
  /** Height of the highest ground, km: 0 is flat, a few tenths rolling hills, several km mountains. */
  heightKm: number;
  /** 0 = rounded hills, 1 = sharp ridged ranges. */
  ridges: number;
  /** Altitude above which snow lies on gentle slopes, km. */
  snowKm: number;
}

export const DEFAULT_TERRAIN: TerrainRecipe = {
  seed: 1,
  tileKm: 1,
  weights: { water: 1, sand: 0.4, meadow: 2, fields: 3, forest: 2, rock: 0.5 },
  waterLevel: 0.25,
  relief: 0.7,
  patchKm: 6,
  cohesion: 2,
  palette: {
    water: [0.02, 0.035, 0.045],
    sand: [0.42, 0.37, 0.27],
    meadow: [0.14, 0.2, 0.07],
    fields: [0.22, 0.21, 0.11],
    forest: [0.05, 0.09, 0.04],
    rock: [0.25, 0.23, 0.21],
  },
  heightKm: 0,
  ridges: 0.6,
  snowKm: 2.8,
};

/** Grid side, tiles. At the default 1 km tile the ground repeats every 128 km. */
export const TERRAIN_GRID = 128;

const FULL = (1 << TYPE_COUNT) - 1;
const COMPATIBLE: number[] = TERRAIN_TYPES.map((a, i) => {
  let mask = 1 << i;
  for (const [x, y] of ADJACENT) {
    if (x === a) mask |= 1 << TERRAIN_TYPES.indexOf(y);
    if (y === a) mask |= 1 << TERRAIN_TYPES.indexOf(x);
  }
  return mask;
});

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A smooth field on the torus: octaves of periodic value noise from a base lattice of
 * baseCells per side, stretched to 0..1. Elevation uses a coarse lattice; land-use patches
 * a finer one.
 */
export function smoothField(size: number, seed: number, baseCells = 4, octaves = 4): Float32Array {
  const random = mulberry32(seed * 7919 + 13);
  const out = new Float32Array(size * size);
  for (let octave = 0, cells = baseCells, amp = 1; octave < octaves; octave++, cells *= 2, amp *= 0.5) {
    const noise = gradientLattice(cells, random);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) out[y * size + x] += noise((x / size) * cells, (y / size) * cells) * amp;
    }
  }
  // Stretch to the full 0..1 range so the water level means the same for every seed.
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / Math.max(hi - lo, 1e-6);
  return out;
}

/**
 * Periodic gradient (Perlin) noise over a cells x cells lattice, about -0.7..0.7. Gradient
 * noise has no grid-aligned blobs, which value noise shows as square hills.
 */
function gradientLattice(cells: number, random: () => number): (x: number, y: number) => number {
  const angles = Array.from({ length: cells * cells }, () => random() * Math.PI * 2);
  const gx = angles.map(Math.cos);
  const gy = angles.map(Math.sin);
  const dot = (ix: number, iy: number, dx: number, dy: number) => {
    const k = (((iy % cells) + cells) % cells) * cells + (((ix % cells) + cells) % cells);
    return gx[k] * dx + gy[k] * dy;
  };
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fade(fx);
    const sy = fade(fy);
    const top = dot(ix, iy, fx, fy) + (dot(ix + 1, iy, fx - 1, fy) - dot(ix, iy, fx, fy)) * sx;
    const bottom = dot(ix, iy + 1, fx, fy - 1) + (dot(ix + 1, iy + 1, fx - 1, fy - 1) - dot(ix, iy + 1, fx, fy - 1)) * sx;
    return top + (bottom - top) * sy;
  };
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Ridged multifractal (Musgrave) on the torus, 0..1: sharp crests whose detail is strongest
 * where the coarser octaves are already high, so main ridges carry branching spurs.
 */
export function ridgedField(size: number, seed: number, baseCells = 6, octaves = 5): Float32Array {
  const random = mulberry32(seed * 6151 + 29);
  const lattices = Array.from({ length: octaves }, (_, o) => gradientLattice(baseCells << o, random));
  const out = new Float32Array(size * size);
  let hi = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      let weight = 1;
      for (let o = 0, amp = 1; o < octaves; o++, amp *= 0.5) {
        const cells = baseCells << o;
        let signal = 1 - Math.abs(lattices[o]((x / size) * cells, (y / size) * cells)) * 1.6;
        signal = Math.max(0, signal) ** 2 * weight;
        weight = Math.min(1, signal * 2);
        sum += signal * amp;
      }
      out[y * size + x] = sum;
      hi = Math.max(hi, sum);
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= hi || 1;
  return out;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * One smooth field per land type at the recipe's patch size: where a type's field is high
 * it forms a patch (a forest, a block of fields). Water and sand follow elevation only.
 */
function patchFields(r: TerrainRecipe, size: number): Float32Array[] {
  const cells = Math.max(2, Math.round((size * r.tileKm) / r.patchKm));
  return TERRAIN_TYPES.map((_, t) => smoothField(size, r.seed * 31 + t * 977 + 5, cells, 2));
}

/** Patch strength: how many times more likely a type is at the top of its field than the bottom. */
const PATCH_CONTRAST = 30;

/** How much a type wants a cell at elevation e (before its global weight). */
function preference(r: TerrainRecipe, type: number, e: number, patch = 0.5): number {
  const name = TERRAIN_TYPES[type];
  if (name === 'water' || name === 'sand') return elevationPreference(r, type, e);
  return elevationPreference(r, type, e) * Math.exp(Math.log(PATCH_CONTRAST) * (patch - 0.5) * 2);
}

function elevationPreference(r: TerrainRecipe, type: number, e: number): number {
  const name = TERRAIN_TYPES[type];
  // Water follows the water level alone: the ground floods below it and not above.
  if (name === 'water') return e < r.waterLevel ? 1 : Math.max(1e-3, Math.exp(-(((e - r.waterLevel) / 0.03) ** 2)));
  // Under the water line land is unlikely however it is weighted (adjacency still puts
  // sand along the shores).
  if (e < r.waterLevel) return 0.02;
  // Above it, relief sorts the land into height bands (meadow low, rock high).
  const centre = r.waterLevel + BAND[name] * (1 - r.waterLevel);
  const fit = Math.exp(-(((e - centre) / 0.18) ** 2));
  return Math.max(1e-4, 1 - r.relief + r.relief * fit);
}

export interface TerrainMap {
  size: number;
  /** Type index per tile, row-major. */
  types: Uint8Array;
  elevation: Float32Array;
  /** Collapses that hit a contradiction and were retried. */
  retries: number;
}

/**
 * Collapses the grid. constraints holds a type index per tile, or -1 for free tiles;
 * painted tiles are fixed first and the rules propagate out from them.
 */
export function generateTerrain(recipe: TerrainRecipe, constraints?: Int8Array, size = TERRAIN_GRID): TerrainMap {
  const elevation = smoothField(size, recipe.seed);
  const patches = patchFields(recipe, size);
  const weights = TERRAIN_TYPES.map((t) => Math.max(0, recipe.weights[t]));
  for (let attempt = 0; attempt < 8; attempt++) {
    const types = collapse(recipe, weights, elevation, patches, size, mulberry32(recipe.seed * 104729 + attempt), constraints);
    if (types) return { size, types, elevation, retries: attempt };
  }
  // Rules too tight for the paint (e.g. water painted against rock): keep the paint and
  // fill the rest by preference alone.
  const types = new Uint8Array(size * size);
  for (let i = 0; i < types.length; i++) {
    const fixed = constraints?.[i] ?? -1;
    types[i] = fixed >= 0 ? fixed : argmax(weights.map((w, t) => w * preference(recipe, t, elevation[i], patches[t][i])));
  }
  return { size, types, elevation, retries: 8 };
}

function argmax(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

function collapse(
  recipe: TerrainRecipe, weights: number[], elevation: Float32Array, patches: Float32Array[], size: number,
  random: () => number, constraints?: Int8Array,
): Uint8Array | null {
  const n = size * size;
  // Types with zero weight never appear unless painted.
  const allowed = weights.reduce((m, w, t) => (w > 0 ? m | (1 << t) : m), 0);
  const domain = new Uint8Array(n).fill(allowed);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    const fixed = constraints?.[i] ?? -1;
    if (fixed >= 0) { domain[i] = 1 << fixed; stack.push(i); }
  }
  const changed: number[] = [];
  if (!propagate(domain, size, stack, changed)) return null;

  // Weighted entropy per open cell, kept in a lazy min-heap: a popped entry whose value no
  // longer matches the cell's current entropy is stale and skipped.
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = random() * 1e-3;
  const entropy = new Float64Array(n);
  const heap = new MinHeap();
  const update = (i: number) => {
    const d = domain[i];
    if ((d & (d - 1)) === 0) { entropy[i] = Infinity; return; }
    let sum = 0;
    let sumLog = 0;
    for (let t = 0; t < TYPE_COUNT; t++) {
      if (!(d & (1 << t))) continue;
      const w = weights[t] * preference(recipe, t, elevation[i], patches[t][i]);
      sum += w;
      sumLog += w * Math.log(w);
    }
    entropy[i] = Math.log(sum) - sumLog / sum + noise[i];
    heap.push(entropy[i], i);
  };
  for (let i = 0; i < n; i++) update(i);

  for (;;) {
    let best = -1;
    while (heap.size) {
      const [e, i] = heap.pop();
      if (e === entropy[i]) { best = i; break; }
    }
    if (best < 0) break;
    const d = domain[best];
    // Cohesion: favour types already settled in the 8-neighbourhood, so patches grow
    // instead of every tile rolling on its own.
    const bx = best % size;
    const by = (best - bx) / size;
    const around = new Array(TYPE_COUNT).fill(0);
    let settled = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const j = ((by + dy + size) % size) * size + ((bx + dx + size) % size);
        const dj = domain[j];
        if ((dj & (dj - 1)) === 0) { around[31 - Math.clz32(dj)]++; settled++; }
      }
    }
    let total = 0;
    const options: [number, number][] = [];
    for (let t = 0; t < TYPE_COUNT; t++) {
      if (!(d & (1 << t))) continue;
      const follow = settled ? Math.exp(recipe.cohesion * (around[t] / settled)) : 1;
      const w = weights[t] * preference(recipe, t, elevation[best], patches[t][best]) * follow;
      options.push([t, w]);
      total += w;
    }
    let pick = random() * total;
    let chosen = options[options.length - 1][0];
    for (const [t, w] of options) {
      if ((pick -= w) <= 0) { chosen = t; break; }
    }
    domain[best] = 1 << chosen;
    entropy[best] = Infinity;
    stack.push(best);
    changed.length = 0;
    if (!propagate(domain, size, stack, changed)) return null;
    for (const i of changed) update(i);
  }
  const types = new Uint8Array(n);
  for (let i = 0; i < n; i++) types[i] = 31 - Math.clz32(domain[i]);
  return types;
}

class MinHeap {
  private keys: number[] = [];
  private values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  pop(): [number, number] {
    const { keys, values } = this;
    const top: [number, number] = [keys[0], values[0]];
    const key = keys.pop()!;
    const value = values.pop()!;
    if (keys.length) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= keys.length) break;
        if (child + 1 < keys.length && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = key;
      values[i] = value;
    }
    return top;
  }
}

/** Arc consistency over the 4-neighbourhood, wrapping at the edges. False on a contradiction. */
function propagate(domain: Uint8Array, size: number, stack: number[], changed: number[]): boolean {
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % size;
    const y = (i - x) / size;
    let reach = 0;
    for (let t = 0; t < TYPE_COUNT; t++) if (domain[i] & (1 << t)) reach |= COMPATIBLE[t];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const j = ((y + dy + size) % size) * size + ((x + dx + size) % size);
      const next = domain[j] & reach;
      if (next === domain[j]) continue;
      if (next === 0) return false;
      domain[j] = next;
      stack.push(j);
      changed.push(j);
    }
  }
  return true;
}

/** True when every pair of neighbouring tiles is allowed to touch. */
export function respectsAdjacency(map: TerrainMap): boolean {
  const { size, types } = map;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = types[y * size + x];
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const b = types[((y + dy) % size) * size + ((x + dx) % size)];
        if (!(COMPATIBLE[a] & (1 << b))) return false;
      }
    }
  }
  return true;
}

/** Reads an untrusted recipe; missing or bad fields fall back to the defaults. */
export function parseTerrain(raw: unknown): TerrainRecipe {
  const r = (raw ?? {}) as Partial<Record<keyof TerrainRecipe, unknown>>;
  const d = DEFAULT_TERRAIN;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const weights = { ...d.weights };
  const palette = { ...d.palette };
  const rw = (r.weights ?? {}) as Record<string, unknown>;
  const rp = (r.palette ?? {}) as Record<string, unknown>;
  for (const t of TERRAIN_TYPES) {
    weights[t] = num(rw[t], d.weights[t], 0, 100);
    const c = rp[t];
    if (Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      palette[t] = c.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number];
    }
  }
  return {
    seed: Math.round(num(r.seed, d.seed, 0, 1e9)),
    tileKm: num(r.tileKm, d.tileKm, 0.1, 20),
    weights,
    waterLevel: num(r.waterLevel, d.waterLevel, 0, 0.95),
    relief: num(r.relief, d.relief, 0, 1),
    patchKm: num(r.patchKm, d.patchKm, 0.5, 100),
    cohesion: num(r.cohesion, d.cohesion, 0, 10),
    palette,
    heightKm: num(r.heightKm, d.heightKm, 0, 8),
    ridges: num(r.ridges, d.ridges, 0, 1),
    snowKm: num(r.snowKm, d.snowKm, 0, 9),
  };
}

/** Height field side, texels: over the 128-tile period, about 250 m per texel at 1 km tiles. */
export const HEIGHT_GRID = 512;

export interface HeightField {
  size: number;
  /** Ground height above sea level per texel, km, row-major over the same period as the layout. */
  heights: Float32Array;
  /** Height under the eye (the origin), as the renderer's linear filter reads it there. */
  atOrigin: number;
}

/**
 * Relief from the same elevation the layout was collapsed on, so land types sit where they
 * belong (water at sea level, rock high): land rises from the shore, shaped into rounded
 * hills or ridged ranges, up to heightKm. Water tiles are held flat at sea level.
 */
export function heightField(map: TerrainMap, recipe: TerrainRecipe, size = HEIGHT_GRID): HeightField {
  const heights = new Float32Array(size * size);
  if (recipe.heightKm <= 0) return { size, heights, atOrigin: 0 };
  // The elevation function is continuous, so sampling it finer gives the same landscape.
  const elevation = smoothField(size, recipe.seed);
  const ridged = ridgedField(size, recipe.seed * 13 + 101);
  const wl = recipe.waterLevel;
  const scale = map.size / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const tile = map.types[Math.floor(y * scale) * map.size + Math.floor(x * scale)];
      if (tile === 0) continue; // water
      const land = Math.max(0, (elevation[i] - wl) / Math.max(1 - wl, 1e-3));
      const rise = land ** 1.6;
      // Ridges carve the rise into crests and valleys; the mean height stays about the same.
      const shape = 1 - recipe.ridges + recipe.ridges * (0.3 + 1.4 * ridged[i]);
      // At least a couple of metres above the water so shores do not flood.
      heights[i] = Math.max(0.002, recipe.heightKm * rise * shape);
    }
  }
  // The highest ground is exactly heightKm, whatever the ridging did to the shape.
  const top = heights.reduce((m, h) => Math.max(m, h), 0);
  if (top > 0) for (let i = 0; i < heights.length; i++) if (heights[i] > 0) heights[i] = Math.max(0.002, (heights[i] / top) * recipe.heightKm);
  // One box blur pass softens tile steps (water edges, type boundaries).
  const soft = new Float32Array(heights.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += heights[((y + dy + size) % size) * size + ((x + dx + size) % size)];
      soft[y * size + x] = sum / 9;
    }
  }
  // The renderer samples texel centres with a linear filter, wrapping: at the origin it
  // reads the four corner texels equally.
  const atOrigin = (soft[0] + soft[size - 1] + soft[(size - 1) * size] + soft[size * size - 1]) / 4;
  return { size, heights: soft, atOrigin };
}

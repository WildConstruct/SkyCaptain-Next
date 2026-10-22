// Paint layers over the weather map, kept on the CPU and uploaded as dirty rectangles.
//   paint: coverage delta, type target, type weight, density delta
//   warp:  displacement (km) applied to the whole weather composite (smudge)
// Strokes snapshot the 64x64 tiles they touch, so undo restores only what changed.

import type { History, HistoryEntry } from './history';
import { toHalf } from './half';

export type BrushTool = 'cloud' | 'erase' | 'type' | 'density' | 'scatter' | 'smudge';

export const BRUSH_TOOLS: { tool: BrushTool; label: string; hint: string }[] = [
  { tool: 'cloud', label: 'Cloud', hint: 'Add coverage (and optionally set the cloud type)' },
  { tool: 'erase', label: 'Clear', hint: 'Remove coverage' },
  { tool: 'type', label: 'Type', hint: 'Push the cloud type toward stratus or towers' },
  { tool: 'density', label: 'Density', hint: 'Thicken or thin clouds' },
  { tool: 'scatter', label: 'Scatter', hint: 'Spray separate small clouds' },
  { tool: 'smudge', label: 'Smudge', hint: 'Drag the weather along the stroke (shapes and paint)' },
];

export interface BrushOptions {
  tool: BrushTool;
  /** Radius, km. */
  size: number;
  /** Amount per dab, 0..1. */
  flow: number;
  /**
   * Cloud brush ceiling: a stroke builds coverage up to this and no further. Below 1 the
   * noise still carves separate clouds; 1 paints toward an overcast deck.
   */
  opacity: number;
  /** 0 = soft falloff from the centre, 1 = hard edge. */
  hardness: number;
  /** Cloud type painted by Cloud and Type brushes; null leaves type alone (Cloud only). */
  type: number | null;
  /** Density brush direction. */
  thin: boolean;
}

export const DEFAULT_BRUSH: BrushOptions = { tool: 'cloud', size: 6, flow: 0.35, opacity: 0.65, hardness: 0.3, type: null, thin: false };

export type LayerName = 'paint' | 'warp';

const TILE = 64;

/** Paint values lie in [-1, 1] and are stored as int16; warp (km) is stored exactly as float32. */
const PAINT_SCALE = 32767;

export interface PaintTile {
  layer: LayerName;
  tx: number;
  ty: number;
  /** TILE x TILE x 4, row-major: int16 (paint, scaled by PAINT_SCALE) or float32 (warp). */
  data: Int16Array | Float32Array;
}

interface DirtyRect { x0: number; y0: number; x1: number; y1: number }

export class PaintLayers {
  readonly size: number;
  readonly paint: Float32Array;
  readonly warp: Float32Array;
  private dirty: Record<LayerName, DirtyRect | null> = { paint: null, warp: null };
  private stroke: Map<string, Float32Array> | null = null;
  private random = mulberry32(1);
  /** Map extent in km (side of the square), kept in sync with settings.weatherScale. */
  extent = 300;

  constructor(size: number, private history: History) {
    this.size = size;
    this.paint = new Float32Array(size * size * 4);
    this.warp = new Float32Array(size * size * 4);
  }

  private layer(name: LayerName): Float32Array {
    return name === 'paint' ? this.paint : this.warp;
  }

  get hasContent(): boolean {
    return this.paint.some((v) => v !== 0) || this.warp.some((v) => v !== 0);
  }

  // --- coordinates -------------------------------------------------------------------

  /** Map km -> continuous texel coordinates (texel centres at +0.5). */
  private toTexel(x: number, z: number): [number, number] {
    return [(x / this.extent + 0.5) * this.size, (z / this.extent + 0.5) * this.size];
  }

  // --- strokes and undo --------------------------------------------------------------

  beginStroke(): void {
    this.stroke = new Map();
  }

  endStroke(): void {
    const saved = this.stroke;
    this.stroke = null;
    if (saved && saved.size > 0) this.history.push(this.tileEntry(saved));
  }

  private tileEntry(saved: Map<string, Float32Array>): HistoryEntry {
    return {
      apply: () => {
        const replaced = new Map<string, Float32Array>();
        for (const [key, data] of saved) {
          const [name, tx, ty] = parseKey(key);
          replaced.set(key, this.copyTile(name, tx, ty));
          this.writeTile(name, tx, ty, data);
        }
        return this.tileEntry(replaced);
      },
    };
  }

  /** Save the tiles under a texel rectangle before the current stroke first modifies them. */
  private touch(name: LayerName, x0: number, y0: number, x1: number, y1: number): void {
    const n = this.size;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(n - 1, x1); y1 = Math.min(n - 1, y1);
    if (x1 < x0 || y1 < y0) return;
    if (this.stroke) {
      for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) {
        for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
          const key = `${name}:${tx}:${ty}`;
          if (!this.stroke.has(key)) this.stroke.set(key, this.copyTile(name, tx, ty));
        }
      }
    }
    this.markDirty(name, x0, y0, x1, y1);
  }

  private copyTile(name: LayerName, tx: number, ty: number): Float32Array {
    const src = this.layer(name);
    const out = new Float32Array(TILE * TILE * 4);
    for (let y = 0; y < TILE; y++) {
      const row = ((ty * TILE + y) * this.size + tx * TILE) * 4;
      out.set(src.subarray(row, row + TILE * 4), y * TILE * 4);
    }
    return out;
  }

  private writeTile(name: LayerName, tx: number, ty: number, data: Float32Array): void {
    const dst = this.layer(name);
    for (let y = 0; y < TILE; y++) {
      const row = ((ty * TILE + y) * this.size + tx * TILE) * 4;
      dst.set(data.subarray(y * TILE * 4, (y + 1) * TILE * 4), row);
    }
    this.markDirty(name, tx * TILE, ty * TILE, tx * TILE + TILE - 1, ty * TILE + TILE - 1);
  }

  private markDirty(name: LayerName, x0: number, y0: number, x1: number, y1: number): void {
    const d = this.dirty[name];
    this.dirty[name] = d
      ? { x0: Math.min(d.x0, x0), y0: Math.min(d.y0, y0), x1: Math.max(d.x1, x1), y1: Math.max(d.y1, y1) }
      : { x0, y0, x1, y1 };
  }

  /** Non-empty tiles of both layers (for documents). */
  exportTiles(): PaintTile[] {
    const tiles: PaintTile[] = [];
    const per = this.size / TILE;
    for (const name of ['paint', 'warp'] as LayerName[]) {
      for (let ty = 0; ty < per; ty++) {
        for (let tx = 0; tx < per; tx++) {
          const data = this.copyTile(name, tx, ty);
          if (!data.some((v) => v !== 0)) continue;
          if (name === 'warp') {
            tiles.push({ layer: name, tx, ty, data });
            continue;
          }
          const q = new Int16Array(data.length);
          for (let i = 0; i < data.length; i++) q[i] = Math.max(-32767, Math.min(32767, Math.round(data[i] * PAINT_SCALE)));
          tiles.push({ layer: name, tx, ty, data: q });
        }
      }
    }
    return tiles;
  }

  /** Replaces both layers with the given tiles (not undoable; used when opening a document). */
  importTiles(tiles: PaintTile[]): void {
    this.paint.fill(0);
    this.warp.fill(0);
    for (const t of tiles) {
      let data: Float32Array;
      if (t.data instanceof Float32Array) {
        data = t.data;
      } else {
        data = new Float32Array(t.data.length);
        for (let i = 0; i < data.length; i++) data[i] = t.data[i] / PAINT_SCALE;
      }
      this.writeTile(t.layer, t.tx, t.ty, data);
    }
    this.markDirty('paint', 0, 0, this.size - 1, this.size - 1);
    this.markDirty('warp', 0, 0, this.size - 1, this.size - 1);
  }

  /** Clears both layers as one undoable step. */
  clearAll(): void {
    if (!this.hasContent) return;
    this.beginStroke();
    for (const name of ['paint', 'warp'] as LayerName[]) {
      this.touch(name, 0, 0, this.size - 1, this.size - 1);
      this.layer(name).fill(0);
    }
    this.endStroke();
  }

  /** Uploads changed rectangles as half floats. Returns true if anything was uploaded. */
  flush(upload: (name: LayerName, x: number, y: number, w: number, h: number, data: Uint16Array) => void): boolean {
    let any = false;
    for (const name of ['paint', 'warp'] as LayerName[]) {
      const d = this.dirty[name];
      if (!d) continue;
      this.dirty[name] = null;
      const w = d.x1 - d.x0 + 1;
      const h = d.y1 - d.y0 + 1;
      const src = this.layer(name);
      const out = new Uint16Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        const row = ((d.y0 + y) * this.size + d.x0) * 4;
        for (let i = 0; i < w * 4; i++) out[y * w * 4 + i] = toHalf(src[row + i]);
      }
      upload(name, d.x0, d.y0, w, h, out);
      any = true;
    }
    return any;
  }

  // --- brushes ----------------------------------------------------------------------

  /**
   * One dab at a map position (km). `delta` is the stroke movement since the last dab,
   * used by the smudge brush.
   */
  dab(opts: BrushOptions, x: number, z: number, delta: [number, number] = [0, 0]): void {
    if (opts.tool === 'scatter') {
      // A few small cloud dabs at random spots inside the brush.
      for (let i = 0; i < 3; i++) {
        const a = this.random() * Math.PI * 2;
        const r = Math.sqrt(this.random()) * opts.size;
        const sub = {
          ...opts, tool: 'cloud' as const, size: opts.size * (0.12 + this.random() * 0.12),
          flow: Math.min(1, opts.flow * 2.5), opacity: Math.min(1, opts.opacity + 0.2), hardness: 0.5,
        };
        this.dab(sub, x + Math.cos(a) * r, z + Math.sin(a) * r);
      }
      return;
    }
    const [cx, cy] = this.toTexel(x, z);
    const r = (opts.size / this.extent) * this.size;
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
    const name: LayerName = opts.tool === 'smudge' ? 'warp' : 'paint';
    this.touch(name, x0, y0, x1, y1);
    const data = this.layer(name);
    const n = this.size;

    // Smudge resamples the previous warp, so read from a copy of the region it can reach.
    let before: Region | null = null;
    let deltaTex: [number, number] = [0, 0];
    if (opts.tool === 'smudge') {
      deltaTex = [(delta[0] / this.extent) * n, (delta[1] / this.extent) * n];
      const m = Math.ceil(Math.hypot(deltaTex[0], deltaTex[1])) + 2;
      before = copyRegion(data, n, x0 - m, y0 - m, x1 + m, y1 + m);
    }

    for (let ty = Math.max(0, y0); ty <= Math.min(n - 1, y1); ty++) {
      for (let tx = Math.max(0, x0); tx <= Math.min(n - 1, x1); tx++) {
        const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy) / Math.max(r, 1e-3);
        if (d >= 1) continue;
        const w = (1 - smoothstep(opts.hardness * 0.95, 1, d)) * opts.flow;
        const i = (ty * n + tx) * 4;
        switch (opts.tool) {
          case 'cloud':
            if (data[i] < opts.opacity) data[i] = Math.min(opts.opacity, data[i] + w);
            if (opts.type !== null) blendType(data, i, opts.type, w);
            break;
          case 'erase':
            data[i] = Math.max(-1, data[i] - w);
            break;
          case 'type':
            blendType(data, i, opts.type ?? 0.5, w);
            break;
          case 'density':
            data[i + 3] = clamp(data[i + 3] + (opts.thin ? -w : w) * 0.5, -1, 1);
            break;
          case 'smudge': {
            // weather(x) = source(x - warp(x)): content follows the stroke.
            const sx = tx - deltaTex[0] * w;
            const sy = ty - deltaTex[1] * w;
            const prev = sampleRegion(before!, sx, sy);
            data[i] = prev[0] + delta[0] * w;
            data[i + 1] = prev[1] + delta[1] * w;
            break;
          }
        }
      }
    }
  }
}

function blendType(data: Float32Array, i: number, value: number, w: number): void {
  const weight = data[i + 2];
  data[i + 1] = (data[i + 1] * weight + value * w) / Math.max(weight + w, 1e-6);
  data[i + 2] = Math.min(1, weight + w);
}

/** A clamped rectangular copy of a layer, texel coordinates kept in map space. */
interface Region { data: Float32Array; x0: number; y0: number; w: number; h: number }

function copyRegion(src: Float32Array, n: number, x0: number, y0: number, x1: number, y1: number): Region {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(n - 1, x1); y1 = Math.min(n - 1, y1);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = ((y0 + y) * n + x0) * 4;
    data.set(src.subarray(row, row + w * 4), y * w * 4);
  }
  return { data, x0, y0, w, h };
}

function sampleRegion(r: Region, x: number, y: number): [number, number] {
  const fx = x - 0.5 - r.x0, fy = y - 0.5 - r.y0;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const ax = fx - ix, ay = fy - iy;
  const at = (px: number, py: number, c: number) => {
    const cx = Math.min(r.w - 1, Math.max(0, px));
    const cy = Math.min(r.h - 1, Math.max(0, py));
    return r.data[(cy * r.w + cx) * 4 + c];
  };
  const out: [number, number] = [0, 0];
  for (let c = 0; c < 2; c++) {
    const top = at(ix, iy, c) * (1 - ax) + at(ix + 1, iy, c) * ax;
    const bottom = at(ix, iy + 1, c) * (1 - ax) + at(ix + 1, iy + 1, c) * ax;
    out[c] = top * (1 - ay) + bottom * ay;
  }
  return out;
}

function parseKey(key: string): [LayerName, number, number] {
  const [name, tx, ty] = key.split(':');
  return [name as LayerName, Number(tx), Number(ty)];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / Math.max(b - a, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lightning: the strike clock and the channel's shape. Ported from Ethera
// (ethera-etheros engine/stack/lightning.mjs, the strike clock, and interpreter.wgsl
// bolt_point, the channel), both pure functions of the settings, the seed and scene time,
// so a frame is the same however playback got there (scrub, render queue, loop).
//
// A strike is a leader that grows from the cloud toward its end over Grow Time, then a
// bright return stroke that decays over Fade. Restrikes are further return strokes down
// the same channel, spaced by Restrike Gap (each gap varied a little, seeded), each 0.72
// as bright as the one before. Flicker modulates the brightness at Flicker Rate.
//
// Here the channel is built on the CPU once per frame, as polylines in world km (the
// main channel and its branches), and the cloud pass reads them (see docs/lightning.md).

export type Vec3 = [number, number, number];

export interface StrikeTiming {
  /** Scene time of the strike, s. */
  strikeAt: number;
  /** How long the leader takes to reach the ground, s. */
  growTime: number;
  /** How long each return stroke takes to fade, s. */
  fade: number;
  /** Return strokes after the first, down the same channel. */
  restrikes: number;
  /** Typical time between return strokes, s. */
  restrikeGap: number;
  /** How much the brightness flickers, 0..1. */
  flicker: number;
  /** Flicker rate, Hz. */
  flickerRate: number;
  seed: number;
}

/** Ethera's defaults, with restrike gaps nearer a real flash's 40-100 ms. */
export const DEFAULT_TIMING: StrikeTiming = {
  strikeAt: 0, growTime: 0.18, fade: 0.45, restrikes: 2, restrikeGap: 0.08, flicker: 0.5, flickerRate: 24, seed: 0,
};

export const RESTRIKE_DECAY = 0.72;

/** A small integer hash to [0, 1): the same on every platform. */
export function hashUnit(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** The start time of each return stroke, relative to the first, s. */
export function strokeTimes(p: StrikeTiming): number[] {
  const times = [0];
  for (let k = 1; k <= p.restrikes; k++) {
    const wobble = 0.65 + 0.7 * hashUnit(p.seed * 7919 + k * 31);
    times.push(times[k - 1] + p.restrikeGap * wobble);
  }
  return times;
}

export interface StrikeState {
  active: boolean;
  /** How far the leader has reached, 0..1. */
  growth: number;
  /** Channel brightness, 0..1 (1 at the first return stroke). */
  brightness: number;
  /** Return strokes so far. */
  strokes: number;
}

/** Where a strike is at scene time `time`. */
export function strikeState(p: StrikeTiming, time: number): StrikeState {
  const age = time - p.strikeAt;
  const idle = { active: false, growth: 0, brightness: 0, strokes: 0 };
  if (age < 0) return idle;
  const grow = Math.max(p.growTime, 1e-4);
  const raw = Math.min(age / grow, 1);
  // The leader steps and stalls a little (ease), arriving with the first stroke.
  const growth = raw * raw * (3 - 2 * raw);
  const times = strokeTimes(p);
  const tau = Math.max(p.fade, 1e-4) / 3;
  let brightness = 0;
  let strokes = 0;
  for (let k = 0; k < times.length; k++) {
    const since = age - (grow + times[k]);
    if (since < 0) continue;
    strokes++;
    brightness = Math.max(brightness, Math.pow(RESTRIKE_DECAY, k) * Math.exp(-since / tau));
  }
  // The leader alone is a faint thread.
  if (strokes === 0) brightness = 0.25 + 0.35 * raw;
  if (age > grow + times[times.length - 1] + p.fade) return { ...idle, growth: 1, strokes };
  if (p.flicker > 0) {
    const tick = Math.floor(age * Math.max(p.flickerRate, 0.1));
    brightness *= 1 - p.flicker * 0.7 * hashUnit(p.seed * 40503 + tick * 13);
  }
  return { active: true, growth, brightness, strokes };
}

/** Seconds from the strike until the last return stroke has faded. */
export function strikeDuration(p: StrikeTiming): number {
  const times = strokeTimes(p);
  return p.growTime + times[times.length - 1] + p.fade;
}

// ---- The channel --------------------------------------------------------------------

export interface ChannelShape {
  /** Sideways wander as a share of the channel's length (Ethera's Jaggedness). */
  rough: number;
  /** Fine detail, 0..1: how much the finer octaves wander. */
  detail: number;
  /** Side branches. */
  branches: number;
  /** Branch angle off the channel, radians. */
  branchAngle: number;
  /** Branch length as a share of the channel's. */
  branchLength: number;
}

export const DEFAULT_SHAPE: ChannelShape = { rough: 0.9, detail: 0.6, branches: 5, branchAngle: 0.6, branchLength: 0.35 };

export const CHANNEL_POINTS = 48;
export const BRANCH_POINTS = 12;

/** One element of a bolt: a polyline (km) and its share of the channel's brightness. */
export interface ChannelElement {
  points: Vec3[];
  weight: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => scale(a, 1 / Math.max(len(a), 1e-9));
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Two smooth noise values in -1..1 at x (seeded value noise). */
function channelNoise(seed: number, x: number): [number, number] {
  const i = Math.floor(x);
  const f = x - i;
  const w = f * f * (3 - 2 * f);
  const h = (k: number, c: number) => hashUnit(Math.imul(k, 374761393) ^ Math.imul(Math.round(seed * 1000) | 0, 668265263) ^ c) * 2 - 1;
  return [h(i, 1) + (h(i + 1, 1) - h(i, 1)) * w, h(i, 2) + (h(i + 1, 2) - h(i, 2)) * w];
}

function frame(dir: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const side = norm(cross(dir, ref));
  return [side, cross(dir, side)];
}

/** A point of a channel from a to b at t (0..1): the line plus seeded wander, pinned at both ends. */
function channelPoint(a: Vec3, b: Vec3, side: Vec3, up: Vec3, seed: number, s: ChannelShape, t: number): Vec3 {
  const pin = smooth(0, 0.06, t) * smooth(0, 0.06, 1 - t);
  let dx = 0, dy = 0, amp = 1, freq = 2.5;
  const gain = 0.32 + (0.64 - 0.32) * s.detail;
  for (let o = 0; o < 4; o++) {
    const [nx, ny] = channelNoise(seed + o * 7.31, t * freq + o * 13.7);
    dx += amp * nx;
    dy += amp * ny;
    freq *= 2.15;
    amp *= gain;
  }
  const k = s.rough * len(sub(b, a)) * 0.16 * pin;
  return add(mix(a, b, t), add(scale(side, dx * k), scale(up, dy * k)));
}

/**
 * The bolt's elements from start to end (km), grown to `growth` (0..1): the main channel
 * first, then branches leaving it at seeded heights, each growing once the leader has
 * passed its root. Elements that have not started are left out.
 */
export function channel(start: Vec3, end: Vec3, seed: number, s: ChannelShape, growth: number): ChannelElement[] {
  const span = sub(end, start);
  const length = Math.max(len(span), 1e-6);
  const dir = scale(span, 1 / length);
  const [side, up] = frame(dir);
  const out: ChannelElement[] = [];
  const grown = (a: Vec3, b: Vec3, f: [Vec3, Vec3], eseed: number, shape: ChannelShape, n: number, g: number): Vec3[] => {
    const pts: Vec3[] = [channelPoint(a, b, f[0], f[1], eseed, shape, 0)];
    for (let i = 1; i <= n; i++) {
      const t0 = (i - 1) / n, t1 = i / n;
      if (t0 >= g) break;
      const next = channelPoint(a, b, f[0], f[1], eseed, shape, t1);
      // The leader's tip: the last segment grows to the front.
      pts.push(mix(pts[pts.length - 1], next, Math.min(1, (g - t0) / (t1 - t0))));
    }
    return pts;
  };
  if (growth <= 0) return out;
  out.push({ points: grown(start, end, [side, up], seed, s, CHANNEL_POINTS, growth), weight: 1 });
  for (let e = 1; e <= s.branches; e++) {
    const hx = hashUnit(seed * 9173 + e * 101), hy = hashUnit(seed * 3301 + e * 211), hz = hashUnit(seed * 7717 + e * 307);
    const tb = 0.12 + 0.73 * hx;
    const g = Math.min(1, Math.max(0, (growth - tb) / 0.35));
    if (g <= 0) continue;
    const at = channelPoint(start, end, side, up, seed, s, tb);
    const ahead = channelPoint(start, end, side, up, seed, s, Math.min(tb + 0.02, 1));
    const tangent = norm(add(sub(ahead, at), scale(dir, 1e-3)));
    const turn = s.branchAngle * (0.5 + hy) * (hz > 0.5 ? 1 : -1);
    const phi = ((hz * 7.13) % 1) * 2 * Math.PI;
    const sideways = add(scale(side, Math.cos(phi)), scale(up, Math.sin(phi)));
    const bdir = norm(add(scale(tangent, Math.cos(turn)), scale(sideways, Math.sin(turn))));
    const bend = add(at, scale(bdir, length * s.branchLength * (0.5 + 0.5 * hy) * (1 - tb * 0.4)));
    const shape = { ...s, rough: s.rough * 1.3 };
    out.push({ points: grown(at, bend, frame(bdir), seed + e * 17, shape, BRANCH_POINTS, g), weight: 0.55 * (1 - tb * 0.5) });
  }
  return out;
}

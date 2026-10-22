// Animation: how a sky changes over time. Frame 0 is exactly the sky as composed; keys at
// later times change settings and shape layers, and everything in between is
// interpolated. On top of the keys:
//   wind      the whole weather map (background, shapes, paint) drifts with the wind; speed
//             and heading can be keyed, and the drift is their integral over time
//   evolution the cloud shape noise scrolls upward, so clouds grow and dissolve as they go
//             (Takram's "evolution"); cloud life is how long a full turnover takes
// Animation time is scene time sped up by the time-lapse factor, so a 10 s clip at 120x
// covers 20 minutes of weather. Everything is a pure function of t, so any frame can be
// rendered on its own.

import type { Settings } from './settings';
import type { ShapeLayer } from './shapes';

/** Settings that keys can change. View, quality, seed and the drift offsets are not keyed. */
export const KEYABLE_SETTINGS = [
  'sunElevation', 'sunAzimuth', 'sunIntensity', 'haze', 'groundAlbedo',
  'coverage', 'typeBias', 'density', 'erosion', 'baseWeather',
  'ambient', 'forwardG', 'powder', 'backG', 'backWeight',
  'cloudBottom', 'cloudThickness', 'towerHeight',
] as const satisfies readonly (keyof Settings)[];
export type KeyableSetting = (typeof KEYABLE_SETTINGS)[number];
export type WindKey = 'windSpeed' | 'windHeading';
export type SkyKey = KeyableSetting | WindKey;
export const SHAPE_KEYS = ['x', 'z', 'size', 'aspect', 'rotation', 'strength'] as const;
export type ShapeKey = (typeof SHAPE_KEYS)[number];

/** Settings whose change re-runs the atmosphere (sky cube and LUTs). */
const SKY_SETTINGS: readonly SkyKey[] = ['sunElevation', 'sunAzimuth', 'sunIntensity', 'haze', 'groundAlbedo'];
const ANGLES: readonly string[] = ['sunAzimuth', 'windHeading', 'rotation'];

export interface Keyframe {
  /** Clip time, seconds (> 0; frame 0 is the composed sky). */
  time: number;
  sky: Partial<Record<SkyKey, number>>;
  /** Per shape layer id. */
  shapes: Record<string, Partial<Record<ShapeKey, number>>>;
}

export interface Animation {
  /** Clip length, seconds. */
  duration: number;
  fps: number;
  /** Scene seconds per clip second. */
  timeLapse: number;
  /** km/h at frame 0 (keys can change it). */
  windSpeed: number;
  /** Compass heading the wind blows toward at frame 0, degrees (0 = north, 90 = east). */
  windHeading: number;
  /** Minutes for clouds to fully turn over; 0 freezes their shapes (they still drift). */
  cloudLife: number;
  /** smooth eases in and out of every key; linear moves at constant speed between keys. */
  ease: 'smooth' | 'linear';
  keys: Keyframe[];
}

export const DEFAULT_ANIMATION: Animation = {
  duration: 10,
  fps: 24,
  timeLapse: 120,
  windSpeed: 30,
  windHeading: 70,
  cloudLife: 30,
  ease: 'smooth',
  keys: [],
};

export function frameCount(a: Animation): number {
  return Math.max(1, Math.round(a.duration * a.fps));
}

/** Clip time of frame i, seconds. */
export function frameTime(a: Animation, i: number): number {
  return i / a.fps;
}

function wrapAngle(d: number): number {
  return ((d % 360) + 540) % 360 - 180;
}

/**
 * A property's value at time t: frame 0 holds `base`, keys that set the property add
 * points, values ease between neighbouring points and hold after the last one.
 */
function track(a: Animation, base: number, t: number, valueAt: (k: Keyframe) => number | undefined, angle: boolean): number {
  let t0 = 0;
  let v0 = base;
  for (const key of a.keys) {
    const v = valueAt(key);
    if (v === undefined) continue;
    if (key.time >= t) {
      const span = key.time - t0;
      let f = span > 0 ? (t - t0) / span : 1;
      if (a.ease === 'smooth') f = f * f * (3 - 2 * f);
      return angle ? wrapAngle(v0 + wrapAngle(v - v0) * f) : v0 + (v - v0) * f;
    }
    t0 = key.time;
    v0 = angle ? v0 + wrapAngle(v - v0) : v;
  }
  return angle ? wrapAngle(v0) : v0;
}

function windAt(a: Animation, t: number): [number, number] {
  const speed = track(a, a.windSpeed, t, (k) => k.sky.windSpeed, false);
  const heading = (track(a, a.windHeading, t, (k) => k.sky.windHeading, true) * Math.PI) / 180;
  // km/h -> km per clip second, toward the heading (+x east, +z north).
  const v = (speed * a.timeLapse) / 3600;
  return [v * Math.sin(heading), v * Math.cos(heading)];
}

/** Drift (km) the wind has carried the weather by time t: the integral of the wind. */
export function driftAt(a: Animation, t: number): [number, number] {
  if (t <= 0) return [0, 0];
  const keyed = a.keys.some((k) => k.sky.windSpeed !== undefined || k.sky.windHeading !== undefined);
  if (!keyed) {
    const [vx, vz] = windAt(a, 0);
    return [vx * t, vz * t];
  }
  // Simpson's rule on a fixed grid: deterministic and exact for piecewise cubics.
  const n = 256;
  const h = t / n;
  let x = 0;
  let z = 0;
  for (let i = 0; i <= n; i++) {
    const w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
    const [vx, vz] = windAt(a, i * h);
    x += w * vx;
    z += w * vz;
  }
  return [(x * h) / 3, (z * h) / 3];
}

/** The settings at clip time t (seconds). Pure: same inputs, same sky. */
export function settingsAt(base: Settings, a: Animation, t: number): Settings {
  const s: Settings = { ...base };
  for (const key of KEYABLE_SETTINGS) {
    if (a.keys.some((k) => k.sky[key] !== undefined)) {
      (s[key] as number) = track(a, base[key] as number, t, (k) => k.sky[key], ANGLES.includes(key));
    }
  }
  // The weather map is sampled at p + wind, so moving the content toward a heading means
  // subtracting the drift.
  const [dx, dz] = driftAt(a, t);
  s.windX = base.windX - dx;
  s.windZ = base.windZ - dz;
  // One shape period of vertical scroll per cloud life turns the clouds over completely.
  const sceneMinutes = (t * a.timeLapse) / 60;
  s.evolve = base.evolve + (a.cloudLife > 0 ? (sceneMinutes / a.cloudLife) * base.shapeScale : 0);
  return s;
}

/** The shape layers at clip time t: keyed position, size, rotation and strength. */
export function shapesAt(base: ShapeLayer[], a: Animation, t: number): ShapeLayer[] {
  return base.map((shape) => {
    if (!a.keys.some((k) => k.shapes[shape.id])) return { ...shape };
    const out: ShapeLayer = { ...shape };
    for (const prop of SHAPE_KEYS) {
      out[prop] = track(a, shape[prop], t, (k) => k.shapes[shape.id]?.[prop], ANGLES.includes(prop));
    }
    return out;
  });
}

/** What changing time re-runs: the atmosphere if a sky setting is keyed, the weather map if shapes or background are. */
export function timeInvalidation(a: Animation): 'sky' | 'weather' | 'clouds' {
  if (a.keys.some((k) => SKY_SETTINGS.some((key) => k.sky[key] !== undefined))) return 'sky';
  if (a.keys.some((k) => Object.keys(k.shapes).length > 0 || k.sky.baseWeather !== undefined)) return 'weather';
  return 'clouds';
}

/**
 * Records values at time t: into the key there (within half a frame) or a new key.
 * Returns a new animation; keys stay sorted by time.
 */
export function setKey(a: Animation, t: number, change: { sky?: Keyframe['sky']; shape?: { id: string; values: Keyframe['shapes'][string] } }): Animation {
  const keys = a.keys.map((k) => ({ time: k.time, sky: { ...k.sky }, shapes: Object.fromEntries(Object.entries(k.shapes).map(([id, v]) => [id, { ...v }])) }));
  let key = keys.find((k) => Math.abs(k.time - t) < 0.5 / a.fps);
  if (!key) {
    key = { time: t, sky: {}, shapes: {} };
    keys.push(key);
    keys.sort((x, y) => x.time - y.time);
  }
  Object.assign(key.sky, change.sky ?? {});
  if (change.shape) key.shapes[change.shape.id] = { ...key.shapes[change.shape.id], ...change.shape.values };
  return { ...a, keys };
}

export function removeKey(a: Animation, index: number): Animation {
  return { ...a, keys: a.keys.filter((_, i) => i !== index) };
}

/** Reads an untrusted animation block; missing or bad fields fall back to the defaults. */
export function parseAnimation(raw: unknown): Animation {
  const r = (raw ?? {}) as Partial<Record<keyof Animation | 'sunEnd', unknown>>;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const d = DEFAULT_ANIMATION;
  const duration = num(r.duration, d.duration, 0.1, 3600);
  const keys: Keyframe[] = [];
  const skyKeys: readonly string[] = [...KEYABLE_SETTINGS, 'windSpeed', 'windHeading'];
  if (Array.isArray(r.keys)) {
    for (const k of r.keys as unknown[]) {
      const key = k as { time?: unknown; sky?: Record<string, unknown>; shapes?: Record<string, Record<string, unknown>> };
      const time = num(key?.time, NaN, 0, 3600);
      if (!(time > 0)) continue;
      const sky: Keyframe['sky'] = {};
      for (const [name, v] of Object.entries(key.sky ?? {})) {
        if (skyKeys.includes(name) && typeof v === 'number' && Number.isFinite(v)) sky[name as SkyKey] = v;
      }
      const shapes: Keyframe['shapes'] = {};
      for (const [id, values] of Object.entries(key.shapes ?? {})) {
        const clean: Partial<Record<ShapeKey, number>> = {};
        for (const [name, v] of Object.entries(values ?? {})) {
          if ((SHAPE_KEYS as readonly string[]).includes(name) && typeof v === 'number' && Number.isFinite(v)) clean[name as ShapeKey] = v;
        }
        if (Object.keys(clean).length) shapes[id] = clean;
      }
      keys.push({ time, sky, shapes });
    }
  }
  // Version 1 files moved the sun with a single end position: that is a key at the end.
  const sun = r.sunEnd as { elevation?: unknown; azimuth?: unknown } | null | undefined;
  if (sun && typeof sun === 'object') {
    keys.push({ time: duration, sky: { sunElevation: num(sun.elevation, 0, -10, 90), sunAzimuth: num(sun.azimuth, 0, -180, 180) }, shapes: {} });
  }
  keys.sort((x, y) => x.time - y.time);
  return {
    duration,
    fps: num(r.fps, d.fps, 1, 120),
    timeLapse: num(r.timeLapse, d.timeLapse, 0, 100000),
    windSpeed: num(r.windSpeed, d.windSpeed, 0, 400),
    windHeading: num(r.windHeading, d.windHeading, -360, 360),
    cloudLife: num(r.cloudLife, d.cloudLife, 0, 10000),
    ease: r.ease === 'linear' ? 'linear' : 'smooth',
    keys,
  };
}

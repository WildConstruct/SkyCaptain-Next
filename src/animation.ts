// Animation: a recipe for how a sky changes over time. Time drives three things, all
// relative to the sky as composed (frame 0 is exactly the sky you see):
//   wind      the whole weather map (background, shapes, paint) drifts with the wind
//   evolution the cloud shape noise scrolls upward, so clouds grow and dissolve as they
//             go (Takram's "evolution"); cloud life is how long a full turnover takes
//   sun       optionally moves in a straight line to an end elevation and azimuth
// Animation time is scene time sped up by the time-lapse factor, so a 10 s clip at 120x
// covers 20 minutes of weather. Everything is a pure function of t, so any frame can be
// rendered on its own and comes out the same every time.

import type { Settings } from './settings';

export interface Animation {
  /** Clip length, seconds. */
  duration: number;
  fps: number;
  /** Scene seconds per clip second. */
  timeLapse: number;
  /** km/h. */
  windSpeed: number;
  /** Compass heading the wind blows toward, degrees (0 = north, 90 = east). */
  windHeading: number;
  /** Minutes for clouds to fully turn over; 0 freezes their shapes (they still drift). */
  cloudLife: number;
  /** Move the sun to these values by the end of the clip; null leaves it still. */
  sunEnd: { elevation: number; azimuth: number } | null;
}

export const DEFAULT_ANIMATION: Animation = {
  duration: 10,
  fps: 24,
  timeLapse: 120,
  windSpeed: 30,
  windHeading: 70,
  cloudLife: 30,
  sunEnd: null,
};

export function frameCount(a: Animation): number {
  return Math.max(1, Math.round(a.duration * a.fps));
}

/** Clip time of frame i, seconds. */
export function frameTime(a: Animation, i: number): number {
  return i / a.fps;
}

/** The settings at clip time t (seconds). Pure: same inputs, same sky. */
export function settingsAt(base: Settings, a: Animation, t: number): Settings {
  const sceneHours = (t * a.timeLapse) / 3600;
  const km = a.windSpeed * sceneHours;
  const heading = (a.windHeading * Math.PI) / 180;
  const s: Settings = {
    ...base,
    // The weather map is sampled at p + wind, so moving the content toward a heading means
    // subtracting along it. Map axes: +x east, +z north.
    windX: base.windX - km * Math.sin(heading),
    windZ: base.windZ - km * Math.cos(heading),
    // One shape period of vertical scroll per cloud life turns the clouds over completely.
    evolve: base.evolve + (a.cloudLife > 0 ? (sceneHours * 60 / a.cloudLife) * base.shapeScale : 0),
  };
  if (a.sunEnd && a.duration > 0) {
    const f = Math.min(1, Math.max(0, t / a.duration));
    s.sunElevation = base.sunElevation + (a.sunEnd.elevation - base.sunElevation) * f;
    // Shortest way round for azimuth.
    const d = ((a.sunEnd.azimuth - base.sunAzimuth + 540) % 360) - 180;
    s.sunAzimuth = ((base.sunAzimuth + d * f + 540) % 360) - 180;
  }
  return s;
}

/** Whether anything in the sky's atmosphere changes over the clip (the sky LUTs re-run). */
export function movesSun(a: Animation): boolean {
  return a.sunEnd !== null;
}

/** Reads an untrusted animation block; missing or bad fields fall back to the defaults. */
export function parseAnimation(raw: unknown): Animation {
  const r = (raw ?? {}) as Partial<Record<keyof Animation, unknown>>;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const d = DEFAULT_ANIMATION;
  const sun = r.sunEnd as { elevation?: unknown; azimuth?: unknown } | null | undefined;
  return {
    duration: num(r.duration, d.duration, 0.1, 3600),
    fps: num(r.fps, d.fps, 1, 120),
    timeLapse: num(r.timeLapse, d.timeLapse, 0, 100000),
    windSpeed: num(r.windSpeed, d.windSpeed, 0, 400),
    windHeading: num(r.windHeading, d.windHeading, -360, 360),
    cloudLife: num(r.cloudLife, d.cloudLife, 0, 10000),
    sunEnd: sun && typeof sun === 'object'
      ? { elevation: num(sun.elevation, 0, -10, 90), azimuth: num(sun.azimuth, 0, -180, 180) }
      : null,
  };
}

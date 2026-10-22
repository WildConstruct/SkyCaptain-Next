// The fixed-eye view: camera basis, projection, and mapping between view directions and
// weather-map positions on the cloud base. Must agree with display.wgsl and clouds.wgsl.

import type { Settings } from './settings';

export type Vec3 = [number, number, number];

const EARTH_RADIUS_KM = 6360;
const EYE_ALTITUDE_KM = 0.002;

export interface Basis {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  tanHalf: number;
}

export function basis(s: Settings): Basis {
  const yaw = (s.yaw * Math.PI) / 180;
  const pitch = (s.pitch * Math.PI) / 180;
  const f: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const r: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const u: Vec3 = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  return { right: r, up: u, forward: f, tanHalf: Math.tan((s.fov * Math.PI) / 360) };
}

export function viewUniforms(s: Settings, aspect: number): Float32Array<ArrayBuffer> {
  const b = basis(s);
  return new Float32Array([...b.right, b.tanHalf * aspect, ...b.up, b.tanHalf, ...b.forward, s.ev]);
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** View direction through a point in normalised device coordinates (-1..1, y up). */
export function rayDir(s: Settings, aspect: number, ndcX: number, ndcY: number): Vec3 {
  const b = basis(s);
  const sx = ndcX * b.tanHalf * aspect;
  const sy = ndcY * b.tanHalf;
  return normalize([
    b.forward[0] + sx * b.right[0] + sy * b.up[0],
    b.forward[1] + sx * b.right[1] + sy * b.up[1],
    b.forward[2] + sx * b.right[2] + sy * b.up[2],
  ]);
}

/** Normalised device coordinates of a direction, or null when it is behind the camera. */
export function project(s: Settings, aspect: number, dir: Vec3): [number, number] | null {
  const b = basis(s);
  const z = dot(dir, b.forward);
  if (z <= 1e-3) return null;
  return [dot(dir, b.right) / (z * b.tanHalf * aspect), dot(dir, b.up) / (z * b.tanHalf)];
}

/** Weather-map position (km) where a view direction meets the cloud base, or null below the horizon. */
export function mapPointFromDir(s: Settings, dir: Vec3): [number, number] | null {
  if (dir[1] <= 0.002) return null;
  const radius = EARTH_RADIUS_KM + s.cloudBottom;
  const oy = EARTH_RADIUS_KM + EYE_ALTITUDE_KM;
  const b = oy * dir[1];
  const t = -b + Math.sqrt(b * b - (oy * oy - radius * radius));
  // Weather is sampled at (world xz + wind), so map space is offset by the drift.
  return [dir[0] * t + s.windX, dir[2] * t + s.windZ];
}

/** View direction toward a weather-map position on the cloud base. */
export function dirFromMapPoint(s: Settings, x: number, z: number): Vec3 {
  const wx = x - s.windX;
  const wz = z - s.windZ;
  const radius = EARTH_RADIUS_KM + s.cloudBottom;
  const y = Math.sqrt(Math.max(0, radius * radius - wx * wx - wz * wz)) - (EARTH_RADIUS_KM + EYE_ALTITUDE_KM);
  return normalize([wx, y, wz]);
}

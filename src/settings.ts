export type QualityName = 'laptop' | 'desktop' | 'ultra' | 'reference';

export interface Quality {
  label: string;
  faceSize: number;
  viewSteps: number;
  lightSteps: number;
  samples: number;
}

// Budgets target an M1-class GPU first; bigger GPUs simply converge faster or run Ultra.
export const QUALITY: Record<QualityName, Quality> = {
  laptop: { label: 'Laptop (M1)', faceSize: 512, viewSteps: 160, lightSteps: 4, samples: 4 },
  desktop: { label: 'Desktop', faceSize: 768, viewSteps: 300, lightSteps: 5, samples: 6 },
  ultra: { label: 'Ultra', faceSize: 1024, viewSteps: 500, lightSteps: 6, samples: 8 },
  // Path-traced ground truth for judging the approximations (clouds.wgsl render_reference).
  reference: { label: 'Reference (path traced, slow)', faceSize: 256, viewSteps: 0, lightSteps: 0, samples: 256 },
};

export interface Settings {
  sunElevation: number;
  sunAzimuth: number;
  sunIntensity: number;
  haze: number;
  groundAlbedo: number;
  coverage: number;
  typeBias: number;
  density: number;
  erosion: number;
  cloudBottom: number;
  cloudThickness: number;
  towerHeight: number;
  shapeScale: number;
  detailScale: number;
  weatherScale: number;
  baseWeather: number;
  windX: number;
  windZ: number;
  ambient: number;
  forwardG: number;
  backG: number;
  backWeight: number;
  msA: number;
  msB: number;
  msC: number;
  octaves: number;
  powder: number;
  seed: number;
  /** Upward scroll of the cloud shape noise, km: clouds grow and dissolve as it rises (animation). */
  evolve: number;
  /** Eye height above the ground, km: from standing on the ground to above the clouds. */
  eyeAltitude: number;
  /** Lightning: strikes per minute from each storm-cell shape layer (0 = none). */
  lightning: number;
  /** Lightning brightness (1 = a return stroke as bright as nature's, against this sun). */
  lightningBrightness: number;
  /** Share of strikes that run cloud to ground (the rest stay inside the cloud). */
  lightningGround: number;
  lightningSeed: number;
  /** Scene time, seconds: the waves' clock (animation sets it; a still is time 0). */
  sceneTime: number;
  ev: number;
  /** Preview and clips only: film grain (noise floor) amount. */
  grain: number;
  /** Preview and clips only: analog softness, a blur radius in pixels. */
  softness: number;
  /** Preview and clips only: lens focus distance, m (0 = infinity: the scene in focus). */
  focusM: number;
  /** Preview and clips only: lens aperture, f-number. */
  fStop: number;
  /** Preview and clips only: veiling glare around bright light, 0..1. */
  bloom: number;
  /** Preview and clips only: film halation, a warm halo on highlights, 0..1. */
  halation: number;
  /** Preview and clips only: natural lens vignetting (cos^4), 0..1. */
  vignette: number;
  /** Preview and clips only: lateral chromatic aberration (fractional colour scale). */
  aberration: number;
  fov: number;
  yaw: number;
  pitch: number;
  quality: QualityName;
}

export const DEFAULTS: Settings = {
  sunElevation: 22,
  sunAzimuth: 35,
  sunIntensity: 20,
  haze: 30,
  groundAlbedo: 0.25,
  coverage: 0.25,
  typeBias: 0,
  density: 200,
  erosion: 1,
  cloudBottom: 1.5,
  cloudThickness: 3.5,
  towerHeight: 10,
  shapeScale: 3.3,
  detailScale: 0.17,
  weatherScale: 300,
  baseWeather: 1,
  windX: 0,
  windZ: 0,
  ambient: 1,
  forwardG: 0.7,
  backG: 0.2,
  backWeight: 0.5,
  msA: 0.5,
  msB: 0.5,
  msC: 0.5,
  octaves: 8,
  powder: 0.8,
  seed: 1,
  evolve: 0,
  eyeAltitude: 0,
  lightning: 0,
  lightningBrightness: 1,
  lightningGround: 0.35,
  lightningSeed: 1,
  sceneTime: 0,
  ev: 0,
  grain: 0,
  softness: 0,
  focusM: 0,
  fStop: 2.8,
  bloom: 0,
  halation: 0,
  vignette: 0,
  aberration: 0,
  fov: 80,
  yaw: 20,
  pitch: 18,
  quality: 'laptop',
};

// What an edit invalidates. Ordered from cheapest to most expensive.
export type Invalidation = 'view' | 'clouds' | 'weather' | 'sky';

const SKY_KEYS: (keyof Settings)[] = ['sunElevation', 'sunAzimuth', 'sunIntensity', 'haze', 'groundAlbedo', 'eyeAltitude'];
const WEATHER_KEYS: (keyof Settings)[] = ['seed', 'weatherScale', 'baseWeather'];
const VIEW_KEYS: (keyof Settings)[] = ['ev', 'fov', 'yaw', 'pitch', 'grain', 'softness', 'focusM', 'fStop', 'bloom', 'halation', 'vignette', 'aberration'];

export function invalidationFor(key: keyof Settings): Invalidation {
  if (SKY_KEYS.includes(key)) return 'sky';
  if (WEATHER_KEYS.includes(key)) return 'weather';
  if (VIEW_KEYS.includes(key)) return 'view';
  return 'clouds';
}

export function sunDirection(s: Settings): [number, number, number] {
  const el = (s.sunElevation * Math.PI) / 180;
  const az = (s.sunAzimuth * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}

const EARTH_RADIUS_KM = 6360;
const ATMOSPHERE_TOP_KM = 6460;
const SUN_ANGULAR_RADIUS = 0.00465;

export function packParams(s: Settings, frame: number, q: Quality = QUALITY[s.quality]): Float32Array<ArrayBuffer> {
  const sun = sunDirection(s);
  return new Float32Array([
    sun[0], sun[1], sun[2], s.sunIntensity,
    1, 1, 1, SUN_ANGULAR_RADIUS,
    s.cloudBottom, s.cloudBottom + Math.max(s.towerHeight, s.cloudThickness), EARTH_RADIUS_KM, ATMOSPHERE_TOP_KM,
    s.shapeScale, s.detailScale, s.weatherScale, s.cloudThickness,
    s.coverage, s.typeBias, s.density, s.erosion,
    s.ambient, s.forwardG, s.backG, s.backWeight,
    s.msA, s.msB, s.msC, s.powder,
    s.windX, s.windZ, 0, 0,
    q.viewSteps, q.lightSteps, q.faceSize, frame,
    s.haze, s.groundAlbedo, s.seed, s.octaves,
    s.evolve, s.eyeAltitude, 0, 0,
  ]);
}

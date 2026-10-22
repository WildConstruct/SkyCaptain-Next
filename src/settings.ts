export type QualityName = 'laptop' | 'desktop' | 'ultra';

export interface Quality {
  label: string;
  faceSize: number;
  viewSteps: number;
  lightSteps: number;
  samples: number;
}

// Budgets target an M1-class GPU first; bigger GPUs simply converge faster or run Ultra.
export const QUALITY: Record<QualityName, Quality> = {
  laptop: { label: 'Laptop (M1)', faceSize: 512, viewSteps: 64, lightSteps: 5, samples: 4 },
  desktop: { label: 'Desktop', faceSize: 768, viewSteps: 96, lightSteps: 6, samples: 6 },
  ultra: { label: 'Ultra', faceSize: 1024, viewSteps: 128, lightSteps: 6, samples: 8 },
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
  ev: number;
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
  groundAlbedo: 0.12,
  coverage: 0.55,
  typeBias: 0,
  density: 30,
  erosion: 0.4,
  cloudBottom: 1.5,
  cloudThickness: 3.5,
  towerHeight: 10,
  shapeScale: 9,
  detailScale: 1.2,
  weatherScale: 300,
  baseWeather: 1,
  windX: 0,
  windZ: 0,
  ambient: 1,
  forwardG: 0.8,
  backG: 0.3,
  backWeight: 0.25,
  msA: 0.5,
  msB: 0.5,
  msC: 0.5,
  octaves: 3,
  powder: 0.25,
  seed: 1,
  ev: 0,
  fov: 80,
  yaw: 20,
  pitch: 18,
  quality: 'laptop',
};

// What an edit invalidates. Ordered from cheapest to most expensive.
export type Invalidation = 'view' | 'clouds' | 'weather' | 'sky';

const SKY_KEYS: (keyof Settings)[] = ['sunElevation', 'sunAzimuth', 'sunIntensity', 'haze', 'groundAlbedo'];
const WEATHER_KEYS: (keyof Settings)[] = ['seed', 'weatherScale', 'baseWeather'];
const VIEW_KEYS: (keyof Settings)[] = ['ev', 'fov', 'yaw', 'pitch'];

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

export function packParams(s: Settings, frame: number): Float32Array<ArrayBuffer> {
  const q = QUALITY[s.quality];
  const sun = sunDirection(s);
  return new Float32Array([
    sun[0], sun[1], sun[2], s.sunIntensity,
    1, 1, 1, SUN_ANGULAR_RADIUS,
    s.cloudBottom, s.cloudBottom + Math.max(s.towerHeight, s.cloudThickness), EARTH_RADIUS_KM, ATMOSPHERE_TOP_KM,
    s.shapeScale, s.detailScale, s.weatherScale, s.cloudThickness,
    s.coverage, s.typeBias, s.density, s.erosion,
    s.ambient, s.forwardG, s.backG, s.backWeight,
    s.msA, s.msB, s.msC, s.powder,
    s.windX, s.windZ, s.windX * 1.6, s.windZ * 1.6,
    q.viewSteps, q.lightSteps, q.faceSize, frame,
    s.haze, s.groundAlbedo, s.seed, s.octaves,
  ]);
}

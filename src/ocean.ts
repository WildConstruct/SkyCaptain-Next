// Wind waves on open water: a spectral ocean (JONSWAP spectrum, three cascades, inverse
// FFT on the GPU; shaders/ocean.wgsl), ported from the ABYSSAL / natural-disasters ocean
// (MIT, (c) 2026 Davi (Token-Gremlin); see THIRD_PARTY_NOTICES.md). The eye is fixed and
// at least a couple of hundred metres from the water it looks at, so only the surface's
// slope (and its folding, for whitecaps) is solved, not displaced geometry. Here: the
// wave settings, the spectrum's parameters and the seeded noise.

export interface WaveSettings {
  /** Wind over the water, m/s: from glassy (1) to a gale (20+). */
  windMs: number;
  /** Compass heading the wind blows toward, degrees (0 = north, 90 = east). */
  headingDeg: number;
  /** Open water the wind blows across, km: small for a lake, hundreds for the sea. */
  fetchKm: number;
}

export const DEFAULT_WAVES: WaveSettings = { windMs: 6, headingDeg: 70, fetchKm: 40 };

/** FFT size per cascade (texels per side). */
export const OCEAN_N = 256;
/**
 * Tile size of each cascade, metres. Non-harmonic, so the three never beat into a
 * repeating pattern; the largest holds the spectral peak of a strong sea, the smallest
 * still resolves ripples a few hundred metres away.
 */
export const OCEAN_SCALES: [number, number, number] = [1013, 173, 29.7];

const GRAVITY = 9.80665;

/**
 * JONSWAP fetch relations (Hasselmann et al. 1973): alpha and the peak frequency, with the
 * fetch clamped at the fully developed (Pierson-Moskowitz) limit where they diverge.
 */
export function jonswapParams(windMs: number, fetchKm: number): { alpha: number; peakOmega: number } {
  const u = Math.max(windMs, 0.5);
  const fullyDeveloped = (2.2e4 * u * u) / GRAVITY;
  const fetch = Math.max(Math.min(fetchKm * 1000, fullyDeveloped), 400);
  return {
    alpha: 0.076 * Math.pow((u * u) / (fetch * GRAVITY), 0.22),
    peakOmega: Math.max(22 * Math.pow((GRAVITY * GRAVITY) / (u * fetch), 1 / 3), 0.3),
  };
}

/**
 * The ocean's uniform block (ocean.wgsl OceanParams): wind and spectrum, the three tile
 * sizes with their band limits, and the scene time.
 */
export function packOcean(w: WaveSettings, timeS: number): Float32Array<ArrayBuffer> {
  const { alpha, peakOmega } = jonswapParams(w.windMs, w.fetchKm);
  const heading = (w.headingDeg * Math.PI) / 180;
  // Compass heading to an angle in the xz plane (x east, z north).
  const angle = Math.atan2(Math.cos(heading), Math.sin(heading));
  // Hand a band to the next cascade down while its shortest wave still spans ~4 texels.
  const b1 = ((2 * Math.PI) / OCEAN_SCALES[1]) * 4;
  const b2 = ((2 * Math.PI) / OCEAN_SCALES[2]) * 4;
  return new Float32Array([
    OCEAN_N, timeS, angle, Math.max(w.windMs, 0.5),
    alpha, peakOmega, 3.3, 0.0065,
    ...OCEAN_SCALES, 100,
    b1, b2, 1.0, 0,
  ]);
}

/** Two standard normal values per texel and cascade (Box-Muller over xorshift32): fixed, so waves never change between runs. */
export function oceanNoise(seed = 0xc0ffee): Float32Array<ArrayBuffer> {
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 8) / 16777216;
  };
  const out = new Float32Array(3 * OCEAN_N * OCEAN_N * 2);
  for (let i = 0; i < out.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-7)));
    const a = 2 * Math.PI * rnd();
    out[i] = r * Math.cos(a);
    out[i + 1] = r * Math.sin(a);
  }
  return out;
}

/** Reads untrusted wave settings; missing or bad fields fall back to the defaults. */
export function parseWaves(raw: unknown): WaveSettings {
  const r = (raw ?? {}) as Partial<Record<keyof WaveSettings, unknown>>;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    windMs: num(r.windMs, DEFAULT_WAVES.windMs, 0, 40),
    headingDeg: num(r.headingDeg, DEFAULT_WAVES.headingDeg, -360, 360),
    fetchKm: num(r.fetchKm, DEFAULT_WAVES.fetchKm, 0.5, 2000),
  };
}

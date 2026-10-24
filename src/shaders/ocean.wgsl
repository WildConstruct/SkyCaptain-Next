// Spectral ocean slope field: JONSWAP spectrum with Donelan-Banner style spreading, evolved
// in time and brought to space by an inverse FFT, three cascades. Ported from the ABYSSAL /
// natural-disasters ocean (MIT, (c) 2026 Davi (Token-Gremlin); src/ocean/OceanFFT.js) and
// cut down to what a fixed eye needs: slope and folding, no displaced geometry.
//
// Passes (renderer.ts updateOcean): spectrum -> fft_rows -> fft_cols -> pack -> mips.
// Per cascade the spectrum pass writes three complex fields, each packing two real fields
// as f + i*g (valid because both spectra are Hermitian):
//   A = dh/dx + i dh/dz      (slopes)
//   B = dDx/dx + i dDz/dz    (horizontal displacement derivatives, for folding)
//   C = dDx/dz               (the cross term)
// pack writes per texel (slope x, slope z, slope x^2 + z^2, Jacobian); the mip chain then
// averages it, so at any level E[s^2] - |E[s]|^2 is the slope variance the texel hides,
// which the water shader turns into roughness (LEAN-style).

struct OceanParams {
  wind: vec4f,      // N, time (s), wind angle (rad, xz plane), wind speed (m/s)
  spectrum: vec4f,  // JONSWAP alpha, peak omega, gamma, short-wave fade (m)
  scales: vec4f,    // tile size of cascades 0..2 (m), depth (m)
  bands: vec4f,     // band edge 0|1, band edge 1|2 (rad/m), choppiness, unused
}

@group(0) @binding(0) var<uniform> ocean: OceanParams;
@group(0) @binding(1) var<storage, read> noise: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> fields: array<vec2f>;
@group(0) @binding(3) var slope_out: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var mip_src: texture_2d_array<f32>;
@group(0) @binding(5) var mip_dst: texture_storage_2d_array<rgba16float, write>;

const OCEAN_PI: f32 = 3.14159265358979;
const G: f32 = 9.80665;
const FFT_N: u32 = 256u;

fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

fn omega_of(k: f32) -> f32 { return sqrt(G * k * tanh(min(k * ocean.scales.w, 20.0))); }

fn domega_dk(k: f32) -> f32 {
  let d = ocean.scales.w;
  let th = tanh(min(k * d, 20.0));
  let ch = cosh(min(k * d, 20.0));
  return G * (d * k / (ch * ch) + th) / max(2.0 * sqrt(G * k * th), 1e-9);
}

fn norm_factor(s: f32) -> f32 {
  let s2 = s * s; let s3 = s2 * s; let s4 = s3 * s;
  if (s < 5.0) { return -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163; }
  return -4.80e-8 * s4 + 1.07e-5 * s3 - 9.53e-4 * s2 + 5.90e-2 * s + 3.93e-1;
}

fn spread_power(w: f32, peak: f32) -> f32 {
  if (w > peak) { return 9.77 * pow(max(w / peak, 1e-5), -2.5); }
  return 6.97 * pow(max(w / peak, 1e-5), 5.0);
}

fn jonswap(w: f32) -> f32 {
  let alpha = ocean.spectrum.x;
  let peak = ocean.spectrum.y;
  let gamma = ocean.spectrum.z;
  let sigma = select(0.09, 0.07, w <= peak);
  let r = exp(-(w - peak) * (w - peak) / (2.0 * sigma * sigma * peak * peak));
  let inv = 1.0 / max(w, 1e-5);
  return alpha * G * G * inv * inv * inv * inv * inv * exp(-1.25 * pow(peak * inv, 4.0)) * pow(gamma, r);
}

// Energy density at wavevector k (rad/m) in a cascade's band.
fn spectrum_at(k: vec2f, band: vec2f) -> f32 {
  let kl = length(k);
  if (kl < max(band.x, 1e-6) || kl > band.y) { return 0.0; }
  let w = omega_of(kl);
  let theta = atan2(k.y, k.x) - ocean.wind.z;
  let s = spread_power(w, ocean.spectrum.y);
  let spread = norm_factor(s) * pow(max(abs(cos(0.5 * theta)), 1e-5), 2.0 * s);
  let fade = exp(-ocean.spectrum.w * ocean.spectrum.w * kl * kl);
  return jonswap(w) * spread * fade * abs(domega_dk(kl)) / kl;
}

fn cascade_band(c: u32) -> vec2f {
  if (c == 0u) { return vec2f(1e-4, ocean.bands.x); }
  if (c == 1u) { return vec2f(ocean.bands.x, ocean.bands.y); }
  return vec2f(ocean.bands.y, 9999.0);
}

fn cascade_scale(c: u32) -> f32 {
  if (c == 0u) { return ocean.scales.x; }
  if (c == 1u) { return ocean.scales.y; }
  return ocean.scales.z;
}

// Field f of cascade c at texel (x, y).
fn field_index(c: u32, f: u32, x: u32, y: u32) -> u32 {
  return ((c * 3u + f) * FFT_N + y) * FFT_N + x;
}

@compute @workgroup_size(8, 8, 1)
fn spectrum(@builtin(global_invocation_id) id: vec3u) {
  let n = FFT_N;
  if (id.x >= n || id.y >= n) { return; }
  let c = id.z;
  let dk = 2.0 * OCEAN_PI / cascade_scale(c);
  // Standard FFT ordering: index i is wavenumber i below n/2 and i - n above.
  let sx = select(i32(id.x), i32(id.x) - i32(n), id.x >= n / 2u);
  let sy = select(i32(id.y), i32(id.y) - i32(n), id.y >= n / 2u);
  let k = vec2f(f32(sx), f32(sy)) * dk;
  let mx = (n - id.x) % n;
  let my = (n - id.y) % n;
  let band = cascade_band(c);
  // skyCaptain: amplitudes so the surface's variance is the spectrum's integral: the noise
  // has unit variance per component (E|xi|^2 = 2) and h(k) sums h0(k) and h0(-k)*, so
  // E|h0|^2 = S dk^2 / 2 needs amplitude sqrt(S dk^2 / 4). (Upstream used sqrt(2 S dk^2),
  // 8x the variance: slopes 2.8x too steep against Cox-Munk.)
  let amp_k = sqrt(0.25 * spectrum_at(k, band) * dk * dk);
  let amp_mk = sqrt(0.25 * spectrum_at(-k, band) * dk * dk);
  let h0 = noise[(c * n + id.y) * n + id.x] * amp_k;
  let h0m = noise[(c * n + my) * n + mx] * amp_mk;
  let kl = max(length(k), 1e-6);
  let phase = omega_of(kl) * ocean.wind.y;
  let e = vec2f(cos(phase), sin(phase));
  // h(k, t) = h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t}
  let h = cmul(h0, e) + cmul(vec2f(h0m.x, -h0m.y), vec2f(e.x, -e.y));
  let ih = vec2f(-h.y, h.x);
  let dydx = ih * k.x;
  let dydz = ih * k.y;
  let dxdx = -h * k.x * k.x / kl;
  let dzdz = -h * k.y * k.y / kl;
  let dxdz = -h * k.x * k.y / kl;
  fields[field_index(c, 0u, id.x, id.y)] = vec2f(dydx.x - dydz.y, dydx.y + dydz.x);
  fields[field_index(c, 1u, id.x, id.y)] = vec2f(dxdx.x - dzdz.y, dxdx.y + dzdz.x);
  fields[field_index(c, 2u, id.x, id.y)] = dxdz;
}

// Inverse FFT of one row or column per workgroup: radix-2 Stockham (autosorting) in
// workgroup memory, 128 threads x 2 elements. buffer halves [0, N) and [N, 2N) ping-pong.
var<workgroup> line: array<vec2f, 512>;

fn fft_line(j: u32) -> u32 {
  var src = 0u;
  var dst = FFT_N;
  for (var ns = 1u; ns < FFT_N; ns *= 2u) {
    let v0 = line[src + j];
    let v1 = line[src + j + FFT_N / 2u];
    let k = j % ns;
    let angle = OCEAN_PI * f32(k) / f32(ns);
    let t = cmul(vec2f(cos(angle), sin(angle)), v1);
    let d = (j / ns) * ns * 2u + k;
    line[dst + d] = v0 + t;
    line[dst + d + ns] = v0 - t;
    workgroupBarrier();
    let swap = src;
    src = dst;
    dst = swap;
  }
  return src;
}

@compute @workgroup_size(128)
fn fft_rows(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let j = lid.x;
  let base = (wid.y * FFT_N + wid.x) * FFT_N;
  line[j] = fields[base + j];
  line[j + 128u] = fields[base + j + 128u];
  workgroupBarrier();
  let src = fft_line(j);
  fields[base + j] = line[src + j];
  fields[base + j + 128u] = line[src + j + 128u];
}

@compute @workgroup_size(128)
fn fft_cols(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let j = lid.x;
  let base = wid.y * FFT_N * FFT_N + wid.x;
  line[j] = fields[base + j * FFT_N];
  line[j + 128u] = fields[base + (j + 128u) * FFT_N];
  workgroupBarrier();
  let src = fft_line(j);
  fields[base + j * FFT_N] = line[src + j];
  fields[base + (j + 128u) * FFT_N] = line[src + j + 128u];
}

@compute @workgroup_size(8, 8, 1)
fn pack(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= FFT_N || id.y >= FFT_N) { return; }
  let c = id.z;
  let a = fields[field_index(c, 0u, id.x, id.y)];
  let b = fields[field_index(c, 1u, id.x, id.y)];
  let cross = fields[field_index(c, 2u, id.x, id.y)].x;
  let lambda = ocean.bands.z;
  let jx = 1.0 + lambda * b.x;
  let jz = 1.0 + lambda * b.y;
  // Choppy waves: the slope of the displaced surface, sharper at crests. skyCaptain: the
  // division is held to 2x so folding crests do not throw slopes to infinity.
  let slope = vec2f(a.x / max(jx, 0.5), a.y / max(jz, 0.5));
  let jacobian = jx * jz - lambda * lambda * cross * cross;
  textureStore(slope_out, id.xy, c, vec4f(slope, dot(slope, slope), jacobian));
}

// One mip level down: the mean of 2x2 texels (slope, squared slope and folding average).
@compute @workgroup_size(8, 8, 1)
fn mips(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(mip_dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy) * 2;
  let sum = textureLoad(mip_src, p, id.z, 0) + textureLoad(mip_src, p + vec2i(1, 0), id.z, 0)
    + textureLoad(mip_src, p + vec2i(0, 1), id.z, 0) + textureLoad(mip_src, p + vec2i(1, 1), id.z, 0);
  textureStore(mip_dst, id.xy, id.z, sum * 0.25);
}

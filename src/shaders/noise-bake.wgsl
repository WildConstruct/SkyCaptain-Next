// Bake entry points for the tileable noise volumes.
//
// Ported from Takram three-geospatial clouds (MIT, (c) 2024 Shota Matsuda):
// cloudShape.frag, cloudShapeDetail.frag, turbulence.frag, tileableNoise.glsl and
// perlin.glsl. Those are in turn based on Sebastien Hillaire's TileableVolumeNoise (MIT,
// (c) 2017) and Stefan Gustavson's periodic Perlin noise (MIT). Kept numerically faithful,
// quirks included (squared Worley distance, one scalar offset per feature point), so our
// clouds can be compared against theirs. See docs/takram-port.md.
//
// shape.r  = Perlin-Worley eroded by Worley fBm (Takram's cloud shape)
// shape.gba = curl-noise turbulence, constant along z so any slice is the 2D field
// detail.r = Worley fBm (Takram's shape detail)

@group(0) @binding(0) var shape_out: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var detail_out: texture_storage_3d<rgba8unorm, write>;

fn gl_mod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn gl_mod3(x: vec3f, y: f32) -> vec3f { return x - y * floor(x / y); }
fn gl_mod4(x: vec4f, y: vec4f) -> vec4f { return x - y * floor(x / y); }

// tileableNoise.glsl
fn tn_hash(n: f32) -> f32 { return fract(sin(n + 1.951) * 43758.5453); }

fn tn_noise(x: vec3f) -> f32 {
  let p = floor(x);
  let f0 = fract(x);
  let f = f0 * f0 * (3.0 - 2.0 * f0);
  let n = p.x + p.y * 57.0 + 113.0 * p.z;
  return mix(
    mix(mix(tn_hash(n + 0.0), tn_hash(n + 1.0), f.x), mix(tn_hash(n + 57.0), tn_hash(n + 58.0), f.x), f.y),
    mix(mix(tn_hash(n + 113.0), tn_hash(n + 114.0), f.x), mix(tn_hash(n + 170.0), tn_hash(n + 171.0), f.x), f.y),
    f.z);
}

// Squared distance to the nearest feature point, clamped to [0, 1].
fn tn_worley(p: vec3f, cell_count: f32) -> f32 {
  let cell = p * cell_count;
  var d = 1.0e10;
  for (var x = -1; x <= 1; x++) {
    for (var y = -1; y <= 1; y++) {
      for (var z = -1; z <= 1; z++) {
        var tp = floor(cell) + vec3f(f32(x), f32(y), f32(z));
        tp = cell - tp - tn_noise(gl_mod3(tp, cell_count));
        d = min(d, dot(tp, tp));
      }
    }
  }
  return clamp(d, 0.0, 1.0);
}

// perlin.glsl: Gustavson's periodic 4D classic Perlin noise.
fn mod289(x: vec4f) -> vec4f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute(v: vec4f) -> vec4f { return mod289((v * 34.0 + 1.0) * v); }
fn taylor_inv_sqrt(r: vec4f) -> vec4f { return 1.79284291400159 - 0.85373472095314 * r; }
fn fade4(v: vec4f) -> vec4f { return v * v * v * (v * (v * 6.0 - 15.0) + 10.0); }

struct Grad4 { x: vec4f, y: vec4f, z: vec4f, w: vec4f }

fn grad4(ixy: vec4f) -> Grad4 {
  var g: Grad4;
  var gx = ixy / 7.0;
  var gy = floor(gx) / 7.0;
  var gz = floor(gy) / 6.0;
  gx = fract(gx) - 0.5;
  gy = fract(gy) - 0.5;
  gz = fract(gz) - 0.5;
  let gw = vec4f(0.75) - abs(gx) - abs(gy) - abs(gz);
  let sw = step(gw, vec4f(0.0));
  gx -= sw * (step(vec4f(0.0), gx) - 0.5);
  gy -= sw * (step(vec4f(0.0), gy) - 0.5);
  g.x = gx; g.y = gy; g.z = gz; g.w = gw;
  return g;
}

fn g_at(g: Grad4, i: u32) -> vec4f { return vec4f(g.x[i], g.y[i], g.z[i], g.w[i]); }

fn normed(a: vec4f, b: vec4f, c: vec4f, d: vec4f) -> array<vec4f, 4> {
  let n = taylor_inv_sqrt(vec4f(dot(a, a), dot(b, b), dot(c, c), dot(d, d)));
  return array<vec4f, 4>(a * n.x, b * n.y, c * n.z, d * n.w);
}

fn perlin4(position: vec4f, rep: vec4f) -> f32 {
  let pi0 = gl_mod4(floor(position), rep);
  let pi1 = gl_mod4(pi0 + 1.0, rep);
  let pf0 = fract(position);
  let pf1 = pf0 - 1.0;
  let ix = vec4f(pi0.x, pi1.x, pi0.x, pi1.x);
  let iy = vec4f(pi0.y, pi0.y, pi1.y, pi1.y);
  let ixy = permute(permute(ix) + iy);
  let ixy0 = permute(ixy + vec4f(pi0.z));
  let ixy1 = permute(ixy + vec4f(pi1.z));
  let g00 = grad4(permute(ixy0 + vec4f(pi0.w)));
  let g01 = grad4(permute(ixy0 + vec4f(pi1.w)));
  let g10 = grad4(permute(ixy1 + vec4f(pi0.w)));
  let g11 = grad4(permute(ixy1 + vec4f(pi1.w)));

  // Same component order and normalisation grouping as the GLSL original.
  let a = normed(g_at(g00, 0u), g_at(g00, 2u), g_at(g00, 1u), g_at(g00, 3u)); // 0000 0100 1000 1100
  let b = normed(g_at(g01, 0u), g_at(g01, 2u), g_at(g01, 1u), g_at(g01, 3u)); // 0001 0101 1001 1101
  let c = normed(g_at(g10, 0u), g_at(g10, 2u), g_at(g10, 1u), g_at(g10, 3u)); // 0010 0110 1010 1110
  let d = normed(g_at(g11, 0u), g_at(g11, 2u), g_at(g11, 1u), g_at(g11, 3u)); // 0011 0111 1011 1111

  let n0000 = dot(a[0], pf0);
  let n1000 = dot(a[2], vec4f(pf1.x, pf0.y, pf0.z, pf0.w));
  let n0100 = dot(a[1], vec4f(pf0.x, pf1.y, pf0.z, pf0.w));
  let n1100 = dot(a[3], vec4f(pf1.x, pf1.y, pf0.z, pf0.w));
  let n0010 = dot(c[0], vec4f(pf0.x, pf0.y, pf1.z, pf0.w));
  let n1010 = dot(c[2], vec4f(pf1.x, pf0.y, pf1.z, pf0.w));
  let n0110 = dot(c[1], vec4f(pf0.x, pf1.y, pf1.z, pf0.w));
  let n1110 = dot(c[3], vec4f(pf1.x, pf1.y, pf1.z, pf0.w));
  let n0001 = dot(b[0], vec4f(pf0.x, pf0.y, pf0.z, pf1.w));
  let n1001 = dot(b[2], vec4f(pf1.x, pf0.y, pf0.z, pf1.w));
  let n0101 = dot(b[1], vec4f(pf0.x, pf1.y, pf0.z, pf1.w));
  let n1101 = dot(b[3], vec4f(pf1.x, pf1.y, pf0.z, pf1.w));
  let n0011 = dot(d[0], vec4f(pf0.x, pf0.y, pf1.z, pf1.w));
  let n1011 = dot(d[2], vec4f(pf1.x, pf0.y, pf1.z, pf1.w));
  let n0111 = dot(d[1], vec4f(pf0.x, pf1.y, pf1.z, pf1.w));
  let n1111 = dot(d[3], pf1);

  let fxyzw = fade4(pf0);
  let n_0w = mix(vec4f(n0000, n1000, n0100, n1100), vec4f(n0001, n1001, n0101, n1101), fxyzw.w);
  let n_1w = mix(vec4f(n0010, n1010, n0110, n1110), vec4f(n0011, n1011, n0111, n1111), fxyzw.w);
  let n_zw = mix(n_0w, n_1w, fxyzw.z);
  let n_yzw = mix(n_zw.xy, n_zw.zw, fxyzw.y);
  return 2.2 * mix(n_yzw.x, n_yzw.y, fxyzw.x);
}

fn tn_perlin(point: vec3f, frequency: vec3f, octave_count: i32) -> f32 {
  var sum = 0.0;
  var weight_sum = 0.0;
  var weight = 1.0;
  var freq = frequency;
  for (var i = 0; i < octave_count; i++) {
    let p = vec4f(point * freq, 0.0);
    sum += perlin4(p, vec4f(freq, 1.0)) * weight;
    weight_sum += weight;
    weight *= 0.5;
    freq *= 2.0;
  }
  return sum / weight_sum; // Intentionally not clamped (as upstream).
}

fn takram_remap(x: f32, a: f32, b: f32) -> f32 { return (x - a) / (b - a); }

// cloudShape.frag
fn perlin_worley(point: vec3f) -> f32 {
  let perlin = clamp(tn_perlin(point, vec3f(8.0), 3), 0.0, 1.0);
  let noise = vec3f(1.0 - tn_worley(point, 8.0), 1.0 - tn_worley(point, 32.0), 1.0 - tn_worley(point, 56.0));
  let fbm = dot(noise, vec3f(0.625, 0.25, 0.125));
  return fbm + perlin * (1.0 - fbm); // remap(perlin, 0, 1, fbm, 1)
}

fn worley_fbm4(point: vec3f, cell_count: f32) -> f32 {
  let noise = vec4f(
    1.0 - tn_worley(point, cell_count * 2.0),
    1.0 - tn_worley(point, cell_count * 4.0),
    1.0 - tn_worley(point, cell_count * 8.0),
    1.0 - tn_worley(point, cell_count * 16.0));
  let fbm = vec3f(
    dot(noise.xyz, vec3f(0.625, 0.25, 0.125)),
    dot(noise.yzw, vec3f(0.625, 0.25, 0.125)),
    dot(noise.zw, vec2f(0.75, 0.25)));
  return dot(fbm, vec3f(0.625, 0.25, 0.125));
}

// turbulence.frag
fn perlin3d(p: vec3f) -> vec3f {
  return vec3f(
    tn_perlin(p, vec3f(12.0), 3),
    tn_perlin(p.yzx + vec3f(-19.1, 33.4, 47.2), vec3f(12.0), 3),
    tn_perlin(p.zxy + vec3f(74.2, -124.5, 99.4), vec3f(12.0), 3));
}

fn curl(p: vec3f) -> vec3f {
  let delta = 0.1;
  let dx = vec3f(delta, 0.0, 0.0);
  let dy = vec3f(0.0, delta, 0.0);
  let dz = vec3f(0.0, 0.0, delta);
  let px0 = perlin3d(p - dx);
  let px1 = perlin3d(p + dx);
  let py0 = perlin3d(p - dy);
  let py1 = perlin3d(p + dy);
  let pz0 = perlin3d(p - dz);
  let pz1 = perlin3d(p + dz);
  let x = py1.z - py0.z - pz1.y + pz0.y;
  let y = pz1.x - pz0.x - px1.z + px0.z;
  let z = px1.y - px0.y - py1.x + py0.x;
  return normalize(vec3f(x, y, z) / (2.0 * delta));
}

@compute @workgroup_size(4, 4, 4)
fn bake_shape(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(shape_out);
  if (any(id >= size)) { return; }
  let point = (vec3f(id) + 0.5) / vec3f(size);
  let shape = takram_remap(perlin_worley(point), worley_fbm4(point, 4.0) - 1.0, 1.0);
  let turbulence = 0.5 * curl(vec3f(point.xy, 0.0)) + 0.5;
  textureStore(shape_out, id, vec4f(shape, turbulence));
}

@compute @workgroup_size(4, 4, 4)
fn bake_detail(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(detail_out);
  if (any(id >= size)) { return; }
  let point = (vec3f(id) + 0.5) / vec3f(size);
  textureStore(detail_out, id, vec4f(worley_fbm4(point, 1.0), 0.0, 0.0, 1.0));
}

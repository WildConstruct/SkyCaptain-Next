// One-time bake of tileable 3D noise. Never evaluated per march step.
// shape: r = Perlin-Worley, gba = Worley fBm at increasing frequency.
// detail: rgb = Worley fBm at increasing frequency.

fn wrap3(c: vec3i, period: i32) -> vec3u {
  return vec3u(((c % period) + period) % period);
}

fn gradient(c: vec3i, period: i32) -> vec3f {
  return normalize(hash33(wrap3(c, period) + vec3u(17u, 59u, 83u)) * 2.0 - 1.0);
}

fn fade3(t: vec3f) -> vec3f {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// Tileable gradient noise in [-1, 1] (approximately). p is in lattice units.
fn perlin(p: vec3f, period: i32) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = fade3(f);
  var result = 0.0;
  let n000 = dot(gradient(i + vec3i(0, 0, 0), period), f - vec3f(0, 0, 0));
  let n100 = dot(gradient(i + vec3i(1, 0, 0), period), f - vec3f(1, 0, 0));
  let n010 = dot(gradient(i + vec3i(0, 1, 0), period), f - vec3f(0, 1, 0));
  let n110 = dot(gradient(i + vec3i(1, 1, 0), period), f - vec3f(1, 1, 0));
  let n001 = dot(gradient(i + vec3i(0, 0, 1), period), f - vec3f(0, 0, 1));
  let n101 = dot(gradient(i + vec3i(1, 0, 1), period), f - vec3f(1, 0, 1));
  let n011 = dot(gradient(i + vec3i(0, 1, 1), period), f - vec3f(0, 1, 1));
  let n111 = dot(gradient(i + vec3i(1, 1, 1), period), f - vec3f(1, 1, 1));
  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

// Inverted tileable Worley noise in [0, 1]: 1 at feature points.
fn worley(p: vec3f, period: i32) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  var d = 1e9;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let o = vec3i(x, y, z);
        let feature = hash33(wrap3(i + o, period)) + vec3f(o);
        let delta = feature - f;
        d = min(d, dot(delta, delta));
      }
    }
  }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}

fn worley_fbm(uvw: vec3f, freq: i32) -> f32 {
  return worley(uvw * f32(freq), freq) * 0.625
       + worley(uvw * f32(freq * 2), freq * 2) * 0.25
       + worley(uvw * f32(freq * 4), freq * 4) * 0.125;
}

fn perlin_fbm(uvw: vec3f, freq: i32, octaves: i32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var fq = freq;
  for (var o = 0; o < octaves; o++) {
    sum += perlin(uvw * f32(fq), fq) * amp;
    norm += amp;
    amp *= 0.5;
    fq *= 2;
  }
  return sum / norm;
}

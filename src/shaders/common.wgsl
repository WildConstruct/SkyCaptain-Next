// Shared parameter block. All distances are kilometres, radiance is scene-linear.
struct Params {
  sun_dir: vec4f,     // xyz unit vector toward the sun, w = sun illuminance
  sun_color: vec4f,   // rgb tint, w = sun angular radius (radians)
  layer: vec4f,       // cloud base altitude, highest tower top altitude, planet radius, atmosphere top radius
  scale: vec4f,       // shape period, detail period, weather map extent, cumulus height
  cloud: vec4f,       // coverage, type bias, density (extinction per km), detail erosion
  light: vec4f,       // ambient strength, forward g, back g, back lobe weight
  ms: vec4f,          // octave a (scatter), b (extinction), c (eccentricity), powder
  wind: vec4f,        // weather offset xz (km): shape and detail ride with it; zw unused
  march: vec4f,       // max view steps, light steps, cube face size, frame index
  misc: vec4f,        // haze distance, ground albedo, weather seed, scattering octave count
  anim: vec4f,        // x = evolution: upward scroll of the shape noise (km), y = eye altitude (km); zw unused
}

const PI: f32 = 3.14159265358979;

fn remap(v: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
  return c + (v - a) * (d - c) / max(b - a, 1e-5);
}

// pcg3d: integer hash, good enough statistics for noise lattices and jitter.
fn pcg3d(v_in: vec3u) -> vec3u {
  var v = v_in * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

fn hash33(v: vec3u) -> vec3f {
  return vec3f(pcg3d(v)) * (1.0 / 4294967295.0);
}

// Cube face convention matches WebGPU/GL cube sampling: faces +X,-X,+Y,-Y,+Z,-Z.
fn cube_dir(face: u32, uv: vec2f) -> vec3f {
  let u = uv.x * 2.0 - 1.0;
  let v = uv.y * 2.0 - 1.0;
  switch face {
    case 0u: { return normalize(vec3f(1.0, -v, -u)); }
    case 1u: { return normalize(vec3f(-1.0, -v, u)); }
    case 2u: { return normalize(vec3f(u, 1.0, v)); }
    case 3u: { return normalize(vec3f(u, -1.0, -v)); }
    case 4u: { return normalize(vec3f(u, -v, 1.0)); }
    default: { return normalize(vec3f(-u, -v, -1.0)); }
  }
}

// Returns (near, far) distances to a sphere centred at the origin, or (-1,-1) on a miss.
fn ray_sphere(origin: vec3f, dir: vec3f, radius: f32) -> vec2f {
  let b = dot(origin, dir);
  let c = dot(origin, origin) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) { return vec2f(-1.0); }
  let s = sqrt(disc);
  return vec2f(-b - s, -b + s);
}

fn henyey_greenstein(cos_theta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = max(1.0 + g2 - 2.0 * g * cos_theta, 1e-4);
  return (1.0 - g2) / (4.0 * PI * denom * sqrt(denom));
}

// The eye sits above the ground at the origin: 2 m by default, raised by the Elevation
// setting (params.anim.y). Shaders that have params pass eye_altitude(params.anim.y); radii
// are arguments because this prelude is shared by modules without params.
fn eye_altitude(setting: f32) -> f32 { return max(setting, 0.002); }

// Distance along dir from an eye at radius eye_r to the ground, or -1 when it misses.
fn ground_hit(eye_r: f32, dir: vec3f, ground_r: f32) -> f32 {
  let hit = ray_sphere(vec3f(0.0, eye_r, 0.0), dir, ground_r);
  return select(-1.0, hit.x, hit.x > 0.0);
}

// The ground seen along dir from the eye (eye_alt up): transmittance-LUT uvs for the air
// between the eye and the ground point, as the ratio of two upward rays (LUT: x = mu * 0.5
// + 0.5, y = height fraction). xy = at the ground point, zw = at the eye; x < 0 when dir
// misses the ground.
fn ground_air_uvs(dir: vec3f, ground_r: f32, top_r: f32, eye_alt: f32) -> vec4f {
  let origin = vec3f(0.0, ground_r + eye_alt, 0.0);
  let t = ground_hit(ground_r + eye_alt, dir, ground_r);
  if (t <= 0.0) { return vec4f(-1.0); }
  let up = -dir;
  let g = origin + dir * t;
  return vec4f(
    dot(normalize(g), up) * 0.5 + 0.5, 0.0,
    up.y * 0.5 + 0.5, clamp(eye_alt / (top_r - ground_r), 0.0, 1.0));
}

// Hillaire 2020 style atmosphere: transmittance LUT, multiple-scattering LUT, and a
// sky radiance cube that is recomputed only when the sun or atmosphere changes.
// Units: km and per-km coefficients. Output radiance is scene-linear.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var lut_sampler: sampler;
@group(0) @binding(2) var transmittance_lut: texture_2d<f32>;
@group(0) @binding(3) var ms_lut: texture_2d<f32>;
@group(0) @binding(4) var out2d: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var out_cube: texture_storage_2d_array<rgba16float, write>;

const RAYLEIGH_SCATTER = vec3f(5.802e-3, 13.558e-3, 33.1e-3);
const RAYLEIGH_H = 8.0;
const MIE_SCATTER = 3.996e-3;
const MIE_ABSORB = 4.40e-3;
const MIE_H = 1.2;
const MIE_G = 0.8;
const OZONE_ABSORB = vec3f(0.650e-3, 1.881e-3, 0.085e-3);

fn ground_radius() -> f32 { return params.layer.z; }
fn top_radius() -> f32 { return params.layer.w; }

struct Medium {
  rayleigh: vec3f,
  mie: f32,
  extinction: vec3f,
}

fn medium_at(altitude: f32) -> Medium {
  let haze = 1.0 / max(params.misc.x, 1.0) * 30.0; // haze slider scales aerosol density
  let r_density = exp(-altitude / RAYLEIGH_H);
  let m_density = exp(-altitude / MIE_H) * haze;
  let o_density = max(0.0, 1.0 - abs(altitude - 25.0) / 15.0);
  var m: Medium;
  m.rayleigh = RAYLEIGH_SCATTER * r_density;
  m.mie = MIE_SCATTER * m_density;
  m.extinction = m.rayleigh + vec3f((MIE_SCATTER + MIE_ABSORB) * m_density) + OZONE_ABSORB * o_density;
  return m;
}

fn rayleigh_phase(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }

fn lut_uv(radius: f32, mu: f32) -> vec2f {
  let h = clamp((radius - ground_radius()) / (top_radius() - ground_radius()), 0.0, 1.0);
  return vec2f(mu * 0.5 + 0.5, h);
}

fn transmittance_to_top(radius: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transmittance_lut, lut_sampler, lut_uv(radius, mu), 0.0).rgb;
}

fn multiple_scattering(radius: f32, mu: f32) -> vec3f {
  return textureSampleLevel(ms_lut, lut_sampler, lut_uv(radius, mu), 0.0).rgb;
}

// Distance to leave the atmosphere, or to hit the ground (negative flag in w).
fn march_extent(origin: vec3f, dir: vec3f) -> vec2f {
  let top = ray_sphere(origin, dir, top_radius());
  let ground = ray_sphere(origin, dir, ground_radius());
  if (ground.x > 0.0) { return vec2f(ground.x, 1.0); }
  return vec2f(max(top.y, 0.0), 0.0);
}

@compute @workgroup_size(8, 8)
fn transmittance(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(out2d);
  if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let radius = mix(ground_radius(), top_radius(), uv.y);
  let mu = uv.x * 2.0 - 1.0;
  let origin = vec3f(0.0, radius, 0.0);
  let dir = vec3f(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  let extent = march_extent(origin, dir);
  if (extent.y > 0.5) {
    textureStore(out2d, id.xy, vec4f(0.0, 0.0, 0.0, 1.0));
    return;
  }
  let steps = 40;
  let dt = extent.x / f32(steps);
  var depth = vec3f(0.0);
  for (var i = 0; i < steps; i++) {
    let p = origin + dir * (f32(i) + 0.5) * dt;
    depth += medium_at(length(p) - ground_radius()).extinction * dt;
  }
  textureStore(out2d, id.xy, vec4f(exp(-depth), 1.0));
}

// Hillaire 2020 section 5.5: isotropic multiple-scattering transfer, Lms = L2 / (1 - fms).
@compute @workgroup_size(8, 8)
fn multiscatter(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(out2d);
  if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let radius = mix(ground_radius() + 0.01, top_radius() - 0.01, uv.y);
  let sun_mu = uv.x * 2.0 - 1.0;
  let sun = vec3f(sqrt(max(0.0, 1.0 - sun_mu * sun_mu)), sun_mu, 0.0);
  let origin = vec3f(0.0, radius, 0.0);
  let albedo = params.misc.y;
  var l2 = vec3f(0.0);
  var fms = vec3f(0.0);
  let dirs = 8u;
  for (var a = 0u; a < dirs; a++) {
    for (var b = 0u; b < dirs; b++) {
      let theta = acos(1.0 - 2.0 * (f32(a) + 0.5) / f32(dirs));
      let phi = 2.0 * PI * (f32(b) + 0.5) / f32(dirs);
      let dir = vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
      let extent = march_extent(origin, dir);
      let steps = 20;
      let dt = extent.x / f32(steps);
      var throughput = vec3f(1.0);
      var lum = vec3f(0.0);
      var lum_f = vec3f(0.0);
      for (var i = 0; i < steps; i++) {
        let p = origin + dir * (f32(i) + 0.5) * dt;
        let r = length(p);
        let m = medium_at(r - ground_radius());
        let scatter = m.rayleigh + vec3f(m.mie);
        let step_t = exp(-m.extinction * dt);
        let sun_t = transmittance_to_top(r, dot(p / r, sun));
        let s = scatter * sun_t / (4.0 * PI);
        let s_int = (s - s * step_t) / max(m.extinction, vec3f(1e-6));
        let f_int = (scatter - scatter * step_t) / max(m.extinction, vec3f(1e-6));
        lum += throughput * s_int;
        lum_f += throughput * f_int;
        throughput *= step_t;
      }
      if (extent.y > 0.5) {
        let hit = origin + dir * extent.x;
        let n = normalize(hit);
        let sun_t = transmittance_to_top(length(hit), dot(n, sun));
        lum += throughput * sun_t * max(dot(n, sun), 0.0) * albedo / PI;
      }
      l2 += lum;
      fms += lum_f;
    }
  }
  let norm = 1.0 / f32(dirs * dirs);
  l2 *= norm;
  fms *= norm;
  let result = l2 / (1.0 - min(fms, vec3f(0.99)));
  textureStore(out2d, id.xy, vec4f(result, 1.0));
}

fn sky_radiance(dir: vec3f) -> vec3f {
  let sun = params.sun_dir.xyz;
  let illum = params.sun_color.rgb * params.sun_dir.w;
  let origin = vec3f(0.0, ground_radius() + eye_altitude(params.anim.y), 0.0);
  let extent = march_extent(origin, dir);
  let steps = 32;
  let cos_theta = dot(dir, sun);
  let pr = rayleigh_phase(cos_theta);
  let pm = henyey_greenstein(cos_theta, MIE_G);
  var throughput = vec3f(1.0);
  var lum = vec3f(0.0);
  var t_prev = 0.0;
  for (var i = 0; i < steps; i++) {
    // Quadratic step distribution: dense near the eye, sparse in the distance.
    let s = (f32(i) + 0.3) / f32(steps);
    let t = extent.x * s * s;
    let dt = t - t_prev;
    t_prev = t;
    let p = origin + dir * t;
    let r = length(p);
    let m = medium_at(r - ground_radius());
    let mu_sun = dot(p / r, sun);
    let sun_t = transmittance_to_top(r, mu_sun);
    let ms = multiple_scattering(r, mu_sun);
    let s_in = m.rayleigh * (pr * sun_t + ms) + vec3f(m.mie) * (pm * sun_t + ms);
    let step_t = exp(-m.extinction * dt);
    lum += throughput * (s_in - s_in * step_t) / max(m.extinction, vec3f(1e-6));
    throughput *= step_t;
  }
  // Toward the ground this is only the air in front of it: the ground itself is shaded in
  // the cloud pass (clouds.wgsl ground_radiance), which knows the cloud shadows.
  return lum * illum;
}

@compute @workgroup_size(8, 8)
fn sky_cube(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(out_cube).x;
  if (id.x >= size || id.y >= size) { return; }
  let dir = cube_dir(id.z, (vec2f(id.xy) + 0.5) / f32(size));
  textureStore(out_cube, id.xy, id.z, vec4f(sky_radiance(dir), 1.0));
}

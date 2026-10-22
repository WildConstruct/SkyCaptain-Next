// Nubis-style 2.5D cloud layer, raymarched from a fixed eye straight into an environment cube.
// Each dispatch thread owns one 4x4 texel block and renders one texel of it per frame in
// Bayer order, so a full cube refresh takes 16 frames. Early frames fill not-yet-rendered
// texels so edits appear immediately at quarter, then half resolution. Later frames keep
// adding jittered samples and average them per texel until the target sample count.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var repeat_sampler: sampler;
@group(0) @binding(2) var clamp_sampler: sampler;
@group(0) @binding(3) var shape_tex: texture_3d<f32>;
@group(0) @binding(4) var detail_tex: texture_3d<f32>;
@group(0) @binding(5) var weather_tex: texture_2d<f32>;
@group(0) @binding(6) var transmittance_lut: texture_2d<f32>;
@group(0) @binding(7) var sky_tex: texture_cube<f32>;
@group(0) @binding(8) var<storage, read_write> accum: array<vec2u>;
@group(0) @binding(9) var cloud_out: texture_storage_2d_array<rgba16float, write>;

const BAYER_OFFSETS = array<vec2u, 16>(
  vec2u(0u, 0u), vec2u(2u, 2u), vec2u(2u, 0u), vec2u(0u, 2u),
  vec2u(1u, 1u), vec2u(3u, 3u), vec2u(3u, 1u), vec2u(1u, 3u),
  vec2u(1u, 0u), vec2u(3u, 2u), vec2u(3u, 0u), vec2u(1u, 2u),
  vec2u(0u, 1u), vec2u(2u, 3u), vec2u(2u, 1u), vec2u(0u, 3u),
);

fn ground_radius() -> f32 { return params.layer.z; }
fn cloud_bottom() -> f32 { return params.layer.x; }
// Top of the march shell: the tallest tower possible.
fn cloud_top() -> f32 { return params.layer.y; }
// Height of ordinary cumulus; light-march and occlusion distances scale with it.
fn cumulus_height() -> f32 { return params.scale.w; }

const MAX_MARCH_KM: f32 = 40.0;

// Each cloud type has its own height: stratus 0.35 km, cumulus the layer height, towers up
// to the top of the shell.
fn cloud_height(kind: f32) -> f32 {
  if (kind < 0.5) { return mix(0.35, cumulus_height(), kind * 2.0); }
  return mix(cumulus_height(), cloud_top() - cloud_bottom(), (kind - 0.5) * 2.0);
}

// Vertical profile within a cloud's own height (h = 0 base .. 1 top).
fn height_profile(h: f32, kind: f32) -> f32 {
  let bottom_ramp = clamp(remap(h, 0.0, 0.07, 0.0, 1.0), 0.0, 1.0);
  let top_ramp = clamp(remap(h, 0.6, 1.0, 1.0, 0.0), 0.0, 1.0);
  // Towers carry more density higher up (anvil); stratus stays bottom-weighted.
  let gradient = mix(1.0 - h * 0.6, 0.7 + h * 0.3, kind);
  return bottom_ramp * top_ramp * gradient;
}

struct Sample {
  density: f32,
  h: f32,
}

fn cloud_density(p: vec3f, with_detail: bool) -> Sample {
  var s: Sample;
  s.density = 0.0;
  let altitude = length(p) - ground_radius();
  if (altitude <= cloud_bottom() || altitude >= cloud_top()) { return s; }

  let weather = textureSampleLevel(weather_tex, clamp_sampler, (p.xz + params.wind.xy) / params.scale.z + 0.5, 0.0);
  let coverage = clamp(weather.r + params.cloud.x * 2.0 - 1.0, 0.0, 1.0);
  if (coverage <= 0.0) { return s; }
  let kind = clamp(weather.g + params.cloud.y, 0.0, 1.0);
  // Height scales with local coverage (Schneider 2017): cloud edges are shorter than their
  // centres, so coverage blobs become domes instead of extruded slabs with flat tops.
  let h = (altitude - cloud_bottom()) / (cloud_height(kind) * mix(0.3, 1.0, coverage));
  s.h = h;
  if (h >= 1.0) { return s; }

  let local = vec3f(p.x + params.wind.x, altitude, p.z + params.wind.y);
  let shape = textureSampleLevel(shape_tex, repeat_sampler, local / params.scale.x, 0.0);
  let low_fbm = dot(shape.gba, vec3f(0.625, 0.25, 0.125));
  // Low-frequency Worley dilates the Perlin-Worley into billows. Damped so the result spans
  // roughly 0.15..0.95 (median ~0.55) and coverage still has something to carve.
  var base = clamp(remap(shape.r, (low_fbm - 1.0) * 0.35, 1.0, 0.0, 1.0), 0.0, 1.0);
  base *= height_profile(h, kind);
  // Coverage shrinks with height so tops round off; towers narrow more as they rise.
  let tower = clamp((kind - 0.5) * 2.0, 0.0, 1.0);
  let cov_h = coverage * (1.0 - smoothstep(0.35, 1.0, h) * mix(0.3, 0.45, tower));
  base = clamp(remap(base, 1.0 - cov_h, 1.0, 0.0, 1.0), 0.0, 1.0) * cov_h;
  if (base <= 0.0) { return s; }

  if (with_detail) {
    let dp = vec3f(p.x + params.wind.z, altitude, p.z + params.wind.w) / params.scale.y;
    let detail = textureSampleLevel(detail_tex, repeat_sampler, dp, 0.0).rgb;
    let high_fbm = dot(detail, vec3f(0.625, 0.25, 0.125));
    // Wispy erosion at the base, billowy erosion toward the tops.
    let modifier = mix(high_fbm, 1.0 - high_fbm, clamp(h * 5.0, 0.0, 1.0));
    base = clamp(remap(base, modifier * params.cloud.w, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  s.density = base * weather.b;
  return s;
}

fn sun_transmittance(p: vec3f) -> vec3f {
  let r = length(p);
  let mu = dot(p / r, params.sun_dir.xyz);
  let uv = vec2f(mu * 0.5 + 0.5, clamp((r - ground_radius()) / (params.layer.w - ground_radius()), 0.0, 1.0));
  return textureSampleLevel(transmittance_lut, clamp_sampler, uv, 0.0).rgb;
}

fn phase(cos_theta: f32, scale: f32) -> f32 {
  let forward = henyey_greenstein(cos_theta, params.light.y * scale);
  let back = henyey_greenstein(cos_theta, -params.light.z * scale);
  return mix(forward, back, params.light.w);
}

// Optical depth toward the sun along a short cone, with growing step lengths.
fn light_optical_depth(p: vec3f, jitter: vec3f) -> f32 {
  let sun = params.sun_dir.xyz;
  let steps = i32(params.march.y);
  var ds = cumulus_height() * 0.04;
  var travelled = 0.0;
  var depth = 0.0;
  for (var i = 0; i < steps; i++) {
    let cone = (jitter * 2.0 - 1.0) * travelled * 0.15;
    let q = p + (sun * (travelled + ds * 0.5) + cone);
    depth += cloud_density(q, i < 2).density * ds;
    travelled += ds;
    ds *= 1.6;
  }
  return depth * params.cloud.z;
}

struct MarchResult {
  scatter: vec3f,
  transmittance: f32,
}

fn march(dir: vec3f, seed: vec3u) -> MarchResult {
  var result: MarchResult;
  result.scatter = vec3f(0.0);
  result.transmittance = 1.0;
  if (dir.y <= 0.0) { return result; }

  let origin = vec3f(0.0, ground_radius() + 0.002, 0.0);
  let t0 = ray_sphere(origin, dir, ground_radius() + cloud_bottom()).y;
  let t_top = ray_sphere(origin, dir, ground_radius() + cloud_top()).y;
  let t1 = min(t_top, t0 + MAX_MARCH_KM);
  // Step length is set by the cumulus layer, so ordinary clouds get the full step budget;
  // the march continues at the same spacing through the tower region above.
  let t_cumulus = min(ray_sphere(origin, dir, ground_radius() + cloud_bottom() + cumulus_height()).y, t1);
  if (t0 <= 0.0 || t1 <= t0) { return result; }

  let sun = params.sun_dir.xyz;
  let cos_theta = dot(dir, sun);
  let illum = params.sun_color.rgb * params.sun_dir.w;
  let sigma_scale = params.cloud.z;
  let albedo = 0.98;

  // Ambient from the sky cube: zenith for tops, horizon ring for bases, plus a ground bounce.
  let sky_top = textureSampleLevel(sky_tex, clamp_sampler, vec3f(0.0, 1.0, 0.0), 0.0).rgb;
  let sky_side = (textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(1.0, 0.25, 0.0)), 0.0).rgb
                + textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(-1.0, 0.25, 0.0)), 0.0).rgb
                + textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(0.0, 0.25, 1.0)), 0.0).rgb
                + textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(0.0, 0.25, -1.0)), 0.0).rgb) * 0.25;
  let ground_bounce = illum * sun_transmittance(origin) * max(sun.y, 0.0) * params.misc.y / PI;

  let max_steps = i32(params.march.x);
  let dt = max(t_cumulus - t0, 1e-3) / f32(max_steps);
  let jitter = hash33(seed);
  var t = t0 + dt * jitter.x;
  var transmittance = 1.0;
  var scatter = vec3f(0.0);
  var first_hit = -1.0;
  var octave_phase = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  let octaves = min(i32(params.misc.w), 4);
  for (var k = 0; k < 4; k++) {
    octave_phase[k] = phase(cos_theta, pow(params.ms.z, f32(k)));
  }

  for (var i = 0; i < max_steps * 3; i++) {
    if (t >= t1 || transmittance < 0.01) { break; }
    let p = origin + dir * t;
    let coarse = cloud_density(p, false);
    if (coarse.density <= 0.0) {
      t += dt * 2.0;
      continue;
    }
    let s = cloud_density(p, true);
    if (s.density > 0.0) {
      if (first_hit < 0.0) { first_hit = t; }
      let sigma_t = s.density * sigma_scale;
      let sigma_s = sigma_t * albedo;
      let tau_light = light_optical_depth(p, hash33(seed + vec3u(u32(i) * 7919u, 0u, 0u)));
      // Wrenninge multiple-scattering octaves: scatter a^k, extinction b^k, eccentricity c^k.
      var sun_scatter = 0.0;
      for (var k = 0; k < octaves; k++) {
        let fk = f32(k);
        sun_scatter += pow(params.ms.x, fk) * exp(-tau_light * pow(params.ms.y, fk)) * octave_phase[k];
      }
      let powder = mix(1.0, 1.0 - exp(-sigma_t * 0.2), params.ms.w);
      // Ambient is occluded by the cloud above: one cheap upward sample gives dark cores, bright tops.
      let above = cloud_density(p + normalize(p) * cumulus_height() * 0.15, false).density;
      let occlusion = exp(-(above + s.density) * sigma_scale * cumulus_height() * 0.15);
      let ambient = mix(sky_side * 0.6 + ground_bounce, sky_top * 0.7 + sky_side * 0.3, s.h) * params.light.x * mix(0.15, 1.0, occlusion);
      let in_scatter = sigma_s * (illum * sun_transmittance(p) * sun_scatter * powder + ambient);
      let step_t = exp(-sigma_t * dt);
      // Hillaire energy-conserving integration over the step.
      scatter += transmittance * (in_scatter - in_scatter * step_t) / max(sigma_t, 1e-5);
      transmittance *= step_t;
    }
    t += dt;
  }

  if (first_hit < 0.0) { return result; }
  // Aerial perspective: distant clouds fade into the sky behind them.
  let fade = exp(-first_hit / (params.misc.x * 3.0));
  result.scatter = scatter * fade;
  result.transmittance = mix(1.0, transmittance, fade);
  return result;
}

fn pack(v: vec4f) -> vec2u {
  return vec2u(pack2x16float(v.xy), pack2x16float(v.zw));
}

fn unpack(v: vec2u) -> vec4f {
  return vec4f(unpack2x16float(v.x), unpack2x16float(v.y));
}

fn store_texel(texel: vec2u, face: u32, value: vec4f) {
  textureStore(cloud_out, texel, face, value);
}

@compute @workgroup_size(8, 8, 1)
fn render(@builtin(global_invocation_id) id: vec3u) {
  let size = u32(params.march.z);
  let blocks = size / 4u;
  if (id.x >= blocks || id.y >= blocks) { return; }
  let face = id.z;
  let frame = u32(params.march.w);
  let slot = frame % 16u;
  let pass_index = frame / 16u;
  let texel = id.xy * 4u + BAYER_OFFSETS[slot];

  let seed = vec3u(texel.x + face * size, texel.y, frame);
  var sub = vec2f(0.5);
  if (pass_index > 0u) { sub = hash33(seed + vec3u(0u, 0u, 7777u)).xy; }
  let dir = cube_dir(face, (vec2f(texel) + sub) / f32(size));
  let m = march(dir, seed);
  let value = vec4f(m.scatter, m.transmittance);

  let index = (face * size + texel.y) * size + texel.x;
  var resolved = value;
  if (pass_index > 0u) {
    let previous = unpack(accum[index]);
    resolved = previous + (value - previous) / f32(pass_index + 1u);
  }
  accum[index] = pack(resolved);

  if (pass_index == 0u && slot == 0u) {
    for (var y = 0u; y < 4u; y++) {
      for (var x = 0u; x < 4u; x++) { store_texel(id.xy * 4u + vec2u(x, y), face, resolved); }
    }
  } else if (pass_index == 0u && slot < 4u) {
    for (var y = 0u; y < 2u; y++) {
      for (var x = 0u; x < 2u; x++) { store_texel(texel + vec2u(x, y), face, resolved); }
    }
  } else {
    store_texel(texel, face, resolved);
  }
}

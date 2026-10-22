// 2.5D cloud layer (Takram three-geospatial's model on our authored weather), raymarched from a fixed eye straight into an environment cube.
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
// Height of ordinary cumulus.
fn cumulus_height() -> f32 { return params.scale.w; }

// The density model and lighting below are ported from Takram three-geospatial clouds
// (MIT, (c) 2024 Shota Matsuda): clouds.glsl sampleWeather/sampleMedia and clouds.frag
// marchClouds, converted from metres to kilometres. Constants keep Takram's defaults and
// names. Where we differ (our authored weather map, per-type cloud height, a cone march
// in place of their beer shadow map, the sky cube in place of precomputed irradiance)
// it is marked "skyCaptain:". docs/takram-port.md lists every difference.
const COVERAGE_FILTER_WIDTH: f32 = 0.6;
const SHAPE_ALTERING_BIAS: f32 = 0.35;
const WEATHER_EXPONENT: f32 = 1.0;
const SHAPE_AMOUNT: f32 = 1.0;
// DensityProfile(expTerm 0, exponent 0, linearTerm 0.75, constantTerm 0.25).
const PROFILE_LINEAR: f32 = 0.75;
const PROFILE_CONSTANT: f32 = 0.25;
const TURBULENCE_PERIOD_KM: f32 = 5.0;
const TURBULENCE_DISPLACEMENT_KM: f32 = 0.35;
// Primary march (qualityPresets 'high'): metres -> km.
const MIN_STEP_KM: f32 = 0.05;
const MAX_STEP_KM: f32 = 1.0;
const MAX_RAY_KM: f32 = 200.0;
const PERSPECTIVE_STEP_SCALE: f32 = 1.01;
const MIN_DENSITY: f32 = 1e-5;
const MIN_EXTINCTION: f32 = 1e-2; // 1e-5 per metre
const MIN_TRANSMITTANCE: f32 = 1e-2;
// Secondary marches toward the sun and the ground.
const ITERATIONS_TO_SUN: i32 = 2;
const ITERATIONS_TO_GROUND: i32 = 3;
const MIN_SECONDARY_STEP_KM: f32 = 0.1;
const SECONDARY_STEP_SCALE: f32 = 2.0;
// Lighting.
const GROUND_BOUNCE_SCALE: f32 = 1.0;
const POWDER_EXPONENT_KM: f32 = 0.15; // 150 per metre of extinction
// skyCaptain: rayDistance * 1e-5 per metre in Takram's mip estimate.
const MIP_PER_KM: f32 = 0.01;
const RECIPROCAL_PI4: f32 = 0.0795774715459;

fn remap_clamped(x: f32, a: f32, b: f32) -> f32 {
  return clamp((x - a) / (b - a), 0.0, 1.0);
}

// skyCaptain: each cloud type has its own layer height: stratus 0.35 km, cumulus the
// layer height, towers up to the top of the shell. Takram uses fixed layers instead.
fn cloud_height(kind: f32) -> f32 {
  if (kind < 0.5) { return mix(0.35, cumulus_height(), kind * 2.0); }
  return mix(cumulus_height(), cloud_top() - cloud_bottom(), (kind - 0.5) * 2.0);
}

fn shape_altering(hf: f32, kind: f32) -> f32 {
  // Semi-circle that rounds clouds toward the top.
  // skyCaptain: towers raise the bias toward 1 so the widest point climbs to mid-height
  // and they stand as columns; Takram's 0.35 (widest near the base) suits cumulus.
  let bias = mix(SHAPE_ALTERING_BIAS, 0.9, clamp((kind - 0.5) * 2.0, 0.0, 1.0));
  let x = clamp(pow(hf, bias) * 2.0 - 1.0, -1.0, 1.0);
  return 1.0 - x * x;
}

struct Weather {
  density: f32,
  hf: f32,     // height fraction within the cloud's own layer
  scale: f32,  // skyCaptain: authored density multiplier (weather map b)
}

fn sample_weather(p: vec3f, altitude: f32) -> Weather {
  var w: Weather;
  w.density = 0.0;
  w.hf = 0.0;
  w.scale = 0.0;
  if (altitude <= cloud_bottom() || altitude >= cloud_top()) { return w; }
  // skyCaptain: the local weather is our authored map (background, shapes, paint).
  let tex = textureSampleLevel(weather_tex, clamp_sampler, (p.xz + params.wind.xy) / params.scale.z + 0.5, 0.0);
  let kind = clamp(tex.g + params.cloud.y, 0.0, 1.0);
  w.hf = (altitude - cloud_bottom()) / cloud_height(kind);
  if (w.hf >= 1.0) { return w; }
  let local_weather = pow(tex.r, WEATHER_EXPONENT);
  // skyCaptain: Takram's coverage is one global number, and below ~0.6 it erodes everything
  // above a low dome, so a painted storm would never stand up. What the artist authored
  // raises coverage locally; where nothing is authored the global coverage rules as upstream.
  let coverage = max(params.cloud.x, local_weather);
  let factor = 1.0 - coverage * shape_altering(w.hf, kind);
  w.density = remap_clamped(mix(local_weather, 1.0, COVERAGE_FILTER_WIDTH), factor, factor + COVERAGE_FILTER_WIDTH);
  w.scale = tex.b;
  return w;
}

struct Media {
  extinction: f32, // per km; scattering equals extinction (albedo 1, as upstream)
}

fn sample_media(w: Weather, p: vec3f, altitude: f32, mip: f32, jitter: f32) -> Media {
  var density = w.density;
  // Curl-noise turbulence, strongest at the cloud base.
  let turbulence_uv = (p.xz + params.wind.xy) / TURBULENCE_PERIOD_KM;
  let turbulence = TURBULENCE_DISPLACEMENT_KM
    * (textureSampleLevel(shape_tex, repeat_sampler, vec3f(turbulence_uv, 0.5), 0.0).gba * 2.0 - 1.0)
    * density * remap_clamped(w.hf, 0.3, 0.0);
  let local = vec3f(p.x + params.wind.x, altitude, p.z + params.wind.y) + turbulence;
  let shape = textureSampleLevel(shape_tex, repeat_sampler, local / params.scale.x, 0.0).r;
  density = remap_clamped(density, (1.0 - shape) * SHAPE_AMOUNT, 1.0);

  if (mip * 0.5 + (jitter - 0.5) * 0.5 < 0.5) {
    let dp = (vec3f(p.x + params.wind.z, altitude, p.z + params.wind.w) + turbulence) / params.scale.y;
    let detail = textureSampleLevel(detail_tex, repeat_sampler, dp, 0.0).r;
    // Fluffy at the top and whippy at the bottom.
    let modifier = mix(pow(detail, 6.0), 1.0 - detail, remap_clamped(w.hf, 0.2, 0.4)) * params.cloud.w;
    density = remap_clamped(density * 2.0, modifier * 0.5, 1.0);
  }
  // Density profile, then Takram's saturate() at 1 per metre (1000 per km).
  let profile = PROFILE_LINEAR * w.hf + PROFILE_CONSTANT;
  var m: Media;
  m.extinction = min(density * params.cloud.z * w.scale * profile, 1000.0);
  return m;
}

fn sun_transmittance(p: vec3f) -> vec3f {
  let r = length(p);
  let mu = dot(p / r, params.sun_dir.xyz);
  let uv = vec2f(mu * 0.5 + 0.5, clamp((r - ground_radius()) / (params.layer.w - ground_radius()), 0.0, 1.0));
  return textureSampleLevel(transmittance_lut, clamp_sampler, uv, 0.0).rgb;
}

fn phase(cos_theta: f32, attenuation: f32) -> f32 {
  let forward = henyey_greenstein(cos_theta, params.light.y * attenuation);
  let back = henyey_greenstein(cos_theta, -params.light.z * attenuation);
  return mix(forward, back, params.light.w);
}

struct Depth {
  optical_depth: f32,
  distance: f32,
}

fn media_at(p: vec3f, mip: f32, jitter: f32) -> f32 {
  let altitude = length(p) - ground_radius();
  let w = sample_weather(p, altitude);
  if (w.density <= MIN_DENSITY) { return 0.0; }
  return sample_media(w, p, altitude, mip, jitter).extinction;
}

// marchOpticalDepth: a few short, doubling steps.
fn march_optical_depth(origin: vec3f, dir: vec3f, max_iterations: i32, mip: f32, jitter: f32) -> Depth {
  var r: Depth;
  r.optical_depth = 0.0;
  r.distance = 0.0;
  let iterations = i32(max(0.0, remap(mip, 0.0, 1.0, f32(max_iterations + 1), 1.0) - jitter));
  if (iterations == 0) {
    r.optical_depth = 0.5; // Upstream's fudge for the mean optical depth.
    return r;
  }
  var step_size = MIN_SECONDARY_STEP_KM / f32(iterations);
  var next = step_size * jitter;
  for (var i = 0; i < iterations; i++) {
    r.distance = next;
    r.optical_depth += media_at(origin + dir * next, mip, jitter) * step_size;
    next += step_size;
    step_size *= SECONDARY_STEP_SCALE;
  }
  return r;
}

// skyCaptain: Takram adds the optical depth beyond the short march from a beer shadow
// map. We have no shadow map yet, so march on toward the sun with growing steps and
// coarse density (no detail) for params.march.y steps.
fn far_optical_depth(origin: vec3f, start: f32, jitter: f32) -> f32 {
  let sun = params.sun_dir.xyz;
  let steps = i32(params.march.y);
  var ds = max(MIN_SECONDARY_STEP_KM * 1.5, start);
  var t = start + ds * jitter;
  var depth = 0.0;
  for (var i = 0; i < steps; i++) {
    let p = origin + sun * t;
    if (length(p) - ground_radius() >= cloud_top()) { break; }
    depth += media_at(p, 1.0, 1.0) * ds;
    t += ds;
    ds *= 1.8;
  }
  return depth;
}

fn approximate_multiple_scattering(optical_depth: f32, cos_theta: f32) -> f32 {
  // a: scattering, b: extinction, c: phase attenuation (Wrenninge et al.)
  var coeffs = vec3f(1.0);
  let attenuation = params.ms.xyz;
  var scattering = 0.0;
  let octaves = min(i32(params.misc.w), 12);
  for (var i = 0; i < octaves; i++) {
    scattering += coeffs.x * exp(-optical_depth * coeffs.y) * phase(cos_theta, coeffs.z);
    coeffs *= attenuation;
  }
  return scattering;
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
  let t_near = ray_sphere(origin, dir, ground_radius() + cloud_bottom()).y;
  let t_far = min(ray_sphere(origin, dir, ground_radius() + cloud_top()).y, MAX_RAY_KM);
  if (t_near <= 0.0 || t_far <= t_near) { return result; }

  let sun = params.sun_dir.xyz;
  let cos_theta = dot(dir, sun);
  let illum = params.sun_color.rgb * params.sun_dir.w;
  let coverage = params.cloud.x;

  // skyCaptain: sky light from the sky cube instead of precomputed irradiance. Mean
  // radiance over the upper hemisphere, and over the whole sphere (the lower half seen
  // from inside the layer is mostly ground, which the bounce term adds separately).
  let sky_top = textureSampleLevel(sky_tex, clamp_sampler, vec3f(0.0, 1.0, 0.0), 0.0).rgb;
  let sky_side = (textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(1.0, 0.25, 0.0)), 0.0).rgb
                + textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(-1.0, 0.25, 0.0)), 0.0).rgb
                + textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(0.0, 0.25, 1.0)), 0.0).rgb
                + textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(0.0, 0.25, -1.0)), 0.0).rgb) * 0.25;
  let sky_hemisphere = sky_top * 0.25 + sky_side * 0.75;
  // skyIrradiance / 4pi in Takram's terms.
  let sky_light = sky_hemisphere * 0.5;
  // Ground irradiance: horizontal sky irradiance plus the sun through the clear fraction.
  let ground_sky_irradiance = PI * (sky_top * 0.5 + sky_side * 0.5);
  let ground_sun_irradiance = illum * sun_transmittance(origin) * max(sun.y, 0.0);
  let ground_radiance = params.misc.y / PI * (ground_sky_irradiance + (1.0 - coverage) * ground_sun_irradiance);

  let max_iterations = i32(params.march.x);
  let jitter = hash33(seed).x;
  var step_size = MIN_STEP_KM + (PERSPECTIVE_STEP_SCALE - 1.0) * t_near;
  var d = step_size * jitter * 2.0;
  let max_d = t_far - t_near;
  var radiance_integral = vec3f(0.0);
  var transmittance_integral = 1.0;
  var weighted_distance_sum = 0.0;
  var transmittance_sum = 0.0;

  for (var i = 0; i < max_iterations; i++) {
    if (d > max_d) { break; }
    let t = t_near + d;
    let p = origin + dir * t;
    let altitude = length(p) - ground_radius();
    let mip = log2(max(1.0, 1.0 + t * MIP_PER_KM));
    let w = sample_weather(p, altitude);
    if (w.density <= MIN_DENSITY) {
      // Step longer in empty space.
      step_size *= PERSPECTIVE_STEP_SCALE;
      d += mix(step_size, MAX_STEP_KM, min(1.0, mip));
      continue;
    }
    let media = sample_media(w, p, altitude, mip, jitter);
    if (media.extinction > MIN_EXTINCTION) {
      let sun_irradiance = illum * sun_transmittance(p);
      let surface_normal = normalize(p);
      let to_sun = march_optical_depth(p, sun, ITERATIONS_TO_SUN, mip, jitter);
      let optical_depth = to_sun.optical_depth + far_optical_depth(p, to_sun.distance, hash33(seed + vec3u(u32(i), 31u, 0u)).x);
      var radiance = sun_irradiance * approximate_multiple_scattering(optical_depth, cos_theta);
      if (mip < 0.5) {
        let to_ground = march_optical_depth(p, -surface_normal, ITERATIONS_TO_GROUND, mip, jitter);
        radiance += ground_radiance * exp(-to_ground.optical_depth) * RECIPROCAL_PI4 * GROUND_BOUNCE_SCALE;
      }
      // Crude approximation of the sky gradient. Better than none in the shadows.
      radiance += sky_light * (w.hf * 0.5 + 0.5) * params.light.x;
      radiance *= media.extinction;
      radiance *= 1.0 - params.ms.w * exp(-media.extinction * POWDER_EXPONENT_KM);

      // Energy-conserving analytical integration (Frostbite 2016, 5.6.3).
      let transmittance = exp(-media.extinction * step_size);
      let clamped = max(media.extinction, 1e-4);
      radiance_integral += transmittance_integral * (radiance - radiance * transmittance) / clamped;
      transmittance_integral *= transmittance;
      weighted_distance_sum += t * transmittance_integral;
      transmittance_sum += transmittance_integral;
    }
    if (transmittance_integral <= MIN_TRANSMITTANCE) { break; }
    // Take a shorter step because we've already hit the clouds.
    step_size *= PERSPECTIVE_STEP_SCALE;
    d += step_size;
  }

  if (transmittance_sum <= 0.0) { return result; }
  // skyCaptain: Takram evaluates full aerial perspective at the transmittance-weighted
  // front depth (Frostbite 5.9.1). We fade toward the sky behind with the haze distance.
  let front_depth = weighted_distance_sum / transmittance_sum;
  let fade = exp(-front_depth / (params.misc.x * 3.0));
  let alpha = remap_clamped(transmittance_integral, 1.0, MIN_TRANSMITTANCE);
  result.scatter = radiance_integral * fade;
  result.transmittance = 1.0 - alpha * fade;
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

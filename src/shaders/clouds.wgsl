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
// Cloud shadow map over the ground around the eye: ground_shadow writes it, the ground reads it.
@group(0) @binding(11) var shadow_out: texture_storage_2d<rgba16float, write>;
@group(0) @binding(12) var shadow_tex: texture_2d<f32>;
// Ground terrain (ground.wgsl).
@group(0) @binding(14) var terrain_tex: texture_2d<f32>;
@group(0) @binding(15) var<uniform> ground: Ground;
// Relief (terrain.ts heightField): ground height in km over the terrain period.
@group(0) @binding(16) var height_tex: texture_2d<f32>;
// What the view saw of the ground, for the composite (see render()).
@group(0) @binding(17) var<storage, read_write> ground_accum: array<vec2u>;
@group(0) @binding(18) var ground_out: texture_storage_2d_array<rgba16float, write>;
// Wind waves (ocean.wgsl).
@group(0) @binding(19) var ocean_tex: texture_2d_array<f32>;
@group(0) @binding(20) var ocean_sampler: sampler;

const BAYER_OFFSETS = array<vec2u, 16>(
  vec2u(0u, 0u), vec2u(2u, 2u), vec2u(2u, 0u), vec2u(0u, 2u),
  vec2u(1u, 1u), vec2u(3u, 3u), vec2u(3u, 1u), vec2u(1u, 3u),
  vec2u(1u, 0u), vec2u(3u, 2u), vec2u(3u, 0u), vec2u(1u, 2u),
  vec2u(0u, 1u), vec2u(2u, 3u), vec2u(2u, 1u), vec2u(0u, 3u),
);

fn ground_radius() -> f32 { return params.layer.z; }
fn eye() -> vec3f { return vec3f(0.0, ground_radius() + eye_altitude(params.anim.y), 0.0); }
// 0 with the eye under the cloud base, 1 from 300 m above it (see ground_radiance).
fn above_clouds_weight() -> f32 {
  return smoothstep(params.layer.x, params.layer.x + 0.3, eye_altitude(params.anim.y));
}
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
// skyCaptain: coverage that full-strength local weather reaches (see sample_weather).
const AUTHORED_COVERAGE: f32 = 0.6;
const SHAPE_ALTERING_BIAS: f32 = 0.35;
const WEATHER_EXPONENT: f32 = 1.0;
const SHAPE_AMOUNT: f32 = 1.0;
// DensityProfile(expTerm 0, exponent 0, linearTerm 0.75, constantTerm 0.25).
const PROFILE_LINEAR: f32 = 0.75;
const PROFILE_CONSTANT: f32 = 0.25;
const TURBULENCE_PERIOD_KM: f32 = 5.0;
const TURBULENCE_DISPLACEMENT_KM: f32 = 0.35;
// skyCaptain: how fast the turbulence field changes, relative to the shape evolution.
const TURBULENCE_EVOLUTION: f32 = 0.5;
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
// Averages of the baked detail noise's two erosion terms (measured: E[d^6], E[1 - d]).
const DETAIL_MEAN_POW6: f32 = 0.150;
const DETAIL_MEAN_INVERSE: f32 = 0.303;
// Detail features (one detail scale) fade out between these sizes on screen, in texels.
const DETAIL_MIN_TEXELS: f32 = 4.0;
const DETAIL_FULL_TEXELS: f32 = 16.0;
const GOLDEN_RATIO_FRACT: f32 = 0.618033989;
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

fn shape_altering(hf: f32) -> f32 {
  // Semi-circle that rounds clouds toward the top. With peaked local weather (weather.wgsl)
  // this also tapers towers: only the strongest weather reaches the top.
  let x = clamp(pow(hf, SHAPE_ALTERING_BIAS) * 2.0 - 1.0, -1.0, 1.0);
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
  // skyCaptain: repeat past the map's edge rather than stretch its edge texels; from altitude
  // the horizon is far beyond the map.
  let tex = textureSampleLevel(weather_tex, repeat_sampler, (p.xz + params.wind.xy) / params.scale.z + 0.5, 0.0);
  let kind = clamp(tex.g + params.cloud.y, 0.0, 1.0);
  w.hf = (altitude - cloud_bottom()) / cloud_height(kind);
  if (w.hf >= 1.0) { return w; }
  let local_weather = pow(tex.r, WEATHER_EXPONENT);
  // skyCaptain: Takram's coverage is one global number, and below ~0.6 it erodes everything
  // above a low dome, so a painted storm would never stand up. Authored weather (shapes,
  // paint: weather alpha) raises coverage locally, up to AUTHORED_COVERAGE: the most at
  // which shape noise still carves, so authored clouds never set solid. The background
  // follows the global coverage exactly, as upstream. Clear zeroes the density (blue).
  if (tex.b <= 0.0) { return w; }
  let coverage = max(params.cloud.x, AUTHORED_COVERAGE * local_weather * tex.a);
  let factor = 1.0 - coverage * shape_altering(w.hf);
  w.density = remap_clamped(mix(local_weather, 1.0, COVERAGE_FILTER_WIDTH), factor, factor + COVERAGE_FILTER_WIDTH);
  w.scale = tex.b;
  return w;
}

struct Media {
  extinction: f32, // per km; scattering equals extinction (albedo 1, as upstream)
}

// skyCaptain: detail_amount says how much of the fine detail this sample sees: 1 for the
// view near the eye, fading with distance; 0 for light, which sees the detail's average
// erosion instead. In a real cloud light diffuses through hundreds of metres of droplets,
// so brightness follows the cloud's broad shape, while the fine structure shows at its
// edges. Lighting through full detail lit every ~150 m bump as its own small globule.
// (Takram switches detail on or off per ray by a jittered distance test, which speckled.)
fn sample_media(w: Weather, p: vec3f, altitude: f32, detail_amount: f32) -> Media {
  var density = w.density;
  // Curl-noise turbulence, strongest at the cloud base.
  // skyCaptain: the turbulence field evolves with time (its slice moves), so ragged bases
  // morph slowly instead of sliding rigidly with the cloud.
  let turbulence_uv = (p.xz + params.wind.xy) / TURBULENCE_PERIOD_KM;
  let turbulence_slice = 0.5 + params.anim.x * TURBULENCE_EVOLUTION / TURBULENCE_PERIOD_KM;
  let turbulence = TURBULENCE_DISPLACEMENT_KM
    * (textureSampleLevel(shape_tex, repeat_sampler, vec3f(turbulence_uv, turbulence_slice), 0.0).gba * 2.0 - 1.0)
    * density * remap_clamped(w.hf, 0.3, 0.0);
  // Evolution (Takram): the shape noise scrolls upward through the cloud, so clouds grow and
  // dissolve over an animation instead of only sliding.
  let local = vec3f(p.x + params.wind.x, altitude - params.anim.x, p.z + params.wind.y) + turbulence;
  let shape = textureSampleLevel(shape_tex, repeat_sampler, local / params.scale.x, 0.0).r;
  density = remap_clamped(density, (1.0 - shape) * SHAPE_AMOUNT, 1.0);

  // Fluffy at the top and whippy at the bottom; the average erosion where detail is off.
  let fluffy = remap_clamped(w.hf, 0.2, 0.4);
  var modifier = mix(DETAIL_MEAN_POW6, DETAIL_MEAN_INVERSE, fluffy);
  if (detail_amount > 0.0) {
    // skyCaptain: detail rides with the cloud and boils upward with the evolution, so in
    // slow real-time motion turrets rise and fringes churn. Takram drifts detail faster
    // than the shape, which at real speed reads as texture swimming through the cloud.
    let dp = (vec3f(p.x + params.wind.x, altitude - params.anim.x, p.z + params.wind.y) + turbulence) / params.scale.y;
    let detail = textureSampleLevel(detail_tex, repeat_sampler, dp, 0.0).r;
    modifier = mix(modifier, mix(pow(detail, 6.0), 1.0 - detail, fluffy), detail_amount);
  }
  density = remap_clamped(density * 2.0, modifier * params.cloud.w * 0.5, 1.0);
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

// Extinction at p, seeing detail_amount of the fine detail (see sample_media).
fn media_at(p: vec3f, detail_amount: f32) -> f32 {
  let altitude = length(p) - ground_radius();
  let w = sample_weather(p, altitude);
  if (w.density <= MIN_DENSITY) { return 0.0; }
  return sample_media(w, p, altitude, detail_amount).extinction;
}

// How much detail the view sees at distance t (km): full while a detail feature spans many
// cube texels, gone by the time it shrinks to a few. Detail smaller than that only reads
// as fine-grained globules (it used to switch on and off per ray, which also speckled).
fn view_detail(t: f32) -> f32 {
  let texels = params.scale.y / max(t * texel_angle(), 1e-6);
  return smoothstep(DETAIL_MIN_TEXELS, DETAIL_FULL_TEXELS, texels);
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
    // Light sees the smooth field (see sample_media).
    r.optical_depth += media_at(origin + dir * next, 0.0) * step_size;
    next += step_size;
    step_size *= SECONDARY_STEP_SCALE;
  }
  return r;
}

// skyCaptain: Takram adds the optical depth beyond the short march from a beer shadow
// map. We march on toward the sun with growing steps for params.march.y steps.
fn far_optical_depth(origin: vec3f, start: f32, jitter: f32) -> f32 {
  let sun = params.sun_dir.xyz;
  let steps = i32(params.march.y);
  var ds = max(MIN_SECONDARY_STEP_KM * 1.5, start);
  var t = start + ds * jitter;
  var depth = 0.0;
  for (var i = 0; i < steps; i++) {
    let p = origin + sun * t;
    if (length(p) - ground_radius() >= cloud_top()) { break; }
    // The detail's average erosion: raw coarse density keeps the thin fringe that detail
    // erodes, which over-darkens; full detail shades every small bump.
    depth += media_at(p, 0.0) * ds;
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

// --- Ground ------------------------------------------------------------------------------
// The ground's light depends on the clouds, so it is shaded here and in the composite
// rather than in the sky pass. Here: direct sun through the cloud above each ground point
// (the cloud shadow map). The composite (display.wgsl, export.wgsl) adds the rest: the
// environment as seen from the ground, sky through the clouds plus the light the clouds
// scatter, integrated from the finished cube (downwelling.wgsl). So overcast ground is lit
// by the grey dome and sunset ground glows with the cloud undersides. The result goes into
// the cloud cube as radiance with transmittance 1, on top of the air in front of the
// ground (sky cube).

// The eye is 2 m up, so the visible ground ends at the horizon about 5 km away: the shadow
// map covers 12 km around the eye (512 texels, ~23 m each), marched once per change with
// many steps instead of per ground sample. Smooth, and cheap per frame.
const GROUND_SHADOW_KM: f32 = 12.0;
const GROUND_SHADOW_STEPS: i32 = 96;
const DISTANT_SHADOW_STEPS: i32 = 24;
const OVERHEAD_STEPS: i32 = 12;

fn transmittance_lut_at(r: f32, mu: f32) -> vec3f {
  let uv = vec2f(mu * 0.5 + 0.5, clamp((r - ground_radius()) / (params.layer.w - ground_radius()), 0.0, 1.0));
  return textureSampleLevel(transmittance_lut, clamp_sampler, uv, 0.0).rgb;
}

// Optical depth through the cloud layer from p along dir, with detail. (Coarse density is
// not a safe shortcut: Takram's detail step erodes the thin fringe of every cloud to zero,
// while coarse density keeps it as a faint fog that over a 10 km path shadows everything.)
fn layer_optical_depth(p: vec3f, dir: vec3f, steps: i32, jitter: f32) -> f32 {
  let t_bottom = ray_sphere(p, dir, ground_radius() + cloud_bottom()).y;
  let t_top = ray_sphere(p, dir, ground_radius() + cloud_top()).y;
  if (t_top <= 0.0) { return 0.0; }
  let t0 = max(t_bottom, 0.0);
  let t1 = min(t_top, t0 + 60.0);
  if (t1 <= t0) { return 0.0; }
  let dt = (t1 - t0) / f32(steps);
  var depth = 0.0;
  for (var i = 0; i < steps; i++) {
    depth += media_at(p + dir * (t0 + (f32(i) + jitter) * dt), 0.0) * dt;
  }
  return depth;
}

fn ground_point(xz: vec2f) -> vec3f {
  let r = ground_radius();
  return vec3f(xz.x, sqrt(max(r * r - dot(xz, xz), 0.0)), xz.y);
}

@compute @workgroup_size(8, 8)
fn ground_shadow(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(shadow_out);
  if (any(id.xy >= size)) { return; }
  let xz = ((vec2f(id.xy) + 0.5) / vec2f(size) - 0.5) * GROUND_SHADOW_KM;
  let g = ground_point(xz);
  let sun = params.sun_dir.xyz;
  var shadow = 0.0;
  if (dot(normalize(g), sun) > 0.0) { shadow = exp(-layer_optical_depth(g, sun, GROUND_SHADOW_STEPS, 0.5)); }
  textureStore(shadow_out, id.xy, vec4f(shadow, 0.0, 0.0, 1.0));
}

// ---- Relief -------------------------------------------------------------------------
// skyCaptain: the ground has height (terrain.ts heightField). Rays that can reach it march
// the height field; mountains then hide the clouds and sky behind them, and get their own
// air (aerial perspective) up to the hit.

const TERRAIN_STEPS: i32 = 256;
// Shortest terrain step (km) and its growth with distance: nothing nearer than ~200 m needs
// to hold up, and a step of 3% of the distance still reaches 1000 km in the budget.
const TERRAIN_MIN_STEP_KM: f32 = 0.02;
const TERRAIN_STEP_GROWTH: f32 = 0.03;
const TERRAIN_NEAR_SKIP_KM: f32 = 0.03;
const TERRAIN_BISECTIONS: i32 = 7;
const TERRAIN_MAX_KM: f32 = 400.0;
const SELF_SHADOW_STEPS: i32 = 20;

fn relief_on() -> bool { return ground.info.x > 0.5 && ground.relief.x > 0.0; }

// Ground height above sea level at xz (km).
fn terrain_height(xz: vec2f) -> f32 {
  if (!relief_on()) { return 0.0; }
  let period = ground.info.y * ground.info.z;
  return textureSampleLevel(height_tex, repeat_sampler, (xz + ground.place.xy) / period, 0.0).r;
}

// Surface normal from the height field's slope, tilted from the local up.
fn terrain_normal(xz: vec2f, up: vec3f) -> vec3f {
  if (!relief_on()) { return up; }
  let e = ground.info.y * ground.info.z / f32(textureDimensions(height_tex).x);
  let dx = terrain_height(xz + vec2f(e, 0.0)) - terrain_height(xz - vec2f(e, 0.0));
  let dz = terrain_height(xz + vec2f(0.0, e)) - terrain_height(xz - vec2f(0.0, e));
  return normalize(up - vec3f(dx, 0.0, dz) / (2.0 * e));
}

// Distance along dir to the ground (relief or sea level), or -1 when the ray misses it.
fn terrain_hit(o: vec3f, dir: vec3f, jitter: f32) -> f32 {
  let r0 = ground_radius();
  let sea = ground_hit(length(o), dir, r0);
  if (!relief_on()) { return sea; }
  // Only the slab under the highest ground can hold a hit.
  let slab = ray_sphere(o, dir, r0 + ground.relief.x + 0.005);
  if (slab.y <= 0.0) { return -1.0; }
  // A rising ray cannot meet anything near enough to matter (shots keep ~200 m clear), and
  // skipping the first metres keeps it from catching the ground the eye stands on.
  var t = max(slab.x, select(0.0, TERRAIN_NEAR_SKIP_KM, dot(dir, normalize(o)) > 0.0));
  var t_end = min(slab.y, t + TERRAIN_MAX_KM);
  if (sea > 0.0) { t_end = min(t_end, sea); }
  var prev = t;
  // Steps follow the height above the ground, never shorter than a fraction of the
  // distance (distant ridges are coarse anyway); jittered so the stepping does not band.
  // (Steps that start at metres and grow 1% ran out ~1.5 km away: horizon rays never
  // reached the mountains.)
  t += (TERRAIN_MIN_STEP_KM + t * TERRAIN_STEP_GROWTH) * jitter;
  for (var i = 0; i < TERRAIN_STEPS; i++) {
    if (t > t_end) { break; }
    let p = o + dir * t;
    let gap = length(p) - r0 - terrain_height(p.xz);
    if (gap < 0.0) {
      var a = prev;
      var b = t;
      for (var k = 0; k < TERRAIN_BISECTIONS; k++) {
        let m = 0.5 * (a + b);
        let pm = o + dir * m;
        if (length(pm) - r0 - terrain_height(pm.xz) < 0.0) { b = m; } else { a = m; }
      }
      return b;
    }
    prev = t;
    t += max(gap * 0.5, TERRAIN_MIN_STEP_KM + t * TERRAIN_STEP_GROWTH);
  }
  // Past the relief the ray can still meet the sea.
  return select(-1.0, sea, sea > 0.0 && t >= sea);
}

// Sun visibility over the relief from a ground point (1 = lit, 0 = behind a ridge).
fn terrain_shadow(g: vec3f, sun: vec3f, jitter: f32) -> f32 {
  if (!relief_on()) { return 1.0; }
  let r0 = ground_radius();
  var t = 0.01 + 0.02 * jitter;
  var lit = 1.0;
  for (var i = 0; i < SELF_SHADOW_STEPS; i++) {
    let p = g + sun * t;
    let gap = length(p) - r0 - terrain_height(p.xz);
    // Soft: grazing passes over a ridge darken partly.
    lit = min(lit, clamp(gap / (0.02 * t) + 1.0, 0.0, 1.0));
    if (lit <= 0.0 || length(p) - r0 > ground.relief.x) { break; }
    t *= 1.45;
  }
  return lit;
}

// Air transmittance from the eye to p along dir (the transmittance LUT as a ratio of two
// rays to the top of the atmosphere, taken in whichever direction avoids the planet).
fn air_between(o: vec3f, p: vec3f, dir: vec3f) -> vec3f {
  let ro = length(o);
  let rp = length(p);
  // Heading up at p, the ray escapes onward; heading down (a hit on the ground below the
  // eye), the reversed ray from p escapes back past the eye.
  if (dot(p / rp, dir) >= 0.0) {
    // Onward from p the ray escapes: T(o -> p) = T(o -> top) / T(p -> top).
    return clamp(transmittance_lut_at(ro, dot(o / ro, dir)) / max(transmittance_lut_at(rp, dot(p / rp, dir)), vec3f(1e-6)), vec3f(0.0), vec3f(1.0));
  }
  // Toward the planet: use the reversed ray, which escapes from p back past o.
  return clamp(transmittance_lut_at(rp, dot(p / rp, -dir)) / max(transmittance_lut_at(ro, dot(o / ro, -dir)), vec3f(1e-6)), vec3f(0.0), vec3f(1.0));
}

// The air's own glow between the eye and a hit at t: the sky cube holds the in-scatter of
// the whole path in this direction (to space, or to sea level), so take the fraction of it
// that the air up to the hit accounts for.
fn air_inscatter(o: vec3f, dir: vec3f, t: f32) -> vec3f {
  let full = textureSampleLevel(sky_tex, clamp_sampler, dir, 0.0).rgb;
  let sea = ground_hit(length(o), dir, ground_radius());
  var t_full = 1e4;
  if (sea > 0.0) { t_full = sea; }
  let to_hit = air_between(o, o + dir * t, dir);
  var to_end = vec3f(0.0);
  if (sea > 0.0) { to_end = air_between(o, o + dir * sea, dir); }
  else { to_end = transmittance_lut_at(length(o), dot(normalize(o), dir)); }
  return full * clamp((1.0 - to_hit) / max(1.0 - to_end, vec3f(1e-4)), vec3f(0.0), vec3f(1.0));
}

// Layered landscape material over the land-cover type, by slope and altitude: steep faces
// turn to rock, snow lies above the snow line on gentler slopes.
fn layered_albedo(surface: Surface, xz: vec2f, height: f32, slope: f32) -> vec3f {
  if (surface.water > 0.0 || !relief_on()) { return surface.albedo; }
  let grain = gfbm(xz / 0.15, 91u);
  let rock = ground.palette[5].rgb * mix(0.7, 1.25, grain);
  var albedo = mix(surface.albedo, rock, smoothstep(0.3, 0.55, slope + (grain - 0.5) * 0.15));
  let line = ground.relief.z + (gfbm(xz / 1.5, 93u) - 0.5) * 0.35;
  let snow = smoothstep(line - 0.08, line + 0.08, height) * (1.0 - smoothstep(0.45, 0.7, slope));
  albedo = mix(albedo, vec3f(0.82, 0.84, 0.88) * mix(0.9, 1.05, grain), snow);
  return albedo;
}

struct GroundHit {
  radiance: vec3f,  // sun and glint off the ground, through the air in front
  gbuffer: vec4f,   // rgb = albedo x air (x the composite's sky-light share), a = water
}

fn ground_radiance(o: vec3f, dir: vec3f, t_ground: f32, jitter: vec3f) -> GroundHit {
  let g = o + dir * t_ground;
  let up = normalize(g);
  let height = length(g) - ground_radius();
  let n = terrain_normal(g.xz, up);
  let slope = 1.0 - dot(n, up);
  let sun = params.sun_dir.xyz;
  let illum = params.sun_color.rgb * params.sun_dir.w;

  // A cube texel's footprint on the ground, km (stretched at grazing angles, taken as the
  // equal-area width as for water).
  let footprint = t_ground * texel_angle() / sqrt(max(abs(dot(dir, n)), 0.01));
  let surface = ground_surface(g.xz, footprint);
  let albedo = layered_albedo(surface, g.xz, height, slope);
  let cos_sun = dot(n, sun);
  var direct = vec3f(0.0);
  var sun_at_ground = vec3f(0.0);
  if ((cos_sun > 0.0 || surface.water > 0.0) && dot(up, sun) > -0.05) {
    // skyCaptain: the shadow map holds the sun's transmittance through the clouds from
    // sea-level ground near the eye. Raised ground below the clouds lies on the sun ray of
    // the sea-level point it shades, so read the map there; that stays smooth where
    // marching per sample would speckle. Far ground, or ground up in the clouds, marches.
    let lift = max(height, 0.0);
    let source = g.xz - sun.xz / max(sun.y, 0.05) * lift;
    var shadow = textureSampleLevel(shadow_tex, clamp_sampler, source / GROUND_SHADOW_KM + 0.5, 0.0).r;
    if (any(abs(source) > vec2f(GROUND_SHADOW_KM * 0.5)) || height > cloud_bottom()) {
      shadow = exp(-layer_optical_depth(g, sun, DISTANT_SHADOW_STEPS, jitter.x));
    }
    // A fixed step offset: jittered, the ridge shadow speckled at low sample counts.
    shadow *= terrain_shadow(g, sun, 0.5);
    sun_at_ground = illum * transmittance_lut_at(length(g), max(dot(up, sun), 0.0)) * shadow;
    direct = sun_at_ground * max(cos_sun, 0.0);
  }
  // skyCaptain: the ground's sky light is normally integrated from the finished cube at
  // composite time (the ground buffer below carries what it needs), which is right for
  // ground near an eye under the clouds. From above them, the eye sees clear sky the ground
  // below does not: there, light each ground point by the sky dimmed by the cloud straight
  // above it (cloud bottoms still pass some light down).
  let above = above_clouds_weight();
  if (above > 0.0) {
    let sky_top = textureSampleLevel(sky_tex, clamp_sampler, vec3f(0.0, 1.0, 0.0), 0.0).rgb;
    let sky_side = textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(1.0, 0.25, 0.0)), 0.0).rgb;
    let overhead = exp(-layer_optical_depth(g, up, OVERHEAD_STEPS, jitter.y));
    direct += above * PI * (sky_top * 0.5 + sky_side * 0.5) * mix(0.35, 1.0, overhead);
  }
  let air = air_between(o, g, dir);
  var hit: GroundHit;
  if (surface.water > 0.0) {
    hit.radiance = air * water_radiance(g, up, dir, t_ground, sun, sun_at_ground);
    // The mirror of the finished sky and clouds is added at composite time.
    hit.gbuffer = vec4f(0.0, 0.0, 0.0, 1.0);
    return hit;
  }
  hit.radiance = air * albedo / PI * direct;
  // Slopes facing away see less sky: a simple sky-view term from the normal.
  let sky_view = 0.5 + 0.5 * dot(n, up);
  hit.gbuffer = vec4f(albedo * air * (1.0 - above) * sky_view, 0.0);
  return hit;
}

// Size of a cube texel seen from the eye, radians (a face spans 90 degrees).
fn texel_angle() -> f32 { return 0.5 * PI / params.march.z; }

// A pixel's footprint on the water, metres: stretched along the view at grazing angles,
// taken as the equal-area width (as the ABYSSAL ocean does) so the light it reflects is
// averaged honestly.
fn water_footprint(t_km: f32, dir: vec3f, up: vec3f) -> f32 {
  return t_km * 1000.0 * texel_angle() / sqrt(max(abs(dot(dir, up)), 0.01));
}

// Water as the ABYSSAL ocean shades it (OceanMesh.js), less what the composite adds: sun
// specular (GGX with the sun disc's width) and the body of the water, lit by the beam that
// gets through the surface and by the sky. The mirror of the sky and clouds comes later.
fn water_radiance(g: vec3f, up: vec3f, dir: vec3f, t: f32, sun: vec3f, sun_at_ground: vec3f) -> vec3f {
  let w = water_surface(g.xz, up, water_footprint(t, dir, up));
  let v = -dir;
  let nov = max(dot(w.normal, v), 1e-4);
  let f = water_fresnel(nov);
  var spec = vec3f(0.0);
  let nol = dot(w.normal, sun);
  if (nol > 0.0) {
    let h = normalize(sun + v);
    let disc = clamp(w.alpha + params.sun_color.w * 0.5, 0.0, 1.0);
    let widen = (w.alpha * w.alpha) / (disc * disc);
    let fs = 0.02 + 0.98 * pow(1.0 - max(dot(v, h), 1e-4), 5.0);
    spec = sun_at_ground * ggx_d(max(dot(w.normal, h), 0.0), disc) * smith_vis(nov, nol, w.alpha) * fs * nol * widen;
  }
  // Sky light under the surface, E / pi: the zenith and the horizon band.
  let sky_top = textureSampleLevel(sky_tex, clamp_sampler, vec3f(0.0, 1.0, 0.0), 0.0).rgb;
  let sky_side = textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(1.0, 0.25, 0.0)), 0.0).rgb;
  let sky = sky_top * 0.5 + sky_side * 0.5;
  let sun_up = max(dot(up, sun), 0.0);
  let beam = sun_at_ground * sun_up * (1.0 - water_fresnel(max(sun_up, 1e-3))) / PI;
  // The body's colour is the terrain palette's water: what the volume sends back out per
  // unit of downwelling light (a few percent, peaking in the blue for deep water).
  let scatter = ground.palette[0].rgb;
  let body = scatter * (beam + sky * 0.94) + scatter * 0.3 * sky;
  return (1.0 - f) * body + spec;
}

struct MarchResult {
  scatter: vec3f,
  transmittance: f32,
  ground: vec4f,  // the ground buffer for the composite (see GroundHit), seen through the clouds
}

// The view from the eye along dir: clouds, then the ground behind them (seen through what
// the clouds let through). The ground is opaque: it hides the sky behind it and carries its
// own air in front, so its transmittance is 0 and the composite adds no sky there.
fn march(dir: vec3f, seed: vec3u) -> MarchResult {
  let origin = eye();
  let jitter = hash33(seed + vec3u(0u, 0u, 4242u));
  let t_ground = terrain_hit(origin, dir, jitter.x);
  var span = shell_interval(origin, dir);
  // Clouds behind a ridge are hidden by it.
  if (t_ground > 0.0 && span.y > 0.0) { span.y = min(span.y, t_ground); }
  var result = march_clouds(origin, dir, span, seed);
  if (t_ground > 0.0) {
    let hit = ground_radiance(origin, dir, t_ground, jitter);
    result.scatter += (hit.radiance + air_inscatter(origin, dir, t_ground)) * result.transmittance;
    result.ground = hit.gbuffer * result.transmittance;
    result.transmittance = 0.0;
  }
  return result;
}

fn march_clouds(origin: vec3f, dir: vec3f, span: vec2f, seed: vec3u) -> MarchResult {
  var result: MarchResult;
  result.scatter = vec3f(0.0);
  result.transmittance = 1.0;
  let t_near = span.x;
  let t_far = min(span.y, t_near + MAX_RAY_KM);
  if (span.y <= 0.0 || t_far <= t_near) { return result; }

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
  let ground_sun_irradiance = illum * sun_transmittance(vec3f(0.0, ground_radius() + 0.002, 0.0)) * max(sun.y, 0.0);
  let ground_radiance = params.misc.y / PI * (ground_sky_irradiance + (1.0 - coverage) * ground_sun_irradiance);

  let max_iterations = i32(params.march.x);
  // skyCaptain: stratified across a texel's passes (a golden-ratio sequence from a random
  // start per texel) rather than independent per pass. With large far steps, a handful of
  // random offsets clumped into blotches that read as small globules.
  let jitter = fract(hash33(vec3u(seed.xy, 0u)).x + f32(seed.z / 16u) * GOLDEN_RATIO_FRACT);
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
    let media = sample_media(w, p, altitude, view_detail(t));
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

fn store_texel(texel: vec2u, face: u32, value: vec4f, ground_value: vec4f) {
  textureStore(cloud_out, texel, face, value);
  textureStore(ground_out, texel, face, ground_value);
}

// Running mean of a texel's samples in both outputs; early passes fill the texel's 4x4 or
// 2x2 block so edits show at once.
fn resolve_texel(id: vec2u, texel: vec2u, face: u32, size: u32, slot: u32, pass_index: u32, value: vec4f, ground_value: vec4f) {
  let index = (face * size + texel.y) * size + texel.x;
  var resolved = value;
  var ground_resolved = ground_value;
  if (pass_index > 0u) {
    let previous = unpack(accum[index]);
    resolved = previous + (value - previous) / f32(pass_index + 1u);
    let ground_previous = unpack(ground_accum[index]);
    ground_resolved = ground_previous + (ground_value - ground_previous) / f32(pass_index + 1u);
  }
  accum[index] = pack(resolved);
  ground_accum[index] = pack(ground_resolved);
  if (pass_index == 0u && slot == 0u) {
    for (var y = 0u; y < 4u; y++) {
      for (var x = 0u; x < 4u; x++) { store_texel(id * 4u + vec2u(x, y), face, resolved, ground_resolved); }
    }
  } else if (pass_index == 0u && slot < 4u) {
    for (var y = 0u; y < 2u; y++) {
      for (var x = 0u; x < 2u; x++) { store_texel(texel + vec2u(x, y), face, resolved, ground_resolved); }
    }
  } else {
    store_texel(texel, face, resolved, ground_resolved);
  }
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
  resolve_texel(id.xy, texel, face, size, slot, pass_index, vec4f(m.scatter, m.transmittance), m.ground);
}

// ---------------------------------------------------------------------------------------
// Reference: a slow, unbiased-in-the-clouds path tracer over the same density field, used
// to score the approximations above (octave multiple scattering, cone shadowing, sky
// gradient, ground bounce). Not used for normal work: select the Reference quality tier.
//
// Delta tracking for collisions and ratio tracking for sun visibility, against a majorant
// of params.cloud.z (density x weather scale x profile never exceeds it). Albedo is 1 and
// phase sampling is the same dual Henyey-Greenstein, so the path throughput stays 1 until
// Russian roulette. Sun is next-event estimated; the sky cube (which has no sun disk) is
// what an escaping path sees. The ground is Lambertian with the scene albedo: it gets sun
// through the clouds and unoccluded sky irradiance, and ends the path.
// Each sample stores (scatter, 1 - hit) with the same haze fade as march(), so the
// display composites both renderers the same way.

struct Rng { state: u32 }

fn rng_next(r: ptr<function, Rng>) -> f32 {
  (*r).state = (*r).state * 747796405u + 2891336453u;
  var w = (((*r).state >> (((*r).state >> 28u) + 4u)) ^ (*r).state) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w >> 8u) * (1.0 / 16777216.0);
}

fn reference_extinction(p: vec3f) -> f32 {
  // mip 0 with jitter 0 always takes the detail branch.
  // The reference sees all the detail: it is the ground truth for the approximations.
  return media_at(p, 1.0);
}

// Distance along dir until the ray leaves the cloud shell (from inside or below it).
// Returns (enter, exit); exit < 0 when the ray never touches the shell.
fn shell_interval(o: vec3f, dir: vec3f) -> vec2f {
  let r_bottom = ground_radius() + cloud_bottom();
  let r_top = ground_radius() + cloud_top();
  let top = ray_sphere(o, dir, r_top);
  if (top.y <= 0.0) { return vec2f(-1.0); }
  // skyCaptain: the eye can be below, inside or above the layer (Elevation). Start where the
  // ray is first inside the top sphere and outside the bottom one; stop at the bottom sphere
  // or the top, and never past the ground. (A ray grazing the bottom sphere from above can
  // re-enter the layer beyond it; that far piece is dropped.)
  var t0 = max(top.x, 0.0);
  var t1 = top.y;
  let bottom = ray_sphere(o, dir, r_bottom);
  if (bottom.y > 0.0) {
    if (bottom.x <= t0) { t0 = max(t0, bottom.y); } else { t1 = min(t1, bottom.x); }
  }
  let ground = ground_hit(length(o), dir, ground_radius());
  if (ground > 0.0) { t1 = min(t1, ground); }
  if (t1 <= t0) { return vec2f(-1.0); }
  return vec2f(t0, t1);
}

struct Collision {
  hit: bool,
  t: f32,
}

fn delta_track(o: vec3f, dir: vec3f, t0: f32, t1: f32, majorant: f32, rng: ptr<function, Rng>) -> Collision {
  var c: Collision;
  c.hit = false;
  c.t = t0;
  for (var i = 0; i < 100000; i++) {
    c.t -= log(1.0 - rng_next(rng)) / majorant;
    if (c.t >= t1) { return c; }
    if (rng_next(rng) * majorant < reference_extinction(o + dir * c.t)) {
      c.hit = true;
      return c;
    }
  }
  return c;
}

// Ratio tracking with Russian roulette below 0.1.
fn ratio_track(o: vec3f, dir: vec3f, majorant: f32, rng: ptr<function, Rng>) -> f32 {
  let span = shell_interval(o, dir);
  if (span.y <= 0.0) { return 1.0; }
  var t = span.x;
  var transmittance = 1.0;
  for (var i = 0; i < 100000; i++) {
    t -= log(1.0 - rng_next(rng)) / majorant;
    if (t >= span.y) { break; }
    transmittance *= 1.0 - reference_extinction(o + dir * t) / majorant;
    if (transmittance < 0.1) {
      if (rng_next(rng) > transmittance * 10.0) { return 0.0; }
      transmittance = 0.1;
    }
  }
  return transmittance;
}

fn orthonormal(n: vec3f) -> mat3x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  return mat3x3f(vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x), vec3f(b, s + n.y * n.y * a, -n.y), n);
}

fn sample_hg(wo: vec3f, g: f32, u: vec2f) -> vec3f {
  var cos_theta: f32;
  if (abs(g) < 1e-3) {
    cos_theta = 1.0 - 2.0 * u.x;
  } else {
    let s = (1.0 - g * g) / (1.0 - g + 2.0 * g * u.x);
    cos_theta = (1.0 + g * g - s * s) / (2.0 * g);
  }
  let sin_theta = sqrt(max(0.0, 1.0 - cos_theta * cos_theta));
  let phi = 2.0 * PI * u.y;
  return orthonormal(wo) * vec3f(sin_theta * cos(phi), sin_theta * sin(phi), cos_theta);
}

fn sample_phase(wo: vec3f, rng: ptr<function, Rng>) -> vec3f {
  let u = vec2f(rng_next(rng), rng_next(rng));
  if (rng_next(rng) < params.light.w) { return sample_hg(wo, -params.light.z, u); }
  return sample_hg(wo, params.light.y, u);
}

fn reference_path(dir0: vec3f, rng: ptr<function, Rng>) -> vec4f {
  let origin = eye();
  // The ground uses the same analytic shading as the fast renderer (without the ground
  // buffer: the reference is for judging clouds).
  var ground = vec3f(0.0);
  let jitter = vec3f(rng_next(rng), rng_next(rng), rng_next(rng));
  let t_ground = terrain_hit(origin, dir0, jitter.x);
  if (t_ground > 0.0) {
    ground = ground_radiance(origin, dir0, t_ground, jitter).radiance + air_inscatter(origin, dir0, t_ground);
  }
  var span0 = shell_interval(origin, dir0);
  if (t_ground > 0.0 && span0.y > 0.0) { span0.y = min(span0.y, t_ground); }
  let open_sky = select(1.0, 0.0, t_ground > 0.0);
  if (span0.y <= 0.0) { return vec4f(ground, open_sky); }
  let majorant = max(params.cloud.z, 1e-3);
  let first = delta_track(origin, dir0, span0.x, min(span0.y, span0.x + MAX_RAY_KM), majorant, rng);
  if (!first.hit) { return vec4f(ground, open_sky); }

  let sun = params.sun_dir.xyz;
  let illum = params.sun_color.rgb * params.sun_dir.w;
  let sky_top = textureSampleLevel(sky_tex, clamp_sampler, vec3f(0.0, 1.0, 0.0), 0.0).rgb;
  let sky_side = (textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(1.0, 0.25, 0.0)), 0.0).rgb
                + textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(-1.0, 0.25, 0.0)), 0.0).rgb
                + textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(0.0, 0.25, 1.0)), 0.0).rgb
                + textureSampleLevel(sky_tex, clamp_sampler, normalize(vec3f(0.0, 0.25, -1.0)), 0.0).rgb) * 0.25;
  let ground_sky_irradiance = PI * (sky_top * 0.5 + sky_side * 0.5);

  var p = origin + dir0 * first.t;
  var dir = dir0;
  var throughput = 1.0;
  var radiance = vec3f(0.0);
  for (var bounce = 0; bounce < 256; bounce++) {
    // Next-event estimation toward the sun.
    let visibility = ratio_track(p, sun, majorant, rng);
    radiance += throughput * illum * sun_transmittance(p) * phase(dot(dir, sun), 1.0) * visibility;

    if (bounce >= 8) {
      if (rng_next(rng) > 0.9) { break; }
      throughput /= 0.9;
    }
    dir = sample_phase(dir, rng);
    let span = shell_interval(p, dir);
    if (span.y <= 0.0) {
      radiance += throughput * textureSampleLevel(sky_tex, clamp_sampler, dir, 0.0).rgb;
      break;
    }
    let c = delta_track(p, dir, span.x, span.y, majorant, rng);
    if (c.hit) {
      p += dir * c.t;
      continue;
    }
    // Left the shell: through the top into the sky, or through the bottom to the ground.
    let exit = p + dir * span.y;
    if (length(exit) > ground_radius() + cloud_bottom() + 1e-3) {
      radiance += throughput * textureSampleLevel(sky_tex, clamp_sampler, dir, 0.0).rgb;
      break;
    }
    let ground_hit = ray_sphere(exit, dir, ground_radius());
    if (ground_hit.x <= 0.0) {
      // Grazes the bottom of the shell without reaching the ground: look at the sky.
      radiance += throughput * textureSampleLevel(sky_tex, clamp_sampler, dir, 0.0).rgb;
      break;
    }
    let g = exit + dir * ground_hit.x;
    let n = normalize(g);
    let cos_sun = max(dot(n, sun), 0.0);
    let sun_ground = illum * sun_transmittance(g) * cos_sun * ratio_track(g, sun, majorant, rng);
    radiance += throughput * params.misc.y / PI * (ground_sky_irradiance + sun_ground);
    break;
  }
  let fade = exp(-first.t / (params.misc.x * 3.0));
  return vec4f(radiance * fade, 1.0 - fade);
}

@compute @workgroup_size(8, 8, 1)
fn render_reference(@builtin(global_invocation_id) id: vec3u) {
  let size = u32(params.march.z);
  let blocks = size / 4u;
  if (id.x >= blocks || id.y >= blocks) { return; }
  let face = id.z;
  let frame = u32(params.march.w);
  let slot = frame % 16u;
  let pass_index = frame / 16u;
  let texel = id.xy * 4u + BAYER_OFFSETS[slot];
  var rng: Rng;
  rng.state = pcg3d(vec3u(texel.x + face * size, texel.y, frame)).x;
  let sub = vec2f(rng_next(&rng), rng_next(&rng));
  let dir = cube_dir(face, (vec2f(texel) + sub) / f32(size));
  let value = reference_path(dir, &rng);
  resolve_texel(id.xy, texel, face, size, slot, pass_index, value, vec4f(0.0));
}

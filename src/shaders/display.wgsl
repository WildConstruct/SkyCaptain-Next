// Viewport: looks around the environment cube from the fixed eye.
// The environment value (sky * T + cloud scatter + sun disc) is scene-linear.
// PREVIEW ONLY: exposure + ACES-fit tone map + sRGB encode happen here and nowhere else.

struct View {
  right: vec4f,    // xyz, w = tan(fov/2) * aspect
  up: vec4f,       // xyz, w = tan(fov/2)
  forward: vec4f,  // xyz, w = exposure (EV)
  film: vec4f,     // grain amount, softness (blur radius, px), grain seed, unused
  lens: vec4f,     // (post.wgsl)
  glow: vec4f,     // (post.wgsl)
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<uniform> view: View;
@group(0) @binding(2) var cube_sampler: sampler;
@group(0) @binding(3) var sky_tex: texture_cube<f32>;
@group(0) @binding(4) var cloud_tex: texture_cube<f32>;
@group(0) @binding(5) var transmittance_lut: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> downwelling: vec4f;
// Ground terrain (ground.wgsl).
// Declared for ground.wgsl; unused here (the cloud pass reads the layout).
@group(0) @binding(7) var terrain_tex: texture_2d<f32>;
@group(0) @binding(8) var<uniform> ground: Ground;
// Wind waves (ocean.wgsl), for the water's mirror.
@group(0) @binding(10) var ocean_tex: texture_2d_array<f32>;
@group(0) @binding(11) var ocean_sampler: sampler;
// What the cloud pass saw of the ground per direction (clouds.wgsl GroundHit).
@group(0) @binding(9) var ground_tex: texture_cube<f32>;

// The cloud pass's ground shadow map (composite.wgsl).
@group(0) @binding(12) var shadow_tex: texture_2d<f32>;

fn seen_ground(dir: vec3f) -> vec4f { return textureSampleLevel(ground_tex, cube_sampler, dir, 0.0); }

fn mirror_radiance(r: vec3f) -> vec3f {
  let cloud = textureSampleLevel(cloud_tex, cube_sampler, r, 0.0);
  return textureSampleLevel(sky_tex, cube_sampler, r, 0.0).rgb * cloud.a + cloud.rgb;
}

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: VsOut;
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.ndc = uv * 2.0 - 1.0;
  return out;
}

fn environment(dir: vec3f, pixel: f32) -> vec3f {
  let sky = textureSampleLevel(sky_tex, cube_sampler, dir, 0.0).rgb;
  let cloud = textureSampleLevel(cloud_tex, cube_sampler, dir, 0.0);
  var background = sky;
  let sun = params.sun_dir.xyz;
  let radius = params.sun_color.w;
  let cos_angle = dot(dir, sun);
  let eye_alt = eye_altitude(params.anim.y);
  if (cos_angle > cos(radius) && ground_hit(params.layer.z + eye_alt, dir, params.layer.z) < 0.0) {
    let mu = dir.y;
    let h = clamp(eye_alt / (params.layer.w - params.layer.z), 0.0, 1.0);
    let t = textureSampleLevel(transmittance_lut, cube_sampler, vec2f(mu * 0.5 + 0.5, h), 0.0).rgb;
    let solid_angle = 2.0 * PI * (1.0 - cos(radius));
    let disc = params.sun_color.rgb * params.sun_dir.w / solid_angle * t;
    // Soft limb darkening.
    let r = acos(clamp(cos_angle, -1.0, 1.0)) / radius;
    background += disc * (1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - r * r))));
  }
  // The ground's share already carries the clouds in front of it.
  return background * cloud.a + cloud.rgb + ground_ambient(dir, pixel);
}

fn view_dir(ndc: vec2f) -> vec3f {
  return normalize(view.forward.xyz + ndc.x * view.right.w * view.right.xyz + ndc.y * view.up.w * view.up.xyz);
}

// The scene, scene-linear and exposed, for the camera pass (post.wgsl) to image through a
// lens and onto film. Preview and clips only; the HDRI export never sees either pass.
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  // The angle one pixel spans, for resolving water per pixel (composite.wgsl).
  let pixel = length(dpdy(in.ndc)) * view.up.w;
  // Held inside half-float range: a single glitter facet can be brighter than that.
  return vec4f(min(environment(view_dir(in.ndc), pixel) * exp2(view.forward.w), vec3f(6e4)), 1.0);
}

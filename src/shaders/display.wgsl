// Viewport: looks around the environment cube from the fixed eye.
// The environment value (sky * T + cloud scatter + sun disc) is scene-linear.
// PREVIEW ONLY: exposure + ACES-fit tone map + sRGB encode happen here and nowhere else.

struct View {
  right: vec4f,    // xyz, w = tan(fov/2) * aspect
  up: vec4f,       // xyz, w = tan(fov/2)
  forward: vec4f,  // xyz, w = exposure (EV)
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<uniform> view: View;
@group(0) @binding(2) var cube_sampler: sampler;
@group(0) @binding(3) var sky_tex: texture_cube<f32>;
@group(0) @binding(4) var cloud_tex: texture_cube<f32>;
@group(0) @binding(5) var transmittance_lut: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> downwelling: vec4f;

// Sky and cloud light on the ground (the direct sun is already in the cloud cube): the
// downwelling irradiance integrated from the finished cube, through the air in front.
fn ground_ambient(dir: vec3f) -> vec3f {
  let uvs = ground_air_uvs(dir, params.layer.z, params.layer.w, eye_altitude(params.anim.y));
  if (uvs.x < 0.0) { return vec3f(0.0); }
  let air = clamp(
    textureSampleLevel(transmittance_lut, cube_sampler, uvs.xy, 0.0).rgb
      / max(textureSampleLevel(transmittance_lut, cube_sampler, uvs.zw, 0.0).rgb, vec3f(1e-6)),
    vec3f(0.0), vec3f(1.0));
  // From above the clouds the ground's sky light is computed per point in the cloud pass.
  let below = 1.0 - smoothstep(params.layer.x, params.layer.x + 0.3, eye_altitude(params.anim.y));
  return air * params.misc.y / PI * downwelling.rgb * below;
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

fn environment(dir: vec3f) -> vec3f {
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
  // Clouds between the eye and the ground (from above) hide its sky light too.
  return (background + ground_ambient(dir)) * cloud.a + cloud.rgb;
}

fn aces_fit(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn srgb_encode(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let dir = normalize(view.forward.xyz + in.ndc.x * view.right.w * view.right.xyz + in.ndc.y * view.up.w * view.up.xyz);
  let linear = environment(dir);
  let exposed = linear * exp2(view.forward.w);
  return vec4f(srgb_encode(aces_fit(exposed)), 1.0);
}

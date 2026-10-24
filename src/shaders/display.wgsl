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

// Sky and cloud light on the ground (the direct sun is already in the cloud cube): the
// downwelling irradiance integrated from the finished cube, times what the cloud pass saw of
// the ground in this direction (albedo through the air and the clouds in front), plus on
// water the mirror of the finished sky and clouds. Water lies at sea level, so its point is
// the sea-level hit; relief in front has already zeroed the water share.
const WATER_TAPS: i32 = 8;

fn ground_ambient(dir: vec3f) -> vec3f {
  let seen = textureSampleLevel(ground_tex, cube_sampler, dir, 0.0);
  var light = seen.rgb / PI * downwelling.rgb;
  if (seen.a > 0.0) {
    let eye_alt = eye_altitude(params.anim.y);
    let eye_r = params.layer.z + eye_alt;
    let t = ground_hit(eye_r, dir, params.layer.z);
    if (t > 0.0) {
      let uvs = ground_air_uvs(dir, params.layer.z, params.layer.w, eye_alt);
      let air = clamp(
        textureSampleLevel(transmittance_lut, cube_sampler, uvs.xy, 0.0).rgb
          / max(textureSampleLevel(transmittance_lut, cube_sampler, uvs.zw, 0.0).rgb, vec3f(1e-6)),
        vec3f(0.0), vec3f(1.0));
      let g = vec3f(0.0, eye_r, 0.0) + dir * t;
      let up = normalize(g);
      // The same surface the cloud pass lit: footprint of one cube texel (clouds.wgsl).
      let footprint = t * 1000.0 * (0.5 * PI / params.march.z) / sqrt(max(abs(dot(dir, up)), 0.01));
      let w = water_surface(g.xz, up, footprint);
      let n = w.normal;
      var mirrored = vec3f(0.0);
      // The reflection through a GGX lobe as wide as the hidden waves: a fixed spiral of taps
      // around the mirror direction, so distant water reflects a soft sky band, not speckle.
      let r0 = reflect(dir, n);
      let bx = normalize(cross(r0, up + vec3f(1e-3, 0.0, 0.0)));
      let by = cross(r0, bx);
      for (var i = 0; i < WATER_TAPS; i++) {
        let a = (f32(i) + 0.5) / f32(WATER_TAPS);
        let spin = f32(i) * 2.39996;
        var r = normalize(r0 + (bx * cos(spin) + by * sin(spin)) * w.alpha * sqrt(a));
        // Waves can tip a reflection below the horizon: bend it back up along the surface
        // (ABYSSAL OceanMesh.js), toward the bright band just above the horizon.
        let below = dot(r, up);
        if (below < 0.0) { r = normalize(r + up * (mix(0.02, 0.35, sqrt(w.alpha)) - below * 1.15)); }
        let cloud = textureSampleLevel(cloud_tex, cube_sampler, r, 0.0);
        mirrored += textureSampleLevel(sky_tex, cube_sampler, r, 0.0).rgb * cloud.a + cloud.rgb;
      }
      mirrored /= f32(WATER_TAPS);
      light += water_fresnel(max(dot(-dir, n), 1e-4)) * mirrored * air * seen.a;
    }
  }
  return light;
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
  // The ground's share already carries the clouds in front of it.
  return background * cloud.a + cloud.rgb + ground_ambient(dir);
}

fn view_dir(ndc: vec2f) -> vec3f {
  return normalize(view.forward.xyz + ndc.x * view.right.w * view.right.xyz + ndc.y * view.up.w * view.up.xyz);
}

// The scene, scene-linear and exposed, for the camera pass (post.wgsl) to image through a
// lens and onto film. Preview and clips only; the HDRI export never sees either pass.
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(environment(view_dir(in.ndc)) * exp2(view.forward.w), 1.0);
}

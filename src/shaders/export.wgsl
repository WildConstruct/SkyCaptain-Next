// HDRI export: composites the environment into an equirectangular (lat-long) image.
// Scene-linear, no exposure or tone mapping. Same composite as display.wgsl, plus a
// supersampled sun disc so its energy survives at any output resolution.
// Convention: u = 0.5 looks north (+Z, the default view), u increases toward east (+X);
// v = 0 is the zenith.
// The cubes are sampled per face as 2D arrays (clamped inside the face) instead of through
// seamless cube filtering, which some drivers get wrong at face edges in compute shaders.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var cube_sampler: sampler;
@group(0) @binding(2) var sky_tex: texture_2d_array<f32>;
@group(0) @binding(3) var cloud_tex: texture_2d_array<f32>;
@group(0) @binding(4) var transmittance_lut: texture_2d<f32>;
@group(0) @binding(5) var out_latlong: texture_storage_2d<rgba32float, write>;

struct FaceUv {
  face: u32,
  uv: vec2f,
}

// Inverse of cube_dir() in common.wgsl.
fn cube_face_uv(d: vec3f) -> FaceUv {
  let a = abs(d);
  var r: FaceUv;
  var st: vec2f;
  if (a.x >= a.y && a.x >= a.z) {
    if (d.x > 0.0) { r.face = 0u; st = vec2f(-d.z, -d.y) / a.x; } else { r.face = 1u; st = vec2f(d.z, -d.y) / a.x; }
  } else if (a.y >= a.z) {
    if (d.y > 0.0) { r.face = 2u; st = vec2f(d.x, d.z) / a.y; } else { r.face = 3u; st = vec2f(d.x, -d.z) / a.y; }
  } else {
    if (d.z > 0.0) { r.face = 4u; st = vec2f(d.x, -d.y) / a.z; } else { r.face = 5u; st = vec2f(-d.x, -d.y) / a.z; }
  }
  r.uv = st * 0.5 + 0.5;
  return r;
}

fn sample_face(tex: texture_2d_array<f32>, d: vec3f) -> vec4f {
  let f = cube_face_uv(d);
  let half_texel = 0.5 / f32(textureDimensions(tex).x);
  let uv = clamp(f.uv, vec2f(half_texel), vec2f(1.0 - half_texel));
  return textureSampleLevel(tex, cube_sampler, uv, f.face, 0.0);
}

fn latlong_dir(uv: vec2f) -> vec3f {
  let phi = (uv.x - 0.5) * 2.0 * PI;
  let el = (0.5 - uv.y) * PI;
  return vec3f(sin(phi) * cos(el), sin(el), cos(phi) * cos(el));
}

fn sun_disc(dir: vec3f) -> vec3f {
  let sun = params.sun_dir.xyz;
  let radius = params.sun_color.w;
  let cos_angle = dot(dir, sun);
  if (cos_angle < cos(radius) || dir.y <= 0.0) { return vec3f(0.0); }
  let t = textureSampleLevel(transmittance_lut, cube_sampler, vec2f(dir.y * 0.5 + 0.5, 0.0), 0.0).rgb;
  let solid_angle = 2.0 * PI * (1.0 - cos(radius));
  let r = acos(clamp(cos_angle, -1.0, 1.0)) / radius;
  let limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - r * r)));
  return params.sun_color.rgb * params.sun_dir.w / solid_angle * t * limb;
}

@compute @workgroup_size(8, 8)
fn composite(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(out_latlong);
  if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let dir = latlong_dir(uv);
  let sky = sample_face(sky_tex, dir).rgb;
  let cloud = sample_face(cloud_tex, dir);

  // Supersample the sun disc only near the sun (4x4 per texel).
  var sun = vec3f(0.0);
  let texel_angle = PI / f32(size.y);
  if (dot(dir, params.sun_dir.xyz) > cos(params.sun_color.w + texel_angle * 2.0)) {
    for (var j = 0u; j < 4u; j++) {
      for (var i = 0u; i < 4u; i++) {
        let sub = (vec2f(id.xy) + (vec2f(f32(i), f32(j)) + 0.5) / 4.0) / vec2f(size);
        sun += sun_disc(latlong_dir(sub));
      }
    }
    sun /= 16.0;
  }
  textureStore(out_latlong, id.xy, vec4f((sky + sun) * cloud.a + cloud.rgb, 1.0));
}

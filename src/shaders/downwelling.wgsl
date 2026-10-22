// Downwelling irradiance at the eye: what the composited environment (sky through clouds,
// plus the light the clouds scatter) delivers onto level ground. One workgroup integrates
// a fixed cosine-weighted set of upper-hemisphere directions, so with cosine-weighted
// sampling E = pi * mean(L). The sun disc is not in the cubes, so direct sun is added
// separately (with its cloud shadow) by the ground shading in clouds.wgsl.

@group(0) @binding(0) var cube_sampler: sampler;
@group(0) @binding(1) var sky_tex: texture_cube<f32>;
@group(0) @binding(2) var cloud_tex: texture_cube<f32>;
@group(0) @binding(3) var<storage, read_write> downwelling: vec4f;

const SAMPLES_PER_THREAD: u32 = 16u;
const THREADS: u32 = 64u;
var<workgroup> partial: array<vec3f, 64>;

fn hemisphere_dir(i: u32, n: u32) -> vec3f {
  // Cosine-weighted Fibonacci spiral over the upper hemisphere (y up).
  let golden = 2.39996322972865332;
  // Stops just above the horizon (y >= 0.02): filtering at the horizon would blend in texels
  // below it (the ground and the air in front of it), which are not sky light.
  let fi = (f32(i) + 0.5) / f32(n) * 0.9996;
  let r = sqrt(fi);
  let phi = f32(i) * golden;
  return vec3f(r * cos(phi), sqrt(max(0.0, 1.0 - fi)), r * sin(phi));
}

@compute @workgroup_size(64)
fn integrate(@builtin(local_invocation_index) lid: u32) {
  let n = SAMPLES_PER_THREAD * THREADS;
  var sum = vec3f(0.0);
  for (var k = 0u; k < SAMPLES_PER_THREAD; k++) {
    let dir = hemisphere_dir(lid + k * THREADS, n);
    let sky = textureSampleLevel(sky_tex, cube_sampler, dir, 0.0).rgb;
    let cloud = textureSampleLevel(cloud_tex, cube_sampler, dir, 0.0);
    sum += sky * cloud.a + cloud.rgb;
  }
  partial[lid] = sum;
  workgroupBarrier();
  for (var stride = THREADS / 2u; stride > 0u; stride /= 2u) {
    if (lid < stride) { partial[lid] += partial[lid + stride]; }
    workgroupBarrier();
  }
  if (lid == 0u) {
    downwelling = vec4f(PI * partial[0] / f32(n), 1.0);
  }
}

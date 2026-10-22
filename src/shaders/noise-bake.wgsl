// Bake entry points for the tileable noise volumes (functions live in noise.wgsl).

@group(0) @binding(0) var shape_out: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var detail_out: texture_storage_3d<rgba8unorm, write>;

// Raw Worley fBm sits in a narrow band (about 0.3..0.7); stretch it to the full range so
// coverage and erosion thresholds actually carve.
fn stretched_worley(uvw: vec3f, freq: i32) -> f32 {
  return clamp(remap(worley_fbm(uvw, freq), 0.3, 0.68, 0.0, 1.0), 0.0, 1.0);
}

@compute @workgroup_size(4, 4, 4)
fn bake_shape(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(shape_out);
  if (any(id >= size)) { return; }
  let uvw = (vec3f(id) + 0.5) / vec3f(size);
  let p = clamp(perlin_fbm(uvw, 4, 6) * 0.5 + 0.5, 0.0, 1.0);
  let w4 = stretched_worley(uvw, 4);
  // Perlin-Worley: Perlin billows with Worley-carved cells (Schneider 2015), stretched from
  // its measured 0.5..1 band to the full range.
  let pw = clamp(remap(remap(p, 0.0, 1.0, w4, 1.0), 0.5, 1.0, 0.0, 1.0), 0.0, 1.0);
  textureStore(shape_out, id, vec4f(pw, w4, stretched_worley(uvw, 8), stretched_worley(uvw, 16)));
}

@compute @workgroup_size(4, 4, 4)
fn bake_detail(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(detail_out);
  if (any(id >= size)) { return; }
  let uvw = (vec3f(id) + 0.5) / vec3f(size);
  textureStore(detail_out, id, vec4f(stretched_worley(uvw, 2), stretched_worley(uvw, 4), stretched_worley(uvw, 8), 1.0));
}

// Bake entry points for the tileable noise volumes (functions live in noise.wgsl).

@group(0) @binding(0) var shape_out: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var detail_out: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(4, 4, 4)
fn bake_shape(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(shape_out);
  if (any(id >= size)) { return; }
  let uvw = (vec3f(id) + 0.5) / vec3f(size);
  let p = clamp(perlin_fbm(uvw, 4, 6) * 0.5 + 0.5, 0.0, 1.0);
  let w4 = worley_fbm(uvw, 4);
  // Perlin-Worley: Perlin billows with Worley-carved cells (Schneider 2015). The final remap
  // restores contrast so empty space exists before coverage is applied; otherwise moderate
  // coverage fills the sky with a low-density veil.
  let pw = clamp(remap(remap(p, 0.0, 1.0, w4, 1.0), 0.45, 1.0, 0.0, 1.0), 0.0, 1.0);
  textureStore(shape_out, id, vec4f(pw, w4, worley_fbm(uvw, 8), worley_fbm(uvw, 16)));
}

@compute @workgroup_size(4, 4, 4)
fn bake_detail(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(detail_out);
  if (any(id >= size)) { return; }
  let uvw = (vec3f(id) + 0.5) / vec3f(size);
  textureStore(detail_out, id, vec4f(worley_fbm(uvw, 2), worley_fbm(uvw, 4), worley_fbm(uvw, 8), 1.0));
}

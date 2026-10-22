// Procedural base weather map. Later, shape and paint layers composite on top of this.
// r = coverage potential, g = cloud type (0 stratus .. 1 towering), b = density multiplier.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var weather_out: texture_storage_2d<rgba8unorm, write>;

fn weather_fbm(uv: vec2f, freq: i32, seed: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var fq = freq;
  for (var o = 0; o < 5; o++) {
    sum += perlin(vec3f(uv * f32(fq), seed + f32(o) * 1.37), fq) * amp;
    norm += amp;
    amp *= 0.5;
    fq *= 2;
  }
  return sum / norm * 0.5 + 0.5;
}

@compute @workgroup_size(8, 8)
fn generate(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(weather_out);
  if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let seed = params.misc.z;
  let coverage = smoothstep(0.4, 0.75, weather_fbm(uv, 4, seed));
  let kind = smoothstep(0.3, 0.7, weather_fbm(uv, 2, seed + 11.0));
  let density = mix(0.6, 1.0, weather_fbm(uv, 8, seed + 23.0));
  textureStore(weather_out, id.xy, vec4f(coverage, kind, density, 1.0));
}

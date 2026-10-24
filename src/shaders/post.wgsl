// Camera: the exposed, scene-linear view (display.wgsl fs) imaged through a lens onto film.
// Preview and clips only; the HDRI export never sees it.
//
// Lens: the scene is at least a couple of hundred metres away, so with the focus on a
// subject a few metres off, all of it is blurred by the same circle of confusion (the depth
// term 1 - focus / distance is within ~1.5% of 1 beyond 200 m). One disc gather of that
// radius, plus softness, is the depth of field. Taps read the mip whose texel matches their
// spacing, so a sun glint opens into a smooth bokeh disc instead of a ring of copies.
// Lateral chromatic aberration scales red and blue about the centre. Glow: veiling glare
// (bloom) and film halation (red light scattered back from the film base, a warm halo on
// highlights) are energy-preserving mixes toward wide blurs from the mips. Vignette is the
// natural cos^4 falloff of the lens's own field of view. Then the tone curve and grain.

struct View {
  right: vec4f,    // xyz, w = tan(horizontal fov / 2)
  up: vec4f,       // xyz, w = tan(vertical fov / 2)
  forward: vec4f,  // xyz, w = exposure (EV)
  film: vec4f,     // grain amount, softness (blur radius, px), grain seed, unused
  lens: vec4f,     // blur radius (fraction of image width), chromatic aberration, vignette, unused
  glow: vec4f,     // bloom, halation, unused, unused
}

@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: VsOut;
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(uv.x, 1.0 - uv.y);
  return out;
}

// One mip down through a 13-tap filter (Jimenez, "Next generation post processing in Call
// of Duty", 2014): overlapping boxes, so the chain stays round and smooth instead of
// blocky. scene is bound to the source level alone here.
@fragment
fn fs_down(in: VsOut) -> @location(0) vec4f {
  let o = 1.0 / vec2f(textureDimensions(scene, 0));
  let s = in.uv;
  let a = textureSampleLevel(scene, linear_sampler, s + vec2f(-2.0, -2.0) * o, 0.0).rgb;
  let b = textureSampleLevel(scene, linear_sampler, s + vec2f(0.0, -2.0) * o, 0.0).rgb;
  let c = textureSampleLevel(scene, linear_sampler, s + vec2f(2.0, -2.0) * o, 0.0).rgb;
  let d = textureSampleLevel(scene, linear_sampler, s + vec2f(-2.0, 0.0) * o, 0.0).rgb;
  let e = textureSampleLevel(scene, linear_sampler, s, 0.0).rgb;
  let f = textureSampleLevel(scene, linear_sampler, s + vec2f(2.0, 0.0) * o, 0.0).rgb;
  let g = textureSampleLevel(scene, linear_sampler, s + vec2f(-2.0, 2.0) * o, 0.0).rgb;
  let h = textureSampleLevel(scene, linear_sampler, s + vec2f(0.0, 2.0) * o, 0.0).rgb;
  let i = textureSampleLevel(scene, linear_sampler, s + vec2f(2.0, 2.0) * o, 0.0).rgb;
  let j = textureSampleLevel(scene, linear_sampler, s + vec2f(-1.0, -1.0) * o, 0.0).rgb;
  let k = textureSampleLevel(scene, linear_sampler, s + vec2f(1.0, -1.0) * o, 0.0).rgb;
  let l = textureSampleLevel(scene, linear_sampler, s + vec2f(-1.0, 1.0) * o, 0.0).rgb;
  let m = textureSampleLevel(scene, linear_sampler, s + vec2f(1.0, 1.0) * o, 0.0).rgb;
  let sum = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  return vec4f(sum, 1.0);
}

const LENS_TAPS: i32 = 48;
const GOLDEN_ANGLE: f32 = 2.39996323;

fn aces_fit(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn srgb_encode(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

// The scene at uv through the lens's lateral colour: red imaged slightly larger than green,
// blue slightly smaller.
fn lens_sample(uv: vec2f, lod: f32) -> vec3f {
  let ca = view.lens.y;
  if (ca <= 0.0) { return textureSampleLevel(scene, linear_sampler, uv, lod).rgb; }
  let c = uv - 0.5;
  return vec3f(
    textureSampleLevel(scene, linear_sampler, 0.5 + c * (1.0 - ca), lod).r,
    textureSampleLevel(scene, linear_sampler, uv, lod).g,
    textureSampleLevel(scene, linear_sampler, 0.5 + c * (1.0 + ca), lod).b);
}

// Mip level lod read through a cubic B-spline (four bilinear taps), so a small level opens
// into a smooth blur rather than visible texels.
fn blur_at(uv: vec2f, lod: f32) -> vec3f {
  let size = vec2f(textureDimensions(scene, i32(lod)));
  let p = uv * size - 0.5;
  let i = floor(p);
  let f = p - i;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let h0 = (i - 0.5 + w1 / g0) / size;
  let h1 = (i + 1.5 + w3 / g1) / size;
  return (textureSampleLevel(scene, linear_sampler, vec2f(h0.x, h0.y), lod).rgb * g0.x
    + textureSampleLevel(scene, linear_sampler, vec2f(h1.x, h0.y), lod).rgb * g1.x) * g0.y
    + (textureSampleLevel(scene, linear_sampler, vec2f(h0.x, h1.y), lod).rgb * g0.x
    + textureSampleLevel(scene, linear_sampler, vec2f(h1.x, h1.y), lod).rgb * g1.x) * g1.y;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(scene, 0));
  let levels = f32(textureNumLevels(scene));
  let uv = in.uv;

  // Depth of field and softness: one disc of the combined radius, in pixels.
  let coc = view.lens.x * size.x;
  let soft = view.film.y;
  let radius = sqrt(coc * coc + soft * soft);
  var color: vec3f;
  if (radius < 0.5) {
    color = lens_sample(uv, 0.0);
  } else {
    let spacing = radius * sqrt(PI / f32(LENS_TAPS));
    let lod = clamp(log2(max(spacing, 1.0)), 0.0, levels - 1.0);
    var sum = vec3f(0.0);
    for (var i = 0; i < LENS_TAPS; i++) {
      let a = f32(i) * GOLDEN_ANGLE;
      let r = radius * sqrt((f32(i) + 0.5) / f32(LENS_TAPS));
      sum += lens_sample(uv + vec2f(cos(a), sin(a)) * r / size, lod);
    }
    color = sum / f32(LENS_TAPS);
  }

  // Glow: bloom is broad (levels 3 to 6), halation tight (levels 1 to 3), both mixes, so
  // light moves outward from highlights rather than being added.
  let bloom = view.glow.x;
  let halation = view.glow.y;
  if (bloom > 0.0 || halation > 0.0) {
    let top = levels - 1.0;
    let b1 = blur_at(uv, min(1.0, top));
    let b2 = blur_at(uv, min(2.0, top));
    let b3 = blur_at(uv, min(3.0, top));
    if (bloom > 0.0) {
      let wide = b3 * 0.2 + blur_at(uv, min(4.0, top)) * 0.25 + blur_at(uv, min(5.0, top)) * 0.25 + blur_at(uv, min(6.0, top)) * 0.3;
      color = mix(color, wide, bloom);
    }
    if (halation > 0.0) {
      let halo = b1 * 0.3 + b2 * 0.4 + b3 * 0.3;
      color = mix(color, halo, halation * vec3f(1.0, 0.32, 0.06));
    }
  }

  // Natural vignetting: cos^4 of the angle off the lens axis.
  let vignette = view.lens.z;
  if (vignette > 0.0) {
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let tan_off = ndc * vec2f(view.right.w, view.up.w);
    let cos2 = 1.0 / (1.0 + dot(tan_off, tan_off));
    color *= mix(1.0, cos2 * cos2, vignette);
  }

  var shown = srgb_encode(aces_fit(color));
  let grain = view.film.x;
  if (grain > 0.0) {
    let cell = vec3u(vec2u(in.position.xy), u32(view.film.z));
    let n = hash33(cell) + hash33(cell + vec3u(0u, 0u, 7919u)) - 1.0;
    let luma = dot(shown, vec3f(0.2126, 0.7152, 0.0722));
    shown += n * grain * (0.35 + 2.6 * luma * (1.0 - luma));
  }
  return vec4f(clamp(shown, vec3f(0.0), vec3f(1.0)), 1.0);
}

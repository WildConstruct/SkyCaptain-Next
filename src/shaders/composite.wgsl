// The ground's share of the composite, shared by the preview (display.wgsl) and the HDRI
// export (export.wgsl) so they agree. Each module provides:
//   seen_ground(dir) -> vec4f      the cloud pass's ground buffer (clouds.wgsl GroundHit)
//   mirror_radiance(r) -> vec3f    the finished sky and clouds along r
// and binds transmittance_lut, cube_sampler, shadow_tex (the cloud pass's ground shadow map:
// r = sun through the clouds, g = sun past the relief, over GROUND_SHADOW_KM at sea level),
// column_tex and repeat_sampler (the cloud pass's column map, for ground.wgsl under_deck).


const WATER_TAPS: i32 = 8;
// Glitter: the sun reflects off individual capillary facets about this big (m^2).
const FACET_M2: f32 = 4e-4;
// Sparkles re-draw this many times a second as the facets turn (shutter sub-frames see
// different ones, so motion blur averages the twinkle as film does).
const SPARKLE_RATE: f32 = 120.0;

// A Poisson count with mean lambda from two uniforms: exact by inversion for small means,
// the normal approximation for large ones.
fn poisson(lambda: f32, u: vec2f) -> f32 {
  if (lambda > 30.0) {
    let gauss = sqrt(-2.0 * log(max(u.x, 1e-7))) * cos(6.2831853 * u.y);
    return max(0.0, round(lambda + sqrt(lambda) * gauss));
  }
  var p = exp(-lambda);
  var cdf = p;
  var k = 0.0;
  for (var i = 0; i < 64; i++) {
    if (u.x <= cdf) { break; }
    k += 1.0;
    p *= lambda / k;
    cdf += p;
  }
  return k;
}

// Sky and cloud light on the ground (the direct sun on land is already in the cloud cube):
// the downwelling irradiance integrated from the finished cube, times what the cloud pass
// saw of the ground in this direction (albedo through the air and the clouds in front). On
// water, the mirror of the finished sky and clouds and, near the eye, the sun's glint.
// Water lies at sea level, so its point is the sea-level hit; relief in front has already
// zeroed the water share. pixel is the angle one output pixel spans (radians): water is
// resolved per pixel, finer than the cube, so glints stay sharp in the frame.
fn ground_ambient(dir: vec3f, pixel: f32) -> vec3f {
  let seen = seen_ground(dir);
  var light = seen.rgb / PI * downwelling.rgb;
  if (seen.a <= 0.0) { return light; }
  let eye_alt = eye_altitude(params.anim.y);
  let eye_r = params.layer.z + eye_alt;
  let t = ground_hit(eye_r, dir, params.layer.z);
  if (t <= 0.0) { return light; }
  let uvs = ground_air_uvs(dir, params.layer.z, params.layer.w, eye_alt);
  let air = clamp(
    textureSampleLevel(transmittance_lut, cube_sampler, uvs.xy, 0.0).rgb
      / max(textureSampleLevel(transmittance_lut, cube_sampler, uvs.zw, 0.0).rgb, vec3f(1e-6)),
    vec3f(0.0), vec3f(1.0));
  let g = vec3f(0.0, eye_r, 0.0) + dir * t;
  let up = normalize(g);
  // Never finer than a quarter of a cube texel: the cloud pass shaded the body at that.
  let angle = max(pixel, 0.125 * PI / params.march.z);
  let footprint = t * 1000.0 * angle / sqrt(max(abs(dot(dir, up)), 0.01));
  // The water one output pixel covers, m^2 (for counting glitter facets).
  let pixel_m = t * 1000.0 * max(pixel, 1e-6);
  let pixel_area = pixel_m * pixel_m / max(abs(dot(dir, up)), 0.01);
  let w = water_surface(g.xz, up, footprint);
  let n = w.normal;
  let v = -dir;
  let nov = max(dot(n, v), 1e-4);

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
    mirrored += mirror_radiance(r);
  }
  mirrored /= f32(WATER_TAPS);
  // Whitecaps hide the mirror under them.
  var water = water_fresnel(nov) * mirrored * (1.0 - w.foam);

  // The sun's glint (GGX widened by the sun disc, as clouds.wgsl water_radiance), lit
  // through the air above the water and the shadow map's clouds and relief.
  let near = near_glint(g.xz);
  let sun = params.sun_dir.xyz;
  let nol = dot(n, sun);
  let sun_up = dot(up, sun);
  if (near > 0.0 && sun_up > -0.05) {
    let shadow = textureSampleLevel(shadow_tex, cube_sampler, g.xz / GROUND_SHADOW_KM + 0.5, 0.0);
    let sun_air = textureSampleLevel(transmittance_lut, cube_sampler, vec2f(max(sun_up, 0.0) * 0.5 + 0.5, 0.0), 0.0).rgb;
    let sun_at_water = params.sun_color.rgb * params.sun_dir.w * sun_air * shadow.r * shadow.g;
    // Whitecaps near the eye, resolved per pixel (the cloud pass adds them farther out):
    // diffuse foam under the sky and the sun.
    let foam = FOAM_ALBEDO / PI * (downwelling.rgb + sun_at_water * max(sun_up, 0.0));
    water = mix(water, foam, w.foam * near);
    let h = normalize(sun + v);
    let disc = clamp(w.alpha + params.sun_color.w * 0.5, 0.0, 1.0);
    let widen = (w.alpha * w.alpha) / (disc * disc);
    let fs = 0.02 + 0.98 * pow(1.0 - max(dot(v, h), 1e-4), 5.0);
    if (nol > 0.0) {
      let noh = max(dot(n, h), 0.0);
      let glint = near * (1.0 - w.foam) * sun_at_water * ggx_d(noh, disc) * smith_vis(nov, nol, w.alpha) * fs * nol * widen;
      // Glitter: the glint is the mean over the pixel's facets; draw how many of them catch
      // the sun disc right now (a facet does when its normal lies in the sun's cone of half
      // vectors), so near water sparkles and far water, with millions of facets, is smooth.
      let sun_cone = 2.0 * PI * (1.0 - cos(params.sun_color.w));
      let p_facet = clamp(ggx_d(noh, w.alpha) * noh * sun_cone / (4.0 * max(dot(v, h), 1e-3)), 0.0, 1.0);
      let lambda = pixel_area / FACET_M2 * p_facet;
      var sparkle = 1.0;
      if (lambda < 1e4) {
        let cell = vec3u(bitcast<u32>(dir.x), bitcast<u32>(dir.y) ^ (bitcast<u32>(dir.z) * 747796405u), u32(ground.gusts.w * SPARKLE_RATE));
        sparkle = poisson(lambda, hash33(cell).xy) / max(lambda, 1e-3);
      }
      water += glint * min(sparkle, 1e3);
    }
  }
  return light + water * air * seen.a;
}

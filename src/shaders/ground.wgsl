// Ground surface: what the ground is at a point, from the terrain layout (src/terrain.ts,
// one land-cover type per tile) and procedural detail per type. Shared by the cloud pass
// (sun, cloud shadows), the composite (sky light, water reflections) and the export, so
// they all shade the same ground. Modules that include this declare:
//   terrain_tex: texture_2d<f32>  r = type index / 255, g = per-tile random, b = elevation
//   ground: Ground (uniform)
// Evaluated once per ground pixel, never per march step. Water also needs:
//   ocean_tex: texture_2d_array<f32> (ocean.wgsl: slope, squared slope, folding; mipmapped)
//   ocean_sampler: sampler (repeat, linear)

struct Ground {
  palette: array<vec4f, 6>, // linear albedo per type (rgb)
  info: vec4f,              // x = terrain on (0/1), y = tile size (km), z = grid side (tiles), w = seed
  relief: vec4f,            // x = highest ground (km, 0 = flat), y = ground height under the eye (km), z = snow line (km)
  waves: vec4f,             // tile size of ocean cascades 0..2 (m), wind over the water (m/s)
  place: vec4f,             // xy = where the eye stands in terrain space (km): the ground is offset by it
}

const T_WATER: u32 = 0u;
const T_SAND: u32 = 1u;
const T_MEADOW: u32 = 2u;
const T_FIELDS: u32 = 3u;
const T_FOREST: u32 = 4u;
const T_ROCK: u32 = 5u;

struct Surface {
  albedo: vec3f,
  water: f32,   // 1 on water: mirror-like, see water_normal()
}

fn ghash(p: vec2i, salt: u32) -> f32 {
  return hash33(vec3u(bitcast<u32>(p.x), bitcast<u32>(p.y), salt + u32(ground.info.w) * 7919u)).x;
}

// Smooth value noise, 0..1; p in noise cells.
fn gnoise(p: vec2f, salt: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = ghash(i, salt);
  let b = ghash(i + vec2i(1, 0), salt);
  let c = ghash(i + vec2i(0, 1), salt);
  let d = ghash(i + vec2i(1, 1), salt);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn gfbm(p: vec2f, salt: u32) -> f32 {
  return gnoise(p, salt) * 0.55 + gnoise(p * 2.13, salt + 1u) * 0.3 + gnoise(p * 4.37, salt + 2u) * 0.15;
}

fn terrain_texel(q: vec2f) -> vec4f {
  let grid = i32(ground.info.z);
  let cell = vec2i(floor(q));
  return textureLoad(terrain_tex, ((cell % grid) + grid) % grid, 0);
}

// The ground at xz (km, world space: the ground does not drift with the wind).
// How much of a detail of `feature` km survives a pixel footprint of `footprint` km: 1 while
// the pixel resolves it, fading to 0 (its average) once several features share a pixel.
// Without it sub-pixel detail aliases into speckle.
fn resolved(feature: f32, footprint: f32) -> f32 {
  return 1.0 - smoothstep(0.5 * feature, 2.0 * feature, footprint);
}

// Noise n (mean 0.5) over features of `feature` km, faded toward its mean by the footprint.
fn detail(n: f32, feature: f32, footprint: f32) -> f32 {
  return mix(0.5, n, resolved(feature, footprint));
}

// The ground at world_xz (km; the ground does not drift with the wind), seen by a pixel
// covering `footprint` km of it.
fn ground_surface(world_xz: vec2f, footprint: f32) -> Surface {
  var s: Surface;
  s.water = 0.0;
  if (ground.info.x < 0.5) {
    s.albedo = vec3f(params.misc.y);
    return s;
  }
  let tile = ground.info.y;
  let xz = world_xz + ground.place.xy;
  // Warp the tile grid so boundaries wander like coastlines and field edges, not pixels.
  let warp = vec2f(gfbm(xz / (tile * 0.9), 11u), gfbm(xz / (tile * 0.9), 23u)) - 0.5;
  let q = xz / tile + warp * 0.9;
  let texel = terrain_texel(q);
  let kind = u32(round(texel.r * 255.0));
  let base = ground.palette[min(kind, 5u)].rgb;
  let rand = texel.g;
  var albedo = base;
  switch kind {
    case T_WATER: {
      s.water = 1.0;
    }
    case T_SAND: {
      albedo = base * mix(0.85, 1.12, detail(gnoise(xz / 0.03, 31u), 0.03, footprint));
    }
    case T_MEADOW: {
      // Broad tonal drifts with a yellower cast where it is drier.
      let drift = detail(gfbm(xz / 0.35, 41u), 0.35, footprint);
      albedo = mix(base, base * vec3f(1.35, 1.2, 0.8), drift) * mix(0.85, 1.1, detail(gnoise(xz / 0.02, 42u), 0.02, footprint));
    }
    case T_FIELDS: {
      // Each tile splits into parcels; each parcel is a crop (green, golden, ploughed) with
      // furrows in its own direction.
      let parcels = 2.0 + floor(rand * 3.0);
      let pcell = floor(q * parcels);
      let pr = ghash(vec2i(pcell), 51u);
      var crops = array<vec3f, 4>(vec3f(1.0), vec3f(1.45, 1.25, 0.65), vec3f(0.85, 1.25, 0.75), vec3f(0.95, 0.75, 0.6));
      // Far away a pixel spans several parcels: their crops average toward the mean.
      let crop = mix(vec3f(1.06, 1.06, 0.75), crops[u32(pr * 3.999)], resolved(tile / parcels, footprint));
      let angle = ghash(vec2i(pcell), 52u) * 3.14159;
      let along = dot(xz, vec2f(cos(angle), sin(angle)));
      let furrows = 0.9 + 0.1 * sin(along / 0.006) * resolved(0.04, footprint);
      // A darker margin between parcels, about 20 m wide; averaged out once a pixel spans it.
      let edge = min(min(fract(q.x * parcels), 1.0 - fract(q.x * parcels)), min(fract(q.y * parcels), 1.0 - fract(q.y * parcels)));
      let margin = 0.04 * tile / parcels;
      let hedge = mix(1.0 - 0.45 * 0.08, mix(0.55, 1.0, smoothstep(0.0, 0.04, edge)), resolved(margin, footprint));
      albedo = base * crop * furrows * hedge * mix(0.9, 1.08, detail(gnoise(xz / 0.05, 53u), 0.05, footprint));
    }
    case T_FOREST: {
      // Crowns and gaps.
      let crowns = detail(gnoise(xz / 0.012, 61u), 0.012, footprint) * 0.6 + detail(gnoise(xz / 0.004, 62u), 0.004, footprint) * 0.4;
      albedo = base * mix(0.45, 1.25, crowns) * mix(0.85, 1.15, detail(gfbm(xz / 0.5, 63u), 0.5, footprint));
    }
    default: {
      albedo = base * mix(0.7, 1.3, detail(gfbm(xz / 0.08, 71u), 0.08, footprint));
    }
  }
  s.albedo = clamp(albedo, vec3f(0.0), vec3f(1.0));
  return s;
}

// Open water from the spectral ocean (ocean.wgsl): the mean slope over a footprint of
// `footprint` metres, and the slope variance the footprint hides, which becomes roughness.
// Ported in spirit from the ABYSSAL / natural-disasters ocean (MIT): only the waves a pixel
// resolves bend its normal; the rest widen its highlight (Cox-Munk, LEAN-style).
const OCEAN_TURNS = array<f32, 3>(0.0, 0.6143, 1.7287);
const OCEAN_OFFSETS = array<vec2f, 3>(vec2f(0.0), vec2f(0.371, 0.113), vec2f(0.687, 0.529));

struct Water {
  normal: vec3f,
  alpha: f32,   // GGX roughness (alpha = sqrt(2 x mean square slope))
  fold: f32,    // mean Jacobian: below ~0.6 the surface is folding over (whitecaps)
}

fn water_surface(xz: vec2f, up: vec3f, footprint: f32) -> Water {
  let p = xz * 1000.0;
  var slope = vec2f(0.0);
  var hidden = 0.0;
  var fold = 1.0;
  for (var c = 0; c < 3; c++) {
    let tile = ground.waves[c];
    let texel = tile / f32(textureDimensions(ocean_tex).x);
    let lod = clamp(log2(max(footprint / texel, 1.0)), 0.0, f32(textureNumLevels(ocean_tex) - 1));
    // Each cascade turned to its own angle so their repeats never line up into a grid
    // (as the ABYSSAL ripple taps do); its slope is turned back before adding.
    let turn = OCEAN_TURNS[c];
    let rot = mat2x2f(cos(turn), sin(turn), -sin(turn), cos(turn));
    let s = textureSampleLevel(ocean_tex, ocean_sampler, (rot * p) / tile + OCEAN_OFFSETS[c], c, lod);
    slope += transpose(rot) * s.xy;
    hidden += max(s.z - dot(s.xy, s.xy), 0.0);
    fold = min(fold, s.w);
  }
  // Capillary ripples shorter than the finest cascade still roughen the surface: about
  // half of the Cox-Munk mean square slope for this wind lives there.
  let capillary = 0.5 * (0.003 + 0.00512 * ground.waves.w);
  var w: Water;
  let tx = normalize(cross(vec3f(0.0, 0.0, 1.0), up));
  let tz = cross(up, tx);
  w.normal = normalize(up - slope.x * tx - slope.y * tz);
  w.alpha = clamp(sqrt(2.0 * (hidden + capillary)), 0.012, 0.62);
  w.fold = fold;
  return w;
}

// GGX normal distribution and height-correlated Smith visibility.
fn ggx_d(noh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = noh * noh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn smith_vis(nov: f32, nol: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = nol * sqrt(nov * nov * (1.0 - a2) + a2);
  let gl = nov * sqrt(nol * nol * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}


// Schlick Fresnel for water (f0 = 0.02).
fn water_fresnel(cos_theta: f32) -> f32 {
  return 0.02 + 0.98 * pow(1.0 - clamp(cos_theta, 0.0, 1.0), 5.0);
}

// Side of the cloud pass's ground shadow map, km, centred under the eye (clouds.wgsl
// ground_shadow): r = sun through the clouds, g = sun past the relief, at sea level.
const GROUND_SHADOW_KM: f32 = 12.0;

// How much of the water's sun glint the composite draws at xz (km): all of it well inside
// the ground shadow map, which it needs for the clouds' and the relief's shadows, so the
// glint is resolved per output pixel near the eye; the cloud pass draws the rest, farther
// out (clouds.wgsl water_radiance).
fn near_glint(xz: vec2f) -> f32 {
  let r = max(abs(xz.x), abs(xz.y));
  return 1.0 - smoothstep(GROUND_SHADOW_KM * 0.38, GROUND_SHADOW_KM * 0.48, r);
}

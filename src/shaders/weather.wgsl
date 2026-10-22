// Weather map: procedural background, then shape layers in order, then paint.
// The map covers a fixed square of side params.scale.z km centred on the eye (no tiling).
// r = local weather, g = cloud type (0 stratus .. 1 towering), b = density multiplier,
// a = how much global coverage may act here (0 where Clear or a clear hole forced clear sky).
//
// Local weather feeds Takram's coverage function (clouds.wgsl), which turns smooth bumps
// into domed clouds and flat plateaus into flat-topped walls. So nothing writes plateaus:
// shapes and paint author an *amount* of cloud, and that amount scales a field of Worley
// cells (one soft bump per cloud), as Takram's own local weather texture does. Sheets
// (haze) are the exception and stay flat on purpose.
// The smudge warp displaces where the whole composite is evaluated, so it drags
// background, shapes and paint together.

struct Shape {
  center: vec2f,     // km, weather-map space
  size: f32,         // km, half-length along the shape's main axis
  aspect: f32,       // width / length
  rotation: vec2f,   // cos, sin
  strength: f32,     // 0..1
  type_override: f32,// < 0 = generator default
  kind: f32,         // see SHAPE_* below
  seed: f32,
  _pad: vec2f,
}

struct Shapes {
  count: u32,
  base_amount: f32,  // strength of the procedural background weather
  _pad: vec2f,
  items: array<Shape, 16>,
}

const SHAPE_CUMULUS_FIELD = 0.0;
const SHAPE_STORM_CELL = 1.0;
const SHAPE_FRONT = 2.0;
const SHAPE_CLEAR_HOLE = 3.0;
const SHAPE_HAZE_SHEET = 4.0;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var weather_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<storage, read> shapes: Shapes;
// paint: coverage delta, type target, type weight, density delta
@group(0) @binding(3) var paint_tex: texture_2d<f32>;
// warp: displacement in km (xy)
@group(0) @binding(4) var warp_tex: texture_2d<f32>;
@group(0) @binding(5) var layer_sampler: sampler;

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

// Non-tiling world-space noise for shape interiors, feature size in km.
fn shape_noise(xz: vec2f, feature_km: f32, seed: f32) -> f32 {
  let p = vec3f(xz / feature_km, seed * 7.31);
  let n = perlin(p, 4096) + perlin(p * 2.03, 4096) * 0.5 + perlin(p * 4.1, 4096) * 0.25;
  return clamp(n / 1.75 * 0.5 + 0.5, 0.0, 1.0);
}

struct Cell {
  amount: f32,   // authored cloud amount, scales the cell field
  sheet: f32,    // authored flat layer (haze), not broken into cells
  clear: f32,    // forced clear sky, which also holds off the global coverage
  kind: f32,
  density: f32,
}

// Takram localWeather.frag: Worley fBm with squared-distance cells, 1 at feature points.
fn cell_noise(p: vec2f, seed: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  var d = 1e9;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2i(x, y);
      let feature = hash33(bitcast<vec3u>(vec3i(i + o, i32(seed)))).xy + vec2f(o);
      let delta = feature - f;
      d = min(d, dot(delta, delta));
    }
  }
  return 1.0 - clamp(d, 0.0, 1.0);
}

fn cell_fbm(p: vec2f, frequency: f32, seed: u32) -> f32 {
  var noise = 0.0;
  var amplitude = 0.4;
  var freq = frequency;
  for (var i = 0u; i < 4u; i++) {
    noise += amplitude * cell_noise(p * freq, seed + i * 101u);
    freq *= 2.0;
    amplitude *= 0.95;
  }
  return noise;
}

// Takram's low and mid cloud weather over a 100 km tile, as our background.
const WEATHER_TILE_KM = 100.0;
fn takram_background(xz: vec2f, seed: u32) -> vec2f {
  let p = xz / WEATHER_TILE_KM;
  let mid = smoothstep(1.0, 1.4, cell_fbm(p + 0.5, 8.0, seed + 7u));
  let low = clamp(smoothstep(0.8, 1.4, cell_fbm(p, 16.0, seed)) - mid, 0.0, 1.0);
  return vec2f(low, mid);
}

// Where clouds may form inside an authored area: soft bumps ~3 km apart with real gaps.
// The fBm's median is ~1.17; this window leaves about a quarter of the area empty and
// puts the median at ~0.3, so each cell domes on its own instead of merging into a slab.
fn authored_cells(xz: vec2f, seed: u32) -> f32 {
  return smoothstep(1.05, 1.4, cell_fbm(xz / WEATHER_TILE_KM, 24.0, seed + 31u));
}

struct Local {
  p: vec2f,      // shape-local coordinates, km (x along main axis)
  d: f32,        // normalised distance: 1 at the shape boundary
  across: f32,   // signed position across a front, -1 .. 1 at the edges
}

fn to_local(shape: Shape, xz: vec2f) -> Local {
  let r = shape.rotation;
  let rel = xz - shape.center;
  let p = vec2f(r.x * rel.x + r.y * rel.y, -r.y * rel.x + r.x * rel.y);
  let width = max(shape.size * shape.aspect, 0.1);
  var l: Local;
  l.p = p;
  l.across = p.y / width;
  if (shape.kind == SHAPE_FRONT) {
    // Capsule: distance to the main axis segment, scaled by the band half-width.
    let along = clamp(p.x, -shape.size, shape.size);
    l.d = length(vec2f(p.x - along, p.y)) / width;
  } else {
    l.d = length(vec2f(p.x / max(shape.size, 0.1), p.y / width));
  }
  return l;
}

fn apply_shape(cell: Cell, shape: Shape, xz: vec2f) -> Cell {
  let l = to_local(shape, xz);
  if (l.d > 1.6) { return cell; }
  // Soft-edged footprint: full inside, fading over the outer third.
  let w = shape.strength * (1.0 - smoothstep(0.65, 1.0, l.d));
  var out = cell;
  var amount = 0.0;
  var sheet = 0.0;
  var kind = 0.5;
  var dens = 1.0;

  if (shape.kind == SHAPE_CLEAR_HOLE) {
    out.amount = cell.amount * (1.0 - w);
    out.sheet = cell.sheet * (1.0 - w);
    out.clear = max(cell.clear, w);
    return out;
  } else if (shape.kind == SHAPE_CUMULUS_FIELD) {
    amount = w * mix(0.75, 1.0, shape_noise(xz, 12.0, shape.seed));
    kind = mix(0.3, 0.55, shape_noise(xz, 9.0, shape.seed + 3.0));
    dens = 0.9;
  } else if (shape.kind == SHAPE_STORM_CELL) {
    // A peaked core (a cluster of towers, tallest in the middle) and a broken ring of
    // outflow cumulus.
    let core = shape.strength * clamp(1.0 - l.d * l.d, 0.0, 1.0);
    let ring = shape.strength * exp(-pow((l.d - 1.25) / 0.22, 2.0)) * 0.7;
    amount = max(core, ring);
    kind = mix(0.5, 1.0, smoothstep(0.0, 0.7, core));
    dens = 1.0;
  } else if (shape.kind == SHAPE_FRONT) {
    // Band of cloud: convective towers on the leading edge, stratiform behind.
    amount = w * mix(0.7, 1.0, shape_noise(xz, 10.0, shape.seed));
    kind = mix(0.2, 0.85, smoothstep(-0.6, 0.6, l.across));
    dens = 0.95;
  } else if (shape.kind == SHAPE_HAZE_SHEET) {
    sheet = w * mix(0.55, 0.75, shape_noise(xz, 12.0, shape.seed));
    kind = 0.05;
    dens = 0.35;
  }
  if (shape.type_override >= 0.0) { kind = shape.type_override; }

  out.amount = max(cell.amount, amount);
  out.sheet = max(cell.sheet, sheet);
  let blend = clamp(max(amount, sheet) * 1.5, 0.0, 1.0);
  out.kind = mix(cell.kind, kind, blend);
  out.density = mix(cell.density, dens, blend);
  return out;
}

@compute @workgroup_size(8, 8)
fn generate(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(weather_out);
  if (any(id.xy >= size)) { return; }
  let extent = params.scale.z;
  let pixel_uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let warp = textureSampleLevel(warp_tex, layer_sampler, pixel_uv, 0.0).xy;
  let xz = (pixel_uv - 0.5) * extent - warp;
  let uv = xz / extent + 0.5;
  let seed = params.misc.z;

  let seed_u = u32(seed * 7919.0);

  // Background weather: Takram's local weather generator (low and mid cumulus cells).
  let bg = takram_background(xz, seed_u);
  let background = max(bg.x, bg.y) * shapes.base_amount;
  var cell: Cell;
  cell.amount = 0.0;
  cell.sheet = 0.0;
  cell.clear = 0.0;
  // Mid cells are taller; background stays at or below cumulus congestus.
  cell.kind = mix(0.3, 0.55, bg.y / max(bg.x + bg.y, 1e-3)) * step(1e-3, bg.x + bg.y);
  cell.density = mix(0.6, 1.0, weather_fbm(uv, max(1, i32(round(extent / 60.0))) * 8, seed + 23.0));

  for (var i = 0u; i < min(shapes.count, 16u); i++) {
    cell = apply_shape(cell, shapes.items[i], xz);
  }

  // Paint: Cloud adds amount, Clear removes it and forces clear sky (paint.r < 0).
  let paint = textureSampleLevel(paint_tex, layer_sampler, uv, 0.0);
  cell.amount = clamp(cell.amount + paint.r, 0.0, 1.0);
  cell.sheet = clamp(cell.sheet + min(paint.r, 0.0), 0.0, 1.0);
  cell.clear = clamp(max(cell.clear, -paint.r), 0.0, 1.0);
  cell.kind = mix(cell.kind, paint.g, clamp(paint.b, 0.0, 1.0));
  cell.density = clamp(cell.density + paint.a, 0.05, 1.0);

  let open = 1.0 - cell.clear;
  let local_weather = max(max(background * open, cell.amount * authored_cells(xz, seed_u)), cell.sheet);
  textureStore(weather_out, id.xy, vec4f(local_weather, cell.kind, cell.density, open));
}

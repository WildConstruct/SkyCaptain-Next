// Weather map: procedural background, then shape layers composited in order.
// The map covers a fixed square of side params.scale.z km centred on the eye (no tiling).
// r = coverage, g = cloud type (0 stratus .. 1 towering), b = density multiplier.
// Paint layers will composite after shapes.

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
  coverage: f32,
  kind: f32,
  density: f32,
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
  var cov = 0.0;
  var kind = 0.5;
  var dens = 1.0;

  if (shape.kind == SHAPE_CLEAR_HOLE) {
    out.coverage = cell.coverage * (1.0 - w);
    return out;
  } else if (shape.kind == SHAPE_CUMULUS_FIELD) {
    // Separate fair-weather cumulus islands rather than one blob.
    cov = w * smoothstep(0.42, 0.62, shape_noise(xz, 5.0, shape.seed));
    kind = mix(0.3, 0.55, shape_noise(xz, 9.0, shape.seed + 3.0));
    dens = 0.9;
  } else if (shape.kind == SHAPE_STORM_CELL) {
    // Towering core plus a broken ring of outflow cumulus.
    // Dome-shaped coverage: dense centre falling to the edge, so the tower has a rounded,
    // billowed silhouette instead of an extruded footprint.
    let core = shape.strength * (1.0 - smoothstep(0.25, 1.0, l.d)) * mix(0.8, 1.0, shape_noise(xz, 3.0, shape.seed));
    let ring = shape.strength * exp(-pow((l.d - 1.25) / 0.22, 2.0)) * smoothstep(0.45, 0.65, shape_noise(xz, 3.5, shape.seed + 5.0));
    cov = max(core, ring);
    kind = mix(0.5, 1.0, smoothstep(0.0, 0.6, core));
    dens = 1.0;
  } else if (shape.kind == SHAPE_FRONT) {
    // Band of cloud: convective towers on the leading edge, stratiform behind.
    cov = w * smoothstep(0.3, 0.55, shape_noise(xz, 6.0, shape.seed));
    kind = mix(0.2, 0.85, smoothstep(-0.6, 0.6, l.across));
    dens = 0.95;
  } else if (shape.kind == SHAPE_HAZE_SHEET) {
    cov = w * mix(0.55, 0.75, shape_noise(xz, 12.0, shape.seed));
    kind = 0.05;
    dens = 0.35;
  }
  if (shape.type_override >= 0.0) { kind = shape.type_override; }

  out.coverage = max(cell.coverage, cov);
  let blend = clamp(cov * 1.5, 0.0, 1.0);
  out.kind = mix(cell.kind, kind, blend);
  out.density = mix(cell.density, dens, blend);
  return out;
}

@compute @workgroup_size(8, 8)
fn generate(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(weather_out);
  if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let extent = params.scale.z;
  let xz = (uv - 0.5) * extent;
  let seed = params.misc.z;

  // Background weather: ~15 km coverage features regardless of map extent.
  let freq = max(1, i32(round(extent / 60.0)));
  var cell: Cell;
  cell.coverage = smoothstep(0.4, 0.75, weather_fbm(uv, freq * 4, seed)) * shapes.base_amount;
  // Background stays at or below cumulus congestus; towers come from shapes or the type control.
  cell.kind = smoothstep(0.3, 0.7, weather_fbm(uv, freq * 2, seed + 11.0)) * 0.6;
  cell.density = mix(0.6, 1.0, weather_fbm(uv, freq * 8, seed + 23.0));

  for (var i = 0u; i < min(shapes.count, 16u); i++) {
    cell = apply_shape(cell, shapes.items[i], xz);
  }
  textureStore(weather_out, id.xy, vec4f(cell.coverage, cell.kind, cell.density, 1.0));
}

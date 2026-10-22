# Cloud model: port of Takram three-geospatial

Our clouds use the density model and lighting of
[Takram three-geospatial clouds](https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds)
(MIT, © 2024 Shota Matsuda). We ported it from commit `b012ad06`. It is the quality
baseline, so we tune against a known-good renderer instead of by eye.

The port keeps Takram's numbers and quirks wherever we can. Every place we differ is
marked `skyCaptain:` in the shaders and listed below.

## What we ported, and where it lives

| Takram | Ours | Notes |
| --- | --- | --- |
| `cloudShape.frag`, `cloudShapeDetail.frag`, `turbulence.frag`, `tileableNoise.glsl`, `perlin.glsl` | `src/shaders/noise-bake.wgsl` | Numerically faithful. This keeps the squared Worley distance and the single scalar offset per feature point. Turbulence is stored in the shape volume's `gba` channels and is the same at every z, so no extra texture is needed. |
| `sampleWeather` (shape-altering function, coverage filter width 0.6, bias 0.35) | `sample_weather` in `clouds.wgsl` | |
| `sampleMedia` (turbulence, shape erosion, detail modifier, density profile 0.75·h + 0.25, saturate) | `sample_media` | Takram works in metres and we work in km: their extinction 0.2 /m is our density 200 /km. |
| `marchOpticalDepth` (2 steps to the sun, 3 to the ground, 100 m doubling) | `march_optical_depth` | |
| `approximateMultipleScattering` (8 octaves, a = b = c = 0.5) | `approximate_multiple_scattering` | Octaves, a, b and c are sliders, and default to Takram's values. |
| Dual Henyey-Greenstein, g 0.7 and −0.2, mix 0.5 | `phase` | Silver lining, back-scatter g and back-scatter weight sliders. |
| Ground bounce, sky gradient, powder 0.8 / 150 | `march` | |
| Primary march: 50 m minimum step, ×1.01 perspective growth, 1 km maximum in empty space, 200 km range, energy-conserving integration, transmittance-weighted front depth | `march` | The iteration budget comes from the quality tier: 160 for Laptop, 300 for Desktop, 500 for Ultra and export. Takram's high preset is 500. |

## Where we differ

| Difference | Why | Effect |
| --- | --- | --- |
| **Local weather is our authored map** (background, shapes, paint). The red channel feeds Takram's coverage function. Takram uses a tiled Worley/Perlin texture with fixed layers. | Painting and shapes are the product. | Coverage behaves like Takram's: raising it grows clouds out of the painted cells, and above roughly 0.4 cloud starts to fill clear areas. |
| **Per-type cloud height** from the type channel: stratus 0.35 km, cumulus at the layer height, towers up to the tower height. Takram uses fixed low, mid and high layers. | Storm cells and fronts need towers in one layer. | Same shape-altering function and density profile within each cloud's own height. |
| **Cone march for long-range sun shadowing.** Takram adds optical depth from a beer shadow map (BSM) beyond its 2 short steps. We march on with growing coarse steps (4–6, from the quality tier). | No shadow map yet. | Approximate self-shadowing past about 300 m. A BSM over our fixed eye is a candidate upgrade. |
| **Sky and ground light from our sky cube.** Takram uses precomputed scalar irradiance (Bruneton). | We already render the sky cube. | Mean sky radiance is estimated from five cube samples. |
| **Ground albedo is the scene's albedo setting.** Takram uses a constant 0.3. | Matches our atmosphere's ground. | Darker cloud bases by default (0.12). |
| **Aerial perspective is a haze fade at the front depth.** Takram applies full aerial perspective there. | We have no aerial-perspective LUT yet. | Distant clouds fade less physically. |
| **No high cirrus layer.** | Not ported yet. | To do. |
| **No temporal reprojection or STBN.** We accumulate jittered samples per cube texel instead. | Fixed-eye cube rendering converges without reprojection. | Same converged image, different noise while it refines. |

## Next

1. Build a slow path-traced reference of the same density field to score how close the
   octave approximation, cone shadowing and sky light get.
2. Add a beer shadow map and aerial perspective if the reference shows they matter.

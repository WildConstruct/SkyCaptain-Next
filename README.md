# skyCaptain

Directable environments for the Wild Construct suite: paint and shape a sky in
the browser with WebGPU, export scene-linear HDRIs and a portable recipe.

![Spike look test](docs/look/spike-001.png)

*Spike look test, rendered with software WebGPU: midday cumulus, overhead view,
low-sun towering cloud.*

## How it renders

The eye is fixed, so clouds don't depend on where the camera is looking. They are
raymarched once into the environment cube, and the viewport only samples it.

| Pass | Runs when | Notes |
| --- | --- | --- |
| Noise bake | startup | 128³ Perlin-Worley + Worley shape, 32³ Worley detail, rgba8 |
| Weather map | weather edits | 512², coverage / type / density. Paint and shape layers land here |
| Atmosphere | sun or haze edits | Hillaire 2020 transmittance + multi-scattering LUTs, 256² sky cube |
| Clouds | any cloud edit, until converged | Compute pass; 1/16 of cube texels per frame in Bayer order. The first frames fill at quarter, then half resolution, so edits show immediately. Later passes add jittered samples |
| View | every frame | Samples sky × transmittance + cloud scatter + sun disc. Preview-only tone map |

Cloud lighting follows Nubis 2015 / Hillaire 2016:
- density from the weather map × a vertical profile by cloud type × Perlin-Worley with detail erosion
- Beer-Lambert transmittance, integrated with Hillaire's energy-conserving step integral
- dual-lobe Henyey-Greenstein phase
- Wrenninge multiple-scattering octaves
- cone light march toward the sun
- sky ambient, occluded by the cloud above
- distance fade into the atmosphere

Quality tiers: Laptop (M1) 512² × 64 steps, Desktop 768² × 96, Ultra 1024² × 128.

## Shapes

![Shape layers](docs/look/shapes-001.png)

Shape layers are weather generators placed on the map. They composite in order
over the procedural background weather (its strength is the **Background
weather** slider) and write coverage, cloud type and density into the weather
map:

- **Cumulus field:** a field of separate fair-weather cumulus.
- **Storm cell:** one big tower that tapers to a domed top, with a broken ring of
  outflow cumulus around its base.
- **Front:** a band of turrets on the leading edge with lower, flatter cloud behind.
- **Clear hole:** clear sky, even under an overcast look (it holds off the global coverage).
- **Haze sheet:** thin, low-density stratus.

Each cloud type has its own height. Stratus are about 0.35 km, cumulus use
**Cumulus height**, and towers rise to **Max tower height**. Coverage shrinks
with height, so tops round off.

Editing:
- **In the sky:** drag a shape. Drag empty sky to look around. Shapes are added
  where you are looking.
- **On the minimap:** drag to move, use the square handle to size and rotate, and
  the round handle to set width.
- **Shortcuts:** Ctrl/Cmd+Z to undo, Shift+Ctrl/Cmd+Z to redo, Delete to remove a
  shape.

`node tools/smoke-shapes.mjs` checks these interactions and the GPU weather map
against the dev server.

## Painting

![Painting](docs/look/paint-001.png)

Paint layers are applied after the shapes. Shapes and paint say *how much* cloud goes
where; the weather map turns that amount into a field of separate soft cells, one per
cloud, so a painted area becomes a field of domed cumulus rather than a slab. Cell size
follows the cloud type: towers are broad, stratiform fills in toward a sheet.

Brushes (keys 1 to 6; V returns to Shapes):

- **Cloud:** adds cloud up to **Max coverage**. Low values give small, scattered
  cumulus, and 1 gives the biggest, tallest ones. Can also set the cloud type.
- **Clear:** removes cloud, and holds off the global coverage, so it clears even under
  an overcast look.
- **Type:** pushes clouds toward stratus or towers.
- **Density:** thickens, or thins.
- **Scatter:** sprays small separate clouds.
- **Smudge:** drags the whole weather (background, shapes and paint) along the
  stroke. It writes a displacement field rather than moving pixels, so it stays
  non-destructive.

Paint in the sky or top-down on the minimap. With a brush active, right-drag or
Space-drag looks around. `[` and `]` change brush size. Shapes and paint share one
undo history; paint undo stores only the 64×64 tiles a stroke touched.
`node tools/smoke-paint.mjs` checks each brush against the GPU weather map.

## Sky graphs (Prompt Spaghetti)

![PSG-rolled skies](docs/look/psg-001.png)

A `.psg` graph rolls whole skies: shapes, cloud controls, sun and a caption. Load
`examples/weather-regimes.psg` with **Example graph**, press **R** to reroll, and hold
choices, shape slots or the sun so they survive rerolls. Graph-made shapes sit below
your hand-made ones; rerolls never touch hand-made shapes or paint. Details in
[docs/psg-weather.md](docs/psg-weather.md). `node tools/smoke-psg.mjs` checks load,
reroll, holds and undo.

## Export and sky files

![Exported HDRI](docs/look/export-001.png)

**Export HDRI** renders the environment fresh at export quality and downloads a
scene-linear lat-long image, with north at the centre and east to the right:
- **Formats:** OpenEXR or Radiance `.hdr`.
- **Sizes:** 1K, 2K or 4K.
- **Quality:** 2, 8 or 16 samples per texel.
- **How it renders:** clouds go into a dedicated cube (face = width ÷ 4, Ultra steps,
  full convergence) and are composited with the same shaders as the view, with a
  supersampled sun disc.
- **EXR precision:** written as half float when everything fits, and as 32-bit float
  when the sun exceeds the half range (it usually does), so the sun's energy is never
  clamped.

`tools/smoke-export.mjs` drives the button and checks every pixel. `tools/check-hdri.py`
re-reads the files with the OpenEXR and OpenCV readers.

Everything skyCaptain saves is a `.wcx` file in the WC Preset System Standard, the same
format Lumen uses (`src/wcx.ts`). Each file has a format header, a Moniker block, and
`params` matched by a stable uuid and then by id. `kind` says what the file holds:
`look` or `sky`.

**Save sky** writes the whole sky as one sky `.wcx`:
- every setting (except the quality tier, which belongs to your machine) and the shape layers
- paint, as sparse tiles (int16 paint, float32 smudge warp)
- the sky graph, with its text, seed, holds and resolved values

Opening restores the saved roll without re-evaluating, so a later edit to the graph
can't change a saved sky. **Open…** takes a sky `.wcx`, or an older `.sky.json`. A look
`.wcx` opened there just applies the look. `tools/smoke-document.mjs` round-trips a sky,
plus a legacy file, and compares the GPU weather map.

## Animate

The environment cube is re-rendered from parameters, never baked, so skies animate. An
animation is a short recipe saved inside the sky `.wcx` (`src/animation.ts`):

- **Wind:** the whole weather map drifts (background, shapes and paint), at a speed in
  km/h toward a compass heading.
- **Cloud life:** the cloud shape noise scrolls upward (Takram's evolution), so clouds
  grow and dissolve as they drift. It is the minutes for a full turnover; 0 keeps shapes.
- **Time-lapse:** scene time per clip second. 120× turns a 10 s clip into 20 minutes of
  weather.
- **Sun (optional):** moves in a straight line to an end elevation and azimuth.

Frame 0 is exactly the sky as composed, and every frame is a pure function of time:
any frame can be rendered alone and comes out identical. The scrubber and **Play** preview
in the viewport (the view refines progressively, so fast motion shimmers there).
**Export sequence…** renders every frame fresh and converged as numbered lat-long
EXR/HDR files (`Name.0001.exr`, …) into a folder you pick (Chrome and Edge) or as
downloads elsewhere. `tools/smoke-animate.mjs` checks the recipe, the sky file and a short
sequence, including that a frame re-rendered on its own matches.

## Looks and Moniker names

![Vibes](docs/look/vibes-001.png)

A look is the sun, atmosphere, light and cloud character, with no shapes or paint, so
any look can go over any composed sky. The factory looks are the six vibes: Bright
midday, Golden hour, Last light, Hazy summer, Brooding and Overcast softbox
(`src/vibes.ts`).

**Save look…** suggests a name from the current settings with Moniker, Lumen's
deterministic naming engine (vendored unchanged in `vendor/moniker/`). The artist can
edit the name, or press ↻ for a fresh suggestion. A saved look stays in the browser and
downloads as a `.wcx` file in Lumen's format (`_plugin: "skycaptain"`, `kind: "look"`).
**Import .wcx…** loads one back. Sky files and HDRI exports are also named by Moniker
from the scene, such as `Brooding Golden-Hour Squall Line.wcx`. Importing a sky `.wcx`
as a look keeps only its look settings.

There are two vocabularies:

- `src/moniker/skycaptain-look.moniker` names looks.
- `src/moniker/skycaptain-sky.moniker` names whole skies.

The adapter `src/moniker/skycaptain.js` reads settings and shapes into families such as
time of day, mood and scene. `docs/moniker.md` lists every slot and word, and
`tools/moniker-doc.py` generates it. `npm test` checks the reviewed golden names.

## Roadmap

1. **Look spike.** Done.
2. **Shapes.** Done: five generators, sky and minimap editing, undo.
3. **Speed.** Measure on M1 and 4090. Tune steps, empty-space skipping and tiers.
   Target: a visible draft in one frame and convergence in about 1 s on M1 Laptop tier.
4. **Painting.** Done: six brushes, sky and minimap painting, shared undo.
5. **PSG weather.** Done: a vendored browser build of Prompt Spaghetti's evaluator,
   an example graph, reroll and holds.
6. **Look polish.** Cumulonimbus anvils, ground shadows from clouds, horizon and
   ground model, edge albedo instead of powder.
7. **Export and documents.** Done: EXR/HDR export and sky `.wcx` save/open.
8. **Looks.** Done: six factory looks, saved `.wcx` looks named by Moniker, and Moniker names for skies.
9. **Animation.** Done: wind drift, cloud evolution, sun moves, sequence export.
10. **Ground and skylight.** The ground is lit only by the sun today, so low-sun skies have a
   near-black ground. Add sky irradiance and cloud shadows on the ground.

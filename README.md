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

- **Cumulus field:** separate fair-weather cumulus islands.
- **Storm cell:** a towering, dome-shaped core with a broken ring of outflow cumulus.
- **Front:** a band of cloud, with towers on the leading edge and stratiform cloud behind.
- **Clear hole:** removes coverage.
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

## Roadmap

1. **Look spike.** Done.
2. **Shapes.** Done: five generators, sky and minimap editing, undo.
3. **Speed.** Measure on M1 and 4090. Tune steps, empty-space skipping and tiers.
   Target: a visible draft in one frame and convergence in about 1 s on M1 Laptop tier.
4. **Painting.** Paint layers resolved into the weather map after the shapes:
   coverage, type, density, erase, wind smudge and scatter, painted directly in the
   sky.
5. **PSG weather.** Prompt Spaghetti graphs drive shape layers and sky settings,
   with reroll and locks; see [docs/psg-weather.md](docs/psg-weather.md).
6. **Look polish.** Cumulonimbus anvils, ground shadows from clouds, horizon and
   ground model, edge albedo instead of powder.
7. **Vibes and export.** Look presets (sun + atmosphere + clouds), lat-long
   `.hdr`/`.exr` export from the cube, and a recipe/WCX document.

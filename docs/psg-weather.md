# PSG-driven weather

A Prompt Spaghetti graph (`.psg`) can describe a family of skies. skyCaptain
evaluates it with a seed and turns the result into shape layers and sky settings.
The graph randomizes; the shapes drive the weather; painting refines it.

This is the same pattern Cathode uses for TV bezels (see
`prompt-spaghetti-desktop/docs/cathode-structured-evaluation.md`).
`evaluatePsg(source, { seed, locks, choiceLocks })` returns typed `variables`,
each Weighted Choice's `picks` (with option `meta`), the prose `output` and
`graphSha256`.

## What skyCaptain reads

Variables use the `sky.`, `clouds.` and `shape.N.` namespaces. Anything else is
ignored, so a graph can also carry notes for other tools.

| Variable | Meaning |
| --- | --- |
| `sky.sun_elevation`, `sky.sun_azimuth` | degrees |
| `sky.haze` | clarity distance, km |
| `clouds.coverage`, `clouds.type`, `clouds.density`, `clouds.erosion` | global cloud controls (same ranges as the sliders) |
| `clouds.background` | strength of the procedural background weather, 0..1 |
| `clouds.base_km`, `clouds.thickness_km` | cloud base and cumulus height |
| `clouds.wind_dir`, `clouds.wind_km` | drift direction (degrees) and distance |
| `shape.N.kind` | `cumulus_field`, `storm_cell`, `front`, `clear_hole`, `haze_sheet` |
| `shape.N.azimuth`, `shape.N.distance_km` | where the shape sits, seen from the eye |
| `shape.N.size_km`, `shape.N.aspect`, `shape.N.rotation`, `shape.N.strength` | half-length, width/length, orientation (degrees), 0–1 influence |
| `shape.N.type` | optional per-shape cloud type override |
| `shape.N.seed` | optional detail seed (otherwise derived from the roll seed) |

`N` runs from 0 to 7.

### Ground

A graph can also roll the terrain (`src/terrain.ts`): a land-cover layout collapsed by
wave function collapse. Any `ground.*` variable turns terrain on; a graph without them
leaves the ground alone. A *ground graph* (Ground › Load .psg, or its example) applies only
these and never touches the sky or shapes, so ground and sky reroll independently.

| Variable | Meaning |
| --- | --- |
| `ground.water` | water level, 0–0.9: lakes, then coasts, then sea |
| `ground.geography` | 0–1: how strongly height sorts the land (0 = patchwork) |
| `ground.patch_km`, `ground.tile_km` | land-use patch size and layout grain, km |
| `ground.weight.<type>` | how common a type is: `water`, `sand`, `meadow`, `fields`, `forest`, `rock` |
| `ground.colour.<type>` | `"#rrggbb"` (sRGB) albedo for a type |
| `ground.seed` | layout seed; by default the roll's own seed, so a reroll lays out new ground |

`examples/terrain-biomes.psg` picks a landscape (farmland, lake district, coast, taiga,
arid, wetland) and a season palette. The prose `output` becomes the sky's caption, a readable
description that can also feed Ethera or an image prompt.

Implemented in `src/psg.ts` (driver) and `src/ui/psg-panel.ts` (load, reroll with R,
holds). A held shape layer is locked as it currently is, including hand edits.

Typical graph structure:
- A Weighted Choice picks a weather regime, for example "fair-weather cumulus",
  "squall line" or "clearing after rain". Each option's `meta.set` assigns its
  shape kinds and value ranges.
- Number Range nodes draw positions and sizes.
- Sub-PSG nodes reuse common pieces, such as a storm-cell recipe.

## Reroll and lock

- **Reroll:** evaluate with a new seed.
- **Lock a shape layer:** pass its current `shape.N.*` values as `locks`.
- **Lock a regime:** pass `choiceLocks` for that Weighted Choice.

Locked layers stay put and everything else rerolls, deterministically. Paint
layers are never touched by a reroll.

## Provenance

The sky recipe stores the graph's `graphSha256`, the seed, the locks and the
resolved variables. Reopening a recipe uses the stored values, so editing the
graph never silently changes a saved sky.

## Example

`examples/weather-regimes.psg` has two Weighted Choices. **Weather regime** picks one of five
regimes (fair cumulus, lone thunderstorm, squall line, clearing, high haze), and each
option's `meta.set` assigns its shapes and cloud controls as ranges. **Time of day** picks
the sun. Both feed the Output, so the caption reads like "a squall line marching in under
a darkening sky at golden hour, sun low on the horizon". Load it with **Example graph** in
the Sky graph panel, or open it in Prompt Spaghetti to edit.

## Packaging

`vendor/psg-eval.browser.js` is `evaluatePsg` bundled for the browser by
`node tools/build-psg-eval.mjs <prompt-spaghetti-desktop checkout>`. The script needs
only `zod` and `seedrandom`, both resolved from this repo's devDependencies. Node's
`crypto` is swapped for `tools/shims/crypto.js`, a small synchronous sha256. The
bundle's banner names the PSG commit it was built from, and its sha256 sits next to it.
This mirrors how era-crowd vendors `psg-eval.cjs`.

`node tools/check-psg-bundle.mjs <checkout>` runs the browser bundle against a Node build
of the same source, using real `crypto`, over library graphs and the example. Results
must be identical, including `graphSha256`. Rebuild the bundle and rerun the check
whenever PSG's evaluator changes.

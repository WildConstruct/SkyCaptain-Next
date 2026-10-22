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
| `clouds.base_km`, `clouds.thickness_km` | cloud layer |
| `clouds.wind_dir`, `clouds.wind_km` | drift direction (degrees) and distance |
| `shape.N.kind` | `cumulus_field`, `storm_cell`, `front`, `clear_hole`, `haze_sheet` |
| `shape.N.azimuth`, `shape.N.distance_km` | where the shape sits, seen from the eye |
| `shape.N.size_km`, `shape.N.rotation`, `shape.N.strength` | extent, orientation (degrees), 0–1 influence |
| `shape.N.type` | optional per-shape cloud type override |

`N` runs from 0 to 7. The prose `output` becomes the sky's caption, a readable
description that can also feed Ethera or an image prompt.

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

## Packaging

`evaluatePsg` is dependency-light. Its only Node-specific import is `crypto`
(for the sha256). Bundle it for the browser with esbuild, swapping `crypto` for a
small synchronous sha256, and vendor the bundle with its own sha256. This mirrors
how era-crowd vendors `psg-eval.cjs`. The build script belongs in
prompt-spaghetti-desktop next to `build-psg-eval.mjs`.

# skyCaptain agent guide

skyCaptain makes **directable environments**: paint and shape a sky, get a
scene-linear HDRI and a portable recipe. Hero single clouds belong to Ethera, a
separate tool. Do not build hero-cloud or fly-through features here.

## Product rules

- **Fixed eye.** The camera is one point: on the ground by default, or raised by the
  Elevation setting up to and above the clouds (for aerial and above-the-clouds
  environments), but it never moves within a render. Clouds and sky render
  straight into the environment cube; the viewport only samples that cube. The
  preview and the HDRI export use the same buffer, so they match by construction.
- **Universal hardware.** Budgets target an M1-class GPU. Faster GPUs converge
  sooner or use a higher quality tier; nothing should require a desktop card.
- **Scene-linear.** Radiance stays linear end to end. Exposure, the camera
  (lens blur, glow, vignette, grain), tone mapping and sRGB encoding exist only in
  `display.wgsl` and `post.wgsl` and are labelled preview-only.
- **The weather map is the authoring surface.** Paint layers, shape layers and
  randomization all resolve into the weather map; the renderer only reads it.
- **Bake, don't compute.** Noise volumes are baked once. Never evaluate procedural
  noise per march step.

## How to work

- Small, working increments. Each change should leave the app runnable.
- Judge looks with screenshots: `npm run dev`, then
  `node tools/screenshot.mjs shots/name.png "query=params"`. Put notable looks in
  `docs/look/`; keep everything else in the ignored `shots/` folder.
- Measure speed on real hardware with the status-bar cloud-pass timing (needs
  `timestamp-query`). Record numbers with the GPU name in `docs/perf.md`.
- `npm run build` must pass (typecheck plus bundle) before committing.
- No packet ladders, evidence records or report-per-change. The commit message
  and, when useful, a short note in `docs/` are the record.

## Commands

```sh
npm install
npm run dev        # http://127.0.0.1:5173
npm run build
npm run shot -- shots/view.png "sunElevation=8&pitch=20"
```

# Performance

Numbers from real hardware, with the GPU named. Cloud-pass timings come from the status
bar (needs `timestamp-query`); clip timings from `tools/clip-preview.mjs` progress lines.

## Clip capture (tools/render-studies.mjs, Ultra, 2048 px faces, 1920x1080)

| GPU | Per frame | Rendering | Notes |
| --- | --- | --- | --- |
| RTX 4090 | ~2.5 s | — | One cloud pass per display refresh (128 refreshes at 60 Hz), 300 ms settle, PNG capture |
| RTX 4090 | 0.38 s | 0.24 s | converge() runs passes back to back; raw RGBA piped to ffmpeg |

Before the change, display pacing set the floor: Ultra converges in 16 x 8 = 128 passes,
one per refresh, about 2.1 s at 60 Hz however fast the GPU. The rest of the 0.38 s is
capture and transfer through the page (0.14 s).

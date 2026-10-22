"""Scores the fast cloud model against the path-traced reference for one view.

Usage: python3 tools/compare-reference.py <fast.png> <reference.png> <out-prefix>

Both images come from tools/screenshot.mjs with the same query, one with
quality=reference. They are display-referred (preview tone map), so this measures what
an artist sees, not radiance. Writes <out-prefix>-sheet.png: fast, reference, and a
signed difference (red: fast too bright, blue: fast too dark).
"""
import sys

import numpy as np
from PIL import Image

fast_path, ref_path, prefix = sys.argv[1:4]
fast = np.asarray(Image.open(fast_path).convert('RGB'), dtype=np.float32) / 255.0
ref = np.asarray(Image.open(ref_path).convert('RGB'), dtype=np.float32) / 255.0
if fast.shape != ref.shape:
    sys.exit(f'size mismatch: {fast.shape} vs {ref.shape}')

luma = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
lf, lr = fast @ luma, ref @ luma
diff = lf - lr
# Cloud pixels: where either image departs from the clear-sky-and-ground average a lot is
# unreliable, so use the sky half only and weight by how different from the sky gradient.
sky = np.zeros_like(lf, dtype=bool)
sky[: lf.shape[0] * 3 // 5] = True

def stats(mask, name):
    d = diff[mask]
    print(f'{name}: mean {d.mean():+.4f}  mean |d| {np.abs(d).mean():.4f}  '
          f'p95 |d| {np.percentile(np.abs(d), 95):.4f}  pixels {mask.sum()}')

stats(np.ones_like(sky), 'whole view')
stats(sky, 'sky half  ')
bright = sky & (lr > np.percentile(lr[sky], 70))
dark = sky & (lr < np.percentile(lr[sky], 30))
stats(bright, 'brightest 30% of sky (lit cloud) ')
stats(dark, 'darkest 30% of sky (shaded cloud)')

scale = 4.0
heat = np.zeros_like(fast)
heat[..., 0] = np.clip(diff * scale, 0, 1)
heat[..., 2] = np.clip(-diff * scale, 0, 1)
sheet = np.concatenate([fast, ref, heat], axis=0)
Image.fromarray((sheet * 255).astype(np.uint8)).save(f'{prefix}-sheet.png')
print(f'wrote {prefix}-sheet.png (difference x{scale:g})')

"""Independent check of exported HDRIs with the OpenEXR and OpenCV readers.
Usage: python tools/check-hdri.py file.exr file.hdr   (needs OpenEXR, numpy, opencv-python-headless)"""
import sys
import numpy as np

def load(path):
    if path.endswith('.exr'):
        import OpenEXR
        with OpenEXR.File(path) as f:
            ch = f.channels()
            if 'RGB' in ch:
                return ch['RGB'].pixels.astype(np.float32)
            return np.stack([ch[c].pixels for c in 'RGB'], -1).astype(np.float32)
    import cv2
    return cv2.imread(path, cv2.IMREAD_UNCHANGED)[..., ::-1].astype(np.float32)

images = {p: load(p) for p in sys.argv[1:]}
for p, im in images.items():
    print(f'{p}: {im.shape[1]}x{im.shape[0]} min {im.min():.4g} max {im.max():.4g} mean {im.mean():.4g} finite {np.isfinite(im).all()}')
if len(images) == 2:
    a, b = images.values()
    rel = np.abs(a - b) / np.maximum(np.maximum(a, b).max(-1, keepdims=True), 1e-4)
    print(f'exr vs hdr: median rel diff {np.median(rel):.4f}, 99th pct {np.percentile(rel, 99):.4f}')

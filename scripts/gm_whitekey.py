"""whitekey.py in.png out.png: cut an object rendered on a seamless white/light background.
Background = pixels connected to the border that are near-white; alpha ramps softly with distance from white,
so soft shadows fade out and edges stay anti-aliased. Interior highlights (not border-connected) stay opaque."""
import sys, numpy as np
from PIL import Image
from scipy import ndimage
im = Image.open(sys.argv[1]).convert("RGB"); a = np.asarray(im).astype(np.float32)
lum = a.mean(axis=2); sat = a.max(axis=2) - a.min(axis=2)
# distance from the paper colour (sampled on the border)
border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]]); paper = np.median(border, axis=0)
d = np.sqrt(((a - paper) ** 2).sum(axis=2))
near = d < 34
lab, _ = ndimage.label(near)
edge_labels = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
bg = np.isin(lab, list(edge_labels))
# soft alpha: inside bg region alpha grows with distance from paper (shadows partially kept), elsewhere opaque
# shadow = border-connected but darker than the paper: kept as a soft BLACK shadow (reads on light and dark grounds)
dark = np.clip((paper.mean() - lum) / 90, 0, 1)
edge = ndimage.binary_dilation(~bg, iterations=3) & bg       # anti-aliased object rim keeps its colour
alpha = np.where(bg, np.where(edge, np.clip((d - 8) / 26, 0, 1), dark * 0.55), 1.0)
alpha = ndimage.gaussian_filter(alpha, 0.8)
shadow = bg & ~edge
# un-premultiply against the paper so light fringes don't glow
rgb = a.copy()
m = alpha > 0.02
for c in range(3): rgb[..., c][m] = np.clip((a[..., c][m] - paper[c] * (1 - alpha[m])) / alpha[m], 0, 255)
rgb[shadow] = 0
out = np.dstack([rgb, alpha * 255]).astype(np.uint8)
o = Image.fromarray(out, "RGBA"); bb = o.split()[3].point(lambda v: 255 if v > 10 else 0).getbbox(); o = o.crop(bb); o.thumbnail((1400, 1400), Image.LANCZOS); o.save(sys.argv[2], optimize=True)
print(sys.argv[2], o.size)

#!/usr/bin/env python3
"""Turn generated engravings into collage-ready cut-outs.

    python3 engravings_process.py            # reads library/engravings/gen/urls.txt ("<key> <url>" per line)

Downloads each image, lifts the paper to pure white (so mix-blend-mode: multiply makes it vanish on any paper),
crops to the drawing with a small margin, and writes library/engravings/png/<key>.png plus manifest entries.

Ported from Ahmed's phantasic engine/core (origin/main). Fork notes: curl replaced by urllib (no external binary); ENGRAVINGS_DIR overrides the library folder; an unreadable download is
skipped with a message instead of crashing. urls.txt is yours to fill (Ahmed's came from Higgsfield Z Image generations; any
image URL works). Needs OpenCV and numpy.
"""
import json
import os
import urllib.request
from pathlib import Path

import cv2
import numpy as np

LIB = Path(os.environ.get("ENGRAVINGS_DIR") or Path(__file__).resolve().parent.parent / "library" / "engravings")


def clean(img: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    paper = np.percentile(gray, 90)                      # the background level
    lifted = np.clip((img.astype(np.float32) / max(paper, 1)) * 255, 0, 255)
    lifted[lifted > 238] = 255
    mask = cv2.cvtColor(lifted.astype(np.uint8), cv2.COLOR_BGR2GRAY) < 200
    # drop small detached pieces (stray parts the generator adds beside the object)
    blobs = cv2.dilate(mask.astype(np.uint8), np.ones((25, 25), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(blobs)
    if count > 2:
        keep = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        stray = (labels != keep) & (labels != 0)
        lifted[stray] = 255
        mask &= ~stray
    ys, xs = np.where(mask)
    if len(xs):
        pad = 24
        y0, y1 = max(0, ys.min() - pad), min(img.shape[0], ys.max() + pad)
        x0, x1 = max(0, xs.min() - pad), min(img.shape[1], xs.max() + pad)
        lifted = lifted[y0:y1, x0:x1]
    return lifted.astype(np.uint8)


def main():
    (LIB / "png").mkdir(parents=True, exist_ok=True)
    mf = LIB / "manifest.json"
    manifest = json.loads(mf.read_text(encoding="utf-8")) if mf.exists() else {}
    for line in (LIB / "gen" / "urls.txt").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        key, url = line.split()
        raw = LIB / "gen" / f"{key}.png"
        if not raw.exists():
            urllib.request.urlretrieve(url, raw)
        img = cv2.imread(str(raw))
        if img is None:
            print(f"{key:<12} skipped: {raw} is not a readable image")
            continue
        out = clean(img)
        # ink only: alpha from darkness, so the drawing sits on any paper and effects hug the lines, not a box
        gray = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY).astype(np.float32)
        alpha = np.clip((255 - gray) * 1.6, 0, 255).astype(np.uint8)
        ink = np.clip(out.astype(np.float32) * 0.55, 0, 255).astype(np.uint8)   # darken what remains so shading keeps its weight
        cv2.imwrite(str(LIB / "png" / f"{key}.png"), np.dstack([ink, alpha]))
        manifest[key] = {"concept": key, "file": f"png/{key}.png", "source": "generated (Higgsfield Z Image)",
                         "licence": "own generation", "url": url}
        print(f"{key:<12} {out.shape[1]}x{out.shape[0]}")
    mf.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()

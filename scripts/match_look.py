#!/usr/bin/env python3
"""Shot matching: hold one exposure and white balance across a recording.

    python3 match_look.py <talk.mp4> [--face build/face.json] [--strength 0.9] [--max-gain 0.18]

Phone and DJI cameras re-meter while you talk (you lean, the window light shifts), so jump cuts put a warm, dark
moment next to a cool, bright one. Viewers judge the look by the face, so this measures the face's colour every
frame (from face_track.py; mid-tones of the whole frame when no face is found), smooths it over ~1.5 s, and scales
each frame toward a target: the clip's typical skin hue at the brightness of its better-lit moments (70th
percentile), so dark moments are lifted rather than bright ones pulled down. The original is kept as <name>.raw.mp4; audio is copied untouched.
"""
import argparse
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--face", type=Path)
    ap.add_argument("--strength", type=float, default=0.9)
    ap.add_argument("--max-gain", type=float, default=0.18)
    args = ap.parse_args()
    raw = args.video.with_suffix(".raw.mp4")
    if not raw.exists():
        shutil.copy(args.video, raw)

    faces = {}
    if args.face and args.face.exists():
        import json
        fj = json.loads(args.face.read_text())
        faces = {round(s[0], 1): s[1:5] for s in fj["samples"] if s[1] is not None}
    cap = cv2.VideoCapture(str(raw))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    means, last_box = [], None
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        t = round(round(len(means) / fps * 5) / 5, 1)
        box = faces.get(t, last_box)
        if box:
            last_box = box
            top, bottom, left, right = box
            # the skin between the eyes and the chin: no hair, no beard edge, no background
            h = bottom - top
            patch = fr[int(top + h * 0.35):int(top + h * 0.7), int(left + (right - left) * 0.25):int(right - (right - left) * 0.25)]
            px = patch.reshape(-1, 3).astype(np.float32)
            luma = px.mean(1)
            px = px[(luma > 25) & (luma < 235)]
            if len(px) > 100:
                means.append(px.mean(0))
                continue
        small = cv2.resize(fr, (135, 240)).reshape(-1, 3).astype(np.float32)
        luma = small.mean(1)
        mid = small[(luma > 35) & (luma < 215)]
        means.append(mid.mean(0) if len(mid) > 200 else small.mean(0))
    cap.release()
    means = np.array(means)
    k = max(1, int(fps * 1.5)) | 1
    pad = np.pad(means, ((k // 2, k // 2), (0, 0)), mode="edge")
    smooth = np.stack([np.convolve(pad[:, c], np.ones(k) / k, mode="valid") for c in range(3)], 1)
    hue = np.median(smooth / smooth.sum(1, keepdims=True), 0)          # typical skin colour balance
    level = np.percentile(smooth.sum(1), 70)                          # brightness of the better-lit moments
    target = hue * level
    gains = 1 + np.clip(target / np.maximum(smooth, 1) - 1, -args.max_gain, args.max_gain) * args.strength

    h, w = cv2.VideoCapture(str(raw)).read()[1].shape[:2]
    tmp = args.video.with_suffix(".matched.mp4")
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps),
                            "-i", "-", "-i", str(raw), "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-preset", "fast",
                            "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "copy", str(tmp)], stdin=subprocess.PIPE)
    cap = cv2.VideoCapture(str(raw))
    i = 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        g = gains[min(i, len(gains) - 1)]
        enc.stdin.write(np.clip(fr.astype(np.float32) * g, 0, 255).astype(np.uint8).tobytes())
        i += 1
    enc.stdin.close()
    enc.wait()
    tmp.replace(args.video)
    spread = lambda m: np.ptp(m.mean(1))
    print(f"matched {i} frames: brightness drift {spread(smooth):.0f} -> ~{spread(smooth * gains):.0f} (8-bit levels)")


if __name__ == "__main__":
    main()

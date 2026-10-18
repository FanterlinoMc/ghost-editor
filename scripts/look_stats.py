#!/usr/bin/env python3
"""Measure a recording's own picture (mean saturation and luma, the same definitions as loop/measure.py) inside
the kept takes, so build.mjs can steer the grade toward a template's target look on ANY footage.

    look_stats.py <talk.mp4> --takes '[[a,b],...]' [--n 24]      -> {"sat": 92.4, "luma": 81.0}

Why: a fixed CSS grade on a warm webcam clip lands far from the template's references (held-out test, 6 Oct:
saturation 137 vs refs 66). The reference editors grade per clip; look.target does the same.

Ported from Ahmed's phantasic engine/core (origin/main). Fork notes: unchanged. Needs OpenCV and numpy. build.mjs consumes it for `look.target` (primary recording only).
"""
import argparse
import json

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--takes", required=True)
    ap.add_argument("--n", type=int, default=24)
    a = ap.parse_args()
    takes = json.loads(a.takes)
    total = sum(b - t for t, b in takes) or 1
    times = []
    for i in range(a.n):
        x = (i + 0.5) / a.n * total
        for t, b in takes:
            if x <= b - t:
                times.append(t + x)
                break
            x -= b - t
    cap = cv2.VideoCapture(a.video)
    sat, luma = [], []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, fr = cap.read()
        if not ok:
            continue
        sm = cv2.resize(fr, (270, 480))
        sat.append(cv2.cvtColor(sm, cv2.COLOR_BGR2HSV)[..., 1].mean())
        luma.append(cv2.cvtColor(sm, cv2.COLOR_BGR2GRAY).mean())
    print(json.dumps({"sat": round(float(np.mean(sat)), 1) if sat else None, "luma": round(float(np.mean(luma)), 1) if luma else None}))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Face-aware 9:16 crop for landscape sources. Prints an ffmpeg crop filter: crop=<w>:<h>:<x-expr>:0

    face_crop.py <landscape.mp4>

Samples the source (YuNet, library/models), takes the largest face, and keeps it inside the middle 60% of the 9:16
window. If one fixed x does that, the crop is static (centred on the median face); otherwise a slow pan
(piecewise-linear, 3 s smoothed) follows the speaker. No face found -> centre crop (the old behaviour).

Ported from Ahmed's phantasic engine/core (f88943d, Keynote hardening round 1). Fork notes:
  - OPT-IN. Nothing calls it unless prep.sh is run with FACE_CROP=1 (9:16 only). prep.sh acts only on the STATIC result
    (`crop=<w>:<h>:<x>:0`); the panning `sendcmd=` and the letterboxing `fit:` results are not representable in the crop plan
    (build/crop-*.json: one scale + one offset) that build.mjs and safezone.mjs map face coordinates with, so prep.sh falls
    back to the centred crop for those and says so.
  - needs OpenCV (cv2) and the YuNet model (library/models/*.onnx, downloaded by face_track.py); either missing -> prints the
    centre crop and exits 0, so a caller never has to handle an error.
  - the pan command file defaults to a temp file, not /tmp (Windows).
"""
import json, os, statistics, subprocess, sys, tempfile
try:
    import cv2
except ImportError:   # no OpenCV on this machine: behave like "no face found"
    cv2 = None

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "..", "library", "models", "face_detection_yunet_2023mar.onnx")


def main():
    src = sys.argv[1]
    if cv2 is None:
        print("crop=centre"); return
    cap = cv2.VideoCapture(src)
    fps, n = cap.get(cv2.CAP_PROP_FPS) or 30, int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cw = int(H * 9 / 16) // 2 * 2
    centre = (W - cw) // 2
    if not os.path.exists(MODEL):
        print(f"crop={cw}:{H}:{centre}:0"); return
    q = 2 if W > 1400 else 1
    det = cv2.FaceDetectorYN.create(MODEL, "", (W // q, H // q), 0.6)
    pts, widths, step = [], [], max(1, round(fps / 3))
    for f in range(0, n, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, fr = cap.read()
        if not ok:
            break
        _, faces = det.detect(cv2.resize(fr, (W // q, H // q)))
        if faces is not None and len(faces):
            b = max(faces, key=lambda r: r[2] * r[3])
            pts.append((f / fps, (b[0] + b[2] / 2) * q)); widths.append(b[2] * q * 1.25)
    if len(pts) < 3:
        print(f"crop={cw}:{H}:{centre}:0"); return
    dur = n / fps
    # a face wider than ~85% of the 9:16 window (tight interview close-up) cannot be cropped without losing the ears/glasses:
    # print `fit:<x>:<w>` = keep a wider source window (face fills ~80%) and letterbox it over a blurred backdrop
    fw = sorted(widths)[int(0.9 * (len(widths) - 1))]
    if fw > 0.85 * cw and os.environ.get("FACE_FIT", "1") == "1":
        wc = int(min(W, max(cw, fw / 0.80))) // 2 * 2
        cxm = statistics.median(p[1] for p in pts)
        print(f"fit:{int(max(0, min(W - wc, cxm - wc / 2)))}:{wc}"); return
    med = statistics.median(p[1] for p in pts)
    lo, hi = 0.25 * cw, 0.75 * cw
    clampx = lambda x: int(max(0, min(W - cw, x)))
    static = clampx(med - cw / 2)
    rel = sorted(p[1] - static for p in pts)
    if lo <= rel[int(0.04 * (len(rel) - 1))] and rel[int(0.96 * (len(rel) - 1))] <= hi:
        print(f"crop={cw}:{H}:{static}:0"); return
    # virtual camera operator: follow the face with a dead band (no motion while the face stays near the centre), eased
    # per frame, written as a sendcmd file (crop x per frame) so the pan is smooth even when the speaker sways.
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(tempfile.gettempdir(), "face_crop.cmd")
    pts.sort()
    xs = [p[1] for p in pts]
    def target(t):
        if t <= pts[0][0]: return xs[0]
        for (t0, x0), (t1, x1) in zip(pts, pts[1:]):
            if t0 <= t <= t1: return x0 + (x1 - x0) * ((t - t0) / (t1 - t0) if t1 > t0 else 0)
        return xs[-1]
    cam, dead, alpha, lines = static + cw / 2, 0.10 * cw, 0.12, []
    for i in range(int(dur * fps) + 30):
        t = i / fps
        tg = target(t)
        if abs(tg - cam) > dead: cam += (tg - dead * (1 if tg > cam else -1) - cam) * alpha
        x = clampx(cam - cw / 2)
        if i == 0: x0 = x
        lines.append(f"{t:.3f} crop@c x {x};")
    open(out, "w").write("\n".join(lines) + "\n")
    print(f"sendcmd=f={out},crop@c={cw}:{H}:{x0}:0")

if __name__ == "__main__":
    main()

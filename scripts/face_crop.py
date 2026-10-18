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

FACE_PILLAR=1 (opt-in; Ahmed's Keynote 3, ff71824; default off here): a phone-shot insert inside a 16:9 frame is pillarboxed
(black bars left and right). Plain face cropping would keep the bars in the 9:16 window; with FACE_PILLAR=1 the window is centred
on the picture while an insert is on screen. A clip pillarboxed throughout gets one static x (`crop=...`, which prep.sh can use).
Inserts that come and go give a per-frame `sendcmd=` result like a pan, which prep.sh cannot express (it centres and says so).
"""
import bisect, json, os, statistics, subprocess, sys, tempfile
try:
    import cv2
    import numpy as np
except ImportError:   # no OpenCV on this machine: behave like "no face found"
    cv2 = None

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "..", "library", "models", "face_detection_yunet_2023mar.onnx")


def pillar(fr, W):
    """(lo, hi) of the picture when the frame is pillarboxed (a phone-shot insert inside a 16:9 frame), else None.
    Bars: black strips (>=98% black rows) from each edge, each >= 8% of the width. Between them >= 80% of the columns must
    be bright in >=90% of rows (a dark studio backdrop with a person in front never passes: the person is not full height).
    A ragged insert edge (first frames of a dissolve) is allowed; (lo, hi) is the full-height part. Ahmed's ff71824."""
    frac = (fr.max(axis=2) > 24).mean(axis=0)
    lit = np.where(frac > 0.02)[0]
    if not len(lit): return None
    L, R = int(lit.min()), int(lit.max())
    if L < 0.08 * W or R > 0.92 * W: return None
    core = np.where(frac[L:R + 1] >= 0.9)[0]
    if len(core) < 0.8 * (R - L + 1): return None
    return L + int(core.min()), L + int(core.max())


def pillar_cmd(cap, fps, n, W, cw, H, step, pills, xat, out):
    """sendcmd crop: x from xat(t), except on pillarboxed inserts where the window is centred on the picture (snap, no
    easing). Insert edges are found to the exact frame between the samples. Ahmed's ff71824."""
    flags = {}
    samples = list(range(0, n, step))
    for a, b in zip(samples, samples[1:]):
        flags[a] = pills.get(a)
        if bool(pills.get(a)) != bool(pills.get(b)):
            for f in range(a + 1, b):
                cap.set(cv2.CAP_PROP_POS_FRAMES, f); ok, fr = cap.read()
                flags[f] = pillar(fr, W) if ok else None
    if samples: flags[samples[-1]] = pills.get(samples[-1])
    keys = sorted(flags)
    xs = []
    for i in range(int(n / fps * fps) + 30):
        t = i / fps
        k = keys[max(0, bisect.bisect_right(keys, i) - 1)] if keys else 0
        pb = flags.get(k)
        if pb:
            lo, hi = pb
            x = int(max(0, min(W - cw, (lo + hi) / 2 - cw / 2)))
            if hi - lo >= cw: x = int(max(lo, min(hi - cw, x)))
        else:
            x = int(xat(t))
        xs.append((x, pb))
    # no 1-3 frame blips (a fade frame misread at an insert edge), no 1 px jitter inside an insert
    i = 0
    while i < len(xs):
        j = i
        while j < len(xs) and bool(xs[j][1]) == bool(xs[i][1]): j += 1
        if j - i < 4 and i > 0:
            for k in range(i, j): xs[k] = xs[i - 1]
        elif xs[i][1]:
            # back-to-back inserts with different picture bounds: one x per part (split where the left edge moves > 6 px),
            # left edge = the part's max lo, right edge = the part's median hi (a ragged dissolve frame never drags it in)
            a = i
            while a < j:
                b = a + 1
                while b < j and abs(xs[b][1][0] - xs[a][1][0]) <= 6: b += 1
                lo = max(pb[0] for _, pb in xs[a:b]); his = sorted(pb[1] for _, pb in xs[a:b]); hi = his[len(his) // 2]
                x = int(max(lo, min(hi + 1 - cw, (lo + hi + 1) / 2 - cw / 2))) if hi - lo + 1 >= cw else int(max(0, min(W - cw, (lo + hi + 1) / 2 - cw / 2)))
                for k in range(a, b): xs[k] = (x, xs[k][1])
                a = b
        i = j
    open(out, "w").write("\n".join(f"{i / fps:.3f} crop@c x {x};" for i, (x, _) in enumerate(xs)) + "\n")
    return f"sendcmd=f={out},crop@c={cw}:{H}:{xs[0][0]}:0"


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
    pills, nsamp = {}, 0   # sample frame -> (lo, hi) of a pillarboxed insert; stays empty unless FACE_PILLAR=1
    usepill = os.environ.get("FACE_PILLAR", "0") == "1"
    for f in range(0, n, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, fr = cap.read()
        if not ok:
            break
        nsamp += 1
        if usepill:
            pb = pillar(fr, W)
            if pb: pills[f] = pb
        _, faces = det.detect(cv2.resize(fr, (W // q, H // q)))
        if faces is not None and len(faces):
            b = max(faces, key=lambda r: r[2] * r[3])
            pts.append((f / fps, (b[0] + b[2] / 2) * q)); widths.append(b[2] * q * 1.25)
    if len(pts) < 3:
        print(f"crop={cw}:{H}:{centre}:0"); return
    dur = n / fps
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(tempfile.gettempdir(), "face_crop.cmd")
    if pills and len(pills) == nsamp:
        # pillarboxed throughout: one window centred on the picture (median bounds), a static crop prep.sh can use
        lo, hi = statistics.median(p[0] for p in pills.values()), statistics.median(p[1] for p in pills.values())
        print(f"crop={cw}:{H}:{int(max(0, min(W - cw, (lo + hi + 1) / 2 - cw / 2)))}:0"); return
    # a face wider than ~85% of the 9:16 window (tight interview close-up) cannot be cropped without losing the ears/glasses:
    # print `fit:<x>:<w>` = keep a wider source window (face fills ~80%) and letterbox it over a blurred backdrop
    fw = sorted(widths)[int(0.9 * (len(widths) - 1))]
    if fw > 0.85 * cw and not pills and os.environ.get("FACE_FIT", "1") == "1":
        wc = int(min(W, max(cw, fw / 0.80))) // 2 * 2
        cxm = statistics.median(p[1] for p in pts)
        print(f"fit:{int(max(0, min(W - wc, cxm - wc / 2)))}:{wc}"); return
    med = statistics.median(p[1] for p in pts)
    lo, hi = 0.25 * cw, 0.75 * cw
    clampx = lambda x: int(max(0, min(W - cw, x)))
    static = clampx(med - cw / 2)
    rel = sorted(p[1] - static for p in pts)
    if lo <= rel[int(0.04 * (len(rel) - 1))] and rel[int(0.96 * (len(rel) - 1))] <= hi:
        if pills:   # inserts come and go: the window snaps to the picture on them and stays on the face elsewhere
            print(pillar_cmd(cap, fps, n, W, cw, H, step, pills, lambda t: static, out)); return
        print(f"crop={cw}:{H}:{static}:0"); return
    # virtual camera operator: follow the face with a dead band (no motion while the face stays near the centre), eased
    # per frame, written as a sendcmd file (crop x per frame) so the pan is smooth even when the speaker sways.
    pts.sort()
    xs = [p[1] for p in pts]
    def target(t):
        if t <= pts[0][0]: return xs[0]
        for (t0, x0), (t1, x1) in zip(pts, pts[1:]):
            if t0 <= t <= t1: return x0 + (x1 - x0) * ((t - t0) / (t1 - t0) if t1 > t0 else 0)
        return xs[-1]
    cam, dead, alpha, lines, camx = static + cw / 2, 0.10 * cw, 0.12, [], []
    for i in range(int(dur * fps) + 30):
        t = i / fps
        tg = target(t)
        if abs(tg - cam) > dead: cam += (tg - dead * (1 if tg > cam else -1) - cam) * alpha
        x = clampx(cam - cw / 2)
        if i == 0: x0 = x
        camx.append(x)
        lines.append(f"{t:.3f} crop@c x {x};")
    if pills:
        print(pillar_cmd(cap, fps, n, W, cw, H, step, pills, lambda t: camx[min(len(camx) - 1, int(round(t * fps)))], out)); return
    open(out, "w").write("\n".join(lines) + "\n")
    print(f"sendcmd=f={out},crop@c={cw}:{H}:{x0}:0")

if __name__ == "__main__":
    main()

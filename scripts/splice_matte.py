"""Splice relit footage back into a reel's cut-out matte (talk-matte.webm, RGBA VP9).

    splice_matte.py orig-matte.webm relit.mp4 relit-mask.mp4 START out.webm
        relit covers one continuous source range starting at START seconds
    splice_matte.py orig-matte.webm relit.mp4 relit-mask.mp4 --takes takes.json out.webm
        relit is the takes concatenated, each cut with `handle` seconds either side: takes.json =
        {"handle": 0.1, "takes": [[a, b], ...]} (source seconds, ascending)
Every frame outside the relit ranges is copied from the original matte.

Ported from Ahmed's phantasic engine/core (origin/main, template-premium-iman: the later version, where the person matte owns the
edge and the depth mask only removes what is far from the person). Fork notes: needs OpenCV and numpy, ffmpeg with libvpx-vp9 on
PATH. No GPU, no model, no network. 1080x1920 at 30 fps only (the stage cut-out the build makes). The loop is CPU numpy:
roughly 0.2-0.4 s per frame, i.e. 6-12 minutes for a 60 s reel. EDGE_DARK (env, default 0.3) darkens the outer matte band; 0 = off.
The inputs relit.mp4 / relit-mask.mp4 come from relight.py, and orig-matte.webm is assets/talk-matte.webm from the build
(hyperframes remove-background, run by build.mjs: this script never runs it). Write the output to a NEW file, then copy it
over assets/talk-matte.webm (empire_finish.py does that and keeps assets/talk-matte.orig.webm).
"""
import json, os, subprocess, sys
import cv2
import numpy as np

W, H, FPS = 1080, 1920, 30
EDGE_DARK = float(os.environ.get("EDGE_DARK", 0.3))            # 0 = off
EDGE_FILL = 0.45                                           # original-pixel level where the relight has no data
if len(sys.argv) < 5 or sys.argv[1] in ("-h", "--help"):
    print(__doc__)
    sys.exit(0 if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help") else 2)
om, rv, rm = sys.argv[1], sys.argv[2], sys.argv[3]
out = sys.argv[-1]
for _p in (om, rv, rm):
    if not os.path.isfile(_p):
        sys.exit(f"splice_matte.py: file not found: {_p}")
if os.path.abspath(out) == os.path.abspath(om):
    sys.exit("splice_matte.py: the output must not be the input matte (it is read while it is written)")


def defringe(rgb, a):
    """Darken the outer ~8 px of the matte edge: fine hair shot against a bright wall keeps a light halo of wall
    colour there, which reads as a cut-out line on the dark set."""
    inner = cv2.erode(a, np.ones((17, 17), np.uint8))
    band = cv2.GaussianBlur((a.astype(np.float32) - inner) / 255, (0, 0), 2)
    return (rgb.astype(np.float32) * (1 - EDGE_DARK * band[..., None])).astype(np.uint8)


def rd(args, n):
    p = subprocess.Popen(["ffmpeg", "-loglevel", "error"] + args + ["-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    while True:
        b = p.stdout.read(W * H * n)
        if len(b) < W * H * n:
            return
        yield np.frombuffer(b, np.uint8).reshape(H, W, n)


if sys.argv[4] == "--takes":
    spec = json.load(open(sys.argv[5]))
    h = spec.get("handle", 0.0)
    segs, c0 = [], 0                                       # (source first frame, concat first frame, frame count)
    for a, b in spec["takes"]:
        n = round((b - a + 2 * h) * FPS)
        segs.append((round((a - h) * FPS), c0, n))
        c0 += n
else:
    segs = [(round(float(sys.argv[4]) * FPS), 0, 10 ** 9)]

enc = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-r", str(FPS),
                        "-i", "-", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24", "-row-mt", "1",
                        "-deadline", "good", "-cpu-used", "4", out], stdin=subprocess.PIPE)
active, k, n_done = None, 0, 0
for f, fr in enumerate(rd(["-c:v", "libvpx-vp9", "-i", om, "-pix_fmt", "rgba"], 4)):
    if active is None:
        for s in segs:
            if s[0] == f:
                start = s[1] / FPS
                active = (rd(["-ss", f"{start:.4f}", "-i", rv, "-pix_fmt", "rgb24"], 3),
                          rd(["-ss", f"{start:.4f}", "-i", rm, "-pix_fmt", "gray"], 1), s[2])
                k = 0
    if active is not None:
        try:
            # depth masks also catch near furniture (a chair back): keep only what the person matte keeps
            # the person matte owns the edge (soft hair); the depth mask only removes what is far from the person (a
            # chair back), so it is dilated ~25 px and softened first and can never nibble hair or the jaw line
            dmask = next(active[1])
            dm = cv2.GaussianBlur(cv2.dilate(dmask, np.ones((51, 51), np.uint8)), (0, 0), 8)
            a = np.minimum(dm[..., None], fr[..., 3:])
            a = cv2.GaussianBlur(a, (0, 0), 1.0)[..., None]
            # the relight is black outside its own (depth) mask: where the person matte reaches past it (hair tips,
            # a jaw edge) take the original pixel, dimmed to sit with the relit key, instead of a dark smudge
            m = cv2.GaussianBlur(dmask, (0, 0), 3).astype(np.float32)[..., None] / 255
            rgb = next(active[0]).astype(np.float32) * m + fr[..., :3].astype(np.float32) * EDGE_FILL * (1 - m)
            fr = np.dstack([defringe(np.clip(rgb, 0, 255).astype(np.uint8), a[..., 0]), a])
            k += 1
            n_done += 1
        except StopIteration:
            active = None
        if active is not None and k >= active[2]:
            active = None
    enc.stdin.write(np.ascontiguousarray(fr).tobytes())
enc.stdin.close()
enc.wait()
print(f"frames {f + 1}, relit {n_done}")

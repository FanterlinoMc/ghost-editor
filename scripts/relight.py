"""Depth-based relight of a talking-head clip.

    relight.py src.mp4 depth.mp4 out.mp4 [--frame] [--look neon|warm]

depth (Depth Anything video, 8-bit) -> heavily smoothed height field -> normals -> half-Lambert key + rim.
neon: red key from frame right, blue rim from the left, background to black (a set plate is composited later);
      also writes <out>-mask.mp4 (subject alpha) for splice_matte.py.
warm: amber key from frame left, soft fill, the real background kept but darkened + defocused by depth
      (a lens look on the original room, no compositing needed).

Ported from Ahmed's phantasic engine/core (origin/main, template-premium-iman). Fork notes:
  - needs OpenCV (opencv-python) and numpy, ffmpeg/ffprobe on PATH (libx264, and libvpx-vp9 for --matte). No GPU, no model,
    no network. The DEPTH MAP is an input: Ahmed made it with a depth model (Depth Anything video, a paid Higgsfield job);
    this script does not call it. Without a depth video there is nothing to relight.
  - everything is resampled to 1080x1920 (9:16 only); the frame loop is numpy/OpenCV on the CPU: expect roughly 0.3-0.6 s
    per frame, i.e. 10-20 minutes for a 60 s reel at 30 fps on a laptop (Ahmed: ~5 min on an M-series Mac). Both outputs
    (out.mp4 and out-mask.mp4) are written; the cost is once per source file, so cache them.
  - Windows-safe: no shell, no Mac path.
"""
import os, sys, subprocess, numpy as np, cv2

if len(sys.argv) < 4 or sys.argv[1] in ("-h", "--help"):
    print(__doc__)
    sys.exit(0 if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help") else 2)
src, dep, out = sys.argv[1:4]
for _p in (src, dep):
    if not os.path.isfile(_p):
        sys.exit(f"relight.py: file not found: {_p}")
one = "--frame" in sys.argv
look = sys.argv[sys.argv.index("--look") + 1] if "--look" in sys.argv else "neon"
if look not in ("neon", "warm"):
    sys.exit(f"relight.py: --look must be neon or warm (got {look})")
matte_path = sys.argv[sys.argv.index("--matte") + 1] if "--matte" in sys.argv else None
W, H = 1080, 1920

LOOKS = {
    "neon": dict(key_col=[1.0, 0.16, 0.22], key_dir=[0.85, -0.15, 0.50], key_gain=2.0, key_pow=4.0, key_white=0.35,
                 rim_col=[0.30, 0.42, 1.0], rim_dir=[-0.95, -0.2, -0.15], rim_gain=1.6,
                 ambient=0.24, falloff_from="right", bg="black"),
    "warm": dict(key_col=[1.0, 0.62, 0.34], key_dir=[-0.80, -0.25, 0.55], key_gain=1.25, key_pow=3.0, key_white=0.45,
                 rim_col=[1.0, 0.80, 0.60], rim_dir=[0.95, -0.2, -0.15], rim_gain=0.5,
                 ambient=0.42, falloff_from="left", bg="dim", bg_level=0.30, bg_tint=[1.0, 0.78, 0.58]),
}
P = LOOKS[look]


def unit(v):
    v = np.array(v, np.float32)
    return v / np.linalg.norm(v)


# auto-exposure: the key is tuned on a reference face (Moran, neon, 10 Oct 2026: face-band level 0.2925, linear).
# A paler or brighter subject takes the same light harder, so the key is scaled to land at the reference look.
REF_LEVEL = {"neon": 0.2925, "warm": 0.2925}


def face_level(src, dep, samples=8):
    def grab(p, t):
        r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.2f}", "-i", p, "-frames:v", "1", "-f", "rawvideo",
                            "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-"], capture_output=True).stdout
        return np.frombuffer(r, np.uint8).reshape(H, W, 3) if len(r) == W * H * 3 else None
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
                               capture_output=True, text=True).stdout)
    out = []
    for k in range(samples):
        t = dur * (k + 0.5) / samples
        i, d = grab(src, t), grab(dep, t)
        if i is None or d is None:
            continue
        m = d[..., 0] > 51
        ys = np.where(m.any(1))[0]
        if len(ys) < 50:
            continue
        y0, h = ys[0], ys[-1] - ys[0]
        band = m.copy()
        band[:y0 + int(0.12 * h)] = 0
        band[y0 + int(0.40 * h):] = 0
        xs = np.where(band.any(0))[0]
        if len(xs) < 20:
            continue
        cx, w = (xs[0] + xs[-1]) // 2, xs[-1] - xs[0]
        band[:, :cx - int(0.25 * w)] = 0
        band[:, cx + int(0.25 * w):] = 0
        out.append(np.median(((i.astype(np.float32) / 255) ** 2.2)[band].mean(1)))
    return float(np.median(out)) if out else None


EXPO = 1.0                                                 # input exposure pull (linear), 1 = as filmed
if "--no-auto" not in sys.argv:
    lvl = face_level(src, dep)
    if lvl:
        # a blown-out face (sun, phone auto-exposure) is first pulled down to 1.35x the reference, then the key is
        # scaled on what is left; faces up to 1.35x the reference are untouched here (the key scaling covers them)
        if lvl > REF_LEVEL[look] * 1.35:
            EXPO = REF_LEVEL[look] * 1.35 / lvl
        k = float(np.clip((REF_LEVEL[look] / (lvl * EXPO)) ** 1.5, 0.55, 1.4))
        P = dict(P, key_gain=P["key_gain"] * k, key_white=P["key_white"] * k)
        print(f"relight auto-exposure: face level {lvl:.4f} vs ref {REF_LEVEL[look]}, exposure x{EXPO:.2f}, key x{k:.2f}",
              file=sys.stderr)

KEY_COL, RIM_COL = np.array(P["key_col"], np.float32), np.array(P["rim_col"], np.float32)
L_KEY, L_RIM = unit(P["key_dir"]), unit(P["rim_dir"])
XS = np.linspace(0, 1, W, dtype=np.float32)[None, :]
FALLOFF = np.clip(0.25 + 0.95 * (XS if P["falloff_from"] == "right" else 1 - XS), 0, 1) ** 1.5


def frames(p):
    pr = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-i", p, "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-"],
                          stdout=subprocess.PIPE)
    while True:
        b = pr.stdout.read(W * H * 3)
        if len(b) < W * H * 3:
            return
        yield np.frombuffer(b, np.uint8).reshape(H, W, 3)


def relight(img, d, alpha=None):
    d = d.astype(np.float32) / 255
    mask = np.clip((cv2.GaussianBlur(d, (0, 0), 2) - 0.18) / 0.10, 0, 1)
    mask = cv2.GaussianBlur(cv2.erode(mask, np.ones((7, 7), np.uint8)), (0, 0), 2)
    z = cv2.GaussianBlur(d, (0, 0), 22) * 900
    gx = cv2.Sobel(z, cv2.CV_32F, 1, 0, ksize=5) / 32
    gy = cv2.Sobel(z, cv2.CV_32F, 0, 1, ksize=5) / 32
    n = np.dstack([-gx, -gy, np.ones_like(z)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    key = np.clip((n @ L_KEY) * 0.5 + 0.5, 0, 1) ** P["key_pow"]
    key = cv2.GaussianBlur(key.astype(np.float32), (0, 0), 13) * FALLOFF
    rim = np.clip(n @ L_RIM, 0, 1) ** 2.2
    lin = (img.astype(np.float32) / 255) ** 2.2 * EXPO
    lit = lin * P["ambient"] + lin * key[..., None] * (KEY_COL * P["key_gain"] + P["key_white"]) \
        + lin * rim[..., None] * RIM_COL * P["rim_gain"]
    if P["bg"] == "black":
        lit = lit * mask[..., None]
    else:
        tight = np.clip((cv2.GaussianBlur(d, (0, 0), 1.5) - 0.18) / 0.06, 0, 1)
        far = d < 0.08
        wall = np.median(lin[far], axis=0) if far.sum() > 1000 else lin[5:60, 5:60].reshape(-1, 3).mean(0)
        a = (alpha.astype(np.float32) / 255 if alpha is not None else tight)[..., None]
        # un-mix the wall from semi-transparent hair: F = (I - (1 - a) * wall) / a, then relight F, not I
        fg = np.clip((lin - (1 - a) * wall) / np.maximum(a, 0.08), 0, 1)
        lit = fg * P["ambient"] + fg * key[..., None] * (KEY_COL * P["key_gain"] + P["key_white"]) \
            + fg * rim[..., None] * RIM_COL * P["rim_gain"]
        bgw = np.broadcast_to(wall, lin.shape) * P["bg_level"] * np.array(P["bg_tint"], np.float32) * (0.45 + 0.55 * FALLOFF[..., None])
        lit = lit * a + bgw * (1 - a)
    o = np.clip(lit, 0, 1) ** (1 / 2.2)
    return (o * 255).astype(np.uint8), (mask * 255).astype(np.uint8)


def encoder(path, fmt):
    return subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", fmt, "-s", f"{W}x{H}", "-r", "30",
                             "-i", "-", "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", path], stdin=subprocess.PIPE)


def alphas(p):
    pr = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", p, "-vf", f"alphaextract,scale={W}:{H}",
                           "-f", "rawvideo", "-pix_fmt", "gray", "-"], stdout=subprocess.PIPE)
    while True:
        b = pr.stdout.read(W * H)
        if len(b) < W * H:
            return
        yield np.frombuffer(b, np.uint8).reshape(H, W)


AL = alphas(matte_path) if matte_path else None
if one:
    i, d = next(frames(src)), next(frames(dep))[..., 0]
    o, _ = relight(i, d, next(AL) if AL else None)
    cv2.imwrite(out, cv2.cvtColor(np.hstack([i, o]), cv2.COLOR_RGB2BGR))
else:
    enc, menc = encoder(out, "rgb24"), encoder(out.replace(".mp4", "-mask.mp4"), "gray")
    for i, d in zip(frames(src), frames(dep)):
        o, m = relight(i, d[..., 0], next(AL) if AL else None)
        enc.stdin.write(o.tobytes())
        menc.stdin.write(m.tobytes())
    for e in (enc, menc):
        e.stdin.close()
        e.wait()

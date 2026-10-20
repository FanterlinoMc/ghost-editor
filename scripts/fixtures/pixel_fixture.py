#!/usr/bin/env python3
"""A tiny synthetic reel for scripts/pixel-check.test.mjs: one clean project, or the same with ONE planted defect.

    pixel_fixture.py <dir> [<variant>]

Writes <dir>/reel.json, build/{geometry,edit_truth,caption_layout,sections,pixel_probe,words.whisper}.json,
assets/graphics/* and <dir>/render.mov (270x480, 30 fps, 4 s; h264 qp 0 + pcm audio) into a fresh <dir>. The canvas is
a quarter of 1080x1920 so the test stays fast; zones are the Instagram ones scaled. The probe file is hand-written
from the same scene (no Chrome), for the sample list pixel_check.py computes, so --probe use reads it as current. Face
detections for PX2 go in build/test_detections.json (PIXEL_CHECK_TEST_DETECTIONS, honoured only under node --test).
Nothing here is committed media: every file is generated into a temp dir by the test.
"""
import hashlib
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import pixel_check  # noqa: E402  (the checker's own sample plan: one list for probe and decode)

W, H, FPS, TOTAL = 270, 480, 30, 4.0
N = int(TOTAL * FPS)
FACE = dict(top=100, bottom=260, left=85, right=185, eyes=150, mouth=210)
INK, BOX = (255, 255, 255), (20, 18, 16)
GBOX = dict(x=20, y=300, w=80, h=60)   # the overlay graphic's box (lower left: off the face, out of the zones)


def caption(cid, t0, t1, text, y, x0=95, x1=175, fs=46.0):
    """two words side by side, x0..x1, y..y+30; their rects and the group rect around them"""
    mid = (x0 + x1) // 2
    words = [[x0, y, mid - 5 - x0, 30], [mid + 5, y, x1 - mid - 5, 30]]
    return {"id": cid, "t0": t0, "t1": t1, "text": text, "y": y, "words": words, "group": [x0 - 6, y - 4, x1 - x0 + 12, 38], "fs": fs}


def scene(v):
    s = {
        "caps": [caption("cg0", 0.2, 1.4, "HELLO THERE", 270), caption("cg1", 1.6, 2.4, "SECOND LINE", 270)],
        "graphic": dict(GBOX, t0=1.0, t1=2.0), "insert": None, "hidden": [],
        "face": dict(FACE), "dets_shift": 0, "black": [], "freeze": None, "clip_audio": False,
        "takes": [{"a": 0.0, "b": 2.0}, {"a": 3.0, "b": 5.0}],
        "words": [["hello", 0.2, 0.6], ["there", 0.7, 1.2], ["second", 1.6, 1.95], ["line", 3.1, 3.5], ["end", 3.6, 3.9]],
        "size": (W, H), "extra_text": None, "blob": False, "ink": INK, "box": BOX, "draw_shift": 0, "skip_ink": set(), "early_graphic": False, "box_white": False,
    }
    if v == "px0":
        s["size"] = (W, H - 2)
    elif v == "px1":
        s["graphic"].update(x=110, y=140)   # onto the face core
    elif v == "px2":
        s["dets_shift"] = 100
    elif v == "px3":
        s["face"].update(left=-150, right=-50)
    elif v == "px4":
        s["caps"][0] = caption("cg0", 0.2, 1.4, "HELLO THERE", 160)
    elif v == "px5":
        s["box_white"], s["box"] = True, (240, 240, 236)
    elif v == "px6":
        s["caps"][0]["fs"] = 30.0
    elif v == "px7":
        s["caps"][1] = caption("cg1", 1.6, 2.2, "A VERY LONG CAPTION OF FORTY CHARS HERE", 270)
    elif v == "px8a":
        s["skip_ink"] = {"cg1"}
    elif v in ("insert", "px8b"):
        s["insert"] = dict(t0=3.0, t1=3.6)
        s["hidden"] = [[2.92, 3.65]]
        s["caps"].append(caption("cg2", 2.5, 3.7, "UNDER INSERT", 270))
    elif v == "px9":
        s["draw_shift"] = 30
    elif v == "px9-blob":   # CP4 regression: a bright blob (a pearl necklace) beside a CENTRED caption is not the caption
        s["blob"] = True
    elif v == "px5-close":   # CP4 regression: ink #808080 on a box #6e6e6e (inside the old 40-level ink tolerance)
        s["ink"], s["box"] = (128, 128, 128), (110, 110, 110)
    elif v == "px14-caps":   # CP4 regression: a frozen picture still shows the previous caption: PX14 only
        s["caps"][1] = caption("cg1", 1.6, 2.2, "SECOND LINE", 270)
        s["caps"].append(caption("cg2", 2.25, 2.9, "THIRD ONE", 270))
        s["freeze"] = (60, 90)
    elif v == "px10":
        s["extra_text"] = {"el": "#lyr-t", "text": "OFF THE LEFT EDGE", "cap": False, "lines": [[-50.0, 200.0, 120.0, 30.0]], "clip": None, "op": 1}
    elif v == "px11":
        s["caps"][0] = caption("cg0", 0.2, 1.4, "HELLO THERE", 20)
    elif v == "px11g-upper":   # a graphic in the right-hand column, UPPER half: not the action column (owner answer 3)
        s["graphic"].update(x=190, y=60)
    elif v == "px11g-lower":   # the same graphic in the lower half: the action column
        s["graphic"].update(x=190, y=290)
    elif v == "px12":
        s["early_graphic"] = True
    elif v == "px13":
        s["black"] = [100, 101, 102]
    elif v == "px14":
        s["freeze"] = (84, 117)
    elif v == "px15":
        s["words"][2] = ["second", 1.9, 2.2]   # take 0 ends at b = 2.0, inside this word
    elif v == "px16":
        s["clip_audio"] = True
    elif v != "clean":
        raise SystemExit(f"unknown variant {v}")
    return s


def gframe(j):
    """the overlay graphic's own frame j (80x60 rgba): an opaque blue card with a moving yellow bar, transparent margin"""
    im = np.zeros((60, 80, 4), np.uint8)
    im[10:50, 10:70] = (0, 80, 60 + (j * 67) % 190, 255)   # a colour that jumps every frame: one frame early or late is visible
    x = 12 + (j * 2) % 50
    im[15:45, x:x + 6] = (250, 220, 30, 255)
    return im


def iframe(j):
    """the insert's own frame j (full canvas rgb): a shifting gradient"""
    yy, xx = np.mgrid[0:H, 0:W]
    return np.stack([(xx + 3 * j) % 256, (yy // 2 + j) % 256, np.full_like(xx, 120)], -1).astype(np.uint8)


def background(n):
    rng = np.random.default_rng(1000 + n)
    return rng.integers(60, 160, (H, W, 3), dtype=np.uint8)


def caps_visible(s, c, t):
    hidden = any(a <= t < b for a, b in s["hidden"])
    return c["t0"] <= t < c["t1"], hidden


def draw_caption(img, c, s):
    dx = s["draw_shift"]
    bx = box_rect(c, s)
    img[bx[1]:bx[1] + bx[3], bx[0] + dx:bx[0] + bx[2] + dx, :3] = s["box"]
    if img.shape[2] == 4:
        img[bx[1]:bx[1] + bx[3], bx[0] + dx:bx[0] + bx[2] + dx, 3] = 255
    for (x, y, w, h) in c["words"]:
        for lx in range(x + 1 + (y % 3), x + w - 4, 9 + (x % 2)):   # "letters": 6 px strokes, uneven gaps (a pattern to match)
            img[y + 4:y + h - 4, lx + dx:lx + 6 + dx, :3] = s["ink"]


def box_rect(c, s):
    gx, gy, gw, gh = c["group"]
    return [gx - 16, gy - 16, gw + 32, gh + 32] if s["box_white"] else [gx, gy, gw, gh]


def template(c, s):
    """the probe's image of the block alone (transparent around it), clip = group rect grown 16 px"""
    gx, gy, gw, gh = c["group"]
    x, y, w, h = max(0, gx - 16), max(0, gy - 16), gw + 32, gh + 32
    im = np.zeros((H, W, 4), np.uint8)
    s2 = dict(s, draw_shift=0)
    draw_caption(im, c, s2)
    return [x, y, w, h], im[y:y + h, x:x + w]


def render(s, d):
    w, h = s["size"]
    g = s["graphic"]
    f0, f1 = pixel_check.cl(g["t0"] * FPS), pixel_check.cl(g["t1"] * FPS)
    frames = []
    for n in range(N):
        t = n / FPS
        img = background(n)
        if s["freeze"] and s["freeze"][0] < n < s["freeze"][1]:   # the whole picture, captions included, held
            frames.append(frames[s["freeze"][0]].copy())
            continue
        fy0, fx0 = max(0, s["face"]["top"]), max(0, s["face"]["left"])
        if s["face"]["right"] > 0:
            img[fy0:s["face"]["bottom"], fx0:s["face"]["right"]] = (200, 160, 130)
        ins = s["insert"]
        if ins and ins["t0"] <= t < ins["t1"]:
            img = iframe(n - pixel_check.cl(ins["t0"] * FPS)).copy()
        for c in s["caps"]:
            vis, hidden = caps_visible(s, c, t)
            if not vis or c["id"] in s["skip_ink"]:
                continue
            if hidden and not (s.get("variant") == "px8b"):
                continue
            draw_caption(img, c, s)
        lo = f0 - 1 if s["early_graphic"] else f0
        if lo <= n < f1:
            gf = gframe(max(0, n - f0)).astype(np.float32)
            a = gf[..., 3:4] / 255.0
            reg = img[g["y"]:g["y"] + 60, g["x"]:g["x"] + 80].astype(np.float32)
            img[g["y"]:g["y"] + 60, g["x"]:g["x"] + 80] = (gf[..., :3] * a + reg * (1 - a)).round().astype(np.uint8)
        if s["blob"]:   # bright blobs in the ink colour beside the caption's box, like pearls on a necklace
            for cx in (55, 70, 205, 218):
                img[278:290, cx:cx + 10] = s["ink"]
        if n in s["black"]:
            img = np.zeros_like(img)
        frames.append(np.ascontiguousarray(img[:h, :w]))
    amp = "1.6" if s["clip_audio"] else "0.3"
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-",
           "-f", "lavfi", "-i", f"aevalsrc=min(1\\,max(-1\\,{amp}*sin(2*PI*220*t))):s=48000:d={TOTAL}",
           "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv444p", "-c:a", "pcm_s16le", "-shortest",
           os.path.join(d, "render.mov")]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    assert p.wait() == 0


def write_graphics(s, d):
    gd = os.path.join(d, "assets", "graphics")
    os.makedirs(gd, exist_ok=True)
    L = 30
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "80x60", "-r", str(FPS), "-i", "-",
                          "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-lossless", "1", "-auto-alt-ref", "0", os.path.join(gd, "card-0000000000000000.webm")], stdin=subprocess.PIPE)
    for j in range(L):
        p.stdin.write(gframe(j).tobytes())
    p.stdin.close()
    assert p.wait() == 0
    if s["insert"]:
        p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                              "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv444p", os.path.join(gd, "ins-0000000000000000.mp4")], stdin=subprocess.PIPE)
        for j in range(18):
            p.stdin.write(iframe(j).tobytes())
        p.stdin.close()
        assert p.wait() == 0


def main():
    d, v = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "clean")
    s = scene(v)
    s["variant"] = v
    os.makedirs(os.path.join(d, "build"), exist_ok=True)
    b = lambda name: os.path.join(d, "build", name)
    fc = s["face"]
    face = [[n, fc["top"], fc["bottom"], fc["left"], fc["right"], fc["eyes"], fc["mouth"], 0.0] for n in range(N)]
    g = s["graphic"]
    gr = [{"id": "card", "kind": "beat", "mode": "overlay", "by": "planner", "file": "assets/graphics/card-0000000000000000.webm", "fit": "contain",
           "opacity": 1, "box": {k: g[k] for k in ("x", "y", "w", "h")}, "t0": g["t0"], "t1": g["t1"],
           "f0": pixel_check.cl(g["t0"] * FPS), "f1": pixel_check.cl(g["t1"] * FPS), "hideCaptions": False, "selector": "#b0-in", "hard": True}]
    gr[0]["srcFrames"] = list(range(gr[0]["f1"] - gr[0]["f0"]))
    if s["insert"]:
        i = s["insert"]
        f0, f1 = pixel_check.cl(i["t0"] * FPS), pixel_check.cl(i["t1"] * FPS)
        gr.append({"id": "ins", "kind": "beat", "mode": "insert", "by": "planner", "file": "assets/graphics/ins-0000000000000000.mp4", "fit": "cover",
                   "opacity": 1, "box": {"x": 0, "y": 0, "w": W, "h": H}, "t0": i["t0"], "t1": i["t1"], "f0": f0, "f1": f1,
                   "srcFrames": list(range(f1 - f0)), "hideCaptions": True, "selector": "#b1-in", "hard": True})
    k0 = s["takes"][0]
    geo = {"v": 1, "W": W, "H": H, "fps": FPS, "frames": N, "total": TOTAL, "speech": TOTAL, "format": "9:16", "platform": "instagram",
           "zones": {"top": 55, "bottom": 105, "right": 33, "name": "Instagram Reels"}, "face": face, "faceSkip": [],
           "captionStyle": "house", "captionsDescribed": True,
           "captions": [{"id": c["id"], "t0": c["t0"], "t1": c["t1"], "y": c["y"], "h": 38, "mode": "below", "scale": 1, "cx": W / 2, "text": c["text"]} for c in s["caps"]],
           "hiddenCaps": [[a, b, "graphic:ins"] for a, b in s["hidden"]], "graphics": gr,
           "joins": [{"t": k0["b"] - k0["a"], "frame": int((k0["b"] - k0["a"]) * FPS), "take": 1, "src": "assets/talk.mp4", "out": k0["b"], "in": s["takes"][1]["a"], "outSrc": "assets/talk.mp4"}],
           "stillOk": [], "darkOk": []}
    gbytes = json.dumps(geo, separators=(",", ":")).encode()
    open(b("geometry.json"), "wb").write(gbytes)
    for name, obj in (("edit_truth.json", {"total": TOTAL, "speech": TOTAL, "fps": FPS, "takes": [], "beats": []}),
                      ("caption_layout.json", {"platform": {}, "safeTop": 55, "safeBottom": 375, "blocks": []}),
                      ("sections.json", {"total": TOTAL, "fps": FPS, "globalHash": None, "sections": []}),
                      ("words.whisper.json", {"segments": [{"words": [{"word": w, "start": a, "end": e} for w, a, e in s["words"]]}]})):
        json.dump(obj, open(b(name), "w"))
    json.dump({"source": "assets/talk.mp4", "words": "build/words.whisper.json", "takes": s["takes"]}, open(os.path.join(d, "reel.json"), "w"))
    plan = pixel_check.sample_plan(geo)
    samples, dets = {}, {}
    for n in plan["frames"]:
        t = n / FPS
        hidden = any(a <= t < bb for a, bb in s["hidden"])
        groups, text = [], []
        for c in s["caps"]:
            if not (c["t0"] <= t < c["t1"]):
                continue
            ic, bc = s["ink"], s["box"]
            words = [{"id": f"{c['id']}w{i}", "rect": [float(x) for x in r], "op": 1, "color": f"rgb({ic[0]}, {ic[1]}, {ic[2]})", "fs": c["fs"]} for i, r in enumerate(c["words"])]
            groups.append({"id": c["id"], "rect": [float(x) for x in c["group"]], "op": 1, "words": words,
                           "box": {"color": f"rgb({bc[0]}, {bc[1]}, {bc[2]})", "alpha": 1, "rect": [float(x) for x in box_rect(c, s)]}})
            if not hidden:
                for wd, word in zip(words, c["text"].split(" ", 1)):
                    text.append({"el": "#" + wd["id"], "text": word, "cap": True, "lines": [wd["rect"]], "clip": None, "op": 1})
        if s["extra_text"]:
            text.append(s["extra_text"])
        graphics = {x["id"]: {"rect": [float(x["box"][k]) for k in ("x", "y", "w", "h")], "op": 1 if x["f0"] <= n < x["f1"] else 0} for x in gr}
        samples[str(n)] = {"capsOp": 0 if hidden else 1, "groups": groups, "graphics": graphics, "text": text, "covers": []}
        dets[str(n)] = [fc["top"], fc["bottom"], fc["left"] + s["dets_shift"], fc["right"] + s["dets_shift"]]
    templates = {}
    os.makedirs(b("pixel_probe_caps"), exist_ok=True)
    import cv2
    for c in s["caps"]:
        n = plan["caps"][c["id"]][1]
        clip, im = template(c, s)
        name = f"{n}-{c['id']}.png"
        cv2.imwrite(b(os.path.join("pixel_probe_caps", name)), cv2.cvtColor(im, cv2.COLOR_RGBA2BGRA))
        templates[c["id"]] = {"frame": n, "file": f"pixel_probe_caps/{name}", "clip": clip}
    probe = {"v": 1, "chrome": "fixture", "geometry_sha256": hashlib.sha256(gbytes).hexdigest(), "html_sha256": None, "frames": plan["frames"],
             "refused": [], "samples": samples, "templates": templates}
    open(b("pixel_probe.json"), "w").write(pixel_check.canon(probe))
    json.dump(dets, open(b("test_detections.json"), "w"))
    write_graphics(s, d)
    render(s, d)


if __name__ == "__main__":
    main()

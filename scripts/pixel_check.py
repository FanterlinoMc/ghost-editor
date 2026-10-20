#!/usr/bin/env python3
"""Pixel check (A5, references/pixel-check.md): what a reviewer would catch on a FINISHED reel.

    pixel_check.py <project> <render.mp4> [--out <project>/build/pixel_check.json] [--render-ms N]
                   [--frames-dir DIR] [--probe auto|use] [--yunet MODEL.onnx]
    pixel_check.py <project> --print-samples FILE      (the sample list the probe takes, from geometry.json only)

Reads the render and the build's JSON (edit_truth, caption_layout, geometry, pixel_probe), checks rules PX0-PX16 and
writes build/pixel_check.json. Changes nothing else: no render, no fix, no edit. --probe auto (the default) runs
scripts/pixel_probe.mjs for the sample list while the grey pass, the audio and the graphic files decode; --probe use
reads an existing build/pixel_probe.json (PX0 if it is missing or was made for another geometry / sample list).

Exit 0 = pass or warn, 2 = fail, 3 = could not check (PX0; the report is still written).
Deterministic: the report minus `timing` and `report_sha256` is a pure function of the MP4 bytes, the build JSON, the
graphic files and the tool versions (fixed samples, -filter_threads 1, cv2.setNumThreads(1), rounded values, sorted
findings, canonical JSON).
"""
import time

_T_START = time.time()   # the budget counts the whole process, imports included

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CHECKER_VERSION = "1.0.0"
RULES = [
    ("PX0", "inputs agree"), ("PX1", "graphic covers the face"), ("PX2", "face track agrees with the render"),
    ("PX3", "face out of frame"), ("PX4", "caption over the eyes or mouth"), ("PX5", "caption contrast"),
    ("PX6", "caption text size"), ("PX7", "caption time on screen"), ("PX8", "caption drawn / hidden"),
    ("PX9", "caption off-centre"), ("PX10", "text off the canvas or clipped"), ("PX11", "UI zone"),
    ("PX12", "graphic outside its window"), ("PX13", "black frames"), ("PX14", "frozen frames"),
    ("PX15", "cut inside a word"), ("PX16", "audio clipping"),
]
MAX_FINDINGS = 50
FACE_MAX_AGE = 0.5
EPS = 1e-6
FACE_RULES = ("PX1", "PX2", "PX3", "PX4")
CAPTION_RULES = ("PX4", "PX5", "PX6", "PX7", "PX8", "PX9")


def rnd(x):
    """round half up (Math.round), not Python's banker's rounding"""
    return int(math.floor(x + 0.5))


def cl(x):
    return int(math.ceil(x - EPS))


def fl(x):
    return int(math.floor(x + EPS))


def r2(x):
    return float(f"{x:.2f}")


def r3(x):
    return float(f"{x:.3f}")


def canon(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- sampling (2.4) -----------------------------------
def sample_plan(geo):
    """The fixed frame list, a pure function of geometry.json, plus which samples each rule family uses."""
    fps, N = geo["fps"], geo["frames"]
    clamp = lambda f: min(max(f, 0), N - 1)
    grid, k = [], 0
    while True:
        f = rnd(k * 0.5 * fps)
        if f >= N:
            break
        grid.append(f)
        k += 1
    caps = {}
    for c in geo.get("captions", []):
        a, b = cl(c["t0"] * fps), cl(c["t1"] * fps) - 1
        if b < a:
            continue
        cand = [a + rnd(0.15 * fps), rnd((c["t0"] + c["t1"]) / 2 * fps), b]
        caps[c["id"]] = [clamp(min(max(f, a), b)) for f in cand]
    gfx = {}
    step = max(1, rnd(fps / 10))
    for g in geo.get("graphics", []):
        f0, f1 = g["f0"], g["f1"]
        s = {f0 - 1, f0, f1 - 1, f1} | set(range(f0, f1, step))
        gfx[g["id"]] = sorted({clamp(f) for f in s})
    joins = sorted({clamp(f) for j in geo.get("joins", []) for f in (j["frame"] - 1, j["frame"], j["frame"] + 1)})
    hidden = []
    for w in geo.get("hiddenCaps", []):
        a, b = w[0], min(w[1], geo["total"])
        hidden.append([clamp(cl((a + 0.08) * fps)), clamp(rnd((a + b) / 2 * fps)), clamp(fl((b - 0.05) * fps) - 1)])
    allf = set(grid) | set(joins)
    for v in caps.values():
        allf |= set(v)
    for v in gfx.values():
        allf |= set(v)
    for v in hidden:
        allf |= set(v)
    return {"frames": sorted(allf), "grid": grid, "caps": caps, "gfx": gfx, "joins": joins, "hidden": hidden}


# ---------------------------------------------------------------- runs and findings ---------------------------------
class Rule:
    def __init__(self, rid, name):
        self.id, self.name = rid, name
        self.status, self.checked, self.findings, self.notes = "pass", 0, [], []
        self.confidence = None

    def add(self, sev, subject, t, frame, value, threshold, unit, message, t_from=None, t_to=None, samples=None, extra=None):
        f = {"severity": sev, "subject": subject, "t": r3(t), "frame": int(frame), "value": value, "threshold": threshold,
             "unit": unit, "message": message}
        if t_from is not None:
            f.update({"t_from": r3(t_from), "t_to": r3(t_to), "samples": int(samples)})
        if extra:
            f.update(extra)
        self.findings.append(f)

    def skip(self, why):
        self.status = "skipped"
        self.notes.append(why)

    def out(self):
        fs = sorted(self.findings, key=lambda f: (f["t"], str(f["subject"]), f["message"]))
        if self.status != "skipped":
            self.status = "error" if any(f["severity"] == "error" for f in fs) else "warn" if fs else "pass"
        o = {"id": self.id, "name": self.name, "status": self.status, "checked": int(self.checked), "findings": fs[:MAX_FINDINGS]}
        if len(fs) > MAX_FINDINGS:
            o["truncated"] = len(fs) - MAX_FINDINGS
        if self.notes:
            o["not_checked"] = sorted(set(self.notes))
        if self.confidence:
            o["confidence"] = self.confidence
        return o


def runs(hits, order, fps):
    """hits: {frame: (level, value, payload)} on the evaluated sample list `order`. Consecutive = neighbours in `order`
    no more than 0.5 s apart. -> [[frame, ...], ...] runs of hit samples."""
    out, cur, prev = [], [], None
    for f in order:
        h = hits.get(f)
        if h is None or h[0] <= 0:
            if cur:
                out.append(cur)
            cur, prev = [], f
            continue
        if cur and (f - cur[-1]) > fps * 0.5 + EPS:
            out.append(cur)
            cur = []
        cur.append(f)
        prev = f
    if cur:
        out.append(cur)
    return out


def run_severity(run, hits):
    """two consecutive error-level samples make an error; else a run of two hits is a warn; a lone hit is nothing"""
    if len(run) < 2:
        return None
    lv = [hits[f][0] for f in run]
    if any(lv[i] >= 2 and lv[i + 1] >= 2 for i in range(len(lv) - 1)):
        return "error"
    return "warn"


def worst(run, hits, key=lambda h: h[1]):
    return max(run, key=lambda f: (hits[f][0], key(hits[f]), -f))


# ---------------------------------------------------------------- media helpers ------------------------------------
def tool_version(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True).stdout.split("\n")[0]
        m = re.search(r"version (\S+)", out)
        return m.group(1) if m else out.strip()
    except OSError:
        return None


def ffprobe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,nb_frames,channels,sample_rate",
                        "-of", "json", path], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:200])
    return json.loads(r.stdout).get("streams", [])


def select_script(frames):
    return "+".join(f"eq(n,{f})" for f in frames) or "0"


def decode_frames(path, frames, W, H, pix="rgb24", codec=None, vf=None):
    """yields (frame, ndarray HxWxC) for the listed frame indices, in order (full resolution unless vf scales to W x H)"""
    C = 4 if pix == "rgba" else 1 if pix == "gray" else 3
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fs:
        fs.write(f"[0:v]select='{select_script(frames)}'{',' + vf if vf else ''}[o]")
        script = fs.name
    cmd = ["ffmpeg", "-v", "error", "-nostdin", *(["-c:v", codec] if codec else []), "-i", path, "-filter_threads", "1",
           "-filter_complex_script", script, "-map", "[o]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", pix, "pipe:1"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    err = []
    th = threading.Thread(target=lambda: err.append(p.stderr.read()), daemon=True)
    th.start()
    size = W * H * C
    try:
        for f in frames:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            yield f, np.frombuffer(buf, np.uint8).reshape(H, W, C) if C > 1 else np.frombuffer(buf, np.uint8).reshape(H, W)
    finally:
        p.stdout.close()
        p.wait()
        th.join()
        os.unlink(script)


def grey_pass(path, fps):
    """one pass at 270x480 grey over every frame: blackdetect + freezedetect runs, in output seconds"""
    vf = "scale=270:480,format=gray,blackdetect=d=0:pix_th=0.10:pic_th=0.98,freezedetect=n=-60dB:d=0.5"
    r = subprocess.run(["ffmpeg", "-v", "info", "-nostats", "-nostdin", "-i", path, "-filter_threads", "1", "-an", "-vf", vf, "-f", "null", "-"],
                       capture_output=True, text=True)
    black, freeze, fs = [], [], None
    for line in r.stderr.split("\n"):
        m = re.search(r"black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)", line)
        if m:
            black.append((float(m.group(1)), float(m.group(2))))
        m = re.search(r"freeze_start:\s*([\d.]+)", line)
        if m:
            fs = float(m.group(1))
        m = re.search(r"freeze_end:\s*([\d.]+)", line)
        if m and fs is not None:
            freeze.append((fs, float(m.group(1))))
            fs = None
    return black, freeze, fs


def decode_audio(path):
    st = [s for s in ffprobe(path) if s.get("codec_type") == "audio"]
    if not st:
        return None, 0
    ch = int(st[0].get("channels") or 2)
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-ar", "48000", "-ac", str(ch), "pipe:1"],
                       capture_output=True)
    return np.frombuffer(r.stdout, np.float32).reshape(-1, ch), ch


# ---------------------------------------------------------------- pixel helpers ------------------------------------
def parse_color(s):
    m = re.match(r"rgba?\(([^)]+)\)", s or "")
    if not m:
        return None
    p = [float(x) for x in m.group(1).replace("/", ",").split(",") if x.strip()]
    return np.array(p[:3], np.int16)


def rect_int(r, W, H, grow=0, growx=None):
    gx = grow if growx is None else growx
    x0, y0 = max(0, int(math.floor(r[0] - gx))), max(0, int(math.floor(r[1] - grow)))
    x1, y1 = min(W, int(math.ceil(r[0] + r[2] + gx))), min(H, int(math.ceil(r[1] + r[3] + grow)))
    return x0, y0, x1, y1


def inter_area(a, b):
    """a, b = (x0, y0, x1, y1)"""
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def rel_lum(rgb):
    c = rgb.astype(np.float64) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]


def ink_mask(img, color):
    return np.abs(img.astype(np.int16) - color).max(axis=-1) <= 40


def zones_of(geo):
    W, H, z = geo["W"], geo["H"], geo["zones"]
    # owner answer 3 (2026-10-19): the action column is the right-hand column in the LOWER half only (safezone.mjs)
    return [("top", (0, 0, W, z["top"])), ("bottom", (0, H - z["bottom"], W, H)), ("right", (W - z["right"], H / 2, W, H))]


def zone_area(rect_xyxy, zones):
    """area of the rect inside the union of the zones (zones overlap only in corners: count the union exactly)"""
    m = 0.0
    xs = sorted({rect_xyxy[0], rect_xyxy[2], *[z[1][0] for z in zones], *[z[1][2] for z in zones]})
    ys = sorted({rect_xyxy[1], rect_xyxy[3], *[z[1][1] for z in zones], *[z[1][3] for z in zones]})
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            cell = (xs[i], ys[j], xs[i + 1], ys[j + 1])
            if inter_area(cell, rect_xyxy) <= 0:
                continue
            cx, cy = (cell[0] + cell[2]) / 2, (cell[1] + cell[3]) / 2
            if any(z[1][0] <= cx < z[1][2] and z[1][1] <= cy < z[1][3] for z in zones):
                m += inter_area(cell, rect_xyxy)
    return m


def zone_mask(geo):
    W, H = geo["W"], geo["H"]
    m = np.zeros((H, W), bool)
    for _, (x0, y0, x1, y1) in zones_of(geo):
        m[int(y0):int(y1), int(x0):int(x1)] = True
    return m


def zone_name_at(rect_xyxy, zones):
    best = max(zones, key=lambda z: inter_area(z[1], rect_xyxy))
    return best[0]


# ---------------------------------------------------------------- the check ----------------------------------------
class Check:
    def __init__(self, a):
        self.a = a
        self.proj = os.path.abspath(a.project)
        self.build = os.path.join(self.proj, "build")
        self.rules = {rid: Rule(rid, name) for rid, name in RULES}
        self.timing = {}
        self.unreadable = []
        self.versions = {"checker": CHECKER_VERSION}

    def t(self, stage, ms):
        self.timing[stage] = self.timing.get(stage, 0) + int(round(ms))

    def load(self, name):
        p = os.path.join(self.build, name)
        if not os.path.exists(p):
            return None, None
        b = open(p, "rb").read()
        try:
            return json.loads(b), sha256_bytes(b)
        except ValueError:
            self.unreadable.append(name)
            return None, sha256_bytes(b)

    # ---------------- PX0 ----------------
    def px0(self):
        R = self.rules["PX0"]
        R.checked = 1
        msgs = []
        self.geo, gsha = self.load("geometry.json")
        self.edit, esha = self.load("edit_truth.json")
        self.layout, lsha = self.load("caption_layout.json")
        self.sections, _ = self.load("sections.json")
        self.json_sha = {"geometry.json": gsha, "edit_truth.json": esha, "caption_layout.json": lsha}
        for name in self.unreadable:
            msgs.append(f"PX0 build/{name} is not readable JSON")
        for name, v in (("geometry.json", self.geo), ("edit_truth.json", self.edit), ("caption_layout.json", self.layout)):
            if v is None and name not in self.unreadable:
                msgs.append(f"PX0 missing build/{name}")
        if not os.path.exists(self.a.render):
            msgs.append(f"PX0 missing {os.path.basename(self.a.render)}")
        if msgs:
            return msgs
        g = self.geo
        st = ffprobe(self.a.render)
        v = next((s for s in st if s.get("codec_type") == "video"), None)
        if v is None:
            return [f"PX0 {os.path.basename(self.a.render)} has no video stream"]
        num, den = (int(x) for x in v["r_frame_rate"].split("/"))
        fps = num / den if den else 0
        n = int(v.get("nb_frames") or 0)
        if not n:
            r = subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", self.a.render], capture_output=True, text=True)
            n = int(r.stdout.strip() or 0)
        self.render_info = {"W": v["width"], "H": v["height"], "fps": fps, "frames": n}
        want_n = rnd(g["total"] * g["fps"])
        if v["width"] != g["W"] or v["height"] != g["H"] or abs(fps - g["fps"]) > 1e-3 or abs(n - want_n) > 1:
            fr = f"{fps:g}"
            msgs.append(f"PX0 render {v['width']}x{v['height']} @ {fr} fps, {n} frames does not match the build ({g['W']}x{g['H']} @ {g['fps']} fps, {want_n} frames)")
        for name, d in (("edit_truth.json", self.edit), ("sections.json", self.sections)):
            if d is None:
                continue
            if abs(d.get("total", g["total"]) - g["total"]) > 1e-3 or abs(d.get("fps", g["fps"]) - g["fps"]) > 1e-3:
                msgs.append(f"PX0 geometry.json says total {g['total']}s @ {g['fps']} fps, {name} says {d.get('total')}s @ {d.get('fps')} fps")
        return msgs

    def probe_check(self):
        msgs = []
        self.probe, psha = self.load("pixel_probe.json")
        self.json_sha["pixel_probe.json"] = psha
        if self.probe is None:
            return ["PX0 build/pixel_probe.json is not readable JSON" if psha else "PX0 missing build/pixel_probe.json"]
        if self.probe.get("geometry_sha256") != self.json_sha["geometry.json"] or self.probe.get("frames") != self.plan["frames"]:
            msgs.append("PX0 pixel_probe.json was made for another geometry.json or sample list (stale): run pixel_probe.mjs again")
        return msgs

    # ---------------- graphics ----------------
    def load_graphics(self):
        """decode, per graphic, the file frames the samples need (overlay: rgba with alpha; insert: rgb)"""
        self.gfiles = {g["id"]: None for g in self.geo["graphics"]}
        ths = [threading.Thread(target=self.load_graphic, args=(g,)) for g in self.geo["graphics"]]
        for th in ths:
            th.start()
        for th in ths:
            th.join()

    def load_graphic(self, g):
        path = os.path.join(self.proj, g["file"])
        if not os.path.exists(path):
            return
        st = next(s for s in ffprobe(path) if s.get("codec_type") == "video")
        gw, gh = st["width"], st["height"]
        need = set()
        # an overlay is measured at every graphic sample (PX1, PX11); an insert only at its window's edges (PX12)
        for f in (self.plan["gfx"].get(g["id"], []) if g["mode"] == "overlay" else (g["f0"] - 1, g["f0"], g["f1"] - 1, g["f1"])):
            need.add(self.gframe_for(g, f))
        for wf in self.plan["hidden"]:
            for f in wf:
                if g["f0"] <= f < g["f1"]:
                    need.add(self.gframe_for(g, f))
        need = sorted(x for x in need if x is not None)
        insert = g["mode"] == "insert"
        codec = "libvpx-vp9" if path.endswith(".webm") else None
        frames = {}
        for j, img in decode_frames(path, need, gw, gh, pix="rgb24" if insert else "rgba", codec=codec):
            frames[j] = img.copy()
        self.gfiles[g["id"]] = {"w": gw, "h": gh, "frames": frames}

    @staticmethod
    def gframe_for(g, f):
        sf = g["srcFrames"]
        if not sf:
            return None
        if f < g["f0"]:
            return sf[0]
        if f >= g["f1"]:
            return sf[-1]
        return sf[f - g["f0"]]

    def placed(self, g, f, use_probe_op=True):
        """the graphic's frame for output frame f fitted into its rect on the canvas:
        -> (x0, y0, rgb HxWx3 int16, alpha HxW float) clipped to the rect and the canvas, or None"""
        gf = self.gfiles.get(g["id"])
        j = self.gframe_for(g, f)
        if not gf or j not in gf["frames"]:
            return None
        import cv2
        img = gf["frames"][j]
        ps = (self.probe["samples"].get(str(f)) or {}).get("graphics", {}).get(g["id"])
        rect = ps["rect"] if ps else [g["box"]["x"], g["box"]["y"], g["box"]["w"], g["box"]["h"]]
        x, y, w, h = rect
        if w <= 0 or h <= 0:
            return None
        gw, gh = gf["w"], gf["h"]
        s = min(w / gw, h / gh) if g["fit"] == "contain" else max(w / gw, h / gh)
        dw, dh = gw * s, gh * s
        ox, oy = x + (w - dw) / 2, y + (h - dh) / 2
        if abs(s - 1) > 1e-3:
            img = cv2.resize(img, (max(1, rnd(dw)), max(1, rnd(dh))), interpolation=cv2.INTER_LINEAR)
        ox, oy = rnd(ox), rnd(oy)
        W, H = self.geo["W"], self.geo["H"]
        X0, Y0 = max(ox, int(math.floor(x)), 0), max(oy, int(math.floor(y)), 0)
        X1, Y1 = min(ox + img.shape[1], int(math.ceil(x + w)), W), min(oy + img.shape[0], int(math.ceil(y + h)), H)
        if X1 <= X0 or Y1 <= Y0:
            return None
        crop = img[Y0 - oy:Y1 - oy, X0 - ox:X1 - ox]
        if img.shape[2] == 4:
            alpha = crop[..., 3].astype(np.float32) / 255.0
        else:
            alpha = np.ones(crop.shape[:2], np.float32)
        op = (ps["op"] if (ps and use_probe_op) else g["opacity"])
        return X0, Y0, crop[..., :3].astype(np.int16), alpha * op

    # ---------------- the main pass ----------------
    def run(self):
        T0 = _T_START
        msgs = self.px0()
        if msgs:
            return self.finish_px0(msgs, T0)
        g = self.geo
        self.plan = sample_plan(g)
        fps, W, H = g["fps"], g["W"], g["H"]
        # ---- in parallel: the probe (Chrome), the grey pass, the audio, the graphic files ----
        res = {}

        def timed(name, fn):
            t = time.time()
            try:
                res[name] = fn()
            except Exception as e:  # reported as a skipped rule, never a crash
                res[name] = e
            self.t(name, (time.time() - t) * 1000)

        first = []   # the measuring pass needs these two; the grey pass and the audio run on beside it
        if self.a.probe == "auto":
            first.append(threading.Thread(target=timed, args=("probe", self.run_probe)))
        first.append(threading.Thread(target=timed, args=("graphics", self.load_graphics)))
        later = [threading.Thread(target=timed, args=("grey_pass", lambda: grey_pass(self.a.render, fps))),
                 threading.Thread(target=timed, args=("audio", lambda: decode_audio(self.a.render)))]
        for th in first + later:
            th.start()
        for th in first:
            th.join()
        if isinstance(res.get("probe"), Exception):
            for th in later:
                th.join()
            return self.finish_px0([f"PX0 pixel_probe.mjs failed: {str(res['probe']).splitlines()[0][:200]}"], T0)
        msgs = self.probe_check()
        if msgs:
            for th in later:
                th.join()
            return self.finish_px0(msgs, T0)
        self.versions["chrome"] = self.probe.get("chrome")
        if isinstance(res.get("graphics"), Exception):
            raise res["graphics"]
        # ---- full-resolution decode of the samples, measured frame by frame ----
        t = time.time()
        self.prepare()
        tm = {"measure": 0.0}
        from concurrent.futures import ThreadPoolExecutor
        pool = ThreadPoolExecutor(max_workers=4)   # YuNet beside the decode (cv2 releases the GIL; one thread per detector)
        futs = []
        for f, img in decode_frames(self.a.render, self.plan["frames"], W, H):
            t1 = time.time()
            self.measure(f, img)
            tm["measure"] += time.time() - t1
            if f in self.grid_set and self.wants_face(f):
                futs.append((f, pool.submit(self.detect_face, f, img.copy())))
        self.t("decode", (time.time() - t) * 1000 - tm["measure"] * 1000)
        t2 = time.time()
        for f, fu in futs:
            self.dets[f] = fu.result()
        pool.shutdown()
        self.t("faces_wait", (time.time() - t2) * 1000)
        for th in later:
            th.join()
        t = time.time()
        self.evaluate(res)
        self.t("rules", (time.time() - t) * 1000 + tm["measure"] * 1000)
        return self.finish(T0)

    def run_probe(self):
        fd, fpath = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as f:
            json.dump({"frames": self.plan["frames"]}, f)
        try:
            r = subprocess.run(["node", os.path.join(HERE, "pixel_probe.mjs"), self.proj, "--frames", fpath], capture_output=True, text=True)
            if r.returncode:
                raise RuntimeError((r.stderr or r.stdout).strip()[-300:])
        finally:
            os.unlink(fpath)

    def prepare(self):
        g = self.geo
        fps = g["fps"]
        self.grid_set = set(self.plan["grid"])
        self.face = {e[0]: e for e in g["face"]}
        self.zones = zones_of(g)
        self.zmask = zone_mask(g)
        self.cap_by_id = {c["id"]: c for c in g.get("captions", [])}
        self.cap_samples = {}
        for cid, fs in self.plan["caps"].items():
            for k, f in enumerate(fs):
                self.cap_samples.setdefault(f, []).append((cid, k))
        self.hidden_samples = {}
        for wi, fs in enumerate(self.plan["hidden"]):
            for f in fs:
                self.hidden_samples.setdefault(f, []).append(wi)
        self.m = {k: {} for k in ("px1", "px2", "px3", "px4", "px5", "px6", "px8a", "px8b", "px9", "px10", "px11c", "px11t", "px11g", "px12")}
        self.cover = {}
        self.det_path = None
        self.dark_cache = {}
        self.tls = threading.local()
        self.dets = {}
        import cv2
        self.versions["opencv"] = cv2.__version__
        test_dets = os.environ.get("PIXEL_CHECK_TEST_DETECTIONS")
        if test_dets and os.environ.get("NODE_TEST_CONTEXT"):
            self.test_dets = {int(k): v for k, v in json.load(open(test_dets)).items()}
        else:
            self.test_dets = None
            self.init_yunet()

    def init_yunet(self):
        import cv2
        cv2.setNumThreads(1)
        sys.path.insert(0, HERE)
        import face_track
        path = self.a.yunet or os.environ.get("PIXEL_CHECK_YUNET") or face_track.MODEL
        self.versions["opencv"] = cv2.__version__
        if not os.path.exists(path):
            self.det_problem = f"YuNet model not found ({os.path.basename(path)}; run face_track.py once, or pass --yunet)"
            return
        bad = face_track.model_problem(path)
        if bad:
            self.det_problem = f"YuNet model at {os.path.basename(path)} is not the pinned file ({bad})"
            return
        self.versions["yunet_sha256"] = face_track.MODEL_SHA256
        self.det_path = path

    def face_at(self, f):
        e = self.face.get(f)
        if not e or e[1] is None or e[7] > FACE_MAX_AGE + EPS:
            return None
        return {"top": e[1], "bottom": e[2], "left": e[3], "right": e[4], "eyes": e[5], "mouth": e[6]}

    @staticmethod
    def core_of(fc):
        d = fc["mouth"] - fc["eyes"]
        return (fc["left"], fc["eyes"] - 0.25 * d, fc["right"], fc["mouth"] + 0.25 * d)

    def is_cover(self, f, ps):
        if any(gg["mode"] == "insert" and gg["f0"] <= f < gg["f1"] for gg in self.geo["graphics"]):
            return True
        return bool(ps and ps.get("covers"))

    def measure(self, f, img):
        g, fps, W, H = self.geo, self.geo["fps"], self.geo["W"], self.geo["H"]
        ps = self.probe["samples"].get(str(f), {})
        cover = self.is_cover(f, ps)
        self.cover[f] = cover
        fc = None if cover else self.face_at(f)
        core = self.core_of(fc) if fc else None
        fbox = (fc["left"], fc["top"], fc["right"], fc["bottom"]) if fc else None
        groups = {gr["id"]: gr for gr in ps.get("groups", [])}
        caps_op = ps.get("capsOp", 0)

        # ---- overlay graphics: opaque mask vs the face and the UI zones; PX12 presence at the window edges ----
        for gg in g["graphics"]:
            f0, f1 = gg["f0"], gg["f1"]
            if f not in self.plan["gfx"].get(gg["id"], []):
                continue
            if gg["mode"] == "overlay" and f0 <= f < f1:
                pl = self.placed(gg, f)
                if pl is not None:
                    x0, y0, rgb, al = pl
                    mask = al >= 0.5
                    h, w = mask.shape
                    over = corepx = 0
                    if fbox is not None:
                        a = (max(x0, fbox[0]), max(y0, fbox[1]), min(x0 + w, fbox[2]), min(y0 + h, fbox[3]))
                        if a[2] > a[0] and a[3] > a[1]:
                            over = int(mask[int(a[1]) - y0:int(math.ceil(a[3])) - y0, int(a[0]) - x0:int(math.ceil(a[2])) - x0].sum())
                        c = (max(x0, core[0]), max(y0, core[1]), min(x0 + w, core[2]), min(y0 + h, core[3]))
                        if c[2] > c[0] and c[3] > c[1]:
                            corepx = int(mask[int(math.floor(c[1])) - y0:int(math.ceil(c[3])) - y0, int(math.floor(c[0])) - x0:int(math.ceil(c[2])) - x0].sum())
                        area = max(1.0, (fbox[2] - fbox[0]) * (fbox[3] - fbox[1]))
                        self.m["px1"].setdefault(gg["id"], {})[f] = (over, corepx, area)
                    elif not cover:
                        self.m["px1"].setdefault(gg["id"], {})[f] = None
                    zpx = int((mask & self.zmask[y0:y0 + h, x0:x0 + w]).sum())
                    self.m["px11g"].setdefault(gg["id"], {})[f] = zpx
            if f in (f0 - 1, f0, f1 - 1, f1) and gg.get("hard", True):
                self.m["px12"].setdefault(gg["id"], {})[f] = self.present(gg, f, img, ps)

        # ---- captions ----
        cap_samples = self.cap_samples.get(f, [])
        for cid, k in cap_samples:
            c = self.cap_by_id.get(cid)
            gr = groups.get(cid)
            if c is None:
                continue
            vis_words = [w for w in (gr["words"] if gr else []) if w["op"] >= 0.99] if (gr and caps_op >= 0.99 and gr["op"] >= 0.99) else []
            if gr is None or gr["op"] <= 0:
                continue
            if vis_words:
                area = sum(w["rect"][2] * w["rect"][3] for w in vis_words)
                inkpx, inks = 0, []
                for w in vis_words:
                    col = parse_color(w["color"])
                    x0, y0, x1, y1 = rect_int(w["rect"], W, H)
                    if col is None or x1 <= x0 or y1 <= y0:
                        continue
                    m = ink_mask(img[y0:y1, x0:x1], col)
                    inkpx += int(m.sum())
                cov = inkpx / max(1.0, area)
                self.m["px8a"].setdefault(cid, {})[f] = (r2(cov), k)
                # PX5 contrast at all three samples
                self.m["px5"].setdefault(cid, {})[f] = self.contrast(img, gr, vis_words, cov)
                # PX4 caption over the eyes / mouth
                if core is not None:
                    px = sum(inter_area(core, (w["rect"][0], w["rect"][1], w["rect"][0] + w["rect"][2], w["rect"][1] + w["rect"][3])) for w in vis_words)
                    self.m["px4"].setdefault(cid, {})[f] = int(px)
                elif not cover:
                    self.m["px4"].setdefault(cid, {})[f] = None
                # PX11 caption word in a UI zone
                zpx = sum(zone_area((w["rect"][0], w["rect"][1], w["rect"][0] + w["rect"][2], w["rect"][1] + w["rect"][3]), self.zones) for w in vis_words)
                zn = zone_name_at(tuple(gr["rect"][:2]) + (gr["rect"][0] + gr["rect"][2], gr["rect"][1] + gr["rect"][3]), self.zones)
                self.m["px11c"].setdefault(cid, {})[f] = (int(zpx), zn)
                if k == 1:
                    self.m["px6"][cid] = (f, min(w["fs"] for w in vis_words))
                    self.m["px9"][cid] = (f, self.centre(img, gr, vis_words))

        # ---- captions inside a hidden window ----
        for wi in self.hidden_samples.get(f, []):
            a, b, why = g["hiddenCaps"][wi]
            for gr in ps.get("groups", []):
                c = self.cap_by_id.get(gr["id"])
                if c is None or gr["op"] <= 0 or not (c["t0"] < b and c["t1"] > a):
                    continue
                ins = next((gg for gg in g["graphics"] if gg["mode"] == "insert" and gg["f0"] <= f < gg["f1"]), None)
                x0, y0, x1, y1 = rect_int(gr["rect"], W, H)
                if x1 <= x0 or y1 <= y0:
                    continue
                if ins is not None:
                    pl = self.placed(ins, f)
                    if pl is None:
                        continue
                    ix0, iy0, rgb, _ = pl
                    sub = rgb[y0 - iy0:y1 - iy0, x0 - ix0:x1 - ix0]
                    d = float(np.abs(img[y0:y1, x0:x1].astype(np.int16) - sub).mean())
                    self.m["px8b"].setdefault((gr["id"], wi), {})[f] = ("diff", r2(d), why or ins["id"])
                else:
                    area = sum(w["rect"][2] * w["rect"][3] for w in gr["words"]) or 1.0
                    inkpx = 0
                    for w in gr["words"]:
                        col = parse_color(w["color"])
                        wx0, wy0, wx1, wy1 = rect_int(w["rect"], W, H)
                        if col is None or wx1 <= wx0 or wy1 <= wy0:
                            continue
                        inkpx += int(ink_mask(img[wy0:wy1, wx0:wx1], col).sum())
                    self.m["px8b"].setdefault((gr["id"], wi), {})[f] = ("ink", r2(inkpx / area), why)

        # ---- PX3 face in frame (grid) ----
        if f in self.grid_set and fc is not None:
            area = max(1.0, (fc["right"] - fc["left"]) * (fc["bottom"] - fc["top"]))
            vis = inter_area((fc["left"], fc["top"], fc["right"], fc["bottom"]), (0, 0, W, H)) / area
            out = {"top": -fc["top"], "bottom": fc["bottom"] - H, "left": -fc["left"], "right": fc["right"] - W}
            self.m["px3"][f] = (r2(vis), max(out, key=lambda k: out[k]), fc["eyes"] < 0 or fc["eyes"] > H)
        elif f in self.grid_set and not cover:
            self.m["px3"][f] = None

        # ---- PX10 / PX11 probe text lines ----
        for tx in ps.get("text", []):
            worst_off, edge, clipped = 0.0, None, 0.0
            for (x, y, w, h) in tx["lines"]:
                for e, v in (("left", -x), ("top", -y), ("right", x + w - W), ("bottom", y + h - H)):
                    if v > worst_off:
                        worst_off, edge = v, e
                if tx.get("clip"):
                    cx, cy, cw, ch = tx["clip"]
                    clipped = max(clipped, cx - x, cy - y, x + w - (cx + cw), y + h - (cy + ch))
            key = (tx["el"], tx["text"][:30])
            self.m["px10"].setdefault(key, {})[f] = (rnd(worst_off), edge, rnd(max(0.0, clipped)))
            if not tx.get("cap"):
                zpx = sum(zone_area((x, y, x + w, y + h), self.zones) for (x, y, w, h) in tx["lines"])
                zn = zone_name_at((tx["lines"][0][0], tx["lines"][0][1], tx["lines"][0][0] + tx["lines"][0][2], tx["lines"][0][1] + tx["lines"][0][3]), self.zones)
                self.m["px11t"].setdefault(key, {})[f] = (int(zpx), zn)

    def present(self, gg, f, img, ps):
        """PX12: is the graphic's own frame on screen at f? -> (present, diff, mask share, probe op)"""
        pl = self.placed(gg, f, use_probe_op=False)
        op = ((ps.get("graphics") or {}).get(gg["id"]) or {}).get("op")
        if pl is None:
            return None
        x0, y0, rgb, al = pl
        h, w = al.shape
        mask = al >= 0.5
        solid = al >= 0.95
        share = mask.sum() / max(1, h * w)
        # caption words drawn over the graphic are not the graphic: leave them out of the comparison
        for gr in ps.get("groups", []):
            for wd in gr["words"]:
                rx0, ry0, rx1, ry1 = rect_int(wd["rect"], self.geo["W"], self.geo["H"], grow=6)
                solid[max(0, ry0 - y0):max(0, ry1 - y0), max(0, rx0 - x0):max(0, rx1 - x0)] = False
        if share < 0.01:
            return ("untestable", None, r2(share), op)   # the graphic's own frame there is (nearly) empty: nothing to see
        if solid.sum() == 0:
            return ("untestable", None, r2(share), op)
        d = float(np.abs(img[y0:y0 + h, x0:x0 + w].astype(np.int16) - rgb)[solid].mean())
        return (r2(d) <= 12, r2(d), r2(share), op)

    def contrast(self, img, gr, vis_words, cov):
        import cv2
        if cov < 0.02:
            return None
        W, H = self.geo["W"], self.geo["H"]
        x0, y0, x1, y1 = rect_int(gr["rect"], W, H, grow=12)
        crop = img[y0:y1, x0:x1]
        ink = np.zeros(crop.shape[:2], bool)
        for w in vis_words:
            col = parse_color(w["color"])
            wx0, wy0, wx1, wy1 = rect_int(w["rect"], W, H)
            wx0, wy0, wx1, wy1 = max(wx0, x0), max(wy0, y0), min(wx1, x1), min(wy1, y1)
            if col is None or wx1 <= wx0 or wy1 <= wy0:
                continue
            ink[wy0 - y0:wy1 - y0, wx0 - x0:wx1 - x0] |= ink_mask(img[wy0:wy1, wx0:wx1], col)
        if not ink.any():
            return None
        dist = cv2.distanceTransform((~ink).astype(np.uint8), cv2.DIST_L2, 3)
        halo = (dist >= 4) & (dist <= 12)
        if not halo.any():
            return None
        li, lb = float(np.median(rel_lum(crop[ink]))), float(np.median(rel_lum(crop[halo])))
        return r2((max(li, lb) + 0.05) / (min(li, lb) + 0.05))

    def centre(self, img, gr, vis_words):
        """PX9: the ink's horizontal centre in the group's band (grown 64 px each side: a race moves the drawn text, not
        the probe's layout, by up to ~50 px)"""
        W, H = self.geo["W"], self.geo["H"]
        G = 64
        x0, y0, x1, y1 = rect_int(gr["rect"], W, H, grow=12, growx=G)
        crop = img[y0:y1, x0:x1]
        ink = np.zeros(crop.shape[:2], bool)
        for col in {tuple(parse_color(w["color"]).tolist()) for w in vis_words if parse_color(w["color"]) is not None}:
            ink |= ink_mask(crop, np.array(col, np.int16))
        inkcol = ink.sum(axis=0) >= 3
        # where the words are drawn: the shift (within +-G px) that best lays the probe's word columns over the ink
        # columns; then only the ink inside the group's rect at that shift counts (light footage beside a caption is
        # not the caption)
        n = inkcol.shape[0]
        exp = np.zeros(n + 2 * G, bool)
        for w in vis_words:
            a, b = int(math.floor(w["rect"][0])) - x0 + G, int(math.ceil(w["rect"][0] + w["rect"][2])) - x0 + G
            exp[max(0, a):max(0, b)] = True
        best = None
        for dx in range(-G, G + 1):
            sc = int((inkcol & exp[G - dx:G - dx + n]).sum())
            key = (sc, -abs(dx), dx)
            if best is None or key > best[0]:
                best = (key, dx)
        dx = best[1]
        gx0, gx1 = int(math.floor(gr["rect"][0])) - x0 + dx - 4, int(math.ceil(gr["rect"][0] + gr["rect"][2])) - x0 + dx + 4
        keep = np.zeros(n, bool)
        keep[max(0, gx0):max(0, gx1)] = True
        cols = np.where(inkcol & keep)[0]
        if not len(cols):
            return None
        cl_ = np.split(cols, np.where(np.diff(cols) > 25)[0] + 1)
        while len(cl_) > 1 and cl_[0][-1] - cl_[0][0] < 14:
            cl_ = cl_[1:]
        while len(cl_) > 1 and cl_[-1][-1] - cl_[-1][0] < 14:
            cl_ = cl_[:-1]
        return x0 + (int(cl_[0][0]) + int(cl_[-1][-1])) / 2

    def wants_face(self, f):
        return not self.cover.get(f) and self.face_at(f) is not None and (self.test_dets is not None or self.det_path is not None)

    def detect_face(self, f, img):
        """PX2: YuNet on the render at 540x960 (grown like face_track.py) -> the grown box, or None (no face)"""
        W, H = self.geo["W"], self.geo["H"]
        if self.test_dets is not None:
            d = self.test_dets.get(f)
            return None if d is None else tuple(d)
        import cv2
        det = getattr(self.tls, "det", None)
        if det is None:
            det = self.tls.det = cv2.FaceDetectorYN.create(self.det_path, "", (W // 2, H // 2), 0.6)
        small = cv2.resize(cv2.cvtColor(img, cv2.COLOR_RGB2BGR), (W // 2, H // 2), interpolation=cv2.INTER_AREA)
        _, faces = det.detect(small)
        if faces is None or not len(faces):
            return None
        b = max(faces, key=lambda r: (r[2] * r[3], -r[0], -r[1]))
        x, y, w, h = (float(v) * 2 for v in b[:4])
        return (max(0, y - 0.35 * h), min(H, y + h * 1.12), max(0, x - 0.08 * w), min(W, x + w * 1.08))

    # ---------------- rules ----------------
    def evaluate(self, res):
        g, fps, W, H = self.geo, self.geo["fps"], self.geo["W"], self.geo["H"]
        R = self.rules
        R["PX0"].checked = 1
        tt = lambda f: f / fps
        skips = g.get("faceSkip", [])
        if skips:
            why = "; ".join(f"{a:.3f}-{b:.3f}s ({w})" for a, b, w in skips)
            for rid in FACE_RULES:
                R[rid].notes.append(f"face not modelled in {why} (owner answer 2: room shrink and non-primary sources skipped)")
        if not g.get("captionsDescribed", True):
            for rid in CAPTION_RULES:
                R[rid].skip(f"caption style {g.get('captionStyle')} is not described in geometry.json")

        # PX2 first: it sets the face rules' confidence
        p2 = R["PX2"]
        if self.test_dets is None and self.det_path is None:
            p2.skip(getattr(self, "det_problem", "no face detector"))
        else:
            elig = sorted(self.dets)
            p2.checked = len(elig)
            ious = {}
            for f in elig:
                fc = self.face_at(f)
                gb = (max(0, fc["left"]), max(0, fc["top"]), min(W, fc["right"]), min(H, fc["bottom"]))
                d = self.dets[f]
                if d is None:
                    ious[f] = 0.0
                    continue
                db = (d[2], d[0], d[3], d[1])
                inter = inter_area(gb, db)
                uni = (gb[2] - gb[0]) * (gb[3] - gb[1]) + (db[2] - db[0]) * (db[3] - db[1]) - inter
                ious[f] = r2(inter / uni) if uni > 0 else 0.0
            if elig:
                bad = [f for f in elig if ious[f] < 0.5]
                vbad = [f for f in elig if ious[f] < 0.3]
                med = r2(float(np.median([ious[f] for f in elig])))
                wf = min(elig, key=lambda f: (ious[f], f))
                sev = "error" if len(vbad) >= 0.5 * len(elig) else "warn" if len(bad) >= 0.2 * len(elig) else None
                if sev:
                    p2.add(sev, "face", tt(wf), wf, med, 0.3 if sev == "error" else 0.5, "iou",
                           f"PX2 face track disagrees with the render on {len(bad)}/{len(elig)} samples (median IoU {med:.2f}, worst at t={tt(wf):.3f}s)",
                           t_from=tt(bad[0]), t_to=tt(bad[-1]), samples=len(bad))
                    if sev == "error":
                        for rid in ("PX1", "PX3", "PX4"):
                            R[rid].confidence = "low"
        for rid in ("PX1", "PX3", "PX4"):
            R[rid].confidence = R[rid].confidence or "high"

        # PX1 graphic covers the face
        p1 = R["PX1"]
        for gg in g["graphics"]:
            if gg["mode"] != "overlay":
                continue
            d = self.m["px1"].get(gg["id"], {})
            ev = {f: v for f, v in d.items() if v is not None}
            p1.checked += len(ev)
            hits = {f: v for f, v in ev.items() if v[0] > 0 or v[1] > 0}
            if not hits:
                continue
            lvl = lambda v: 2 if (v[1] > 0 or v[0] >= 0.02 * v[2]) else 1
            sev = "error" if any(lvl(v) == 2 for v in hits.values()) else "warn"
            if gg.get("by") == "user":
                sev = "warn"
            wf = max(hits, key=lambda f: (lvl(hits[f]), hits[f][1], hits[f][0], -f))
            over, corepx, _ = hits[wf]
            share = rnd(100 * len(hits) / max(1, len(ev)))
            hf = sorted(hits)
            p1.add(sev, gg["id"], tt(wf), wf, over, 0, "px",
                   f"PX1 graphic {gg['id']} covers the face at t={tt(wf):.3f}s ({over} px overlap, {corepx} px on the eyes/mouth; {share}% of its window)",
                   t_from=tt(hf[0]), t_to=tt(hf[-1]), samples=len(hits), extra={"core_px": corepx, "window_pct": share})

        # PX3 face out of frame (grid, two consecutive)
        p3 = R["PX3"]
        ev = {f: v for f, v in self.m["px3"].items() if v is not None}
        p3.checked = len(ev)
        order = sorted(ev)
        hits = {f: (2 if (v[0] < 0.5 or v[2]) else 1 if v[0] < 0.85 else 0, -v[0], v) for f, v in ev.items()}
        for run in runs(hits, order, fps):
            sev = run_severity(run, hits)
            if not sev:
                continue
            wf = worst(run, hits)
            vis, edge, _ = hits[wf][2]
            p3.add(sev, "face", tt(wf), wf, vis, 0.5 if sev == "error" else 0.85, "ratio",
                   f"PX3 face {rnd(vis * 100)}% in frame at t={tt(wf):.3f}s (zoom crops it; {edge} edge)",
                   t_from=tt(run[0]), t_to=tt(run[-1]), samples=len(run))

        # PX4 caption over the eyes / mouth (caption samples, two consecutive, per block)
        p4 = R["PX4"]
        if p4.status != "skipped":
            for cid, d in self.m["px4"].items():
                ev = {f: v for f, v in d.items() if v is not None}
                p4.checked += len(ev)
                hits = {f: (2 if v > 0 else 0, v) for f, v in ev.items()}
                for run in runs(hits, sorted(ev), fps):
                    if len(run) < 2:
                        continue
                    wf = worst(run, hits)
                    c = self.cap_by_id[cid]
                    p4.add("error", cid, tt(wf), wf, hits[wf][1], 0, "px",
                           f"PX4 caption {cid} \"{c['text']}\" covers the eyes/mouth at t={tt(wf):.3f}s ({hits[wf][1]} px)",
                           t_from=tt(run[0]), t_to=tt(run[-1]), samples=len(run))

        # PX5 contrast (worst of the three samples)
        p5 = R["PX5"]
        if p5.status != "skipped":
            for cid, d in self.m["px5"].items():
                ev = {f: v for f, v in d.items() if v is not None}
                if not ev:
                    continue
                p5.checked += 1
                wf = min(ev, key=lambda f: (ev[f], f))
                v = ev[wf]
                if v < 4.5:
                    sev, thr = ("error", 3.0) if v < 3.0 else ("warn", 4.5)
                    c = self.cap_by_id[cid]
                    p5.add(sev, cid, tt(wf), wf, v, thr, "ratio", f"PX5 caption {cid} \"{c['text']}\" contrast {v:.2f}:1 at t={tt(wf):.3f}s (min {thr:.2f}:1)")

        # PX6 text size (middle sample)
        p6 = R["PX6"]
        if p6.status != "skipped":
            for cid, (f, fs) in sorted(self.m["px6"].items()):
                p6.checked += 1
                px = rnd(fs)
                if px < 42:
                    sev, thr = ("error", 32) if px < 32 else ("warn", 42)
                    c = self.cap_by_id[cid]
                    p6.add(sev, cid, tt(f), f, px, thr, "px", f"PX6 caption {cid} text {px} px at t={tt(f):.3f}s (min {thr})")

        # PX7 time on screen (geometry only)
        p7 = R["PX7"]
        if p7.status != "skipped":
            for c in g.get("captions", []):
                p7.checked += 1
                hid = sum(max(0.0, min(c["t1"], b) - max(c["t0"], a)) for a, b, _ in g.get("hiddenCaps", []))
                v = r3(c["t1"] - c["t0"] - hid)
                n = sum(ch.isalnum() for ch in c["text"])
                if v <= 0:
                    continue
                cps = r2(n / v)
                sev = "error" if v < 0.10 else "warn" if (v < 0.30 or cps > 25) else None
                if sev:
                    f = cl(c["t0"] * fps)
                    p7.add(sev, c["id"], c["t0"], f, v, 0.10 if sev == "error" else (0.30 if v < 0.30 else 25), "s" if (sev == "error" or v < 0.30) else "chars/s",
                           f"PX7 caption {c['id']} \"{c['text']}\" on screen {v:.3f}s for {n} chars ({cps:.2f} chars/s, max 25)")

        # PX8 drawn / hidden
        p8 = R["PX8"]
        if p8.status != "skipped":
            for cid, d in self.m["px8a"].items():
                p8.checked += len(d)
                for f, (cov, _) in sorted(d.items()):
                    if cov < 0.02:
                        c = self.cap_by_id[cid]
                        p8.add("error", cid, tt(f), f, cov, 0.02, "ratio", f"PX8 caption {cid} \"{c['text']}\" is not drawn at t={tt(f):.3f}s")
            for (cid, wi), d in sorted(self.m["px8b"].items()):
                p8.checked += len(d)
                a, b, _ = g["hiddenCaps"][wi]
                for f, (kind, v, why) in sorted(d.items()):
                    bad = v > 10 if kind == "diff" else v >= 0.02
                    if bad:
                        c = self.cap_by_id[cid]
                        p8.add("error", cid, tt(f), f, v, 10 if kind == "diff" else 0.02, "rgb" if kind == "diff" else "ratio",
                               f"PX8 caption {cid} \"{c['text']}\" shows at t={tt(f):.3f}s inside a hidden window [{a:.3f}, {b:.3f}] ({why or 'hidden'})")

        # PX9 off-centre (middle sample)
        p9 = R["PX9"]
        if p9.status != "skipped":
            for cid, (f, x) in sorted(self.m["px9"].items()):
                if x is None:
                    continue
                p9.checked += 1
                c = self.cap_by_id[cid]
                d = rnd(x - c["cx"])
                if abs(d) > 8:
                    sev, thr = ("error", 16) if abs(d) > 16 else ("warn", 8)
                    p9.add(sev, cid, tt(f), f, d, thr, "px", f"PX9 caption {cid} \"{c['text']}\" is {d} px off centre at t={tt(f):.3f}s ({rnd(x)} vs {rnd(c['cx'])})")

        # PX10 off the canvas / clipped (every probe sample, two consecutive)
        p10 = R["PX10"]
        order = self.plan["frames"]
        for key, d in sorted(self.m["px10"].items()):
            p10.checked += len(d)
            hits = {f: (2 if (v[0] > 2 or v[2] > 2) else 0, max(v[0], v[2]), v) for f, v in d.items()}
            for run in runs(hits, order, fps):
                if len(run) < 2:
                    continue
                wf = worst(run, hits)
                off, edge, clip = hits[wf][2]
                el, text = key
                if off > 2:
                    msg = f"PX10 text \"{text}\" ({el}) runs {off} px off the {edge} at t={tt(wf):.3f}s"
                else:
                    msg = f"PX10 text \"{text}\" ({el}) is clipped {clip} px by its box at t={tt(wf):.3f}s"
                p10.add("error", f"{el} \"{text}\"", tt(wf), wf, max(off, clip), 2, "px", msg, t_from=tt(run[0]), t_to=tt(run[-1]), samples=len(run))

        # PX11 UI zone
        p11 = R["PX11"]
        zname = g["zones"]["name"]
        if g.get("captionsDescribed", True):
            for cid, d in self.m["px11c"].items():
                p11.checked += len(d)
                hits = {f: (2 if v[0] > 0 else 0, v[0], v) for f, v in d.items()}
                for run in runs(hits, sorted(d), fps):
                    if len(run) < 2:
                        continue
                    wf = worst(run, hits)
                    c = self.cap_by_id[cid]
                    p11.add("error", cid, tt(wf), wf, hits[wf][1], 0, "px",
                            f"PX11 caption {cid} \"{c['text']}\" is in the {zname} UI zone at t={tt(wf):.3f}s ({hits[wf][1]} px)",
                            t_from=tt(run[0]), t_to=tt(run[-1]), samples=len(run), extra={"zone": hits[wf][2][1]})
        for key, d in sorted(self.m["px11t"].items()):
            p11.checked += len(d)
            hits = {f: (1 if v[0] > 0 else 0, v[0], v) for f, v in d.items()}
            for run in runs(hits, order, fps):
                if len(run) < 2:
                    continue
                wf = worst(run, hits)
                el, text = key
                p11.add("warn", f"{el} \"{text}\"", tt(wf), wf, hits[wf][1], 0, "px",
                        f"PX11 text \"{text}\" ({el}) is in the {zname} UI zone at t={tt(wf):.3f}s",
                        t_from=tt(run[0]), t_to=tt(run[-1]), samples=len(run), extra={"zone": hits[wf][2][1]})
        for gid, d in sorted(self.m["px11g"].items()):
            p11.checked += len(d)
            hits = {f: (1 if v >= 200 else 0, v) for f, v in d.items()}
            for run in runs(hits, sorted(d), fps):
                if len(run) < 2:
                    continue
                wf = worst(run, hits)
                p11.add("warn", gid, tt(wf), wf, hits[wf][1], 200, "px",
                        f"PX11 graphic {gid} draws {hits[wf][1]} px in the {zname} UI zone at t={tt(wf):.3f}s",
                        t_from=tt(run[0]), t_to=tt(run[-1]), samples=len(run))

        # PX12 outside its window
        p12 = R["PX12"]
        for gg in g["graphics"]:
            if not gg.get("hard", True):
                p12.notes.append(f"graphic {gg['id']}: enter/exit animated, edges not exact")
                continue
            if self.gfiles.get(gg["id"]) is None:
                p12.notes.append(f"graphic {gg['id']}: file {gg['file']} missing")
                continue
            d = self.m["px12"].get(gg["id"], {})
            f0, f1 = gg["f0"], gg["f1"]
            for f, v in sorted(d.items()):
                if v is None:
                    continue
                pres, diff, share, op = v
                if pres == "untestable":
                    p12.notes.append(f"graphic {gg['id']}: its frame at t={tt(f):.3f}s has under 1% opaque pixels (or none solid), that edge is not testable")
                    continue
                p12.checked += 1
                extra = {"diff": diff, "mask_share": share, "probe_op": op}
                if f in (f0 - 1, f1) and pres and 0 <= f < g["frames"]:
                    p12.add("error", gg["id"], tt(f), f, diff, 12, "rgb",
                            f"PX12 graphic {gg['id']} is visible at t={tt(f):.3f}s, outside its window [{gg['t0']:.3f}, {gg['t1']:.3f})", extra=extra)
                if f in (f0, f1 - 1) and not pres:
                    which = "first" if f == f0 else "last"
                    p12.add("error", gg["id"], tt(f), f, diff, 12, "rgb",
                            f"PX12 graphic {gg['id']} is missing at t={tt(f):.3f}s (the {which} frame of its window)", extra=extra)

        # PX13 / PX14 from the grey pass
        p13, p14 = R["PX13"], R["PX14"]
        gp = res.get("grey_pass")
        if isinstance(gp, Exception) or gp is None:
            p13.skip(f"grey pass failed: {gp}")
            p14.skip(f"grey pass failed: {gp}")
        else:
            black, freeze, open_freeze = gp
            p13.checked = p14.checked = g["frames"]
            for a0, b0 in black:
                for a, b in self.subtract((a0, b0), [(x, y) for x, y, *_ in g.get("darkOk", [])] + self.insert_darks(a0, b0)):
                    k = rnd((b - a) * fps)
                    if k < 1:
                        continue
                    sev = "error" if k >= 3 else "warn"
                    p13.add(sev, "picture", a, rnd(a * fps), k, 3 if sev == "error" else 1, "frames", f"PX13 {k} black frame(s) at t={a:.3f}s-{b:.3f}s",
                            t_from=a, t_to=b, samples=k)
            if open_freeze is not None:
                freeze.append((open_freeze, g["total"]))
            for a, b in freeze:
                for pa, pb in self.subtract((a, b), [(x, y) for x, y, *_ in g.get("stillOk", [])] + self.insert_stills(a, b)):
                    dd = r3(pb - pa)
                    if dd >= 0.5:
                        sev = "error" if dd >= 1.0 else "warn"
                        p14.add(sev, "picture", pa, rnd(pa * fps), dd, 1.0 if sev == "error" else 0.5, "s",
                                f"PX14 picture frozen {dd:.3f}s at t={pa:.3f}s-{pb:.3f}s", t_from=pa, t_to=pb, samples=rnd(dd * fps))

        # PX15 cut inside a word
        self.px15()

        # PX16 audio clipping
        p16 = R["PX16"]
        au = res.get("audio")
        if isinstance(au, Exception) or au is None or au[0] is None:
            p16.skip("no audio stream" if not isinstance(au, Exception) else f"audio decode failed: {au}")
        else:
            x, ch = au
            p16.checked = int(x.shape[0])
            n, first = 0, None
            for c in range(ch):
                m = np.abs(x[:, c]) >= 0.999
                if not m.any():
                    continue
                d = np.diff(np.concatenate([[0], m.astype(np.int8), [0]]))
                st, en = np.where(d == 1)[0], np.where(d == -1)[0]
                long = st[(en - st) >= 3]
                n += len(long)
                if len(long):
                    first = long[0] if first is None else min(first, long[0])
            if n:
                sev = "error" if n >= 3 else "warn"
                t = first / 48000
                p16.add(sev, "audio", t, rnd(t * fps), n, 3 if sev == "error" else 1, "runs", f"PX16 audio clips {n} time(s), first at t={t:.3f}s")

    def insert_stills(self, a, b):
        """a freeze inside an insert whose own file is frozen there too is the graphic's design, not a render fault"""
        out = []
        fps = self.geo["fps"]
        for gg in self.geo["graphics"]:
            if gg["mode"] != "insert" or self.gfiles.get(gg["id"]) is None:
                continue
            lo, hi = max(a, gg["t0"]), min(b, gg["t1"])
            if hi - lo < 0.5:
                continue
            j0, j1 = self.gframe_for(gg, cl(lo * fps)), self.gframe_for(gg, min(gg["f1"] - 1, fl(hi * fps) - 1))
            fr = dict(decode_frames(os.path.join(self.proj, gg["file"]), sorted({j0, j1}), self.gfiles[gg["id"]]["w"], self.gfiles[gg["id"]]["h"]))
            if j0 in fr and j1 in fr and float(np.abs(fr[j0].astype(np.int16) - fr[j1]).mean()) < 1.0:
                out.append((lo, hi))
        return out

    def insert_darks(self, a, b):
        """black inside an insert whose own file is black at those frames (a fade up from black) is the graphic's design"""
        out, fps = [], self.geo["fps"]
        for gg in self.geo["graphics"]:
            if gg["mode"] != "insert" or self.gfiles.get(gg["id"]) is None:
                continue
            f0, f1 = max(gg["f0"], rnd(a * fps)), min(gg["f1"], rnd(b * fps))   # blackdetect reports frame times
            if f1 <= f0:
                continue
            # the same blackdetect as the grey pass, on the insert's own file (cached per insert)
            if gg["id"] not in self.dark_cache:
                fb, _, _ = grey_pass(os.path.join(self.proj, gg["file"]), fps)
                self.dark_cache[gg["id"]] = {j for x, y in fb for j in range(rnd(x * fps), rnd(y * fps))}
            dark = self.dark_cache[gg["id"]]
            run = None
            for f in range(f0, f1):
                if self.gframe_for(gg, f) in dark:
                    run = [f, f + 1] if run is None else [run[0], f + 1]
                elif run:
                    out.append((run[0] / fps, run[1] / fps)); run = None
            if run:
                out.append((run[0] / fps, run[1] / fps))
        return out

    @staticmethod
    def subtract(iv, cuts):
        pieces = [iv]
        for x, y in sorted(cuts):
            nxt = []
            for a, b in pieces:
                if y <= a + EPS or x >= b - EPS:
                    nxt.append((a, b))
                    continue
                if x > a:
                    nxt.append((a, x))
                if y < b:
                    nxt.append((y, b))
            pieces = nxt
        return pieces

    def px15(self):
        p = self.rules["PX15"]
        joins = self.geo.get("joins", [])
        if not joins:
            return
        try:
            reel = json.load(open(os.path.join(self.proj, "reel.json")))
        except (OSError, ValueError):
            p.skip("reel.json not readable")
            return
        primary = reel.get("source")
        wpath = reel.get("words")
        words = []
        if wpath and os.path.exists(os.path.join(self.proj, wpath)):
            def walk(o):
                if isinstance(o, dict):
                    if {"start", "end", "word"} <= set(o):
                        words.append((float(o["start"]), float(o["end"]), str(o["word"]).strip()))
                    for v in o.values():
                        walk(v)
                elif isinstance(o, list):
                    for v in o:
                        walk(v)
            walk(json.load(open(os.path.join(self.proj, wpath))))
        if not words:
            p.skip("no words file")
            return
        fps = self.geo["fps"]
        for j in joins:
            if j.get("ramp"):
                p.notes.append(f"join take {j['take']}: a ramped take (no speech)")
                continue
            for side, src, cut, ti in (("b", j.get("outSrc"), j["out"], j["take"] - 1), ("a", j.get("src"), j["in"], j["take"])):
                if src != primary:
                    p.notes.append(f"join take {j['take']}: words of {src} are not read (non-primary source)")
                    continue
                p.checked += 1
                for s, e, w in words:
                    if not (s < cut < e):
                        continue
                    kept, lost = (cut - s, e - cut) if side == "b" else (e - cut, cut - s)
                    m = r3(min(kept, lost))
                    if m >= 0.03:
                        sev = "error" if m >= 0.06 else "warn"
                        p.add(sev, f"take {ti} {side}", j["t"], j["frame"], m, 0.06 if sev == "error" else 0.03, "s",
                              f"PX15 cut at t={j['t']:.3f}s (take {ti} {side} = {cut:.3f}s) splits \"{w}\" ({kept:.3f}s kept, {lost:.3f}s cut)")

    # ---------------- report ----------------
    def base_report(self):
        g = getattr(self, "geo", None) or {}
        ri = getattr(self, "render_info", {})
        rp = self.a.render
        return {
            "schema": "pixel-check/1",
            "versions": self.versions,
            "input": {"render": os.path.basename(rp), "render_sha256": sha256_file(rp) if os.path.exists(rp) else None,
                      "W": ri.get("W"), "H": ri.get("H"), "fps": ri.get("fps"), "frames": ri.get("frames"),
                      "total": g.get("total"), "format": g.get("format"), "platform": g.get("platform"),
                      "json_sha256": {k: v for k, v in sorted(getattr(self, "json_sha", {}).items())}},
        }

    def finish_px0(self, msgs, T0):
        R = self.rules
        for m in msgs:
            R["PX0"].add("error", "inputs", 0, 0, None, None, "", m)
        for rid, _ in RULES[1:]:
            R[rid].skip("PX0 failed")
        return self.finish(T0, px0=True)

    def finish(self, T0, px0=False):
        self.versions.setdefault("ffmpeg", tool_version(["ffmpeg", "-version"]))
        self.versions["engine"] = engine_rev()
        rep = self.base_report()
        plan = getattr(self, "plan", None)
        if plan:
            rep["sampling"] = {"grid_s": 0.5, "frames": len(plan["frames"]), "list_sha256": sha256_bytes(canon(plan["frames"]).encode())}
        rules = [self.rules[rid].out() for rid, _ in RULES]
        errs = sum(1 for r in rules for f in r["findings"] if f["severity"] == "error")
        wrns = sum(1 for r in rules for f in r["findings"] if f["severity"] == "warn")
        rep["verdict"] = "fail" if errs else "warn" if wrns else "pass"
        rep["summary"] = {"errors": errs, "warnings": wrns, "rules": {r["id"]: r["status"] for r in rules}}
        rep["rules"] = rules
        rep["report_sha256"] = sha256_bytes(canon(rep).encode())
        total = int(round((time.time() - T0) * 1000))
        tm = {"total_ms": total, "stages": dict(sorted(self.timing.items()))}
        if self.a.render_ms:
            tm["render_ms"] = int(self.a.render_ms)
            tm["budget_pct"] = round(100.0 * total / self.a.render_ms, 1)
        rep["timing"] = tm
        out = self.a.out or os.path.join(self.build, "pixel_check.json")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w") as f:
            json.dump(rep, f, sort_keys=True, indent=1, separators=(",", ": "), ensure_ascii=True)
            f.write("\n")
        if self.a.frames_dir and not px0:
            self.draw_frames(rules)
        return rep


    def draw_frames(self, rules):
        """--frames-dir: a PNG of each error's worst frame with the relevant boxes drawn (for the reviewer; not hashed)"""
        import cv2
        os.makedirs(self.a.frames_dir, exist_ok=True)
        errs = [(r["id"], f) for r in rules for f in r["findings"] if f["severity"] == "error"]
        want = sorted({f["frame"] for _, f in errs if 0 <= f["frame"] < self.geo["frames"]})
        if not want:
            return
        imgs = {f: img.copy() for f, img in decode_frames(self.a.render, want, self.geo["W"], self.geo["H"])}
        for rid, fd in errs:
            img = imgs.get(fd["frame"])
            if img is None:
                continue
            im = np.ascontiguousarray(img[..., ::-1])
            fc = self.face_at(fd["frame"])
            if fc:
                cv2.rectangle(im, (int(fc["left"]), int(fc["top"])), (int(fc["right"]), int(fc["bottom"])), (0, 255, 255), 3)
                c = self.core_of(fc)
                cv2.rectangle(im, (int(c[0]), int(c[1])), (int(c[2]), int(c[3])), (0, 0, 255), 3)
            ps = self.probe["samples"].get(str(fd["frame"]), {})
            for gr in ps.get("groups", []):
                x, y, w, h = gr["rect"]
                cv2.rectangle(im, (int(x), int(y)), (int(x + w), int(y + h)), (0, 255, 0), 2)
            for gid, gs in (ps.get("graphics") or {}).items():
                x, y, w, h = gs["rect"]
                cv2.rectangle(im, (int(x), int(y)), (int(x + w), int(y + h)), (255, 0, 255), 3)
            cv2.putText(im, fd["message"][:70], (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
            name = re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{rid}-{fd['subject']}-{fd['frame']}")[:120]
            cv2.imwrite(os.path.join(self.a.frames_dir, name + ".png"), im)


def engine_rev():
    try:
        r = subprocess.run(["git", "-C", HERE, "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True)
        return r.stdout.strip() or None
    except OSError:
        return None


def main(argv=None):
    ap = argparse.ArgumentParser(description="pixel check (A5): references/pixel-check.md")
    ap.add_argument("project")
    ap.add_argument("render", nargs="?")
    ap.add_argument("--out")
    ap.add_argument("--render-ms", type=float)
    ap.add_argument("--frames-dir")
    ap.add_argument("--probe", choices=["auto", "use"], default="auto")
    ap.add_argument("--yunet")
    ap.add_argument("--print-samples", metavar="FILE")
    a = ap.parse_args(argv)
    if a.print_samples:
        geo = json.load(open(os.path.join(a.project, "build", "geometry.json")))
        with open(a.print_samples, "w") as f:
            json.dump({"frames": sample_plan(geo)["frames"]}, f)
        return 0
    if not a.render:
        ap.error("render.mp4 is required")
    rep = Check(a).run()
    v = rep["verdict"]
    s = rep["summary"]
    print(f"pixel check: {v} ({s['errors']} errors, {s['warnings']} warnings) in {rep['timing']['total_ms']} ms"
          + (f" = {rep['timing']['budget_pct']}% of the render" if "budget_pct" in rep["timing"] else ""))
    for r in rep["rules"]:
        for f in r["findings"][:5]:
            print(f"  {f['severity']:5s} {f['message']}")
        if len(r["findings"]) > 5:
            print(f"  ... {len(r['findings']) - 5} more {r['id']}")
    if rep["summary"]["rules"]["PX0"] == "error":
        return 3
    return 2 if v == "fail" else 0


if __name__ == "__main__":
    sys.exit(main())

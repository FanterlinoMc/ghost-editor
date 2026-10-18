#!/usr/bin/env python3
"""AI upscale a low-res clip or photo with Real-ESRGAN (spandrel, Apple MPS), then size it down to a target width.

    python scripts/upscale.py in.mp4 out.mp4 [--width 1080] [--model general|x4plus] [--frames N]
    python scripts/upscale.py photo.jpg photo_up.png [--model x4plus]

general = realesr-general-x4v3 (light, natural, good for phone video); x4plus = RealESRGAN_x4plus (stronger, for stills).
No face restoration on purpose: GFPGAN-style models invent features and change who the person looks like.
Weights live in library/models (gitignored) or in the folder UPSCALE_MODELS points at; URLs below.
Device: CUDA if present, Apple MPS if present, else CPU (CPU is very slow on video).

Ported from Ahmed's phantasic engine/core (origin/main). Fork notes: Ahmed's was Apple-MPS only with a hard-coded ~/phantasic models folder (Mac-only); now CUDA / MPS / CPU and
UPSCALE_MODELS. Needs torch, spandrel and OpenCV, none of which the fork pins (see requirements); untested on this
Windows machine (no torch installed), only compiled. No API call, no paid service.
"""
import os
import subprocess
import sys

import cv2
import numpy as np
import torch
from spandrel import ModelLoader

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = {
    "general": ("realesr-general-x4v3.pth", "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth"),
    "x4plus": ("RealESRGAN_x4plus.pth", "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"),
}


def model_path(name):
    f, url = MODELS[name]
    for d in (os.environ.get("UPSCALE_MODELS"), os.path.join(HERE, "..", "library", "models")):
        if d and os.path.exists(os.path.join(d, f)):
            return os.path.join(d, f)
    raise SystemExit(f"missing {f}: download {url} into library/models/ (or set UPSCALE_MODELS to the folder that holds it)")


def load(name):
    dev = "cuda" if torch.cuda.is_available() else "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu"
    m = ModelLoader().load_from_file(model_path(name)).to(dev).eval()
    return m, dev


@torch.inference_mode()
def up(m, dev, bgr):
    x = torch.from_numpy(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float().div(255).unsqueeze(0).to(dev)
    y = m(x).clamp(0, 1).squeeze(0).permute(1, 2, 0).mul(255).round().byte().cpu().numpy()
    return cv2.cvtColor(y, cv2.COLOR_RGB2BGR)


def resize_w(img, width):
    h, w = img.shape[:2]
    hh = int(round(h * width / w / 2) * 2)
    return cv2.resize(img, (width, hh), interpolation=cv2.INTER_AREA)


def main():
    a = sys.argv[1:]
    src, dst = a[0], a[1]
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d
    width = int(opt("--width", 1080))
    name = opt("--model", "x4plus" if src.lower().endswith((".jpg", ".jpeg", ".png", ".webp")) else "general")
    m, dev = load(name)
    if src.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
        cv2.imwrite(dst, resize_w(up(m, dev, cv2.imread(src)), width))
        print("->", dst)
        return
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    n = int(opt("--frames", cap.get(cv2.CAP_PROP_FRAME_COUNT)))
    ok, frame = cap.read()
    first = resize_w(up(m, dev, frame), width)
    h = first.shape[0]
    tmp = dst + ".video.mp4"
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{h}", "-r", f"{fps}",
                            "-i", "-", "-c:v", "libx264", "-crf", "10", "-preset", "slow", "-pix_fmt", "yuv420p", "-g", "30", tmp],
                           stdin=subprocess.PIPE)
    enc.stdin.write(first.tobytes())
    i = 1
    while i < n:
        ok, frame = cap.read()
        if not ok:
            break
        enc.stdin.write(resize_w(up(m, dev, frame), width).tobytes())
        i += 1
        if i % 30 == 0:
            print(f"{i}/{n}", flush=True)
    enc.stdin.close()
    enc.wait()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp, "-i", src, "-map", "0:v", "-map", "1:a?", "-c", "copy", "-shortest", dst], check=True)
    os.remove(tmp)
    print("->", dst)


if __name__ == "__main__":
    main()

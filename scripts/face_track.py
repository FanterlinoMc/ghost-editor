#!/usr/bin/env python3
"""Track the speaker's face so captions never cover it.

    face_track.py <project>/assets/talk.mp4 --out <project>/build/face.json [--fps 5]
    # I-16 / MULTIANGLE Gap 3 - one face track per RECORDING, for the same reason: coordinates are
    # in the pixel space of the file this ran on, so a second camera needs its own.
    #   source 1:  face_track.py <project>/assets/talk-1.mp4 --out <project>/build/face-1.json
    # prep.sh already reads build/face-<N>.json when prepping source N (A15's crop offset).
    # build.mjs consuming a face track per source is MULTIANGLE Gap 6, still open.

Runs OpenCV's YuNet detector (library/models/face_detection_yunet_2023mar.onnx,
fetched on first use, MIT licence) on a downscaled copy at --fps and writes,
in ORIGINAL-recording seconds and 1080x1920 frame pixels:

    {"fps": 5, "w": 1080, "h": 1920, "samples": [[t, top, bottom, left, right, eyes_y, mouth_y] | [t, null], ...]}

top/bottom/left/right is the face box grown to cover hair and chin (the raw
detector box stops at the brow and the mouth line). When several faces are in
frame the largest wins. Frames with no face are null; build.mjs holds the last
known box for short gaps. Needs python opencv (pip install opencv-python).
"""
import argparse
import hashlib
import json
import os
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "..", "library", "models", "face_detection_yunet_2023mar.onnx")
# pinned to one opencv_zoo commit and checked by size + sha256, so a moved branch or a corrupt download never loads
MODEL_URL = ("https://github.com/opencv/opencv_zoo/raw/f12e12798e8314f7c074a6656816c048dcc95b7a"
             "/models/face_detection_yunet/face_detection_yunet_2023mar.onnx")
MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
MODEL_SIZE = 232589


class ModelError(Exception):
    pass


def _download(url, dest):
    urllib.request.urlretrieve(url, dest)


def model_problem(path, size=MODEL_SIZE, sha256=MODEL_SHA256):
    """None when the file at path is the pinned model, else what is wrong with it."""
    n = os.path.getsize(path)
    if n != size:
        return f"size {n} bytes, expected {size}"
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    if h.hexdigest() != sha256:
        return f"sha256 {h.hexdigest()}, expected {sha256}"
    return None


def ensure_model(path=MODEL, url=MODEL_URL, size=MODEL_SIZE, sha256=MODEL_SHA256):
    """Make path the pinned model. A present file is verified; one that fails is downloaded again, once. The download
    goes to a temporary .part file next to path and is renamed into place only after it verifies; on any failure the
    partial file is deleted and ModelError says why."""
    if os.path.exists(path):
        bad = model_problem(path, size, sha256)
        if bad is None:
            return path
        print(f"face model {path} is not the pinned file ({bad}); downloading it again", file=sys.stderr)
        os.remove(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, part = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=os.path.basename(path) + ".", suffix=".part")
    os.close(fd)
    try:
        try:
            _download(url, part)
        except Exception as e:
            raise ModelError(f"face model download failed ({url}): {e}") from e
        bad = model_problem(part, size, sha256)
        if bad is not None:
            raise ModelError(f"face model download from {url} is not the pinned file ({bad}); deleted it")
        os.chmod(part, 0o644)   # mkstemp made it owner-only
        os.replace(part, path)
    finally:
        if os.path.exists(part):
            os.remove(part)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=5)
    a = ap.parse_args()
    try:
        import cv2
    except ImportError:
        sys.exit("opencv missing: pip install opencv-python")
    try:
        ensure_model()
    except ModelError as e:
        sys.exit(str(e))
    cap = cv2.VideoCapture(a.src)
    fps, n = cap.get(cv2.CAP_PROP_FPS), int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    q = 4  # detect on a quarter-size frame: fast, and plenty for a talking head
    det = cv2.FaceDetectorYN.create(MODEL, "", (W // q, H // q), 0.6)
    step = max(1, round(fps / a.fps))
    samples, found = [], 0
    f = 0
    while f < n:
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, fr = cap.read()
        if not ok:
            break
        _, faces = det.detect(cv2.resize(fr, (W // q, H // q)))
        t = round(f / fps, 3)
        if faces is None or not len(faces):
            samples.append([t, None])
        else:
            best = max(faces, key=lambda r: r[2] * r[3])
            x, y, w, h = best[:4] * q
            # YuNet landmarks: right eye, left eye, nose, right mouth corner, left mouth corner
            eyes_y = (best[5] + best[7]) / 2 * q
            mouth_y = (best[11] + best[13]) / 2 * q
            # grow: hair above the detector box, chin/beard below, ears at the sides
            top, bottom = y - 0.35 * h, y + h * 1.12
            left, right = x - 0.08 * w, x + w * 1.08
            samples.append([t, round(max(0, top)), round(min(H, bottom)), round(max(0, left)), round(min(W, right)), round(eyes_y), round(mouth_y)])
            found += 1
        f += step
    # Create the output directory, as transcribe.py already does. Without it a fresh project fails
    # with a bare FileNotFoundError at the very end, after the whole scan has run.
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump({"fps": a.fps, "w": W, "h": H, "samples": samples}, open(a.out, "w"))
    tops = [s[1] for s in samples if s[1] is not None]
    bots = [s[2] for s in samples if s[1] is not None]
    print(f"face in {found}/{len(samples)} samples; top {min(tops) if tops else '-'}-{max(tops) if tops else '-'}, "
          f"bottom {min(bots) if bots else '-'}-{max(bots) if bots else '-'} -> {a.out}")


if __name__ == "__main__":
    main()

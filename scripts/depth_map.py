"""Depth map video of a recording with Depth Anything V2 Small, run locally (onnxruntime, CPU by default).

    depth_map.py SRC.mp4 OUT.mp4 [--size 364] [--threads N] [--provider cpu|coreml] [--model PATH]
    depth_map.py --fetch          download the model once (checks sha256), then exit

OUT is an 8-bit grey H.264 video, near = bright, with the SAME frame count and frame rate as SRC, at the model's working
size (the short side is --size, the long side follows the aspect ratio; both multiples of 14). relight.py and the build
resample it, so it does not have to match SRC's pixel size. reel.json `relight` calls this when assets/<recording>-depth.mp4
is missing (references/reel-json.md, "Empire depth relight").

Model: Depth Anything V2 Small, ONNX export by onnx-community, licence Apache-2.0 (model card:
https://huggingface.co/depth-anything/Depth-Anything-V2-Small). URL, sha256 and size are in library/models.json. The weights
are NEVER in this repo: --fetch downloads them to PHANTASIC_MODELS (default ~/.cache/phantasic/models). Nothing else touches
the network.

Needs: onnxruntime, numpy, opencv-python(-headless); ffmpeg and ffprobe on PATH.
Env: DEPTH_THREADS (onnxruntime intra-op threads, default min(4, CPU count): on the M4 Mac mini 4 threads ran 0.21 s/frame
and 10 threads 0.71 s/frame, the efficiency cores and spinning stall the pool; on a dedicated Linux box try its full quota), DEPTH_PROVIDER (cpu | coreml; coreml is an opt-in
fast path on Apple Silicon, Linux is CPU only), DEPTH_SIZE (short side, default 364), PHANTASIC_MODELS (model folder).

Flicker: the model's output is relative (no fixed scale per frame), so each frame is normalised by its own 1st/99th
percentiles, those bounds are smoothed over time, and the map itself is blended 30 % with the previous one.

Timing: the run prints `depth: N frames in X s (Y s/frame) ...`. To estimate another machine (e.g. a Linux CPU server), run
this on any 10 s clip there with DEPTH_THREADS set to its CPU quota: the cost is per frame, so a reel costs
frames x s/frame, once per recording (the output is cached by the build).
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "..", "library", "models.json")
MODEL_ID = "depth-anything-v2-small"
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)


def die(msg):
    sys.exit(f"depth_map.py: {msg}")


def manifest():
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)[MODEL_ID]


def models_dir():
    return os.environ.get("PHANTASIC_MODELS") or os.path.join(os.path.expanduser("~"), ".cache", "phantasic", "models")


def model_path():
    return os.path.join(models_dir(), manifest()["file"])


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def fetch():
    m, dst = manifest(), model_path()
    if os.path.isfile(dst) and sha256(dst) == m["sha256"]:
        print(f"model already there: {dst}")
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    part = dst + ".part"
    print(f"downloading {m['url']} ({m['bytes'] / 1e6:.0f} MB, {m['licence']}) -> {dst}")
    with urllib.request.urlopen(m["url"]) as r, open(part, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    got = sha256(part)
    if got != m["sha256"]:
        os.remove(part)
        die(f"sha256 mismatch for the download: got {got}, library/models.json says {m['sha256']}; nothing kept")
    os.replace(part, dst)
    print(f"ok, sha256 {got}")


def probe(src):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate",
                        "-of", "json", src], capture_output=True, text=True)
    if r.returncode != 0:
        die(f"ffprobe failed on {src}: {r.stderr.strip()[-300:]}")
    s = json.loads(r.stdout)["streams"][0]
    return int(s["width"]), int(s["height"]), s["r_frame_rate"]


def work_size(w, h, short):
    """(width, height) fed to the model: the short side = `short`, the long side follows the aspect, both multiples of 14."""
    short = max(14, int(round(short / 14)) * 14)
    if w <= h:
        return short, max(14, int(round(short * h / w / 14)) * 14)
    return max(14, int(round(short * w / h / 14)) * 14), short


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--fetch", action="store_true", help="download the model (sha256-checked) and exit")
    ap.add_argument("--model", default=None, help="the .onnx file (default: PHANTASIC_MODELS/<manifest file>)")
    ap.add_argument("--size", type=int, default=int(os.environ.get("DEPTH_SIZE", "364")), help="short side fed to the model")
    ap.add_argument("--threads", type=int, default=int(os.environ.get("DEPTH_THREADS", "0") or 0) or min(4, os.cpu_count() or 4))
    ap.add_argument("--provider", default=os.environ.get("DEPTH_PROVIDER", "cpu"), choices=["cpu", "coreml"])
    ap.add_argument("--frames", type=int, default=0, help="stop after this many frames (timing runs only)")
    a = ap.parse_args()
    if a.fetch:
        fetch()
        return
    if not a.src or not a.out:
        ap.print_usage(sys.stderr)
        sys.exit(2)
    if not os.path.isfile(a.src):
        die(f"file not found: {a.src}")
    mp = a.model or model_path()
    if not os.path.isfile(mp):
        die(f"no depth model at {mp}: run `python3 scripts/depth_map.py --fetch` once (Depth Anything V2 Small, Apache-2.0, "
            f"~{manifest()['bytes'] / 1e6:.0f} MB; never stored in the repo)")
    try:
        import numpy as np
        import cv2
        import onnxruntime as ort
    except ImportError as e:
        die(f"needs onnxruntime, numpy and opencv-python ({e}); e.g. `pip install onnxruntime numpy opencv-python-headless`")

    W, H, rate = probe(a.src)
    ww, wh = work_size(W, H, a.size)
    so = ort.SessionOptions()
    so.intra_op_num_threads = a.threads
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    providers = ["CoreMLExecutionProvider", "CPUExecutionProvider"] if a.provider == "coreml" else ["CPUExecutionProvider"]
    sess = ort.InferenceSession(mp, so, providers=providers)
    cv2.setNumThreads(1)
    mean = np.array(MEAN, np.float32).reshape(3, 1, 1)
    std = np.array(STD, np.float32).reshape(3, 1, 1)

    # default constant-rate decode (not passthrough): same frame timing as relight.py and the hyperframes matte (see relight.py)
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", a.src, "-an", "-vf", f"scale={ww}:{wh}:flags=bicubic",
                            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    part = a.out[:-4] + ".part.mp4" if a.out.lower().endswith(".mp4") else a.out + ".part.mp4"
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{ww}x{wh}", "-r", rate,
                            "-i", "-", "-c:v", "libx264", "-crf", "12", "-preset", "fast", "-pix_fmt", "yuv420p", part],
                           stdin=subprocess.PIPE)
    n, t_inf, lo, hi, prev = 0, 0.0, None, None, None
    t0 = time.time()
    try:
        while True:
            b = dec.stdout.read(ww * wh * 3)
            if len(b) < ww * wh * 3:
                break
            x = np.frombuffer(b, np.uint8).reshape(wh, ww, 3).transpose(2, 0, 1).astype(np.float32) / 255.0
            x = ((x - mean) / std)[None]
            ti = time.time()
            d = sess.run(None, {"pixel_values": x})[0][0]
            t_inf += time.time() - ti
            if d.shape != (wh, ww):
                d = cv2.resize(d, (ww, wh), interpolation=cv2.INTER_LINEAR)
            p1, p99 = np.percentile(d, (1, 99))
            lo = p1 if lo is None else 0.85 * lo + 0.15 * p1
            hi = p99 if hi is None else 0.85 * hi + 0.15 * p99
            m = np.clip((d - lo) / max(1e-6, hi - lo), 0, 1)
            prev = m if prev is None else 0.7 * m + 0.3 * prev
            enc.stdin.write((prev * 255 + 0.5).astype(np.uint8).tobytes())
            n += 1
            if a.frames and n >= a.frames:
                break
    finally:
        enc.stdin.close()
        enc.wait()
        dec.stdout.close()
        dec.kill()
        dec.wait()
    if enc.returncode != 0 or n == 0:
        if os.path.exists(part):
            os.remove(part)
        die(f"no frames written (decoded {n}, encoder exit {enc.returncode})")
    os.replace(part, a.out)
    wall = time.time() - t0
    print(f"depth: {n} frames in {wall:.1f} s ({wall / n:.3f} s/frame, model {t_inf / n:.3f} s/frame), provider {a.provider}, "
          f"{a.threads} threads, model input {ww}x{wh}, source {W}x{H} @ {rate} -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()

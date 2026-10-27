"""mac-71: per sample, how much the beat changes the picture vs the no-beat control (mean abs diff, 0-255, on
135x240 grey frames every 0.25 s over the beat's window 1.0-4.5 s output), and which samples look alike."""
import json, subprocess, sys, pathlib, itertools
import numpy as np
O = pathlib.Path(sys.argv[1]); W, H = 135, 240
T = [1.0 + 0.25 * i for i in range(15)]           # 1.0 .. 4.5
def frames(mp4):
    out = []
    for t in T:
        r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.2f}", "-i", str(mp4), "-frames:v", "1", "-vf", f"scale={W}:{H},format=gray",
                            "-f", "rawvideo", "-"], capture_output=True)
        out.append(np.frombuffer(r.stdout, np.uint8).reshape(H, W).astype(np.int16) if len(r.stdout) == W * H else None)
    return out
res = json.loads((O / "results.json").read_text())
ctrl = frames(O / "none" / "build" / "sample.mp4")
F, rows = {}, {}
for name, r in res.items():
    mp4 = O / name / "build" / "sample.mp4"
    if name == "none" or r.get("render") != "ok" or not mp4.exists(): continue
    f = frames(mp4); F[name] = f
    d = [float(np.abs(a - c).mean()) if a is not None and c is not None else None for a, c in zip(f, ctrl)]
    v = [x for x in d if x is not None]
    # share of the frame the beat changed (pixels moved > 24 grey levels), at its fullest
    cov = max(float((np.abs(a - c) > 24).mean()) for a, c in zip(f, ctrl) if a is not None and c is not None)
    rows[name] = {"mean_diff": round(sum(v) / len(v), 1), "peak_diff": round(max(v), 1), "peak_cover": round(cov, 3),
                  "first_visible_s": next((T[i] for i, x in enumerate(d) if x is not None and x > 2.0), None)}
pairs = []
for a, b in itertools.combinations(sorted(F), 2):
    ds = [float(np.abs(x - y).mean()) for x, y in zip(F[a], F[b]) if x is not None and y is not None]
    pairs.append((round(sum(ds) / len(ds), 2), a, b))
pairs.sort()
json.dump({"vs_control": rows, "closest_pairs": pairs[:25]}, open(O / "analysis.json", "w"), indent=1)
for n, r in sorted(rows.items(), key=lambda x: x[1]["mean_diff"]): print(f"{n:24s} {r}")
print("closest pairs:"); [print(" ", p) for p in pairs[:15]]

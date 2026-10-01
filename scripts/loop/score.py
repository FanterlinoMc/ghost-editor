#!/usr/bin/env python3
"""Score a render's metrics against the reference's (both from measure.py) and log the round.

    score.py <ref.json> <ours.json> [--round N --note "what changed" --log rounds.jsonl]

Each metric scores 0-100 by how close it is to the reference (relative error, with a per-metric tolerance);
the total is a weighted mean. A change is kept only if the total goes up (and no metric collapses).
"""
import argparse, json, time
from pathlib import Path

# sat_mean has a low weight: it is mostly the footage (a dark room has little colour to grade up)
# metric: (weight, tolerance as a fraction of the reference value, or absolute when the key ends in _abs)
METRICS = {
    "changes_per_min": (3, 0.35), "burstiness": (2, 0.4), "longest_calm_s": (1, 0.6),
    "sat_mean": (0.5, 0.35), "mean_luma": (1, 0.3), "bright_share": (1, 0.6), "accent_share": (1, 0.8), "blur_share": (1.5, 0.6),
    "lufs": (1.5, None), "lra": (1, 0.6), "bed_vs_voice_db": (1, None), "hits_per_min": (1, 0.5),
}
ABS_TOL = {"lufs": 3.0, "bed_vs_voice_db": 6.0}


def one(k, ref, ours):
    if ref is None or ours is None: return None
    tol = ABS_TOL.get(k)
    err = abs(ours - ref) / tol if tol else abs(ours - ref) / (abs(ref) * METRICS[k][1] + 1e-9)
    return round(max(0.0, 100 * (1 - err)), 1)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("ref"); ap.add_argument("ours"); ap.add_argument("--round", type=int); ap.add_argument("--note", default=""); ap.add_argument("--log")
    a = ap.parse_args()
    R, O = json.loads(Path(a.ref).read_text()), json.loads(Path(a.ours).read_text())
    rows, tw, ts = [], 0, 0
    for k, (w, _) in METRICS.items():
        s = one(k, R.get(k), O.get(k))
        rows.append((k, R.get(k), O.get(k), s))
        if s is not None: tw += w; ts += w * s
    total = round(ts / tw, 1) if tw else 0
    print(f"{'metric':18s} {'ref':>8s} {'ours':>8s} {'score':>6s}")
    for k, r, o, s in sorted(rows, key=lambda x: (x[3] is None, x[3] if x[3] is not None else 0)):
        print(f"{k:18s} {str(r):>8s} {str(o):>8s} {str(s):>6s}")
    print(f"TOTAL {total}")
    if a.log:
        with open(a.log, "a") as f:
            f.write(json.dumps({"round": a.round, "time": time.strftime("%Y-%m-%d %H:%M"), "video": O.get("video"), "total": total,
                                "scores": {k: s for k, _, _, s in rows}, "note": a.note}) + "\n")


if __name__ == "__main__":
    main()

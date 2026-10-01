#!/usr/bin/env python3
"""Remove 1-2 frame black flashes (renderer glitch at jump cuts and scene changes) from a finished video.

A flash = frame(s) whose brightness drops under 60% of both neighbours while the neighbours match (a jump cut),
OR frame(s) under 45% of both neighbours however different they are (a cut between two different pictures, e.g. footage -> page).
Each flash frame is replaced by the frame before it; audio is copied untouched.

    deflash.py <video> [<video> ...]           fix in place, print what was fixed
    deflash.py --scan <video> [<video> ...]    report only
"""
import os, re, subprocess, sys
from pathlib import Path


def yavg(f):
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(f), "-vf", "scale=180:320,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
                        "-f", "null", "-"], capture_output=True, text=True)
    return [float(x) for x in re.findall(r"YAVG=([\d.]+)", r.stdout)]


def flashes(y):
    out, i = [], 1
    while i < len(y) - 1:
        hit = None
        for run in (1, 2):
            j = i + run
            if j >= len(y): break
            a, b = y[i - 1], y[j]
            dip = all(y[k] < 0.6 * min(a, b) for k in range(i, j))
            jump = min(a, b) > 30 and abs(a - b) < 0.25 * max(a, b) and dip
            black = min(a, b) > 32 and all(y[k] < 0.45 * min(a, b) for k in range(i, j))  # cut between two pictures; captions can lift a black frame above 16
            if jump or black:
                hit = (i, j - 1); break
        if hit: out.append(hit); i = hit[1] + 2
        else: i += 1
    return out


def main():
    scan = sys.argv[1] == "--scan"
    for arg in sys.argv[2 if scan else 1:]:
        f = Path(arg)
        if not f.exists(): print(f"{f}: missing"); continue
        fl = flashes(yavg(f))
        if not fl: print(f"{f.name}: clean"); continue
        desc = ", ".join(f"{a / 30:.2f}s" + (f"(+{b - a})" if b > a else "") for a, b in fl)
        if scan: print(f"{f.name}: {len(fl)} flash(es) at {desc}"); continue
        n = len(fl)
        g = f"[0:v]split={n + 1}[o0]" + "".join(f"[r{k}]" for k in range(n)) + ";"
        g += ";".join(f"[o{k}][r{k}]freezeframes=first={a}:last={b}:replace={a - 1}[o{k + 1}]" for k, (a, b) in enumerate(fl))
        tmp = f.with_name(f.stem + ".deflash.mp4")
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(f), "-filter_complex", g, "-map", f"[o{n}]", "-map", "0:a", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "copy", str(tmp)], check=True)
        left = flashes(yavg(tmp))
        os.replace(tmp, f)
        print(f"{f.name}: fixed {len(fl)} flash(es) at {desc}; left after fix: {len(left)}")


if __name__ == "__main__":
    main()

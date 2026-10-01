#!/usr/bin/env python3
"""Final master of a rendered reel: gentle compression, then two-pass loudness to a target (video copied untouched).

    master.py in.mp4 out.mp4 [--lufs -14] [--ratio 3] [--threshold -20]

The pitch style masters to -14 LUFS with LRA ~2-3 (the reference edit's numbers); house templates stay at -16.
"""
import argparse, json, re, subprocess


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--lufs", type=float, default=-14); ap.add_argument("--ratio", type=float, default=3); ap.add_argument("--threshold", type=float, default=-20)
    a = ap.parse_args()
    comp = f"acompressor=threshold={a.threshold}dB:ratio={a.ratio}:attack=5:release=80:makeup=1"
    r = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", a.src, "-af", f"{comp},loudnorm=I={a.lufs}:TP=-1:LRA=5:print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    m = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S).group(0))
    ln = (f"loudnorm=I={a.lufs}:TP=-1:LRA=5:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
          f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", a.src, "-c:v", "copy", "-af", f"{comp},{ln}", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", a.dst], check=True)
    out = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", a.dst, "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True).stderr
    print("mastered:", re.findall(r"^\s+I:\s+(-?[0-9.]+) LUFS", out, re.M)[-1], "LUFS, LRA", re.findall(r"^\s+LRA:\s+([0-9.]+) LU", out, re.M)[-1])


if __name__ == "__main__":
    main()

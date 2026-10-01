#!/usr/bin/env python3
"""Measure an edit the same way for every video, so a render can be scored against a reference edit.

    measure.py <video.mp4> [--out m.json] [--stems]      (--stems: split voice/music with demucs, ~1 min)

Metrics (all per-minute or ratios, so a 20 s test compares with a 76 s reference):
  rhythm   changes_per_min, first_change_s, changes_first5s, burstiness (CV of gaps), longest_calm_s
  picture  mean_luma, bright_share (flat/white pages), accent_share (saturated blue fields), sat_mean,
           blur_share (frames much softer than the video's median: focus pulls, defocus behind cards)
  sound    lufs, lra, bed_vs_voice_db (with --stems), hits_per_min (transients in the non-voice stem)
"""
import argparse, json, re, subprocess, sys, tempfile
from pathlib import Path
import numpy as np

PY = str(Path.home() / "phantasic/engine/.venv/bin/python")


def ff(args):
    return subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", *args], capture_output=True, text=True)


def rhythm(video, dur):
    r = ff(["-i", video, "-vf", "scdet=threshold=8", "-an", "-f", "null", "-"])
    cuts = sorted(float(x) for x in re.findall(r"lavfi\.scd\.time: ([0-9.]+)", r.stderr))
    merged = []
    for c in cuts:
        if not merged or c - merged[-1] > 0.12: merged.append(c)
    gaps = np.diff([0.0] + merged + [dur]) if merged else np.array([dur])
    return {"changes": len(merged), "changes_per_min": round(len(merged) / dur * 60, 1),
            "first_change_s": round(merged[0], 2) if merged else None,
            "changes_first5s": sum(1 for c in merged if c < 5),
            "burstiness": round(float(np.std(gaps) / max(1e-6, np.mean(gaps))), 2),
            "longest_calm_s": round(float(gaps.max()), 2), "cut_times": [round(c, 2) for c in merged]}


def picture(video):
    import cv2
    cap = cv2.VideoCapture(video); fps = cap.get(cv2.CAP_PROP_FPS) or 30; step = max(1, int(round(fps / 6)))
    luma, sat, sharp, blue, bright = [], [], [], [], []
    i = 0
    while True:
        ok, fr = cap.read()
        if not ok: break
        if i % step == 0:
            sm = cv2.resize(fr, (270, 480)); hsv = cv2.cvtColor(sm, cv2.COLOR_BGR2HSV); g = cv2.cvtColor(sm, cv2.COLOR_BGR2GRAY)
            luma.append(g.mean()); sat.append(hsv[..., 1].mean())
            sharp.append(cv2.Laplacian(g, cv2.CV_64F).var())
            h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
            blue.append(float(((h > 105) & (h < 130) & (s > 140) & (v > 120)).mean()))
            bright.append(float((g > 215).mean()))
        i += 1
    sharp = np.array(sharp); med = np.median(sharp)
    return {"mean_luma": round(float(np.mean(luma)), 1), "sat_mean": round(float(np.mean(sat)), 1),
            "bright_share": round(float(np.mean(np.array(bright) > 0.6)), 3),
            "accent_share": round(float(np.mean(np.array(blue) > 0.5)), 3),
            "blur_share": round(float(np.mean(sharp < 0.35 * med)), 3)}


def sound(video, stems):
    r = ff(["-i", video, "-af", "ebur128", "-f", "null", "-"])
    I = re.findall(r"^\s+I:\s+(-?[0-9.]+) LUFS", r.stderr, re.M); L = re.findall(r"^\s+LRA:\s+([0-9.]+) LU", r.stderr, re.M)
    out = {"lufs": float(I[-1]) if I else None, "lra": float(L[-1]) if L else None}
    if not stems: return out
    d = Path(tempfile.mkdtemp())
    ff(["-y", "-i", video, "-vn", "-ac", "1", "-ar", "22050", str(d / "a.wav")])
    subprocess.run([PY, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-d", "mps", "-o", str(d), str(d / "a.wav")], capture_output=True)
    lv = {}
    for st in ("vocals", "no_vocals"):
        r = ff(["-i", str(d / "htdemucs/a" / f"{st}.wav"), "-af", "ebur128", "-f", "null", "-"])
        m = re.findall(r"^\s+I:\s+(-?[0-9.]+) LUFS", r.stderr, re.M); lv[st] = float(m[-1]) if m else None
    if None not in lv.values(): out["bed_vs_voice_db"] = round(lv["no_vocals"] - lv["vocals"], 1)
    code = ("import librosa,numpy as np;y,sr=librosa.load(r'%s',sr=22050);e=librosa.onset.onset_strength(y=y,sr=sr);"
            "o=librosa.onset.onset_detect(onset_envelope=e,sr=sr,units='time',delta=0.25);f=librosa.time_to_frames(o,sr=sr);"
            "print(int(sum(e[f]>np.percentile(e,96))), len(y)/sr)") % (d / "htdemucs/a/no_vocals.wav")
    r = subprocess.run([PY, "-c", code], capture_output=True, text=True)
    try:
        n, secs = r.stdout.split(); out["hits_per_min"] = round(int(n) / float(secs) * 60, 1)
    except ValueError: pass
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("video"); ap.add_argument("--out"); ap.add_argument("--stems", action="store_true"); a = ap.parse_args()
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", a.video], capture_output=True, text=True).stdout)
    m = {"video": a.video, "duration": round(dur, 2), **rhythm(a.video, dur), **picture(a.video), **sound(a.video, a.stems)}
    js = json.dumps(m, indent=1)
    if a.out: Path(a.out).write_text(js)
    print(js)


if __name__ == "__main__":
    main()

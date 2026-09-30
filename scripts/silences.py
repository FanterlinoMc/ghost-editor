#!/usr/bin/env python3
"""Measure silences in the PREPPED source so the planner can see a pause the
transcript cannot (ISSUES A8).

    silences.py <project>/assets/talk.mp4 --out <project>/build/silences.json \
        [--noise -38] [--min 0.4]

Times are ORIGINAL-recording seconds - the same unit transcribe.py and
reel.json use, and the same file transcribe.py reads (prep.sh's output,
`<project>/assets/talk.mp4`).

Why this exists instead of a word-gap check: on the e2e reel, whisper gave
the single word "typing" a 1.48s span (14.90-16.38s) that runs straight
through a real 0.93s silence. The word timings never show the gap - moving
to word-level instead of segment-level times would not help, because
whisper stretched the word, it didn't split it. The only signal that finds
the pause is the audio itself.

Defaults (noise=-38dB, d=0.4s) reproduce the exact measurement that found
the e2e pause: silence_start 15.199s, silence_end 16.129s, 0.930s. This is
a DETECTION default, not a cut threshold - `autocut.py` removes pauses from
a single clean take and defaults to -35dB/0.28s, tuned to cut aggressively;
this script only reports what it finds, so it can afford to be pickier
about what counts as silence.

Read autocut.py before changing the parsing below: the overall approach
(regex over ffmpeg's silencedetect stderr) is reused from it on purpose.
The pairing of silence_start/silence_end is done explicitly here rather
than with autocut's `ends + [dur] * (len(starts) - len(ends))` padding
trick, to make the one case that trick exists for - a silence still open
at end of file, which prints a silence_start with no matching
silence_end - explicit rather than implicit.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


def resolve_exe(name):
    """Absolute path to ffmpeg/ffprobe.

    Bare exe names resolve against the PATH of the process that launches the
    subprocess, not any env= passed to it - and winget's installer edits PATH
    for new shells but not ones already running. Resolve explicitly and fall
    back to the winget install location rather than fail cryptically.
    """
    found = shutil.which(name)
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    if local:
        for bin_dir in sorted(Path(local).glob("Microsoft/WinGet/Packages/Gyan.FFmpeg*/*/bin")):
            candidate = bin_dir / f"{name}.exe"
            if candidate.exists():
                return str(candidate)
    sys.exit(f"{name} not found on PATH or in the winget install location")


def duration_of(src, ffprobe_bin):
    out = subprocess.run(
        [ffprobe_bin, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
        capture_output=True, text=True, check=True,
    ).stdout
    # ffprobe writes CRLF on Windows; .strip() removes it before float() sees it.
    return float(out.strip())


def measure(src, noise, min_dur):
    ffmpeg_bin = resolve_exe("ffmpeg")
    ffprobe_bin = resolve_exe("ffprobe")
    dur = duration_of(src, ffprobe_bin)
    err = subprocess.run(
        [ffmpeg_bin, "-hide_banner", "-nostats", "-i", src,
         "-af", f"silencedetect=noise={noise}dB:d={min_dur}", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    starts = [float(x) for x in re.findall(r"silence_start:\s*([\d.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*([\d.]+)", err)]
    silences = []
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else dur  # silence still open at EOF
        if e <= s:
            continue
        silences.append({"start": round(s, 3), "end": round(e, 3), "duration": round(e - s, 3)})
    return dur, silences


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", required=True)
    ap.add_argument("--noise", type=float, default=-38.0)
    ap.add_argument("--min", dest="min_dur", type=float, default=0.4)
    a = ap.parse_args()

    dur, silences = measure(a.src, a.noise, a.min_dur)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump({
        "source": os.path.abspath(a.src),
        "duration": round(dur, 3),
        "noise_db": a.noise,
        "min_s": a.min_dur,
        "silences": silences,
    }, open(a.out, "w"), indent=2)

    print(f"\n  start    end   dur   (original seconds; noise={a.noise}dB d={a.min_dur}s)")
    for s in silences:
        print(f"{s['start']:7.3f} {s['end']:7.3f} {s['duration']:5.2f}")
    print(f"\n{len(silences)} silence(s) in {dur:.2f}s -> {a.out}")


if __name__ == "__main__":
    main()

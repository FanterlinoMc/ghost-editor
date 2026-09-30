#!/usr/bin/env python3
"""Transcribe the WHOLE recording (every take) with whisper word timestamps
and print the segment table: the take map you choose takes from.

    transcribe.py <project>/assets/talk.mp4 --out <project>/build/words.whisper.json \
        [--model turbo] [--lang en] [--raw existing.json] \
        [--min-confidence 0.72] [--flags-out <project>/build/words.flags.json]

Times are ORIGINAL-recording seconds, the unit reel.json uses. Product names
get mangled; fix them in reel.json -> captions.fixes, not here.
Whisper is found on PATH (or $WHISPER); the audio goes in as 16 kHz mono.

Every word keeps whisper's own `probability` (ISSUES D5 - it used to be
discarded). Two independent signals flag a word as suspect, because neither
alone is enough:

  - low_confidence: probability below --min-confidence. Catches whisper
    admitting it heard the word badly - typically a mangled proper noun
    (product names, handles) that belongs in reel.json's captions.fixes.
  - long_duration: the word's span is far longer than its character count
    could plausibly take to say. Whisper does not shrink a word's span to
    fit a real pause; it stretches the word across it instead (ISSUES A8).
    The e2e reel's "typing" got a 1.48s span (14.90-16.38s) across a real
    0.93s silence, at probability 0.998 - confidence alone never finds
    this, only duration does.

Flagged words are printed and also written to --flags-out (default:
<out> with ".flags.json" in place of the extension), so a reel's suspect
words are visible without re-parsing the full whisper json.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

RESTART = re.compile(r"(okay,? again|let me (do|say) that again|one more time|take two|from the top|let's try again|wait,? no)", re.I)

# Duration plausibility: BASE + PER_CHAR * len(word) is the expected span for a
# word spoken at a generous, unhurried pace (~150 wpm works out to roughly
# 0.08s/character, plus a floor for the onset/offset of very short words).
# A word is flagged only if it exceeds DURATION_MULTIPLIER times that AND
# clears DURATION_MIN_ABS - the absolute floor keeps short words (a, to, it)
# from being flagged on normal jitter. Tuned against the e2e transcript
# (72 words): this flags exactly "typing" (expected 0.63s, actual 1.48s) and
# nothing else - see ISSUES A8.
DURATION_BASE = 0.15
DURATION_PER_CHAR = 0.08
DURATION_MULTIPLIER = 2.0
DURATION_MIN_ABS = 0.5

# Confidence: whisper's word `probability` on the e2e transcript bottoms out at
# 0.559 ("Yo,"), with only two other words below 0.72 - "IG" (0.69) and
# "Alua." (0.71), both genuinely mangled proper nouns, exactly what
# captions.fixes is for. 0.72 catches those three without also catching
# ordinary words like "want" (0.75). Override with --min-confidence if a
# different reel needs it.
MIN_CONFIDENCE = 0.72


def find_whisper():
    w = os.environ.get("WHISPER") or shutil.which("whisper")
    if not w:
        sys.exit("whisper not found: pip install openai-whisper (or set WHISPER=/path/to/whisper)")
    return w


def transcribe(src, model, lang):
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "audio.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav], check=True)
        cmd = [find_whisper(), wav, "--model", model, "--word_timestamps", "True",
               "--output_format", "json", "--output_dir", td, "--fp16", "False"]
        if lang:
            cmd += ["--language", lang]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
        return json.load(open(os.path.join(td, "audio.json")))


def flag_words(data, min_confidence):
    """Return suspect words: low whisper confidence, or an implausibly long
    span for the word's length. Each has independent `reasons`, since they
    point at different fixes (captions.fixes vs. distrust the timing)."""
    flags = []
    for s in data.get("segments", []):
        for w in s.get("words") or []:
            text = (w.get("word") or "").strip()
            if not text:
                continue
            start, end = w.get("start"), w.get("end")
            duration = None if start is None or end is None else end - start
            prob = w.get("probability")
            reasons = []
            if prob is not None and prob < min_confidence:
                reasons.append("low_confidence")
            if duration is not None:
                expected = DURATION_BASE + DURATION_PER_CHAR * len(text)
                if duration > DURATION_MIN_ABS and duration > DURATION_MULTIPLIER * expected:
                    reasons.append("long_duration")
            if reasons:
                flags.append({
                    "word": text,
                    "start": start,
                    "end": end,
                    "duration": None if duration is None else round(duration, 3),
                    "probability": prob,
                    "reasons": reasons,
                })
    return flags


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="turbo")
    ap.add_argument("--lang", default=None)
    ap.add_argument("--raw", help="reuse an existing whisper json")
    ap.add_argument("--min-confidence", type=float, default=MIN_CONFIDENCE,
                     help=f"flag a word below this whisper probability (default {MIN_CONFIDENCE})")
    ap.add_argument("--flags-out", default=None,
                     help="where to write the flagged-word list (default: --out with .flags.json)")
    a = ap.parse_args()
    data = json.load(open(a.raw)) if a.raw else transcribe(a.src, a.model, a.lang)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(data, open(a.out, "w"))
    print("\n  start    end   gap  text   (original seconds; * = restart marker)")
    prev = 0.0
    for s in data["segments"]:
        t = s["text"].strip()
        if not t:
            continue
        ws = s.get("words") or []
        st = ws[0]["start"] if ws else s["start"]
        en = ws[-1]["end"] if ws else s["end"]
        mark = "*" if RESTART.search(t) else " "
        print(f"{st:7.2f} {en:7.2f} {st - prev:5.1f} {mark}{t}")
        prev = en
    n = sum(len(s.get("words") or []) for s in data["segments"])
    print(f"\n{n} words -> {a.out}")

    flags = flag_words(data, a.min_confidence)
    flags_out = a.flags_out or (os.path.splitext(a.out)[0] + ".flags.json")
    os.makedirs(os.path.dirname(os.path.abspath(flags_out)), exist_ok=True)
    json.dump({"min_confidence": a.min_confidence, "flags": flags}, open(flags_out, "w"), indent=2)
    print(f"\n  start    end   dur  conf  reasons  word   (candidates for captions.fixes / review)")
    if flags:
        for f in flags:
            dur = f"{f['duration']:5.2f}" if f["duration"] is not None else "  n/a"
            conf = f"{f['probability']:.2f}" if f["probability"] is not None else " n/a"
            print(f"{f['start']:7.2f} {f['end']:7.2f} {dur} {conf}  {','.join(f['reasons']):<24} {f['word']}")
    else:
        print("  (none)")
    print(f"\n{len(flags)} flagged word(s) -> {flags_out}")


if __name__ == "__main__":
    main()

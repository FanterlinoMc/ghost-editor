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

I-16 (multi-source, engine/MULTIANGLE.md gap 3): each source transcribes on
its own (run the command above once per talk-<i>.mp4, same as always), then
--merge folds N of those per-source whisper jsons into ONE list the planner
reads. Per-source files for one source follow one naming convention end to
end - talk-<i>.mp4, words-<i>.whisper.json, face-<i>.json, silences-<i>.json
(face_track.py and silences.py need no code change for this: both already
take an explicit --out) - and --merge is what turns N of those into one:

    transcribe.py --merge --out <project>/build/words.merged.json \
        --source 0 assets/talk-0.mp4 build/words-0.whisper.json \
        --source 1 assets/talk-1.mp4 build/words-1.whisper.json \
        [--min-confidence 0.72]

Named words.merged.json, not words.json, on purpose: it sits next to
words.whisper.json and words-0.whisper.json, and its shape is NOT whisper's
(see below) - a name one edit-distance from the single-source file invites
pointing reel.json's `words` field at it unchanged, which fails at both
read sites.

The merged shape is `{"sources": [{"id", "src", "duration"}, ...], "words":
[{"source", "word", "start", "end", "probability", "flags"?}, ...]}`. Two
decisions worth recording:

  - Each word's start/end stay in ITS OWN source's original-recording
    seconds; they are NOT rebased onto one shared/concatenated clock. Gap 1
    is explicit that a bare number is already ambiguous with one source
    ("12.4 seconds into which file?") - inventing a second, merged flat
    timeline here would recreate exactly that ambiguity one layer up, just
    for transcripts instead of takes. The `source` id is what disambiguates,
    the same way a take becomes `{src, a, b}` instead of a bare `(a, b)`.
    This also means a planner can lift a word's own (start, end) straight
    into a take window with no coordinate math - source id plus native
    time is the same shape a take needs.
  - Words are grouped by source (in `--source` order), not interleaved by
    time, since there is no shared clock to interleave them ON. A planner
    wanting "what was said across every source" reads them source by
    source; a planner wanting "pick the best read of this line" filters by
    matching text across sources, which this shape supports directly since
    every word already carries which source it came from.

Confidence/duration flags (ISSUES D5, A8) are carried over per word under a
multi-source merge too, which closes the loop for both signals without the
planner having to re-open N separate .flags.json files.

TWO THINGS THE READER OF words.merged.json MUST NOT GET WRONG (this is
ingest's half of the I-16 contract; build.mjs and plan.py are not this
script's to fix, but both currently assume the single-source shape):

  1. `build.mjs:150-151` does `whisper.segments.flatMap(...)` and
     `plan.py`'s `_segments()` (`plan.py:359`) indexes `data["segments"]`.
     words.merged.json has no "segments" key - pointing either one at this
     file unmodified is a bare crash, not a silent wrong answer. Whichever
     side wires multi-source in needs to branch on the shape, e.g.
     `Array.isArray(data.words) ? data.words : data.segments.flatMap(...)`.
  2. `build.mjs:158-165` assigns each whisper word to a take by TIME OVERLAP
     ALONE (`ov(w, k)`, picking the take with the largest overlap). Every
     source's words start near t=0 in THAT source's own clock, so source 1's
     word at t=1.2 overlaps source 0's take [0.4, 4.88] exactly as well as it
     overlaps a real source-1 take at the same numeric range - the two are
     indistinguishable by time alone once more than one source is in play.
     The engine MUST filter candidate words to `w.source === <take's source
     id>` (resolved via this file's `sources[]` array, matched on `src`)
     BEFORE comparing times, or multi-source captions cross-assign every
     time two sources' takes share a numeric range, which they will by
     default since both start near 0.
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


def probe_duration(asset):
    """Best-effort ffprobe duration in seconds, or None. A word's own max end time
    is NOT the file length (trailing silence, a pause after the last word) - the
    planner needs the real bound to know how much of a source it can still take
    from, the same way plan.py's single-source path already has srcDur from
    build.mjs. Soft-fails: a bad/unresolvable path should not break the merge,
    only omit a field downstream code must already treat as optional."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                               "-of", "csv=p=0", asset], capture_output=True, text=True, timeout=10)
        return round(float(out.stdout.strip()), 3) if out.returncode == 0 and out.stdout.strip() else None
    except Exception:
        return None


def merge_sources(sources, min_confidence):
    """sources: [(id, asset_path, words_json_path), ...], each words_json_path
    pointing at a whisper-shaped json this script already wrote (--out from a
    per-source run, or --raw-compatible data). Returns the merged dict written
    to --out by --merge; see the module docstring for the shape and why.

    Caller must pass unique integer ids - that id is the ONLY thing that tells
    two words apart once they are in one flat list, so a repeated id would
    silently merge two sources' words under one name. Enforced in main(),
    not here, so this function stays usable from a test with ids already
    validated."""
    merged_sources, words = [], []
    for sid, asset, words_path in sources:
        data = json.load(open(words_path))
        merged_sources.append({"id": sid, "src": asset, "duration": probe_duration(asset)})
        reasons_by_word = {}
        for f in flag_words(data, min_confidence):
            reasons_by_word[(f["start"], f["end"], f["word"])] = f["reasons"]
        n = 0
        for s in data.get("segments", []):
            for w in s.get("words") or []:
                text = (w.get("word") or "").strip()
                if not text:
                    continue
                start, end, prob = w.get("start"), w.get("end"), w.get("probability")
                entry = {"source": sid, "word": text, "start": start, "end": end, "probability": prob}
                reasons = reasons_by_word.get((start, end, text))
                if reasons:
                    entry["flags"] = reasons
                words.append(entry)
                n += 1
        print(f"  source {sid} ({asset}): {n} words from {words_path}")
    return {"sources": merged_sources, "words": words}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="?", help="recording to transcribe (omit with --merge)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="turbo")
    ap.add_argument("--lang", default=None)
    ap.add_argument("--raw", help="reuse an existing whisper json")
    ap.add_argument("--min-confidence", type=float, default=MIN_CONFIDENCE,
                     help=f"flag a word below this whisper probability (default {MIN_CONFIDENCE})")
    ap.add_argument("--flags-out", default=None,
                     help="where to write the flagged-word list (default: --out with .flags.json)")
    ap.add_argument("--merge", action="store_true",
                     help="I-16: merge N per-source whisper jsons (--source ...) into one list at --out, instead of transcribing")
    ap.add_argument("--source", nargs=3, action="append", metavar=("ID", "ASSET", "WORDS"), default=None,
                     help="repeatable; one source's id, asset path (as it will appear in reel.json), and its whisper json path")
    a = ap.parse_args()

    if a.merge:
        if not a.source:
            sys.exit("--merge needs at least one --source ID ASSET WORDS")
        try:
            sources = [(int(sid), asset, words_path) for sid, asset, words_path in a.source]
        except ValueError as e:
            sys.exit(f"--source ID must be an integer: {e}")
        ids = [sid for sid, _, _ in sources]
        if len(set(ids)) != len(ids):
            sys.exit(f"--source ids must be unique, got {ids} - a repeated id silently merges two sources' words")
        merged = merge_sources(sources, a.min_confidence)
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        json.dump(merged, open(a.out, "w"), indent=1)
        flagged = sum(1 for w in merged["words"] if w.get("flags"))
        print(f"\n{len(merged['sources'])} source(s), {len(merged['words'])} word(s), {flagged} flagged -> {a.out}")
        return

    if not a.src:
        sys.exit("src is required unless --merge is given")
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

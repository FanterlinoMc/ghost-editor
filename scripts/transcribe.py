#!/usr/bin/env python3
"""Transcribe the WHOLE recording (every take) with whisper word timestamps
and print the segment table: the take map you choose takes from.

    transcribe.py <project>/assets/talk.mp4 --out <project>/build/words.whisper.json \
    # I-16 / MULTIANGLE Gap 3 - one transcript per RECORDING. No flag is needed: --out already
    # names the file, and build.mjs derives the same paths from take.src (lib/sources.mjs), so the
    # convention is all that has to be followed. Source 0 keeps the unsuffixed name.
    #   source 1:  transcribe.py <project>/assets/talk-1.mp4 --out <project>/build/words-1.whisper.json
        [--model turbo] [--lang en] [--raw existing.json] \
        [--min-confidence 0.72] [--flags-out <project>/build/words.flags.json]

Times are ORIGINAL-recording seconds, the unit reel.json uses. Product names
get mangled; fix them in reel.json -> captions.fixes, not here.
The audio goes in as 16 kHz mono. Two interchangeable backends write the SAME json:

  --engine faster   faster-whisper (CTranslate2, CPU, int8). `--model turbo` is its alias for
                    mobiuslabsgmbh/faster-whisper-large-v3-turbo, the CT2 conversion of the same
                    large-v3-turbo checkpoint. Several times faster on CPU. Default when the
                    package imports (see DEFAULT_ENGINE).
  --engine openai   the openai-whisper CLI, found on PATH (or $WHISPER).

--partial <path> is the studio's live-progress feed: a JSONL file, one line flushed per
finished segment. Line 1 is {"duration": <audio seconds>}; every later line is
{"start": s, "end": s, "text": "..."}. The faster backend streams it as segments decode (in
bursts of one 30 s window, which is how faster-whisper yields); the openai backend writes the
segment lines once, at the end. words.whisper.json is still written last, exactly as before.

Model cache: $XDG_CACHE_HOME is honoured by both backends (openai-whisper caches under
$XDG_CACHE_HOME/whisper); HF_HOME is defaulted to $XDG_CACHE_HOME/huggingface when unset so
faster-whisper's download lands on the same volume.

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

# Model cache on the volume: staging sets XDG_CACHE_HOME=/data/cache. openai-whisper already
# caches under $XDG_CACHE_HOME/whisper; huggingface_hub (faster-whisper) looks at HF_HOME
# instead, so derive it - before anything imports huggingface_hub.
if os.environ.get("XDG_CACHE_HOME") and not os.environ.get("HF_HOME") and not os.environ.get("HF_HUB_CACHE"):
    os.environ["HF_HOME"] = os.path.join(os.environ["XDG_CACHE_HOME"], "huggingface")

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

# "auto" = faster-whisper when it imports, else openai. Set to "openai" to make the openai CLI
# the default regardless of what is installed (see the parity numbers in the commit message).
DEFAULT_ENGINE = "auto"


def find_whisper():
    w = os.environ.get("WHISPER") or shutil.which("whisper")
    if not w:
        sys.exit("whisper not found: pip install openai-whisper (or set WHISPER=/path/to/whisper)")
    return w


def audio_f32(src):
    """16 kHz mono float32 PCM via our own ffmpeg. faster-whisper's own decoder is PyAV, and
    av 19 (what pip resolves today) rejects an argument faster-whisper 1.2.1 passes to av.open,
    so a path argument fails before any audio is read. A numpy array sidesteps that and is
    ~38 MB per 10 minutes."""
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000",
                          "-f", "f32le", "-"], check=True, stdout=subprocess.PIPE).stdout
    return np.frombuffer(raw, dtype=np.float32)


class Partial:
    """Append-only JSONL progress feed for the studio's waiting screen. None path = no-op."""
    def __init__(self, path):
        self.f = None
        if path:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            self.f = open(path, "w", encoding="utf-8")

    def line(self, obj):
        if self.f:
            self.f.write(json.dumps(obj, ensure_ascii=False) + "\n")
            self.f.flush()
            try:
                os.fsync(self.f.fileno())
            except OSError:
                pass

    def duration(self, seconds):
        self.line({"duration": round(seconds, 3)})

    def segment(self, start, end, text):
        self.line({"start": round(start, 3), "end": round(end, 3), "text": text.strip()})

    def close(self):
        if self.f:
            self.f.close()


def faster_available():
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def transcribe_faster(src, model, lang, partial):
    """CTranslate2 backend. Returns the json shape the openai CLI writes - segments[].words[]
    with word/start/end/probability and the per-segment decode stats - so flag_words,
    build.mjs, the planner and the studio never learn which engine ran. Decode settings are the
    openai CLI's own (beam 5, temperature fallback, condition_on_previous_text)."""
    from faster_whisper import WhisperModel
    audio = audio_f32(src)
    partial.duration(len(audio) / 16000.0)
    threads = os.cpu_count() or 4
    try:  # a container's cpuset can be smaller than the host's core count
        threads = min(threads, len(os.sched_getaffinity(0)))
    except AttributeError:
        pass
    threads = int(os.environ.get("FASTER_WHISPER_THREADS") or threads)
    compute = os.environ.get("FASTER_WHISPER_COMPUTE", "int8")
    wm = WhisperModel(model, device="cpu", compute_type=compute, cpu_threads=threads)
    vad = os.environ.get("FASTER_WHISPER_VAD") == "1"
    segs, info = wm.transcribe(audio, language=lang, word_timestamps=True, beam_size=5, vad_filter=vad)
    out = []
    for s in segs:  # a generator: the decode happens as it is iterated
        out.append({
            "id": s.id, "seek": s.seek, "start": s.start, "end": s.end, "text": s.text,
            "tokens": s.tokens, "temperature": s.temperature, "avg_logprob": s.avg_logprob,
            "compression_ratio": s.compression_ratio, "no_speech_prob": s.no_speech_prob,
            "words": [{"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
                      for w in (s.words or [])],
        })
        partial.segment(s.start, s.end, s.text)
    return {"text": "".join(s["text"] for s in out), "segments": out, "language": info.language}


def transcribe_openai(src, model, lang, partial):
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "audio.wav")
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav], check=True)
        import wave
        with wave.open(wav) as wf:
            partial.duration(wf.getnframes() / float(wf.getframerate()))
        cmd = [find_whisper(), wav, "--model", model, "--word_timestamps", "True",
               "--output_format", "json", "--output_dir", td, "--fp16", "False"]
        if lang:
            cmd += ["--language", lang]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
        data = json.load(open(os.path.join(td, "audio.json")))
    for seg in data.get("segments", []):  # the CLI only returns at the end: all lines at once
        partial.segment(seg["start"], seg["end"], seg["text"])
    return data


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
    # The segment table prints transcript text. On a cp1252 Windows console a "ť" raised
    # UnicodeEncodeError after words.whisper.json was written but before the flags sidecar
    # was, exiting 1. A console codepage must never decide whether ingest succeeds.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="turbo")
    ap.add_argument("--lang", default=None)
    ap.add_argument("--engine", choices=["faster", "openai"], default=None,
                     help="faster = faster-whisper (CTranslate2, CPU int8); openai = the openai-whisper CLI. "
                          "Default: faster if the package imports, else openai (with a notice)")
    ap.add_argument("--partial", default=None,
                     help="JSONL progress feed: {\"duration\":s} then one {start,end,text} line per segment")
    ap.add_argument("--raw", help="reuse an existing whisper json")
    ap.add_argument("--min-confidence", type=float, default=MIN_CONFIDENCE,
                     help=f"flag a word below this whisper probability (default {MIN_CONFIDENCE})")
    ap.add_argument("--flags-out", default=None,
                     help="where to write the flagged-word list (default: --out with .flags.json)")
    a = ap.parse_args()
    partial = Partial(a.partial)
    if a.raw:
        data = json.load(open(a.raw))
        for seg in data.get("segments", []):
            partial.segment(seg["start"], seg["end"], seg["text"])
    else:
        engine = a.engine or DEFAULT_ENGINE
        if engine == "auto":
            if faster_available():
                engine = "faster"
            else:
                engine = "openai"
                print("transcribe: faster-whisper is not installed; using the openai-whisper CLI "
                      "(pip install faster-whisper for the faster CPU backend)", file=sys.stderr)
        elif engine == "faster" and not faster_available():
            sys.exit("transcribe: --engine faster needs the faster-whisper package (pip install faster-whisper)")
        print(f"transcribe: engine={engine}", file=sys.stderr)
        run = transcribe_faster if engine == "faster" else transcribe_openai
        data = run(a.src, a.model, a.lang, partial)
    partial.close()
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

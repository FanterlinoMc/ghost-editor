#!/usr/bin/env python3
"""GPU transcription with whisper.cpp (whisper-cli, Metal) -> the same words.whisper.json the engine reads.
Many times faster than the CPU Whisper on Apple Silicon; same large-v3-turbo model (q5 quantised).

    fast_transcribe.py <audio-or-video> --out build/words.whisper.json
    fast_transcribe.py --text <audio>              (plain text, for checking a cut)
"""
import argparse, json, os, subprocess, tempfile

MODEL = os.path.expanduser("~/.cache/whisper-cpp/ggml-large-v3-turbo-q5_0.bin")


def wav(src):
    tmp = tempfile.mktemp(suffix=".wav")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", tmp], check=True)
    return tmp


def run(src, words=True):
    w = wav(src); base = tempfile.mktemp()
    args = ["whisper-cli", "-m", MODEL, "-f", w, "-l", "en", "-oj", "-of", base, "-np"]
    if words: args += ["-ml", "1", "-sow"]
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    d = json.load(open(base + ".json")); os.remove(base + ".json"); os.remove(w)
    return d["transcription"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out")
    ap.add_argument("--text", action="store_true")
    a = ap.parse_args()
    if a.text:
        print(" ".join(s["text"].strip() for s in run(a.src, words=False)).strip()); return
    segs = run(a.src)
    ws = [{"word": " " + s["text"].strip(), "start": s["offsets"]["from"] / 1000, "end": s["offsets"]["to"] / 1000} for s in segs if s["text"].strip()]
    out = {"text": "".join(x["word"] for x in ws).strip(), "segments": [{"start": ws[0]["start"] if ws else 0, "end": ws[-1]["end"] if ws else 0, "text": "", "words": ws}]}
    json.dump(out, open(a.out, "w"), indent=1)
    print(f"{len(ws)} words -> {a.out}")


if __name__ == "__main__":
    main()

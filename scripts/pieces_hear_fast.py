#!/usr/bin/env python3
"""pieces_hear with whisper.cpp on the GPU: transcribe each speech piece on its own (see pieces_hear.py)."""
import json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from fast_transcribe import run
def hear(wav_path):
    """Prefer a running whisper-server (model stays loaded: ~0.2 s per piece); fall back to whisper-cli."""
    r = subprocess.run(["curl", "-s", "-m", "60", "http://127.0.0.1:8178/inference", "-F", f"file=@{wav_path}", "-F", "response_format=json",
                        "-F", "language=en"], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)["text"].strip()
    except Exception:
        return " ".join(s["text"].strip() for s in run(wav_path, words=False)).strip()


for proj in sys.argv[1:]:
    p = os.path.join(proj, "build", "islands.json")
    if not os.path.exists(p): continue
    pieces = json.load(open(p))
    src = os.path.join(proj, "assets", "talk.mp4")
    for x in pieces:
        if "heard" in x: continue
        tmp = tempfile.mktemp(suffix=".wav")
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", str(max(0, x["a"] - 0.05)), "-to", str(x["b"] + 0.05), "-i", src,
                        "-vn", "-ac", "1", "-ar", "16000", tmp], check=True)
        x["heard"] = hear(tmp) if x["b"] - x["a"] > 0.12 else ""
        os.remove(tmp)
    json.dump(pieces, open(p, "w"), indent=1)
    print(f"{proj}: {len(pieces)} pieces heard", flush=True)

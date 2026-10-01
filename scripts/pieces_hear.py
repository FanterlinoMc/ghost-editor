#!/usr/bin/env python3
"""Transcribe every speech piece (build/islands.json from smartcut.py --islands) ON ITS OWN, so each piece's text is
what is actually audible in it. Whisper's word stamps on the full recording drift by up to half a second, which
mislabels short pieces ("basically give" for a piece that only says "Basically,"). One model load for many projects.

    pieces_hear.py <project> [<project> ...]      -> adds "heard" to each piece in build/islands.json
"""
import json, subprocess, sys, tempfile, os
import whisper

model = whisper.load_model("large-v3-turbo")
for proj in sys.argv[1:]:
    p = os.path.join(proj, "build", "islands.json")
    if not os.path.exists(p): continue
    pieces = json.load(open(p))
    if all("heard" in x for x in pieces): continue
    src = os.path.join(proj, "assets", "talk.mp4")
    for x in pieces:
        tmp = tempfile.mktemp(suffix=".wav")
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", str(max(0, x["a"] - 0.05)), "-to", str(x["b"] + 0.05), "-i", src,
                        "-vn", "-ac", "1", "-ar", "16000", tmp], check=True)
        r = model.transcribe(tmp, language="en", fp16=False, condition_on_previous_text=False, temperature=0)
        x["heard"] = r["text"].strip()
        os.remove(tmp)
    json.dump(pieces, open(p, "w"), indent=1)
    print(f"{proj}: {len(pieces)} pieces heard", flush=True)

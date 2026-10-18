#!/usr/bin/env python3
"""noir_score.py: score.py cue sheet for a Noir (premium-noir) reel from its build data.

    noir_score.py <project> <video.mp4> [--music piano.mp3] [--pack DIR] [-o cues.json]

Film-documentary sound: a piano bed ducked under the voice, film-room air (room tone) the whole way, a soft felt thud
on frame 1, every chapter card (serif endcard beat) lands on a reverse-cymbal swell + felt thud with the music
lifting while the card holds, a quiet glass shimmer on the gold words (at most one per 2.5 s), and the last word
rings out under a final thud while the piano swells.

Ported from Ahmed's phantasic engine/core (origin/main, template-premium-noir). Fork notes:
  - needs build/words.aligned.json (realign.py) and the reel.json of a built reel. Stdlib only, no network, no model.
  - the sound pack is NOT shipped: --pack DIR (or $PHANTASIC_SFX_PACK) names a folder with s-felt-thud, s-reverse-cymbal,
    s-shimmer and e-roomtone .wav files; a missing wav is skipped by score.py with a warning.
  - --music is optional: the premium-noir style names the piano bed silent-descent, which is not shipped either
    (Ahmed's cue sheet used his own track, signature-eva-v2m.mp3). Without --music the cue sheet has no music.
  - one voice file: a ramped take or a take from another recording is refused.
"""
import json, os, subprocess, sys

A = sys.argv[1:]
if len(A) < 2 or A[0] in ("-h", "--help"):
    print(__doc__)
    sys.exit(0 if A and A[0] in ("-h", "--help") else 2)
proj, video = os.path.abspath(A[0]), os.path.abspath(A[1])
opt = lambda k, d=None: A[A.index(k) + 1] if k in A else d
PACK = opt("--pack") or os.environ.get("PHANTASIC_SFX_PACK")
if not PACK:
    sys.exit("noir_score.py: no sound pack. Pass --pack DIR or set PHANTASIC_SFX_PACK (the premium pack is not shipped with the engine).")
PACK = os.path.expanduser(PACK)
F = lambda n: os.path.join(PACK, n + ".wav")
MUSIC = opt("--music")
MUSIC = os.path.abspath(os.path.expanduser(MUSIC)) if MUSIC else None
OUT = os.path.abspath(opt("-o", os.path.join(proj, "build", "cues.json")))
reel = json.load(open(os.path.join(proj, "reel.json"), encoding="utf-8"))
src_file = reel.get("source", "assets/talk.mp4")
for t in reel["takes"]:
    if t.get("ramp") or t.get("src") not in (None, src_file):
        sys.exit("noir_score.py: a ramped take or a take from another recording (take.src) is not supported: the cue sheet has one voice file")
takes = [(t["a"], t["b"]) for t in reel["takes"]]
holds = [float(t.get("hold", 0)) for t in reel["takes"]]


def out_t(src):
    acc = 0.0
    for (a, b), h in zip(takes, holds):
        if a - 1e-3 <= src <= b + 1e-3:
            return acc + src - a
        acc += b - a + h
    return None


r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                   capture_output=True, text=True, encoding="utf-8", errors="replace")
try:
    dur = float(r.stdout)
except ValueError:
    sys.exit(f"noir_score.py: ffprobe could not read {video}: {r.stderr.strip()[-200:]}")
wa = json.load(open(os.path.join(proj, "build", "words.aligned.json"), encoding="utf-8"))
words = [(w["word"].strip(), out_t(w["start"])) for s in wa["segments"] for w in s.get("words", [])]
words = [(w, t) for w, t in words if t is not None]
bare = lambda w: "".join(c for c in w.lower() if c.isalnum() or c == "'")
emph = {bare(e) for e in reel.get("captions", {}).get("emph", [])}
cards = [(out_t(b["at"]), out_t(b["to"])) for b in reel.get("beats", []) if b.get("type") == "endcard" and b.get("font") == "serif"]
cards = [(a, b) for a, b in cards if a is not None and b is not None]

cues = [{"src": F("s-felt-thud"), "t": 0.02, "db": -14, "verb": 0.3}]
env = [[0, 0]]
for a, b in cards:
    if a > 0.3:
        cues.append({"src": F("s-reverse-cymbal"), "t": round(a, 3), "db": -20, "align": "peak", "fade": 0.03})
    cues.append({"src": F("s-felt-thud"), "t": round(a + 0.02, 3), "db": -11, "verb": 0.4})
    env += [[round(a - 0.1, 3), 0], [round(a + 0.05, 3), 4], [round(b - 0.05, 3), 4], [round(b + 0.15, 3), 0]]
last = -9
for w, t in words:
    if bare(w) in emph and t - last >= 2.5:
        last = t
        cues.append({"src": F("s-shimmer"), "t": round(t, 3), "db": -24, "verb": 0.4, "fade": 0.6})
if words:
    cues.append({"src": F("s-felt-thud"), "t": words[-1][1], "db": -12, "verb": 0.5})
    env += [[round(words[-1][1] - 0.5, 3), 0], [round(words[-1][1] + 0.3, 3), 3]]
env.append([dur, env[-1][1]])
cfg = {"video": video, "out": video.replace(".mp4", "-scored.mp4"),
       "voice": {"src": os.path.join(proj, src_file), "takes": [list(t) for t in takes]},
       "beds": [{"src": F("e-roomtone"), "t": 0, "to": round(dur, 3), "db": 18, "fade": 0.4}],
       "cues": cues, "verb": {"seconds": 2.6, "db": -6}, "fx_duck_db": 10}
if MUSIC:
    cfg["music"] = {"src": MUSIC, "start": 0, "db": -15, "duck_db": 7, "fade_in": 0.8, "fade_out": 1.4, "env": sorted(env)}
else:
    print("noir_score: no --music given, the cue sheet has no piano bed", file=sys.stderr)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(cfg, open(OUT, "w", encoding="utf-8"), indent=1)
print(f"noir_score: {len(cues)} cues, {len(cards)} chapter card(s) -> {OUT}")

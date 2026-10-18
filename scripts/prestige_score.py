#!/usr/bin/env python3
"""prestige_score.py: score.py cue sheet for a Prestige (premium-belmar) reel from its build data.

    prestige_score.py <project> <video.mp4> [--music f.mp3 --music-drop 7.30] [--sfx-dir DIR] [-o cues.json]

The track's own drop (--music-drop, seconds into the file) is placed on the reel's drop boom, so the bed plays
quietly under the talk and hits on the montage. Rules (Belmar DNA):
  - quiet bed under the talk (ducked), 3 f of silence before the drop, +17 dB in the drop (the drop must hit louder than the talk), -6 dB under the end card
  - drop: rumble riser topping out on the gap, deep boom + cine whoosh on the first shot, camera flash on flash cuts
  - talk: soft pop on caption blocks, hit + short riser into talk-section B-roll, heartbeat on the end card

Ported from Ahmed's phantasic engine/core (origin/main, template-premium-belmar). Fork notes:
  - reads build/sfx_events.json, so build the reel first. The sounds it points at are the engine's library/sfx wavs
    (cinematic-rumble-riser, cinematic-deep-boom, whoosh-cine, tech-camera-flash, cinematic-cine-hit, pop-1,
    cinematic-heartbeat); --sfx-dir DIR (or $PHANTASIC_SFX_DIR) points at another folder. A wav that is not there is
    skipped by score.py with a warning, so with an empty library the pass is the voice plus the music.
  - --music is optional (Ahmed's house track empire-house-b.mp3 is not shipped); without it the cue sheet has no music.
    --music-drop is the track's drop second (Ahmed's house-b: 7.30).
  - one voice file: a ramped take or a take from another recording is refused. Stdlib only.
"""
import json, os, subprocess, sys

A = sys.argv[1:]
if len(A) < 2 or A[0] in ("-h", "--help"):
    print(__doc__)
    sys.exit(0 if A and A[0] in ("-h", "--help") else 2)
proj, video = os.path.abspath(A[0]), os.path.abspath(A[1])
opt = lambda k, d=None: A[A.index(k) + 1] if k in A else d
LIB = os.path.expanduser(opt("--sfx-dir") or os.environ.get("PHANTASIC_SFX_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "library", "sfx"))
F = lambda n: os.path.abspath(os.path.join(LIB, n + ".wav"))
MUSIC = opt("--music")
MUSIC = os.path.abspath(os.path.expanduser(MUSIC)) if MUSIC else None
MDROP = float(opt("--music-drop", 7.30))
OUT = os.path.abspath(opt("-o", os.path.join(proj, "build", "cues.json")))
r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                   capture_output=True, text=True, encoding="utf-8", errors="replace")
try:
    dur = float(r.stdout)
except ValueError:
    sys.exit(f"prestige_score.py: ffprobe could not read {video}: {r.stderr.strip()[-200:]}")
ev = json.load(open(os.path.join(proj, "build", "sfx_events.json"), encoding="utf-8"))["events"]
reel = json.load(open(os.path.join(proj, "reel.json"), encoding="utf-8"))
src_file = reel.get("source", "assets/talk.mp4")
for t in reel["takes"]:
    if t.get("ramp") or t.get("src") not in (None, src_file):
        sys.exit("prestige_score.py: a ramped take or a take from another recording (take.src) is not supported: the cue sheet has one voice file")
first = lambda why: next((e["t"] for e in ev if why in e.get("why", "")), None)
boom, riser = first("drop boom"), first("drop riser")
cues = []
for e in ev:
    w, t = e.get("why", ""), e["t"]
    if w.startswith("drop riser"):
        if boom is not None:
            cues.append({"src": F("cinematic-rumble-riser"), "t": round(boom - 0.1, 3), "db": -8, "align": "peak", "fade": 0.03, "tail": 1.6, "fade_in": 0.4})
    elif w.startswith("drop boom"):
        cues += [{"src": F("cinematic-deep-boom"), "t": t, "db": -2, "verb": 0.3}, {"src": F("whoosh-cine"), "t": t, "db": -10, "align": "peak"}]
    elif w.startswith("drop flash cut"):
        cues.append({"src": F("tech-camera-flash"), "t": t, "db": -14})
    elif "hit on the cut" in w and (boom is None or t < boom - 1):
        cues += [{"src": F("cinematic-cine-hit"), "t": t, "db": -14, "verb": 0.2}, {"src": F("whoosh-cine"), "t": t, "db": -18, "align": "peak"}]
    elif "word pop" in w:
        cues.append({"src": F("pop-1"), "t": t, "db": -24})
card = next((e["t"] for e in ev if e.get("why", "").startswith("mono card") or "end card" in e.get("why", "")), None)
if card:
    cues.append({"src": F("cinematic-heartbeat"), "t": card, "db": -14})
holds = [float(t.get("hold", 0)) for t in reel["takes"]]
cfg = {"video": video, "out": video.replace(".mp4", "-scored.mp4"),
       "voice": {"src": os.path.join(proj, src_file), "takes": [[t["a"], t["b"]] for t in reel["takes"]]},
       "cues": cues, "beds": [], "verb": {"seconds": 2.0, "db": -8}, "fx_duck_db": 10}
# a drop that lands while the speaker is still talking (drop.at inside a take) can't be a wall of sound: the music
# lifts only +7 dB, no pre-boom silence, and the boom/riser come down so every word stays >= 6 dB clear
wa = json.load(open(os.path.join(proj, "build", "words.aligned.json"), encoding="utf-8"))
tk = [(t["a"], t["b"]) for t in reel["takes"]]
def _out(src):
    acc = 0.0
    for (a, b), h in zip(tk, holds):
        if a <= src <= b:
            return acc + src - a
        acc += b - a + h
    return None
spoken = [o for o in (_out(w["start"]) for s_ in wa["segments"] for w in s_.get("words", [])) if o is not None]
under = boom is not None and any(boom - 0.1 <= o <= boom + 2.0 for o in spoken)
if under:
    for c in cues:
        if "deep-boom" in c["src"]: c["db"] = -9
        if "rumble-riser" in c["src"]: c["db"] = -16
if boom and MUSIC:
    at = max(0.0, boom - MDROP)
    lift = 7 if under else 17
    env = [[0, 0], [boom - 0.14, 0]] + ([] if under else [[boom - 0.1, -40], [boom - 0.01, -40]]) + [[boom, lift]]
    if card:
        env += [[card - 0.3, lift], [card, -4]]
    env.append([dur, env[-1][1]])
    cfg["music"] = {"src": MUSIC, "start": 0 if boom >= MDROP else MDROP - boom, "at": at, "db": -16, "duck_db": 6,
                    "fade_in": 0.6, "fade_out": 0.9, "env": env}
elif boom:
    print("prestige_score: no --music given, the cue sheet has no music bed", file=sys.stderr)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(cfg, open(OUT, "w", encoding="utf-8"), indent=1)
print(f"prestige_score: {len(cues)} cues, drop {boom}, card {card} -> {OUT}")

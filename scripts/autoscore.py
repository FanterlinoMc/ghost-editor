#!/usr/bin/env python3
"""autoscore.py: write a score.py cue sheet for a built reel from its own build data (Empire rules).

    autoscore.py <project> <video.mp4> [--music file.mp3 --music-start 0] [--pack DIR] [-o cues.json]

Reads <project>/reel.json (takes, interlude beats), build/words.aligned.json (word times, from realign.py) and
build/sfx_events.json (caption card times, red verdict hits). Output times are reel times (takes concatenated).
Rules, tuned by hand on the Moran hook (10 Oct 2026, Ahmed: "this one is good"):
  - a hit on frame 1 (sub + low whoosh), no intro
  - typewriter key under every typed word (not the red verdicts); a closer, louder key on interlude cards
  - red verdicts alternate BIG (riser into ~0.13 s of music silence, sub tail + braam + metal slam) and LIGHT
    (short sub + slam); the first and the last verdict are always BIG; risers at least 2.5 s apart
  - interlude card (endcard beat with arrow:false): music and neon hum drop out, one short heartbeat;
    a low whoosh lands the cut back to the face and the music comes back lifted
  - the last word rings out on a sub tail
  - beds: neon hum (face shots) + room tone (whole reel)

Ported from Ahmed's phantasic engine/core (origin/main, template-premium-iman). Fork notes:
  - the sound pack is NOT shipped. --pack DIR (or $PHANTASIC_SFX_PACK) names a folder of the wavs the cues call
    (e-subboom-tail, e-low-whoosh, e-type-key, e-riser, e-braam, old-metal-slam, old-subboom, e-heartbeat, e-neon-hum,
    e-roomtone). A missing wav is not an error here: score.py skips a cue whose file is absent, with a warning.
  - no network, no model; stdlib only (ffprobe on PATH). Runs in well under a second.
  - one voice file: a reel whose takes name different recordings (take.src) is refused, as is a ramped take. A `hold` is
    counted (the frozen frames after a take); score.py plays the voice takes back to back, so put holds on the LAST take.
"""
import json, os, subprocess, sys

ARGS = sys.argv[1:]
if len(ARGS) < 2 or ARGS[0] in ("-h", "--help"):
    print(__doc__)
    sys.exit(0 if ARGS and ARGS[0] in ("-h", "--help") else 2)
proj, video = os.path.abspath(ARGS[0]), os.path.abspath(ARGS[1])
opt = lambda k, d=None: ARGS[ARGS.index(k) + 1] if k in ARGS else d
PACK = opt("--pack") or os.environ.get("PHANTASIC_SFX_PACK")
if not PACK:
    sys.exit("autoscore.py: no sound pack. Pass --pack DIR or set PHANTASIC_SFX_PACK (the premium pack is not shipped with the engine).")
PACK = os.path.expanduser(PACK)
MUSIC = opt("--music")
OUT = os.path.abspath(opt("-o", os.path.join(proj, "build", "cues.json")))
F = lambda n: os.path.join(PACK, n + ".wav")

reel = json.load(open(os.path.join(proj, "reel.json"), encoding="utf-8"))
src_file = reel.get("source", "assets/talk.mp4")
for t in reel["takes"]:
    if isinstance(t, dict) and (t.get("ramp") or (t.get("src") not in (None, src_file))):
        sys.exit("autoscore.py: a ramped take or a take from another recording (take.src) is not supported: the cue sheet has one voice file")
takes = [(t["a"], t["b"]) if isinstance(t, dict) else tuple(t) for t in reel["takes"]]
holds = [float(t.get("hold", 0)) if isinstance(t, dict) else 0.0 for t in reel["takes"]]


def out_t(src):
    acc = 0.0
    for (a, b), h in zip(takes, holds):
        if a <= src <= b:
            return acc + src - a
        acc += b - a + h
    return None


def probe_dur(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        return float(r.stdout)
    except ValueError:
        sys.exit(f"autoscore.py: ffprobe could not read {path}: {r.stderr.strip()[-200:]}")


dur = probe_dur(video)
wa = json.load(open(os.path.join(proj, "build", "words.aligned.json"), encoding="utf-8"))
raw = [(w["word"].strip(), out_t(w["start"]), out_t(w.get("end", w["start"]))) for s in wa["segments"] for w in s.get("words", [])]
raw = [r for r in raw if r[1] is not None]
words = [(w, t) for w, t, _ in raw]


def gap_before(t):
    """Silence before the word spoken at reel time t (from the previous word's end)."""
    prev = [e for w, s, e in raw if s < t - 0.05 and e is not None]
    return max(0.0, t - max(prev)) if prev else 1.0
ev = json.load(open(os.path.join(proj, "build", "sfx_events.json"), encoding="utf-8"))
ev = ev if isinstance(ev, list) else ev.get("events", [])
reds = sorted(e["t"] for e in ev if "red" in e.get("why", ""))
# a red card cuts in 0.05 s before its word: land the hits on the spoken word itself
_starts = [t for _, t, _ in raw]
reds = [min(_starts, key=lambda s: abs(s - r)) if _starts and min(abs(s - r) for s in _starts) < 0.2 else r for r in reds]
monos = [(out_t(b["at"]) if out_t(b["at"]) is not None else b["at"], out_t(b["to"]) if out_t(b["to"]) is not None else b["to"])
         for b in reel.get("beats", []) if b.get("type") == "endcard" and b.get("arrow") is False]
in_mono = lambda t: any(a <= t < b for a, b in monos)

cues, env = [], [[0, 0]]
# hook
cues += [{"src": F("e-subboom-tail"), "t": 0.02, "db": -9, "verb": 0.25, "fade": 0.5},
         {"src": F("e-low-whoosh"), "t": 0.0, "db": -14}]
# typewriter keys (skip the red verdict words: they slam, they don't type)
red_words = set()
for r in reds:
    near = min(words, key=lambda w: abs(w[1] - r), default=None)
    if near and abs(near[1] - r) < 0.35:
        red_words.add(near)
last = -1
for i, (w, t) in enumerate(words):
    if (w, t) in red_words or t - last < 0.09:
        continue
    last = t
    jitter = ((i * 37) % 7 - 3) / 3                      # deterministic +-1 dB humanisation
    cues.append({"src": F("e-type-key"), "t": round(t, 3), "db": round((-13 if in_mono(t) else -12) + jitter, 1), "fade": 0.02})
# red verdicts
last_riser = -9
for k, r in enumerate(reds):
    big = k in (0, len(reds) - 1) or k % 2 == 0
    if big and r - last_riser >= 2.5 and r > 0.8:
        last_riser = r
        g = gap_before(r)
        tail = min(1.0, max(0.35, g + 0.3))               # the swell lives in the breath before the verdict
        if g >= 0.15:                                     # no breath before the verdict = no room for a swell
            cues.append({"src": F("e-riser"), "t": r - 0.02, "db": (-6 if k == len(reds) - 1 else -9) - (5 if tail < 0.8 else 0),
                         "align": "peak", "fade": 0.03, "tail": round(tail, 2), "fade_in": round(min(0.25, tail / 2), 2)})
        cues += [{"src": F("e-subboom-tail"), "t": r, "db": 0 if k == len(reds) - 1 else -3, "verb": 0.5, "fade": 1.0},
                 {"src": F("e-braam"), "t": r + 0.01, "db": -9 if k == len(reds) - 1 else -13, "len": 1.6, "fade": 1.0},
                 {"src": F("old-metal-slam"), "t": r, "db": 5, "verb": 0.3}]
        env += [[r - 0.26, 0], [r - 0.12, -40], [r, -40], [r + 0.02, 1 if k == len(reds) - 1 else 0]]
    else:
        cues += [{"src": F("old-subboom"), "t": r, "db": -6, "verb": 0.3},
                 {"src": F("old-metal-slam"), "t": r, "db": 2, "verb": 0.25}]
# interlude cards
for a, b in monos:
    cues += [{"src": F("e-heartbeat"), "t": a + 0.02, "db": -24, "len": 0.6},
             {"src": F("e-low-whoosh"), "t": b + 0.01, "db": -6, "align": "peak"}]
    env += [[a - 0.07, 0], [a, -45], [b - 0.02, -45], [b + 0.01, 6]]
# out
if words:
    cues.append({"src": F("e-subboom-tail"), "t": words[-1][1], "db": -8, "verb": 0.5, "fade": 0.1})
env = sorted(env) + [[dur, env[-1][1] if env else 0]]
# carry each level forward so a lift after an interlude persists until the next change
beds, t0 = [], 0.0
for a, b in monos + [(dur, dur)]:
    if a - t0 > 0.3:
        beds.append({"src": F("e-neon-hum"), "t": round(t0, 3), "to": round(a, 3), "db": -30, "fade": 0.2})
    t0 = b
beds.append({"src": F("e-roomtone"), "t": 0, "to": round(dur, 3), "db": 16, "fade": 0.3})

cfg = {"video": video, "out": video.replace(".mp4", "-scored.mp4"),
       "voice": {"src": os.path.join(proj, src_file), "takes": [list(t) for t in takes]},
       "beds": beds, "cues": cues, "verb": {"seconds": 2.8, "db": -5}, "fx_duck_db": 12}
if MUSIC:
    cfg["music"] = {"src": os.path.abspath(os.path.expanduser(MUSIC)), "start": float(opt("--music-start", 0)), "db": -13, "duck_db": 7,
                    "env": env, "fade_out": 0.8}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(cfg, open(OUT, "w", encoding="utf-8"), indent=1)
print(f"autoscore: {len(cues)} cues, {len(reds)} verdicts, {len(monos)} interlude(s) -> {OUT}")

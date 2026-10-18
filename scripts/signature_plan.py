#!/usr/bin/env python3
"""signature_plan.py: one art-direction plan -> a Signature reel (reel.json) and, after the render, its sound design.

    signature_plan.py reel  plan.json                     writes <project>/reel.json from the plan
    signature_plan.py score plan.json video.mp4 [--pack DIR]   writes <project>/build/cues.json for score.py

plan.json (all times are SOURCE seconds, like reel.json):
{
  "project": "path/to/project",                       # the folder with assets/ and build/
  "base": "path/to/reel.json",                         # optional: style, look, captions defaults (default: style premium-signature)
  "title": "...",
  "takes": [[a, b], ...],
  "heroes": ["word", ...], "serif": ["word", ...], "fixes": {"crafting": "crofting"},
  "cuts": [{"src": "assets/anim/01-cliffs.mp4", "at": 8.66, "to": 9.70, "amb": "sea", "media": 0.3}, ...],
  "payoff": 69.36,                                   # the line's last hero word: cymbal into it, shimmer + thud on it
  "music": "path/to/track.mp3",                      # optional (score mode)
  "pack": "path/to/sfx-pack"                         # optional (score mode); or --pack, or $PHANTASIC_SFX_PACK
}
Rules (from the Eva hook, scored by hand 10 Oct 2026 and approved): a cut shorter than 0.6 s is a montage card
(paper card flip, no whoosh); a longer cut gets an airy whoosh into it and its own ambience bed (amb tag), and the
music lifts +3 dB under it; hero words not under a cut get a whisper whoosh; zoom snaps alternate 1.18 / 1.1 / 1.28
on hero words and reset to 1.0 at every take; a light leak covers every take join; the music dips -9 dB for the
1.3 s before the payoff, then sits at -6 dB to the end.

Ported from Ahmed's phantasic engine/core (origin/main, template-premium-signature). Fork notes:
  - pure transform: stdlib only, no network, no model, no generation. `cuts[].src` are pictures or short clips that
    ALREADY exist in the project (Ahmed made them with an image model and an image-to-video model per video; this script
    does not). It runs in well under a second.
  - the plan's "base" is optional. Without it the reel is {style: "premium-signature", source, words, face, ...}: source
    is assets/talk.mp4, words is build/words.aligned.json (realign.py) when present, else build/words.whisper.json.
  - the sound pack is NOT shipped: it names s-felt-thud, s-card-flip, s-airy-whoosh, s-reverse-cymbal, s-shimmer and the
    ambience wavs (s-sea-waves, s-field-wind, s-canal-water, s-city-dusk, s-sizzle, s-airport-amb); a missing wav is
    skipped by score.py with a warning. The music is optional too (silent-descent is not shipped).
  - the reel mode needs build/words.aligned.json to find the hero words (run realign.py first); if it is missing the zoom
    snaps are written for the take starts only and the script says so.
"""
import json, os, subprocess, sys

X = lambda p: os.path.expanduser(p)
AMB = {"sea": ("s-sea-waves", -11), "wind": ("s-field-wind", -18), "water": ("s-canal-water", -8),
       "city": ("s-city-dusk", -4), "food": ("s-sizzle", -17), "airport": ("s-airport-amb", -20)}
GRADE = "contrast(1.06) saturate(1.08) brightness(.9)"

if len(sys.argv) < 3 or sys.argv[1] in ("-h", "--help") or sys.argv[1] not in ("reel", "score"):
    print(__doc__)
    sys.exit(0 if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help") else 2)
mode, plan = sys.argv[1], json.load(open(sys.argv[2], encoding="utf-8"))
proj = os.path.abspath(X(plan["project"]))
takes = [tuple(t) for t in plan["takes"]]
plan.setdefault("cuts", [])


def out_t(src):
    acc = 0.0
    for a, b in takes:
        if a - 1e-3 <= src <= b + 1e-3:
            return acc + src - a
        acc += b - a
    return None


def words(required=True):
    p = os.path.join(proj, "build", "words.aligned.json")
    if not os.path.isfile(p):
        if required:
            sys.exit(f"signature_plan.py: {p} not found (run realign.py first)")
        return []
    wa = json.load(open(p, encoding="utf-8"))
    return [(w["word"].strip(), w["start"], w.get("end", w["start"])) for s in wa["segments"] for w in s.get("words", [])]


bare = lambda w: "".join(c for c in w.lower() if c.isalnum() or c == "'")
heroes = {bare(h) for h in plan.get("heroes", [])}
in_take = lambda t: any(a <= t <= b for a, b in takes)
under_cut = lambda t: any(c["at"] - 0.05 <= t <= c["to"] for c in plan["cuts"])

if mode == "reel":
    if plan.get("base"):
        r = json.load(open(X(plan["base"]), encoding="utf-8"))
    else:
        r = {"style": "premium-signature", "source": "assets/talk.mp4", "face": "build/face.json", "fps": 30}
        aligned = os.path.isfile(os.path.join(proj, "build", "words.aligned.json"))
        r["words"] = "build/words.aligned.json" if aligned else "build/words.whisper.json"
    r["title"] = plan.get("title", r.get("title"))
    r["takes"] = [{"a": a, "b": b} for a, b in takes]
    cap = r.setdefault("captions", {})
    # one type system: every hero word is the serif italic, and a phrase without a hero word gets no hero (never a
    # filler word like "of" or "really" blown up in sans)
    cap["heroes"] = plan.get("heroes", [])
    cap["serif"] = plan.get("serif", plan.get("heroes", [])) if plan.get("serifAll") is False else plan.get("heroes", [])
    cap["heroFallback"] = "none"
    cap.setdefault("smallSize", 60)                      # small lines read at >= 48 px cap height on a phone
    cap["fixes"] = {**cap.get("fixes", {}), **plan.get("fixes", {})}
    snaps, k = [], 0
    wl = words(required=False)
    if not wl and heroes:
        print("signature_plan: build/words.aligned.json not found, so no hero-word zoom snaps (take starts only)", file=sys.stderr)
    hero_ts = [s for w, s, _ in wl if bare(w) in heroes and in_take(s)]
    for a, _ in takes:
        snaps.append([a, 1.0])
    for t in hero_ts:
        if not under_cut(t):
            snaps.append([round(t, 2), (1.18, 1.1, 1.28)[k % 3]]); k += 1
    r["zoom"] = {"snaps": sorted(snaps)}
    beats = []
    for c in plan["cuts"]:
        b = {"type": "scene", "kind": "image", "src": c["src"], "at": c["at"], "to": c["to"], "captions": True,
             "zoom": c.get("zoom", [1.0, 1.04]), "grade": c.get("grade", GRADE), "pos": c.get("pos", "50% 50%")}
        if c["src"].endswith(".mp4"):
            b["media"] = c.get("media", 0.3)
        beats.append(b)
    for a, _ in takes[1:]:
        beats.append({"type": "leak", "at": a, "to": round(a + 0.3, 2)})
    if plan.get("payoff"):
        beats.append({"type": "mood", "at": round(plan["payoff"] - 1.2, 2), "to": round(plan["payoff"] + 0.6, 2)})
    r["beats"] = beats
    r.pop("music", None)
    os.makedirs(proj, exist_ok=True)
    with open(os.path.join(proj, "reel.json"), "w", encoding="utf-8") as fh:
        json.dump(r, fh, indent=1)
    print(f"reel: {len(takes)} takes, {len(plan['cuts'])} cuts, {len(snaps)} zoom snaps -> {os.path.join(proj, 'reel.json')}")
    sys.exit()

if len(sys.argv) < 4:
    sys.exit("signature_plan.py score plan.json video.mp4 [--pack DIR]")
video = os.path.abspath(sys.argv[3])
PACK = (sys.argv[sys.argv.index("--pack") + 1] if "--pack" in sys.argv else None) or plan.get("pack") or os.environ.get("PHANTASIC_SFX_PACK")
if not PACK:
    sys.exit("signature_plan.py score: no sound pack. Pass --pack DIR, set plan.pack or PHANTASIC_SFX_PACK (the premium pack is not shipped).")
PACK = X(PACK)
r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                   capture_output=True, text=True, encoding="utf-8", errors="replace")
try:
    dur = float(r.stdout)
except ValueError:
    sys.exit(f"signature_plan.py: ffprobe could not read {video}: {r.stderr.strip()[-200:]}")
F = lambda n: os.path.join(PACK, n + ".wav")
cues = [{"src": F("s-felt-thud"), "t": 0.02, "db": -16, "verb": 0.2}]
beds, env = [], [[0, 0]]
flips = 0
for c in plan["cuts"]:
    t0, t1 = out_t(c["at"]), out_t(min(c["to"], max(b for _, b in takes)))
    if t0 is None or t1 is None:
        continue
    if c["to"] - c["at"] < 0.6:                          # montage card
        cues.append({"src": F("s-card-flip"), "t": round(t0, 3), "db": -6 if flips == 0 else -9}); flips += 1
        continue
    flips = 0
    cues.append({"src": F("s-airy-whoosh"), "t": round(t0, 3), "db": -12, "align": "peak"})
    if c.get("amb") in AMB and os.path.exists(F(AMB[c["amb"]][0])):
        n, d = AMB[c["amb"]]
        beds.append({"src": F(n), "t": round(t0, 3), "to": round(t1, 3), "db": d, "fade": 0.25})
    env += [[round(t0 - 0.1, 3), 0], [round(t0 + 0.05, 3), 3], [round(t1 - 0.05, 3), 3], [round(t1 + 0.1, 3), 0]]
last = -9
for w, s, _ in words():
    o = out_t(s)
    if o is None or bare(w) not in heroes or under_cut(s) or o - last < 1.5:
        continue
    last = o
    cues.append({"src": F("s-airy-whoosh"), "t": round(o, 3), "db": -24, "align": "peak", "fade": 0.2})
P = out_t(plan["payoff"]) if plan.get("payoff") else None
if P is not None:
    cues += [{"src": F("s-reverse-cymbal"), "t": round(P - 0.48, 3), "db": -19, "align": "peak", "fade": 0.03},
             {"src": F("s-shimmer"), "t": round(P, 3), "db": -12, "verb": 0.5, "fade": 0.8},
             {"src": F("s-felt-thud"), "t": round(P, 3), "db": -12, "verb": 0.3}]
    env = [e for e in env if e[0] < P - 1.4] + [[round(P - 1.4, 3), 0], [round(P - 1.3, 3), -9], [round(P - 0.05, 3), -9],
                                                 [round(P, 3), -6], [round(dur, 3), -6]]
src = os.path.join(proj, "assets", "talk.mp4")
cfg = {"video": video, "out": video.replace(".mp4", "-scored.mp4"),
       "voice": {"src": src, "takes": [list(t) for t in takes]},
       "beds": beds, "cues": cues, "verb": {"seconds": 2.2, "db": -6}, "fx_duck_db": 10}
if plan.get("music"):
    cfg["music"] = {"src": os.path.abspath(X(plan["music"])), "start": 0, "db": -14, "duck_db": 7, "env": sorted(env), "fade_out": 1.2}
os.makedirs(os.path.join(proj, "build"), exist_ok=True)
out = os.path.join(proj, "build", "cues.json")
with open(out, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, indent=1)
print(f"score: {len(cues)} cues, {len(beds)} beds -> {out}")

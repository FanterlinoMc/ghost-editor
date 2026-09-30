"""Turn each clip's paper cutaways into vintage collage scenes (engraving + mixed type), written to reel-collage.json."""
import json
import struct
from pathlib import Path

# R1b port note: main's version hardcoded `~/phantasic/engine/core/library/engravings/png/` (its vendored
# engine copy); this fork keeps the engine at LIB, resolved relative to this script, like every other
# scripts/*.py here (see library_restore.py, audition.py).
HERE = Path(__file__).resolve().parent
LIB = HERE.parent / "library"

PICK = {  # (clip, scene start) -> engraving, paper
    ("c1", 2.1): ("brain", "grid"), ("c3", 1.82): ("moneybag", "grid"),
    ("c1", 10.02): ("robot", "grid"), ("c1", 31.66): ("gears", "plain"),
    ("c2", 3.68): ("gears", "grid"), ("c2", 34.78): ("lightbulb", "plain"), ("c2", 45.1): ("ladder", "grid"),
    ("c3", 8.2): ("magnifier", "plain"), ("c3", 17.86): ("hand", "grid"), ("c3", 28.74): ("chess", "plain"),
}
BASE = {"serif": 150, "box": 140, "dark": 160, "caps": 64}
LINE_H = {"serif": 0.9, "box": 1.25, "dark": 1.2, "caps": 1.2}


def png_size(key):
    with open(LIB / "engravings" / "png" / f"{key}.png", "rb") as f:
        f.read(16)
        return struct.unpack(">II", f.read(8))


def collage(b, img, paper):
    items, y, n = [], 300, 0
    lines = b["lines"]
    # a marker line spoken first opens the scene at the top; later marker lines go under the engraving
    lead = 1 if lines and lines[0].get("style") == "marker" else 0
    if lead:
        l = lines[0]
        items.append({"type": "text", "style": "marker", "text": l["text"], "x": 90, "y": y - 40, "size": 120, "rotate": -4, "at": l.get("at")})
        y += 110
    for l in (l for l in lines[lead:] if l.get("style") != "marker"):
        st, text = l.get("style", "serif"), l["text"]
        if st == "serif" and n % 2 and len(text) > 8:
            st = "caps"                                        # vary the type: every other long serif line goes tiny caps
        size = BASE[st] if len(text) <= 10 or st == "caps" else int(BASE[st] * 10 / len(text) * 1.2)
        items.append({"type": "text", "style": st, "text": text, "x": 80 + (n % 2) * 90, "y": y, "size": size, "at": l.get("at")})
        y += int(size * LINE_H[st] * (1.25 if st == "caps" else 1)) + 10
        n += 1
    marks = [l for l in lines[lead:] if l.get("style") == "marker"]
    bottom = 1400 if marks else 1560                          # the engraving stops above the handwriting
    iw, ih = png_size(img)
    w = int(min(860, (bottom - (y + 10)) * iw / ih))
    items.append({"type": "image", "src": img, "x": (1080 - w) // 2, "y": y + 10, "w": w, "at": round(b["lines"][0].get("at", b["at"]) + 0.25, 2)})
    my = bottom + 30
    for l in marks:
        size = 120 if len(l["text"]) <= 12 else 92
        items.append({"type": "text", "style": "marker", "text": l["text"], "x": 120, "y": my, "size": size, "rotate": -4, "at": l.get("at")})
        my += size
    for it in items:
        if it.get("at") is None:
            it.pop("at")
    return {"type": "scene", "kind": "collage", "at": b["at"], "to": b["to"], "paper": paper, "items": items}


# source of truth: <clip>/reel-src.json (paper pages). Writes the Alif version (clean paper + engraving) to
# <clip>/reel.json and the collage version (screen look) to <clip>-collage/reel.json.
# This is a one-off example-set generator, not general infra: it expects a `sf-patch` project (clips c1/c2/c3,
# each with a reel-src.json) that does not exist in this fork's D:/Projects/reels/ (TEAM.md's project root) -
# R1b did not bring it over, only the script. Point `root` at wherever that source data actually lives.
for clip in ("c1", "c2", "c3"):
    root = Path.home() / "reels/sf-patch"
    src = json.loads((root / clip / "reel-src.json").read_text())
    for screen, out in ((False, root / clip / "reel.json"), (True, root / f"{clip}-collage" / "reel.json")):
        reel = json.loads(json.dumps(src))
        reel["beats"] = [dict(collage(b, *PICK[(clip, b["at"])]), screen=screen) if b.get("kind") == "paper" else b for b in reel["beats"]]
        out.write_text(json.dumps(reel, indent=2))
    print(clip, sum(b.get("kind") == "paper" for b in src["beats"]), "pages, both versions written")

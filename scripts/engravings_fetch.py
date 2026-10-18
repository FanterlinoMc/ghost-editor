#!/usr/bin/env python3
"""Fetch public-domain vintage engravings from Wikimedia Commons for the collage scenes.

    python3 engravings_fetch.py [--per 4] [--only brain,clock]

Only files whose Commons licence is Public Domain or CC0 are kept. Each file is recorded in
library/engravings/manifest.json with its source page and licence. Curate afterwards with the contact sheet.

Ported from Ahmed's phantasic engine/core (origin/main). Fork notes: curl replaced by urllib (no external binary, UTF-8 JSON on Windows); ENGRAVINGS_DIR overrides the output
folder. Needs network access to commons.wikimedia.org; nothing else. No API key, no paid service.
"""
import argparse
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

LIB = Path(os.environ.get("ENGRAVINGS_DIR") or Path(__file__).resolve().parent.parent / "library" / "engravings")
API = "https://commons.wikimedia.org/w/api.php"
UA = "PhantasicEngravings/1.0 (https://phantasic.com)"

# concept -> Commons search (engraving/woodcut style, black line art on white)
CONCEPTS = {
    "brain": "brain engraving anatomy", "head": "phrenology head engraving", "eye": "eye anatomy engraving",
    "heart": "heart anatomy engraving", "hand": "hand engraving pointing", "handshake": "handshake engraving",
    "clock": "clock engraving antique", "hourglass": "hourglass engraving", "money": "coins engraving",
    "moneybag": "money bag engraving", "gears": "gears machine engraving", "lightbulb": "light bulb patent drawing",
    "key": "antique key engraving", "lock": "padlock engraving", "chess": "chess piece engraving",
    "crown": "crown engraving", "ladder": "ladder engraving", "compass": "compass engraving antique",
    "magnifier": "magnifying glass engraving", "telescope": "telescope engraving", "globe": "globe engraving antique",
    "scales": "balance scale engraving", "anchor": "anchor engraving", "megaphone": "speaking trumpet engraving",
    "telephone": "telephone patent drawing", "typewriter": "typewriter engraving", "rocket": "rocket patent drawing",
    "factory": "factory engraving 19th century", "robot": "automaton engraving", "trophy": "trophy cup engraving",
    "target": "archery target engraving", "arrow": "arrow engraving", "mountain": "mountain engraving",
    "horse": "horse engraving", "lion": "lion engraving", "ship": "sailing ship engraving",
    "skull": "skull engraving anatomy", "man": "businessman engraving 19th century", "crowd": "crowd engraving",
    "mail": "envelope letter engraving", "book": "open book engraving", "pen": "quill pen engraving",
    "fire": "fire flames engraving", "lightning": "lightning engraving", "seed": "plant seedling engraving",
    "tree": "oak tree engraving", "bridge": "bridge engraving", "road": "road engraving landscape",
    "maze": "labyrinth engraving", "rope": "rope knot engraving", "chain": "chain engraving",
    "dice": "dice engraving", "cards": "playing cards engraving", "glasses": "spectacles engraving",
}
OK_LICENCE = re.compile(r"public domain|^pd|cc0", re.I)


def get(url: str):
    """GET with our User-Agent; None on any network / HTTP error. (Ahmed shelled out to curl and decoded with the locale
    codec, which breaks on a Windows cp1252 console; urllib needs no external binary and the JSON is read as UTF-8.)"""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
            return r.read()
    except OSError:
        return None


def api(params: dict) -> dict:
    out = get(API + "?" + urllib.parse.urlencode({**params, "format": "json"}))
    return json.loads(out.decode("utf-8")) if out else {}


def search(query: str, n: int) -> list:
    data = api({"action": "query", "generator": "search", "gsrsearch": f"{query} filetype:bitmap", "gsrnamespace": 6,
                "gsrlimit": n * 4, "prop": "imageinfo", "iiprop": "url|extmetadata|size|mime", "iiurlwidth": 1200})
    pages = sorted((data.get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 99))
    found = []
    for p in pages:
        ii = (p.get("imageinfo") or [{}])[0]
        meta = ii.get("extmetadata", {})
        licence = meta.get("LicenseShortName", {}).get("value", "")
        if not OK_LICENCE.search(licence) or ii.get("mime") not in ("image/jpeg", "image/png", "image/tiff"):
            continue
        if min(ii.get("width", 0), ii.get("height", 0)) < 500:
            continue
        found.append({"title": p["title"], "url": ii.get("thumburl") or ii["url"], "page": ii.get("descriptionurl"), "licence": licence})
        if len(found) >= n:
            break
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per", type=int, default=4)
    ap.add_argument("--only")
    args = ap.parse_args()
    LIB.mkdir(parents=True, exist_ok=True)
    mf = LIB / "manifest.json"
    manifest = json.loads(mf.read_text(encoding="utf-8")) if mf.exists() else {}
    concepts = {k: v for k, v in CONCEPTS.items() if not args.only or k in args.only.split(",")}
    for concept, query in concepts.items():
        for i, hit in enumerate(search(query, args.per)):
            key = f"{concept}-{i + 1}"
            raw = LIB / "raw" / f"{key}.img"
            raw.parent.mkdir(exist_ok=True)
            data = get(hit["url"])
            if not data:
                continue
            raw.write_bytes(data)
            manifest[key] = {"concept": concept, "raw": str(raw.relative_to(LIB)), **hit}
            print(f"{key:<16} {hit['licence']:<22} {hit['title'][:70]}")
    mf.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()

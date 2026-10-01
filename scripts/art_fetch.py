#!/usr/bin/env python3
"""Build library/art: public-domain (CC0) paintings from The Met Open Access API, tagged by concept.

Pop-up cards and card pages show a classic painting for an idea (time -> a clock, money -> coins), the way
the engravings do for collage pages. Every file is CC0 (isPublicDomain true), so it can ship in the product.

    art_fetch.py               fetch every concept (skips files already there)
    art_fetch.py --per 4       paintings per concept
"""
import argparse, json, time, urllib.parse, urllib.request
from pathlib import Path

LIB = Path(__file__).resolve().parent.parent / "library" / "art"
API = "https://collectionapi.metmuseum.org/public/collection/v1"
CONCEPTS = {
    "time": ["clock", "hourglass", "pocket watch"],
    "money": ["money changer", "gold coins", "banker"],
    "growth": ["harvest", "wheat field", "orchard"],
    "work": ["scholar", "writing desk", "workshop"],
    "thinking": ["philosopher", "contemplation", "reading"],
    "team": ["group portrait", "family group", "musicians"],
    "target": ["archery", "archer", "hunt"],
    "speed": ["horse race", "racehorse", "galloping"],
    "build": ["construction", "carpenter", "bridge"],
    "numbers": ["astronomer", "mathematician", "geographer"],
    "message": ["letter", "messenger", "reading a letter"],
    "success": ["triumph", "coronation", "victory"],
    "taste": ["still life flowers", "sunflowers", "bouquet"],
    "portrait": ["portrait of a woman", "portrait of a man", "self-portrait"],
    "city": ["city view", "harbor", "street scene"],
    "calm": ["seascape", "moonlight", "lake"],
}


def get(url):
    for k in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "phantasic-art-fetch/1.0"}), timeout=30) as r:
                return r.read()
        except Exception:
            time.sleep(1.5 * (k + 1))
    return None


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--per", type=int, default=4); a = ap.parse_args()
    LIB.mkdir(parents=True, exist_ok=True)
    mf = LIB / "manifest.json"
    man = json.loads(mf.read_text()) if mf.exists() else {}
    used = {v["objectID"] for v in man.values()}
    for concept, queries in CONCEPTS.items():
        have = [k for k in man if k.startswith(concept + "-")]
        n = len(have)
        for q in queries:
            if n >= a.per: break
            s = get(f"{API}/search?hasImages=true&isPublicDomain=true&medium=Paintings&q={urllib.parse.quote(q)}")
            ids = (json.loads(s) or {}).get("objectIDs") or [] if s else []
            for oid in ids[:25]:
                if n >= a.per: break
                if oid in used: continue
                o = get(f"{API}/objects/{oid}")
                if not o: continue
                o = json.loads(o)
                img = o.get("primaryImageSmall") or o.get("primaryImage")
                if not (o.get("isPublicDomain") and img and o.get("classification") == "Paintings"): continue
                data = get(img)
                if not data or len(data) < 20000: continue
                key = f"{concept}-{n + 1}"
                (LIB / f"{key}.jpg").write_bytes(data)
                man[key] = {"concept": concept, "query": q, "objectID": oid, "title": o.get("title"), "artist": o.get("artistDisplayName"),
                            "date": o.get("objectDate"), "license": "CC0 (The Met Open Access)", "source": o.get("objectURL")}
                used.add(oid); n += 1
                print(f"{key:12s} {o.get('title', '')[:50]} ({o.get('artistDisplayName') or 'unknown'})")
                mf.write_text(json.dumps(man, indent=1))
    print(f"{len(man)} paintings in {LIB}")


if __name__ == "__main__":
    main()

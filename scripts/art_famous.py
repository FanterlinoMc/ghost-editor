#!/usr/bin/env python3
"""Famous public-domain paintings for pop-up cards, each mapped to the idea it says best.

Recognisable art lands harder than an unknown museum piece (the reference uses the Mona Lisa, Sunflowers,
the Creation of Adam). Images come from Wikidata (P18) / Wikimedia Commons; every work here was painted
before 1900 and its artist died 70+ years ago, so the work is public domain, and faithful photos of 2D
public-domain art are public domain in the US. Files go to library/art/<key>.jpg next to the Met ones.
"""
import json, time, urllib.parse, urllib.request
from pathlib import Path

LIB = Path(__file__).resolve().parent.parent / "library" / "art"
UA = {"User-Agent": "phantasic-art-famous/1.0 (template asset library)"}
# key: (search title, artist surname to confirm the match, concepts)
FAMOUS = {
    "mona-lisa": ("Mona Lisa", "Leonardo", ["taste", "portrait", "art", "classic"]),
    "sunflowers": ("Sunflowers", "Gogh", ["taste", "art", "creativity"]),
    "creation-of-adam": ("The Creation of Adam", "Michelangelo", ["idea", "creativity", "connection", "ai"]),
    "starry-night": ("The Starry Night", "Gogh", ["vision", "dream", "night"]),
    "great-wave": ("The Great Wave off Kanagawa", "Hokusai", ["pressure", "wave", "risk", "scale"]),
    "rain-steam-speed": ("Rain, Steam and Speed", "Turner", ["speed", "fast", "momentum"]),
    "moneylender": ("The Moneylender and His Wife", "Massys", ["money", "cost", "price", "finance"]),
    "night-watch": ("The Night Watch", "Rembrandt", ["team", "company", "people"]),
    "school-of-athens": ("The School of Athens", "Raphael", ["learning", "knowledge", "mentor", "community"]),
    "wanderer": ("Wanderer above the Sea of Fog", "Friedrich", ["vision", "strategy", "goal", "leader"]),
    "the-scream": ("The Scream", "Munch", ["stress", "problem", "pain", "overwhelm"]),
    "astronomer": ("The Astronomer", "Vermeer", ["data", "numbers", "analysis", "research"]),
    "girl-pearl": ("Girl with a Pearl Earring", "Vermeer", ["attention", "portrait", "focus"]),
    "woman-letter": ("Woman Reading a Letter", "Vermeer", ["message", "email", "reading"]),
    "gleaners": ("The Gleaners", "Millet", ["work", "manual", "repetitive", "labour"]),
    "stone-breakers": ("The Stone Breakers", "Courbet", ["work", "grind", "manual", "hard"]),
    "harvesters": ("The Harvesters", "Bruegel", ["growth", "results", "harvest"]),
    "liberty": ("Liberty Leading the People", "Delacroix", ["win", "leadership", "victory"]),
    "raft-medusa": ("The Raft of the Medusa", "Géricault", ["crisis", "failure", "survival"]),
    "card-players": ("The Card Players", "Cézanne", ["strategy", "decision", "game"]),
    "aristotle": ("Aristotle with a Bust of Homer", "Rembrandt", ["thinking", "wisdom", "expert"]),
    "vanitas": ("Vanitas Still Life", "Claesz", ["time", "deadline", "mortality"]),
    "persistence-clock": ("The Ambassadors", "Holbein", ["business", "deal", "partners"]),
    "water-lilies": ("Water Lilies", "Monet", ["calm", "clarity", "peace"]),
    "birth-of-venus": ("The Birth of Venus", "Botticelli", ["launch", "new", "beauty"]),
}


def get(url):
    for k in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return r.read()
        except Exception:
            time.sleep(2 * (k + 1))
    return None


def main():
    LIB.mkdir(parents=True, exist_ok=True)
    mf = LIB / "manifest.json"
    man = json.loads(mf.read_text()) if mf.exists() else {}
    for key, (title, artist, concepts) in FAMOUS.items():
        if key in man: continue
        s = get("https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=8&search=" + urllib.parse.quote(title))
        hits = json.loads(s).get("search", []) if s else []
        done = False
        for h in hits:
            desc = (h.get("description") or "").lower()
            if "painting" not in desc and "fresco" not in desc and "print" not in desc and "woodblock" not in desc: continue
            if artist.lower()[:5] not in desc.lower() and artist.lower()[:5] not in (h.get("label") or "").lower(): continue
            e = get(f"https://www.wikidata.org/wiki/Special:EntityData/{h['id']}.json")
            if not e: continue
            claims = json.loads(e)["entities"][h["id"]]["claims"]
            if "P18" not in claims: continue
            fname = claims["P18"][0]["mainsnak"]["datavalue"]["value"]
            info = get("https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1000&titles=" + urllib.parse.quote("File:" + fname))
            pages = json.loads(info)["query"]["pages"] if info else {}
            ii = next(iter(pages.values())).get("imageinfo", [{}])[0]
            url = ii.get("thumburl") or ii.get("url")
            lic = ((ii.get("extmetadata") or {}).get("LicenseShortName") or {}).get("value", "")
            if not url: continue
            data = get(url)
            if not data or len(data) < 20000: continue
            (LIB / f"{key}.jpg").write_bytes(data)
            man[key] = {"concept": concepts[0], "concepts": concepts, "title": h.get("label"), "artist": artist, "wikidata": h["id"],
                        "file": fname, "license": f"public domain ({lic or 'PD-art'})", "source": f"https://commons.wikimedia.org/wiki/File:{urllib.parse.quote(fname)}", "famous": True}
            mf.write_text(json.dumps(man, indent=1))
            print(f"{key:18s} {h.get('label')} - {h.get('description')} [{lic}]")
            done = True
            break
        if not done: print(f"{key:18s} NOT FOUND ({title})")
        time.sleep(0.5)


if __name__ == "__main__":
    main()

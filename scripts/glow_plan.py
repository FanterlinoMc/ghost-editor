#!/usr/bin/env python3
"""Podcast Glow planner (style podcast-glow, studied from @kayzee.edits): writes the headline beats into reel.json.

    glow_plan.py <project> [--dry] [--every 5.0]

  - hook: the first sentence (<= 9 words) as a question/title at the TOP ("WHY DO YOU" / "PROCRASTINATE?"); with
    glow.hookGround true and a matte already on the reel it also writes a dark grid ground under it (otherwise build.mjs
    adds that same ground, and the matte, from glow.hookGround itself)
  - headlines: about every `every` seconds the strongest word of a sentence slams in HUGE and yellow under the 1-3 words
    said before it in white ("WE HAVE" / "NO IDEA"); a negation/quantifier rides with its word ("NO DICTIONARY")
  - positions alternate low / top-left; every other low headline gets a hand-drawn arrow
  Everything on screen is spoken. Captions (one word at a time) hide while a headline is up.
"""
import json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from mono_plan import load_words, bare, score, show


def sentences(ws):
    """Words grouped into sentences: a break after . ? ! or a pause over 0.6 s (same rule as Ahmed's breakdown_plan.sentences,
    inlined here because the fork does not carry breakdown_plan.py)."""
    out, cur = [], []
    for i, w in enumerate(ws):
        cur.append(w)
        nxt = ws[i + 1] if i + 1 < len(ws) else None
        if nxt is None or re.search(r"[.?!]$", w["word"]) or nxt["start"] - w["end"] > 0.6:
            out.append(cur)
            cur = []
    return out

STRONG = {"dying", "dead", "die", "extinct", "never", "nobody", "everything", "nothing", "fail", "failing", "lose", "losing", "free",
          "million", "billion", "secret", "truth", "wrong", "mistake", "fear", "scary", "alone", "money", "rich", "broke", "love"}
LEAD = {"no", "not", "never", "less", "more", "zero", "every", "all", "most", "own", "real", "true"}


def r3(x):
    return round(x, 3)


def headline(snt, after=0.0):
    """(small words, big words) inside one sentence, or None."""
    sc = lambda i: score(snt[i]) + (2 if i == len(snt) - 1 else 0) + (6 if bare(snt[i]["word"]) in STRONG else 0)
    cands = [i for i, w in enumerate(snt) if sc(i) >= 6 and w["start"] >= after]
    if not cands:
        return None
    k = max(cands, key=sc)
    b0 = k - 1 if k > 0 and bare(snt[k - 1]["word"]) in LEAD else k
    big = snt[b0:k + 1]
    small = snt[max(0, b0 - 3):b0]
    # never start the small line on a cut-off word mid-phrase
    while small and not small[0]["word"][0].isalnum():
        small = small[1:]
    return small, big


def plan(proj, every=4.5):
    spec = json.loads((proj / "reel.json").read_text())
    style = json.loads((Path(__file__).parent.parent / "styles" / f"{spec.get('style', '')}.json").read_text()) if spec.get("style") else {}
    matte = spec.get("matte", style.get("matte"))
    ws, takes = load_words(proj, spec)
    ss = sentences(ws)
    beats = [b for b in spec.get("beats", []) if not b.get("_glow")]
    out, last_t, pos_i = [], -99.0, 0
    # hook at the top
    first = ss[0]
    hook = None
    if len(first) <= 9 and first[0]["take"] == first[-1]["take"]:
        k = max(range(len(first)), key=lambda i: score(first[i]) + (3 if i == len(first) - 1 else 0))
        big, small = first[k:], first[:k]
        if len(big) > 2:
            big, small = first[k:k + 1], first[:k]
        hook = (small[-4:], big)
    elif first[0]["take"] == first[-1]["take"]:
        # a long opening sentence: its strongest phrase becomes the title (the words before it stay in the captions)
        h = headline(first)
        if h and h[1][0]["start"] - first[0]["start"] < 4.0:
            hook = h
    if hook:
        small, big = hook
        first = (small or big)[:1] + [w for w in first if w["start"] > (small or big)[0]["start"]]
        t0 = max(takes[big[0]["take"]]["a"], (small or big)[0]["start"] - 0.05)
        t1 = min(max(big[-1]["end"] + 0.6, big[0]["start"] + 1.2), takes[big[-1]["take"]]["b"])
        hb = {"_glow": True, "type": "headline", "pos": "top", "small": " ".join(show(w["word"]) for w in small).strip(",;:"),
              "big": " ".join(show(w["word"]) for w in big).rstrip(",.;:"), "smallAt": [r3(w["start"]) for w in small],
              "bigAt": r3(big[0]["start"]), "at": r3(t0), "to": r3(t1)}
        out.append(hb)
        if matte and spec.get("glow", style.get("glow", {})).get("hookGround", False):
            out.append({"_glow": True, "type": "ground", "at": r3(t0), "to": r3(t1), "gradient": ["#141414", "#050505"], "paper": "grid",
                        "gridColor": "rgba(255,255,255,.09)", "gridSize": 64, "grain": False})
        last_t = big[-1]["end"]
    for s in ss[1:] if out else ss:
        if s[0]["start"] - last_t < every * 0.8 or s[0]["take"] != s[-1]["take"]:
            continue
        h = headline(s)
        if not h:
            continue
        small, big = h
        t0 = (small[0]["start"] if small else big[0]["start"]) - 0.04
        end_take = takes[big[-1]["take"]]["b"]
        nxt = next((w["start"] for w in ws if w["start"] > big[-1]["end"] + 0.05), 1e9)
        t1 = min(max(big[-1]["end"] + 0.45, big[0]["start"] + 1.0), end_take, max(nxt + 0.6, big[-1]["end"] + 0.3))
        left = pos_i % 2 == 1
        hb = {"_glow": True, "type": "headline", "pos": "left" if left else "low",
              "small": " ".join(show(w["word"]) for w in small).strip(",;:"), "big": " ".join(show(w["word"]) for w in big).rstrip(",.;:!?"),
              "smallAt": [r3(w["start"]) for w in small], "bigAt": r3(big[0]["start"]), "at": r3(t0), "to": r3(t1)}
        if not left and (pos_i // 2) % 2 == 0:
            hb["arrow"] = "left" if (pos_i // 2) % 4 == 0 else "right"
        out.append(hb)
        pos_i += 1
        last_t = big[-1]["end"]
    spec["beats"] = sorted(beats + out, key=lambda b: (b["at"], b["type"] != "ground"))
    return spec, out


def main():
    argv = sys.argv[1:]
    every = 4.5
    if "--every" in argv:
        i = argv.index("--every"); every = float(argv[i + 1]); del argv[i:i + 2]
    a = [x for x in argv if not x.startswith("--")]
    proj = Path(a[0]).resolve()
    spec, out = plan(proj, every)
    for b in out:
        if b["type"] == "headline":
            print(f'{b["at"]:>7}  {b["pos"]:<5} {b.get("small",""):>26} / {b["big"]}{"  (arrow)" if b.get("arrow") else ""}')
    if "--dry" not in sys.argv:
        (proj / "reel.json").write_text(json.dumps(spec, indent=1))
        print(f"wrote {sum(b['type'] == 'headline' for b in out)} headlines -> {proj / 'reel.json'}")


if __name__ == "__main__":
    main()

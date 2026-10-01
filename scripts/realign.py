#!/usr/bin/env python3
"""Pin Whisper word times to the silence-cut pieces (build/islands.json).

Whole-file Whisper stamps drift up to ~1.5 s; piece bounds come from the audio and are exact.
Each word is matched to its piece via the piece's own transcript ("heard"), then the piece's words
are rescaled into [a, b]. Word text is untouched, so caption fixes and page lines still match.

    realign.py <project>            writes build/words.whisper.json (original kept as build/words.orig.json)
                                    and build/retime.json (old -> new start per word)
"""
import difflib, json, re, shutil, sys
from pathlib import Path


def norm(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def main():
    P = Path(sys.argv[1]); B = P / "build"
    orig = B / "words.orig.json"
    if not orig.exists(): shutil.copy(B / "words.whisper.json", orig)
    data = json.load(open(orig))
    words = [dict(x) for s in data["segments"] for x in s.get("words", [])]
    pieces = [p for p in json.load(open(B / "islands.json")) if (p.get("heard") or p.get("text") or "").strip()]

    ptoks, powner = [], []
    for p in pieces:
        for t in (p.get("heard") or p["text"]).split():
            if norm(t): ptoks.append(norm(t)); powner.append(p["id"])
    wt = [norm(w["word"]) for w in words]
    owner = [None] * len(words)
    sm = difflib.SequenceMatcher(None, wt, ptoks, autojunk=False)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size): owner[blk.a + k] = powner[blk.b + k]
    for op, i1, i2, j1, j2 in sm.get_opcodes():          # a replaced run (misheard word) takes its piece from the other side
        if op == "replace":
            for k, i in enumerate(range(i1, i2)): owner[i] = powner[min(j1 + k, j2 - 1)]

    # a word whose owner is still unknown sits between its neighbours' pieces
    byid = {p["id"]: p for p in pieces}
    for i in range(len(words)):
        if owner[i] is None:
            prev = next((owner[j] for j in range(i - 1, -1, -1) if owner[j] is not None), None)
            nxt = next((owner[j] for j in range(i + 1, len(words)) if owner[j] is not None), None)
            owner[i] = prev if prev is not None else nxt
    # owners must never go backwards in time
    for i in range(1, len(words)):
        if owner[i] is not None and owner[i - 1] is not None and byid[owner[i]]["a"] < byid[owner[i - 1]]["a"]: owner[i] = owner[i - 1]

    new = [dict(w) for w in words]; moves = []
    for pid in dict.fromkeys(o for o in owner if o is not None):
        p = byid[pid]; idx = [i for i in range(len(words)) if owner[i] == pid]
        s0 = words[idx[0]]["start"]; s1 = max(words[idx[-1]]["end"], s0 + 0.05)
        a, b = p["a"] + 0.03, max(p["b"] - 0.05, p["a"] + 0.1)
        f = lambda t: a + (t - s0) / (s1 - s0) * (b - a)
        for i in idx:
            new[i]["start"] = round(f(words[i]["start"]), 3); new[i]["end"] = round(max(f(words[i]["end"]), new[i]["start"] + 0.04), 3)
    for i in range(len(words)): moves.append([words[i]["start"], new[i]["start"], norm(words[i]["word"])])

    out = {"text": data.get("text", ""), "segments": [{"start": new[0]["start"] if new else 0, "end": new[-1]["end"] if new else 0, "text": "", "words": new}]}
    json.dump(out, open(B / "words.whisper.json", "w"), indent=1)
    json.dump(moves, open(B / "retime.json", "w"))
    d = sorted(abs(n - o) for o, n, _ in moves)
    print(f"{P.name}: {len(words)} words, median shift {d[len(d)//2]:.2f}s, max {d[-1]:.2f}s" if d else f"{P.name}: no words")


if __name__ == "__main__":
    main()

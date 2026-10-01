#!/usr/bin/env python3
"""Clean cut for a raw talking-head recording: pauses tightened, restarts and fillers removed, only at real pauses.

    smartcut.py <project>  [--noise -35] [--min 0.28] [--keep 0.12]   -> prints JSON {takes, removed, kept_text}

Whisper's word times drift (a word can be stamped half a second off), so every cut is snapped to a silence found in
the AUDIO. A speech island (sound between two pauses) is either kept whole or dropped whole:
- a restart: an island whose opening words are said again in one of the next islands (the abandoned attempt goes);
- a filler island: only um / uh / er / hmm;
- dead air before the first and after the last real sentence.
"""
import argparse, json, re, subprocess, sys
from pathlib import Path

FILLER = re.compile(r"^(um+|uh+|erm+|er|hmm+|mm+)$")


def silences(src, noise, mn):
    """Silences from the audio itself. The threshold adapts to the recording: prep levels the voice to -16 LUFS,
    which lifts the room noise too, so a fixed -35 dB misses most pauses (measured -31 dBFS in a real pause)."""
    import numpy as np, soundfile as sf, tempfile, os
    tmp = tempfile.mktemp(suffix=".wav")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", tmp], check=True)
    y, sr = sf.read(tmp); os.remove(tmp)
    hop = int(sr * 0.02)
    db = np.array([20 * np.log10(np.sqrt((y[i:i + hop] ** 2).mean()) + 1e-9) for i in range(0, len(y) - hop, hop)])
    floor, speech = np.percentile(db, 8), np.percentile(db, 80)
    thr = noise if noise is not None else floor + 0.32 * (speech - floor)
    quiet = db < thr
    out, k = [], 0
    while k < len(quiet):
        if quiet[k]:
            j = k
            while j < len(quiet) and quiet[j]: j += 1
            if (j - k) * 0.02 >= mn: out.append((k * 0.02, j * 0.02))
            k = j
        else: k += 1
    return out, len(y) / sr


def norm(w):
    return re.sub(r"[^a-z0-9']", "", w.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project", type=Path)
    ap.add_argument("--noise", type=float, default=None, help="fixed silence threshold in dBFS (default: adaptive)")
    ap.add_argument("--min", type=float, default=0.22)
    ap.add_argument("--keep", type=float, default=0.12)
    ap.add_argument("--islands", action="store_true", help="write build/islands.json (numbered speech pieces)")
    ap.add_argument("--drop", help="comma-separated piece ids to remove (overrides the automatic choice)")
    a = ap.parse_args()
    src = a.project / "assets" / "talk.mp4"
    sil, dur = silences(src, a.noise, a.min)
    # speech islands = the gaps between silences
    edges, cur = [], 0.0
    for s, e in sil:
        if s - cur > 0.08: edges.append([cur, s])
        cur = e
    if dur - cur > 0.08: edges.append([cur, dur])
    wj = json.loads((a.project / "build" / "words.whisper.json").read_text())
    words = [{"w": x["word"].strip(), "a": x["start"], "b": x["end"]} for s in wj["segments"] for x in s.get("words", [])]
    # each word belongs to the island its middle falls in (or the nearest)
    isl = [{"a": s, "b": e, "words": []} for s, e in edges]
    for w in words:
        mid = (w["a"] + w["b"]) / 2
        best = min(isl, key=lambda i: 0 if i["a"] <= mid <= i["b"] else min(abs(mid - i["a"]), abs(mid - i["b"]))) if isl else None
        if best: best["words"].append(w)
    isl = [i for i in isl if i["words"]]
    removed = []
    toks = [[norm(w["w"]) for w in i["words"]] for i in isl]
    drop = set()
    for k, i in enumerate(isl):
        t = [x for x in toks[k] if x]
        if t and all(FILLER.match(x) for x in t):
            drop.add(k); removed.append({"why": "filler", "text": " ".join(w["w"] for w in i["words"]), "at": round(i["a"], 2)}); continue
        # restart: this island's first 2-3 words are said again at the start of (or early in) one of the next 2 islands
        head = [x for x in t if x][:3]
        if len(head) < 2: continue
        for j in (k + 1, k + 2):
            if j >= len(isl) or isl[j]["a"] - i["b"] > 2.5: break
            nxt = [x for x in toks[j] if x][:8]
            n = 3 if len(head) >= 3 else 2
            if any(nxt[m:m + n] == head[:n] for m in range(0, max(1, len(nxt) - n + 1))):
                # the later island repeats the attempt: drop this island (and any island in between)
                for q in range(k, j):
                    if q not in drop:
                        drop.add(q); removed.append({"why": "restart", "text": " ".join(w["w"] for w in isl[q]["words"]), "at": round(isl[q]["a"], 2)})
                break
    # the director can override: --islands writes the numbered pieces; --drop removes chosen pieces (restarts that
    # are not word-for-word repeats need judgment: "tell it to give you... basically, | you questions")
    if a.islands:
        (a.project / "build" / "islands.json").write_text(json.dumps([{"id": k, "a": round(i["a"], 2), "b": round(i["b"], 2),
            "text": " ".join(w["w"] for w in i["words"]), "auto_drop": k in drop} for k, i in enumerate(isl)], indent=1))
    if a.drop is not None:
        drop = set(int(x) for x in a.drop.split(",") if x.strip() != "")
        saved = a.project / "build" / "islands.json"
        if saved.exists() and not a.islands:
            # piece ids are the director's: always cut from the saved pieces, never from a renumbered recount
            isl = [{"a": p["a"], "b": p["b"], "words": [{"w": t} for t in (p.get("heard") or p["text"]).split()]} for p in json.loads(saved.read_text())]
            isl = [dict(i, id=p["id"]) for i, p in zip(isl, json.loads(saved.read_text()))]
            keep = [i for i in isl if i["id"] not in drop]
    if a.drop is None or not (a.project / "build" / "islands.json").exists() or a.islands:
        keep = [i for k, i in enumerate(isl) if k not in drop]
    takes = []
    for i in keep:
        s, e = max(0.0, i["a"] - a.keep), min(dur, i["b"] + a.keep)
        if takes and s - takes[-1]["b"] < 0.06: takes[-1]["b"] = round(e, 2)
        else: takes.append({"a": round(s, 2), "b": round(e, 2)})
    kept_text = " ".join(w["w"] for i in keep for w in i["words"])
    kept = sum(t["b"] - t["a"] for t in takes)
    print(json.dumps({"takes": takes, "removed": removed, "kept_text": kept_text, "kept_s": round(kept, 2), "raw_s": round(dur, 2)}))


if __name__ == "__main__":
    main()

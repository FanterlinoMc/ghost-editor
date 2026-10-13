#!/usr/bin/env python3
"""Run transcribe.py under both engines on the same sources and compare the result.

    compare_transcribers.py a.mp4 [b.mp4 ...] [--model turbo] [--lang en]
        [--stock-python PY] [--fw-python PY] [--keep DIR] [--json-out report.json]

Each engine is a separate transcribe.py process (so wall time includes model load, which is what
ingest pays: one process per source). Stock (--engine openai) runs under --stock-python (needs openai-whisper and
$WHISPER or whisper on PATH); faster-whisper runs under --fw-python (needs faster-whisper). They
may be the same interpreter if both packages are installed there.

Per source it prints: wall time for each, word-text agreement, and the distribution of start/end
differences (milliseconds, faster-whisper minus stock) on words matched between the two
transcripts. Words are matched by normalised text (lower case, letters and digits only) with a
sequence alignment, so an inserted or dropped word does not shift every later pairing.
"""
import argparse
import difflib
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TRANSCRIBE = os.path.join(HERE, "transcribe.py")


def norm(w):
    return re.sub(r"[^0-9a-z]", "", w.lower())


def words_of(data):
    out = []
    for s in data.get("segments", []):
        for w in s.get("words") or []:
            n = norm(w.get("word") or "")
            if n:
                out.append((n, w["start"], w["end"]))
    return out


def run_engine(py, engine, src, out, model, lang):
    env = dict(os.environ)
    cmd = [py, TRANSCRIBE, src, "--out", out, "--model", model, "--engine", engine]
    if lang:
        cmd += ["--lang", lang]
    t0 = time.perf_counter()
    subprocess.run(cmd, check=True, env=env, stdout=subprocess.DEVNULL)
    return time.perf_counter() - t0


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return float("nan")
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def compare(a_words, b_words):
    sm = difflib.SequenceMatcher(a=[w[0] for w in a_words], b=[w[0] for w in b_words], autojunk=False)
    ds, de = [], []
    matched = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                a, b = a_words[i1 + k], b_words[j1 + k]
                ds.append((b[1] - a[1]) * 1000)
                de.append((b[2] - a[2]) * 1000)
                matched += 1
    return matched, ds, de


def stats(xs):
    if not xs:
        return {"median_abs": None, "p95_abs": None, "max_abs": None, "bias": None}
    ab = [abs(x) for x in xs]
    return {"median_abs": statistics.median(ab), "p95_abs": pct(ab, 0.95), "max_abs": max(ab),
            "bias": statistics.median(xs)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+")
    ap.add_argument("--model", default="turbo")
    ap.add_argument("--lang", default=None)
    ap.add_argument("--stock-python", default=sys.executable)
    ap.add_argument("--fw-python", default=sys.executable)
    ap.add_argument("--keep", default=None, help="directory to keep both transcripts in")
    ap.add_argument("--json-out", default=None)
    ap.add_argument("--reuse", action="store_true",
                    help="use transcripts already in --keep instead of re-running that engine (time shown as n/a)")
    ap.add_argument("--skip-stock", action="store_true",
                    help="time faster-whisper only (stock on a long file can take hours on a small CPU)")
    a = ap.parse_args()

    keep = a.keep or tempfile.mkdtemp(prefix="cmp-transcribers-")
    os.makedirs(keep, exist_ok=True)
    rows = []
    for src in a.sources:
        name = os.path.splitext(os.path.basename(src))[0]
        so, fo = os.path.join(keep, name + ".stock.json"), os.path.join(keep, name + ".fw.json")
        t_stock = t_fw = None
        if not a.skip_stock and not (a.reuse and os.path.exists(so)):
            print(f"[{name}] stock ...", flush=True)
            t_stock = run_engine(a.stock_python, "openai", src, so, a.model, a.lang)
        if not (a.reuse and os.path.exists(fo)):
            print(f"[{name}] faster-whisper ...", flush=True)
            t_fw = run_engine(a.fw_python, "faster", src, fo, a.model, a.lang)
        if a.skip_stock:
            print(f"[{name}] faster-whisper only: {t_fw:.1f}s", flush=True)
            rows.append({"source": name, "stock_s": None, "fw_s": t_fw})
            continue
        sw, fw = words_of(json.load(open(so))), words_of(json.load(open(fo)))
        matched, ds, de = compare(sw, fw)
        denom = max(len(sw), len(fw)) or 1
        rows.append({"source": name, "stock_s": t_stock, "fw_s": t_fw, "speedup": (t_stock / t_fw) if t_stock and t_fw else None,
                     "stock_words": len(sw), "fw_words": len(fw), "matched": matched,
                     "agreement": matched / denom, "start": stats(ds), "end": stats(de)})

    f = lambda v: "  n/a" if v is None else f"{v:6.0f}"
    print(f"\n{'source':<22}{'stock s':>8}{'fw s':>8}{'x':>6}{'words':>12}{'agree':>8}"
          f"  | start ms: med  p95  max  bias | end ms: med  p95  max  bias")
    t = lambda v, w=8, d=1: " " * (w - 3) + "n/a" if v is None else f"{v:{w}.{d}f}"
    for r in rows:
        if "start" not in r:
            continue
        s, e = r["start"], r["end"]
        print(f"{r['source']:<22}{t(r['stock_s'])}{t(r['fw_s'])}{t(r['speedup'], 6, 2)}"
              f"{str(r['stock_words']) + '/' + str(r['fw_words']):>12}{r['agreement'] * 100:7.1f}%"
              f"  | {f(s['median_abs'])}{f(s['p95_abs'])}{f(s['max_abs'])}{f(s['bias'])}"
              f"  | {f(e['median_abs'])}{f(e['p95_abs'])}{f(e['max_abs'])}{f(e['bias'])}")
    print("(differences are |faster-whisper - stock| in ms; bias is the signed median)")
    print(f"transcripts kept in {keep}")
    if a.json_out:
        json.dump(rows, open(a.json_out, "w"), indent=2)


if __name__ == "__main__":
    main()

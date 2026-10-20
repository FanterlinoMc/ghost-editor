#!/usr/bin/env python3
"""Rebuild the memes the repo does not track (it keeps only their meta.json):
every meme from its meta.json source + args. Existing files are kept.

    library_restore.py [--memes-only]

Sound effects and music are NOT restored here, and nothing in this repo downloads them: they come
from a licensed pack restored by the deployment outside git (library/SOURCES.md); the manifests carry
no download URL, and scripts/no-mixkit-fetch.test.mjs fails if a download path comes back.

Meme clips are rips, not licensed media: the public edition (export_public.py) ships none, so a
public install does not run this at all.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "library")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--memes-only", action="store_true", help="the default now: memes are all this restores")
    a = ap.parse_args()
    print("skip sfx and music: not downloaded by this repo (see library/SOURCES.md)")
    bad = 0
    mdir = os.path.join(LIB, "memes")
    for d in sorted(os.listdir(mdir)):
        p = os.path.join(mdir, d, "meta.json")
        if not os.path.exists(p):
            continue
        m = json.load(open(p))
        g = m.get("args", {})
        cmd = [sys.executable, os.path.join(HERE, "meme_add.py"), d, m["source_url"], "--tags", ",".join(m["emotion"]),
               "--use", m["use_case"], "--triggers", ",".join(m["trigger_phrases"]), "--trend", m["trend_status"], "--name", m["name"]]
        for k, flag in (("in", "--in"), ("out", "--out"), ("key", "--key"), ("similarity", "--similarity"), ("w", "--w"), ("crop", "--crop")):
            if k in g:
                cmd += [flag, str(g[k])]
        if g.get("no_audio"):
            cmd.append("--no-audio")
        if m.get("sfx") and not m.get("image"):
            cmd += ["--sfx", m["sfx"]]
        elif m.get("image"):
            cmd += ["--sfx", m.get("sfx", "vine-boom")]
        r = subprocess.run(cmd, capture_output=True, text=True)
        print(("ok   " if r.returncode == 0 else "FAIL ") + d + ("" if r.returncode == 0 else ": " + r.stderr[-300:]))
        bad += r.returncode != 0
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

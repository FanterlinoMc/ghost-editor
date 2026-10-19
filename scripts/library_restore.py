#!/usr/bin/env python3
"""Rebuild the memes the repo does not track (it keeps only their meta.json):
every meme from its meta.json source + args. Existing files are kept.

    library_restore.py [--memes-only] [--licensed-only]

Sound effects and music are NOT restored here, and nothing in this repo downloads them: they come
from a licensed pack restored by the deployment outside git (library/SOURCES.md). The old Mixkit
download paths (the music `url`s and the old sound-effect fetch script) are retired;
scripts/no-mixkit-fetch.test.mjs fails if one comes back. --sfx-only and --music-only are kept only
to say so and exit non-zero.

--licensed-only is the public build: no meme clips (they are unlicensed rips), so nothing to do.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "library")
RETIRED = ("library_restore.py: sound effects and music are not downloaded by this repo; "
           "restore the licensed pack instead (see library/SOURCES.md)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--memes-only", action="store_true", help="the default now: memes are all this restores")
    ap.add_argument("--sfx-only", action="store_true", help="retired (see library/SOURCES.md)")
    ap.add_argument("--music-only", action="store_true", help="retired (see library/SOURCES.md)")
    ap.add_argument("--licensed-only", action="store_true", help="skip memes (public build)")
    a = ap.parse_args()
    if a.sfx_only or a.music_only:
        sys.exit(RETIRED)
    print("skip sfx and music: not downloaded by this repo (see library/SOURCES.md)")
    if a.licensed_only:
        print("skip memes (--licensed-only: meme clips are unlicensed rips)")
        sys.exit(0)
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

#!/usr/bin/env python3
"""empire_finish.py: the Empire (premium-iman) pass after the first build of a reel.

    empire_finish.py <project> <takes.mp4> <depth.mp4> <takes.json> <out.mp4>
                     [--music f.mp3] [--music-start 7.25] [--pack DIR] [--force-relight] [--no-render]

<project>     a built Empire project: reel.json (style premium-iman, with a `stage`), and assets/talk-matte.webm from the
              first build (hyperframes remove-background, run by build.mjs)
<takes.mp4>   the reel's takes cut from the source with the takes.json handle and concatenated (one depth job)
<depth.mp4>   a depth map video of takes.mp4 (8-bit, 1080x1920 after resampling). INPUT: Ahmed made it with a depth model
              (Depth Anything video, a paid Higgsfield job). This script never calls it.
<takes.json>  {"handle": 0.1, "takes": [[a, b], ...]} (source seconds, ascending), as splice_matte.py reads it
<out.mp4>     the finished, scored reel

Steps (Ahmed's empire_finish.sh, ported from zsh): neon relight (auto-exposure, cached in <project>/build/relight; redone when an
input is newer or with --force-relight) -> splice into the matte (person matte AND depth mask; the original is kept as
assets/talk-matte.orig.webm) -> reel.json stage turned to wrap:false / shade:0 (the relight replaces the faked wraps) -> build.mjs
-> render (npx hyperframes, then master.py from build/master.json) -> autoscore.py + score.py (-14 LUFS) -> vcheck.py -> a
10-frame contact sheet. --no-render stops after the build and scores build/reel-final.mp4 if it already exists.

Fork notes: portable (sys.executable for the python steps, `cmd /c npx` on Windows, no zsh, no Mac path). Needs numpy,
opencv-python, node, ffmpeg. The sound pack and the music are NOT shipped: --pack / $PHANTASIC_SFX_PACK and --music are
optional here; without them autoscore.py is skipped and the reel keeps its rendered audio, mastered. Cost for a 60 s reel on a
laptop CPU: relight 10-20 min + splice 6-12 min (both cached per source), the render as usual. No GPU; no paid call.
"""
import json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
A = sys.argv[1:]
if len(A) < 5 or A[0] in ("-h", "--help"):
    print(__doc__)
    sys.exit(0 if A and A[0] in ("-h", "--help") else 2)
opt = lambda k, d=None: A[A.index(k) + 1] if k in A else d
P, TK, DP, TJ, OUT = (os.path.abspath(x) for x in A[:5])
MUSIC = opt("--music")
MUSIC = os.path.abspath(os.path.expanduser(MUSIC)) if MUSIC else None
MSTART = opt("--music-start", os.environ.get("MUSIC_START", "7.25"))   # a house track whose drop is at 7.28 s starts on the drop
PACK = opt("--pack") or os.environ.get("PHANTASIC_SFX_PACK")
PY = sys.executable
NPX = ["cmd", "/c", "npx"] if os.name == "nt" else ["npx"]            # npx is a .cmd shim on Windows

for label, path in (("project", os.path.join(P, "reel.json")), ("takes video", TK), ("depth video", DP), ("takes.json", TJ),
                    ("first-build matte", os.path.join(P, "assets", "talk-matte.webm"))):
    if not os.path.exists(path):
        sys.exit(f"empire_finish.py: {label} not found: {path}")


def run(cmd, **kw):
    r = subprocess.run(cmd, text=True, encoding="utf-8", errors="replace", capture_output=True, **kw)
    if r.returncode:
        sys.exit(f"empire_finish.py: step failed ({' '.join(map(str, cmd[:3]))} ...)\n{(r.stderr or r.stdout)[-1500:]}")
    return r


build = os.path.join(P, "build")
W = os.path.join(build, "relight")
os.makedirs(W, exist_ok=True)
relit = os.path.join(W, "relit.mp4")
# the relight is the slow step: reuse it when it is newer than its inputs (--force-relight to redo)
if "--force-relight" in A or not os.path.isfile(relit) or os.path.getmtime(TK) > os.path.getmtime(relit) or os.path.getmtime(DP) > os.path.getmtime(relit):
    t = time.time()
    r = run([PY, os.path.join(HERE, "relight.py"), TK, DP, relit, "--look", "neon"])
    print("".join(l + "\n" for l in r.stderr.splitlines() if "auto-exposure" in l).strip() or "relight done", f"({time.time() - t:.0f} s)")
orig = os.path.join(P, "assets", "talk-matte.orig.webm")
if not os.path.isfile(orig):
    shutil.copyfile(os.path.join(P, "assets", "talk-matte.webm"), orig)
r = run([PY, os.path.join(HERE, "splice_matte.py"), orig, relit, os.path.join(W, "relit-mask.mp4"), "--takes", TJ,
         os.path.join(P, "assets", "talk-matte.webm")])
print("".join(l + "\n" for l in r.stdout.splitlines() if l.startswith("frames")).strip())

rp = os.path.join(P, "reel.json")
reel = json.load(open(rp, encoding="utf-8"))
if "stage" not in reel:
    sys.exit("empire_finish.py: reel.json has no `stage` (the Empire look composites the cut-out on a set)")
reel["stage"].update(wrap=False, shade=0, subjectGrade="brightness(1) contrast(1.04)")   # the relight replaces the faked wraps
with open(rp, "w", encoding="utf-8") as fh:
    json.dump(reel, fh, indent=1)

b = run(["node", os.path.join(HERE, "build.mjs"), P], cwd=P)
open(os.path.join(build, "build-finish.log"), "w", encoding="utf-8").write(b.stdout + b.stderr)
final = os.path.join(build, "reel-final.mp4")
if "--no-render" not in A:
    run([*NPX, "hyperframes@0.8.81", "render", "-o", final, "--quiet"], cwd=P)
    mj = os.path.join(build, "master.json")
    if os.path.isfile(mj):
        run([PY, os.path.join(HERE, "master.py"), final, final + ".mastered.mp4", "--from-json", mj])
        os.replace(final + ".mastered.mp4", final)
if not os.path.isfile(final):
    sys.exit(f"empire_finish.py: {final} does not exist (render it, or drop --no-render)")

scored = final
if PACK:
    cues = os.path.join(build, "cues.json")
    cmd = [PY, os.path.join(HERE, "autoscore.py"), P, final, "-o", cues, "--pack", PACK]
    if MUSIC:
        cmd += ["--music", MUSIC, "--music-start", str(MSTART)]
    print(run(cmd).stdout.strip())
    c = json.load(open(cues, encoding="utf-8"))
    v = dict(c); v.pop("music", None); v.update(beds=[], cues=[], out=os.path.join(build, "voice-only.mp4"))
    vj = os.path.join(build, "voice-only.json")
    json.dump(v, open(vj, "w", encoding="utf-8"))
    run([PY, os.path.join(HERE, "score.py"), vj])
    print(run([PY, os.path.join(HERE, "score.py"), cues]).stdout.strip())
    scored = os.path.join(build, "reel-final-scored.mp4")
    print(run([PY, os.path.join(HERE, "vcheck.py"), os.path.join(build, "voice-only.mp4"), scored]).stdout.strip().splitlines()[-1])
else:
    print("empire_finish: no --pack / PHANTASIC_SFX_PACK, so no autoscore: the reel keeps its rendered audio")

D = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", scored]).stdout)
fdir = os.path.join(build, "f")
os.makedirs(fdir, exist_ok=True)
for i in range(10):
    run(["ffmpeg", "-loglevel", "error", "-y", "-ss", str(round(D * (i + 0.5) / 10, 2)), "-i", scored, "-frames:v", "1",
         "-vf", "scale=190:-2,format=yuvj420p", os.path.join(fdir, f"s{i}.jpg")])
sheet = os.path.join(build, "sheet.jpg")
run(["ffmpeg", "-loglevel", "error", "-y", "-i", os.path.join(fdir, "s%d.jpg"), "-vf", "tile=10x1", sheet])
os.makedirs(os.path.dirname(OUT), exist_ok=True)
shutil.copyfile(scored, OUT)
print(f"done -> {OUT} ({D:.1f} s), sheet {sheet}")

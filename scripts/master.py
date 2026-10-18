#!/usr/bin/env python3
"""Final master of a rendered reel: gentle compression, then two-pass loudness to a target (video copied untouched).

    master.py in.mp4 out.mp4 [--lufs -14] [--ratio 3] [--threshold -20] [--limiter [--tp -1.0]]

The pitch style masters to -14 LUFS with LRA ~2-3 (the reference edit's numbers); house templates stay at -16.

--lra N and --post-limit DB (opt-in; Ahmed's f88943d / mini2): loudnorm's LRA target (default 5, as before) and a plain alimiter
after loudnorm in the default path (a ceiling in dBTP; unset = nothing added). Not the same as --tp, which belongs to --limiter.

--fadeout S [--fadeend T] (opt-in; Ahmed's Monk 3 / Headline fix, phantasic 2023064): an audible fade of the mixed audio, S seconds long,
ending at T (default: the end of the file). build.mjs writes style master.fadeOut as `fadeOut` plus `fadeEnd` (= where speech ends)
into build/master.json, so the fade ends with the voice and not over the silent held tail. Both paths honour it; 0 = no fade.

--from-json build/master.json (opt-in; the fork has no render.sh, so this is the Windows-safe way to apply a style's `master`): fills
lufs / ratio / threshold / lra / postLimit / fadeOut / fadeEnd from that file. Flags given on the command line win over the file.

--limiter (opt-in; the default path is unchanged): gain to the target, then a 4x-oversampled brickwall true-peak
limiter a little under the ceiling instead of loudnorm, verified on the encoded file (up to 4 passes). Ported from
phantasic engine/review-fixes a30d106. A different algorithm, so its output differs from the default path.
"""
import argparse, json, re, subprocess, sys


def measure(path, af=None):
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-i", path, "-vn", "-af", (af + "," if af else "") + "ebur128=peak=true", "-f", "null", "-"]
    err = subprocess.run(cmd, capture_output=True, text=True).stderr
    summ = err[err.rfind("Summary:"):]
    i = float(re.search(r"I:\s+(-?[0-9.]+|-inf) LUFS", summ).group(1))
    lra = float(re.search(r"LRA:\s+([0-9.]+) LU", summ).group(1))
    tp = re.search(r"Peak:\s+(-?[0-9.]+|-inf) dBFS", summ.split("True peak:")[-1])
    return i, lra, float(tp.group(1)) if tp else -99.0


def fade_filter(src, fadeout, fadeend):
    """',afade=t=out:st=..:d=..' ending at fadeend (0 / out of range = the end of the file), or '' when fadeout is 0."""
    if not fadeout or fadeout <= 0: return ""
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], capture_output=True, text=True).stdout.strip())
    end = fadeend if 0 < fadeend <= dur else dur
    return f",afade=t=out:st={max(0, end - fadeout):.3f}:d={fadeout}"


def limiter_chain(comp, gain, ceil_db):
    lim = 10 ** (ceil_db / 20)
    # 50 ms of pre-roll silence lets the limiter's look-ahead catch a transient on the very first frames; trimmed off
    # again after the limiter. A 30 ms fade-in removes the start-of-file click the AAC encoder turns into an over.
    return (f"{comp + ',' if comp else ''}volume={gain:.3f}dB,adelay=delays=50:all=1,aresample=192000,"
            f"alimiter=limit={lim:.5f}:level=false:attack=1:release=60:asc=1,aresample=48000,atrim=start=0.05,asetpts=PTS-STARTPTS,afade=t=in:d=0.03")


def limiter_master(a):
    comp = f"acompressor=threshold={a.threshold}dB:ratio={a.ratio}:attack=5:release=80:makeup=1" if a.ratio > 1.01 else ""
    i0, _, _ = measure(a.src, comp or None)
    gain, ceil = a.lufs - i0, a.tp - 0.6
    dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", a.src], capture_output=True, text=True).stdout.strip()
    fade = fade_filter(a.src, a.fadeout, a.fadeend)
    for _ in range(4):
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", a.src, "-c:v", "copy", "-af", limiter_chain(comp, gain, ceil) + fade,
                        "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-t", dur, a.dst], check=True)
        i, lra, tp = measure(a.dst)
        ok_i, ok_tp = abs(i - a.lufs) <= 0.3, tp <= a.tp
        if ok_i and ok_tp: break
        if not ok_tp: ceil -= (tp - a.tp) + 0.15
        if not ok_i: gain += a.lufs - i
    print(f"mastered: {i:.1f} LUFS, true peak {tp:.1f} dBTP, LRA {lra:.1f} (target {a.lufs} / {a.tp})")


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--lufs", type=float, default=-14); ap.add_argument("--ratio", type=float, default=3); ap.add_argument("--threshold", type=float, default=-20)
    ap.add_argument("--lra", type=float, default=5); ap.add_argument("--post-limit", type=float, default=None)
    ap.add_argument("--limiter", action="store_true"); ap.add_argument("--tp", type=float, default=-1.0)
    ap.add_argument("--fadeout", type=float, default=0, help="audible fade at the end (s); 0 = none (opt-in, style master.fadeOut)")
    ap.add_argument("--fadeend", type=float, default=0, help="time (s) the fade ends; 0 = the end of the file")
    ap.add_argument("--from-json", default=None, help="build/master.json: fills lufs/ratio/threshold/lra/postLimit/fadeOut/fadeEnd; explicit flags win")
    a = ap.parse_args()
    if a.from_json:
        m = json.load(open(a.from_json))
        given = {x.lstrip("-").split("=")[0].replace("-", "_") for x in sys.argv[1:] if x.startswith("--")}
        for key, dest in (("lufs", "lufs"), ("ratio", "ratio"), ("threshold", "threshold"), ("lra", "lra"), ("postLimit", "post_limit"), ("fadeOut", "fadeout"), ("fadeEnd", "fadeend")):
            if key in m and dest not in given: setattr(a, dest, float(m[key]))
    if a.limiter: return limiter_master(a)
    comp = f"acompressor=threshold={a.threshold}dB:ratio={a.ratio}:attack=5:release=80:makeup=1"
    r = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", a.src, "-af", f"{comp},loudnorm=I={a.lufs}:TP=-1:LRA={a.lra}:print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    m = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S).group(0))
    ln = (f"loudnorm=I={a.lufs}:TP=-1:LRA={a.lra}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
          f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", a.src, "-c:v", "copy", "-af", f"{comp},{ln}" + (f",alimiter=limit={10 ** (a.post_limit / 20):.3f}:level=disabled" if a.post_limit is not None else "") + fade_filter(a.src, a.fadeout, a.fadeend), "-ar", "48000", "-c:a", "aac", "-b:a", "192k", a.dst], check=True)
    out = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", a.dst, "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True).stderr
    print("mastered:", re.findall(r"^\s+I:\s+(-?[0-9.]+) LUFS", out, re.M)[-1], "LUFS, LRA", re.findall(r"^\s+LRA:\s+([0-9.]+) LU", out, re.M)[-1])


if __name__ == "__main__":
    main()

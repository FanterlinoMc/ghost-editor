#!/usr/bin/env python3
"""score.py: the premium sound pass. Re-mixes a rendered reel's audio from a cue sheet.

    score.py cues.json            (also: score.py --help)

cues.json:
{
  "video": "build/hook-v8.mp4",            # picture (its audio is ignored)
  "out": "build/hook-v8-scored.mp4",
  "voice": {"src": "assets/talk.mp4", "takes": [[14.15, 16.25], [16.7, 24.47]],
            "polish": true},                # concat of the spoken takes, cleaned up (hp, presence, comp)
  "music": {"src": "...", "start": 0, "db": -20, "duck_db": 9, "fade_in": 0.3, "fade_out": 1.0,
            "env": [[t, db], ...]},         # extra volume keyframes on top of db (lifts, pre-hit silences)
  "beds":  [{"src": "...", "t": 0, "to": 9.9, "db": -34, "loop": true, "fade": 0.4}],   # ambiences
  "cues":  [{"src": "...", "t": 2.9, "db": -6, "verb": 0.35, "fade": 0.05, "align": "peak"}],
  "verb":  {"seconds": 2.6, "db": -8},      # shared room for every cue's reverb send
  "lufs": -14, "tp": -1.0
}
Cue "align": "start" (default) puts the file start at t; "peak" puts the file's loudest moment at t (risers,
hits with a pre-attack). All levels are dB relative to full scale before the final loudness normalise, so the
balance between layers is what matters, not the absolute numbers.

Ported from Ahmed's phantasic engine/core (origin/main, template-premium-iman). Fork notes: needs ffmpeg/ffprobe on PATH and numpy
(no other dependency, no network, no model); paths in the cue sheet are relative to the cue sheet's folder, "~" is expanded.
A cue, bed or music file that is NOT on disk is skipped with a warning instead of stopping the pass (the premium sound packs
are not shipped: with none, the result is the polished voice plus the music bed). The voice and the picture are still required.
Windows: the concat list uses forward slashes and LF line ends. Runtime: ~10-20 s of CPU per 60 s reel (numpy FFT reverb plus
two ffmpeg passes), no GPU.
"""
import json, os, subprocess, sys, tempfile
import numpy as np

SR = 48000


TXT = dict(text=True, encoding="utf-8", errors="replace")
WARNED = []


def warn(msg):
    WARNED.append(msg)
    print("WARNING: " + msg, file=sys.stderr)


def present(path, what):
    """True when the file is there; else a warning (the premium packs are not shipped) and False."""
    if os.path.isfile(path):
        return True
    warn(f"{what} not found, skipped: {path}")
    return False


def load(path, t0=None, t1=None):
    args = ["ffmpeg", "-v", "error"]
    if t0 is not None:
        args += ["-ss", str(t0)]
    if t1 is not None:
        args += ["-t", str(t1 - (t0 or 0))]
    args += ["-i", path, "-vn", "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(args, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()


def db(x):
    return 10 ** (x / 20)


def loop_to(src, need, xf_s=0.25):
    """Repeat src until it is `need` samples long, each seam an equal-power crossfade."""
    xf = int(xf_s * SR)
    out = src.copy()
    while len(out) < need:
        w = np.linspace(0, 1, xf)[:, None]
        out = np.concatenate([out[:-xf], out[-xf:] * np.sqrt(1 - w) + src[:xf] * np.sqrt(w), src[xf:]])
    return out


def place(buf, clip, t, gain=1.0):
    i = int(round(t * SR))
    if i < 0:
        clip, i = clip[-i:], 0
    n = min(len(clip), len(buf) - i)
    if n > 0:
        buf[i:i + n] += clip[:n] * gain


def fade(clip, fin=0.0, fout=0.0):
    c = clip.copy()
    a, b = int(fin * SR), int(fout * SR)
    if a > 0:
        c[:a] *= np.linspace(0, 1, a)[:, None]
    if b > 0 and b < len(c):
        c[-b:] *= np.linspace(1, 0, b)[:, None]
    return c


def envelope(n, keys, base_db):
    """Piecewise-linear dB envelope over n samples from [[t, db], ...] (db relative to base)."""
    if not keys:
        return np.full(n, db(base_db), np.float32)
    ts = np.array([k[0] for k in keys]) * SR
    vs = np.array([k[1] for k in keys], dtype=np.float64)
    curve = np.interp(np.arange(n), ts, vs, left=vs[0], right=vs[-1])
    return (10 ** ((base_db + curve) / 20)).astype(np.float32)


def follower(x, attack=0.01, release=0.25):
    """Smoothed amplitude envelope of a mono signal (for ducking)."""
    a = np.abs(x)
    win = int(attack * SR) or 1
    a = np.convolve(a, np.ones(win) / win, mode="same")
    out = np.empty_like(a)
    rel = np.exp(-1 / (release * SR))
    acc = 0.0
    for i in range(0, len(a), 64):                       # block-wise peak-hold release, fast enough in numpy
        blk = a[i:i + 64].max()
        acc = blk if blk > acc else acc * rel ** 64
        out[i:i + 64] = acc
    return out


def reverb_ir(seconds):
    n = int(seconds * SR)
    rng = np.random.default_rng(7)
    t = np.arange(n) / SR
    decay = np.exp(-6.9 * t / seconds)                    # -60 dB at `seconds`
    ir = rng.standard_normal((n, 2)) * decay[:, None]
    ir[: int(0.012 * SR)] = 0                             # 12 ms pre-delay
    k = np.ones(int(0.0015 * SR)) / int(0.0015 * SR)      # darken the tail a little
    ir = np.stack([np.convolve(ir[:, c], k, mode="same") for c in range(2)], 1)
    return ir / np.sqrt((ir ** 2).sum(0)).max()


def convolve(x, ir):
    n = len(x) + len(ir) - 1
    N = 1 << (n - 1).bit_length()
    out = np.stack([np.fft.irfft(np.fft.rfft(x[:, c], N) * np.fft.rfft(ir[:, c], N), N)[:len(x)] for c in range(2)], 1)
    return out.astype(np.float32)


def polish_voice(path, takes):
    with tempfile.TemporaryDirectory() as d:
        parts = []
        for i, (a, b) in enumerate(takes):
            p = os.path.join(d, f"t{i}.wav")
            # 8 ms fades at each join so take edits never click
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(a), "-t", str(b - a), "-i", path, "-vn", "-ac", "2",
                            "-ar", str(SR), "-af", f"afade=t=in:d=0.008,afade=t=out:st={b - a - 0.008:.3f}:d=0.008", p],
                           check=True)
            parts.append(p)
        lst = os.path.join(d, "l.txt")
        with open(lst, "w", encoding="utf-8", newline="\n") as fh:      # forward slashes: the concat demuxer reads backslashes as escapes
            fh.write("".join("file '%s'\n" % p.replace("\\", "/").replace("'", "'\\''") for p in parts))
        cat = os.path.join(d, "cat.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", cat], check=True)
        out = os.path.join(d, "v.wav")
        chain = ("highpass=f=85,afftdn=nr=8:nf=-42,"
                 "equalizer=f=220:t=q:w=1.1:g=-2,equalizer=f=3200:t=q:w=1.0:g=2.5,equalizer=f=9000:t=h:w=0.7:g=1.5,"
                 "acompressor=threshold=-22dB:ratio=3:attack=6:release=120:makeup=4,"
                 "alimiter=limit=0.89:attack=3:release=40")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", cat, "-af", chain, out], check=True)
        return load(out)


def peak_time(clip):
    return int(np.argmax(np.abs(clip).max(1))) / SR


def main(cfg_path):
    cfg = json.load(open(cfg_path))
    base = os.path.dirname(os.path.abspath(cfg_path))
    P = lambda p: p if os.path.isabs(p) else os.path.join(base, os.path.expanduser(p))
    for need, path in (("video", P(cfg["video"])), ("voice", P(cfg["voice"]["src"]))):
        if not os.path.isfile(path):
            sys.exit(f"score.py: {need} not found: {path}")
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                P(cfg["video"])], capture_output=True, **TXT).stdout)
    n = int(dur * SR)

    V = cfg["voice"]
    voice = polish_voice(P(V["src"]), V["takes"]) if V.get("polish", True) else load(P(V["src"]))
    voice = np.pad(voice, ((0, max(0, n - len(voice))), (0, 0)))[:n] * db(V.get("db", 0))
    mono_v = voice.mean(1)

    mix = voice.copy()
    send = np.zeros_like(mix)

    M = cfg.get("music")
    if M and not present(P(M["src"]), "music"):
        M = None
    if M:
        mu = load(P(M["src"]), M.get("start", 0))
        if M.get("at"):                                    # the track enters `at` s into the reel (a drop placed on a beat)
            mu = np.concatenate([np.zeros((int(M["at"] * SR), 2), np.float32), mu])
        if len(mu) < n:                                    # a short track loops (1 s crossfade) instead of stopping
            mu = loop_to(mu, n, 1.0)
        mu = mu[:n]
        mu = fade(mu, M.get("fade_in", 0.3), M.get("fade_out", 1.0))
        env = envelope(n, M.get("env"), M.get("db", -20))
        duck = follower(mono_v, release=M.get("duck_release", 0.3))
        duck = duck / (duck.max() + 1e-9)
        # full duck from ~18 dB under the loudest words, so soft words ("...any... idea") are ducked too
        gain_duck = 10 ** (-M.get("duck_db", 8) * np.clip(duck * 8, 0, 1) / 20)
        mix += mu * (env * gain_duck)[:, None]

    for b in cfg.get("beds", []):
        if not present(P(b["src"]), "bed"):
            continue
        src = load(P(b["src"]))
        t0, t1 = b.get("t", 0), b.get("to", dur)
        need = int((t1 - t0) * SR)
        if b.get("loop", True) and len(src) < need:
            src = loop_to(src, need)
        src = fade(src[:need], b.get("fade", 0.4), b.get("fade", 0.4))
        place(mix, src, t0, db(b.get("db", -32)))

    fx = np.zeros_like(mix)
    protect = np.zeros(n, np.float32)
    for c in cfg.get("cues", []):
        if not present(P(c["src"]), "cue"):
            continue
        clip = load(P(c["src"]))
        if c.get("len"):
            clip = clip[:int(c["len"] * SR)]
        if c.get("tail"):                                 # keep only the last N s (a riser's top end)
            clip = clip[-int(c["tail"] * SR):]
        clip = fade(clip, c.get("fade_in", 0.0), c.get("fade", 0.03))
        t = c["t"] - (peak_time(clip) if c.get("align") == "peak" else 0)
        g = db(c.get("db", -10))
        place(fx, clip, t, g)
        if c.get("verb"):
            place(send, clip, t, g * c["verb"])
        a = int(max(0, c["t"]) * SR)                     # the hit's own attack stays un-ducked
        protect[a:a + int(c.get("punch", 0.14) * SR)] = 1

    R = cfg.get("verb")
    if R and np.abs(send).max() > 0:
        fx += convolve(send, reverb_ir(R.get("seconds", 2.4))) * db(R.get("db", -6))
    # effect tails duck under the voice (a pro mixer's sidechain on the FX bus); attacks are protected
    vf = follower(mono_v, attack=0.005, release=0.18)
    # gate-like: any audible speech (from ~12 dB under the loud words) gets the full duck, so soft trailing words
    # ("to come.") are protected as well as loud ones
    vf = np.clip(vf / (0.25 * np.percentile(vf, 95) + 1e-9), 0, 1)
    fx_duck = 10 ** (-cfg.get("fx_duck_db", 10) * vf / 20)
    pr = np.convolve(protect, np.ones(int(0.03 * SR)) / int(0.03 * SR), mode="same")
    mix += fx * np.maximum(fx_duck, np.clip(pr, 0, 1))[:, None]

    with tempfile.TemporaryDirectory() as d:
        raw = os.path.join(d, "mix.wav")
        mix = mix / max(1.0, np.abs(mix).max() / 0.98)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-", raw],
                       input=mix.astype(np.float32).tobytes(), check=True)
        lufs, tp = cfg.get("lufs", -14), cfg.get("tp", -1.0)
        # two-pass loudnorm so the final level is exact
        meas = subprocess.run(["ffmpeg", "-v", "info", "-i", raw, "-af", f"loudnorm=I={lufs}:TP={tp}:LRA=9:print_format=json",
                               "-f", "null", "-"], capture_output=True, **TXT).stderr
        js = json.loads(meas[meas.rindex("{"):meas.rindex("}") + 1])
        ln = (f"loudnorm=I={lufs}:TP={tp}:LRA=9:measured_I={js['input_i']}:measured_TP={js['input_tp']}:"
              f"measured_LRA={js['input_lra']}:measured_thresh={js['input_thresh']}:offset={js['target_offset']}:linear=true")
        out = P(cfg["out"])
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", P(cfg["video"]), "-i", raw, "-map", "0:v", "-map", "1:a",
                        "-c:v", "copy", "-af", ln + f",aresample={SR}", "-c:a", "aac", "-b:a", "256k", "-shortest", out],
                       check=True)
        chk = subprocess.run(["ffmpeg", "-v", "info", "-i", out, "-af", "ebur128=peak=true", "-f", "null", "-"],
                             capture_output=True, **TXT).stderr
        tail = chk[chk.rindex("Summary"):]
        I = tail.split("I:")[1].split("LUFS")[0].strip()
        TPk = tail.split("Peak:")[1].split("dBFS")[0].strip()
        print(f"scored -> {out}  ({I} LUFS, true peak {TPk} dBFS)" + (f"; {len(WARNED)} file(s) skipped" if WARNED else ""))


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0 if len(sys.argv) == 2 else 2)
    main(sys.argv[1])

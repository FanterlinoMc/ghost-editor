#!/usr/bin/env node
// node scripts/build-ahmed-rest.test.mjs
// The last small pieces of Ahmed's engine work (phase A of the "merge the rest" port), each opt-in:
//   - Keynote 3 (phantasic ff71824): leaks.shape / blend / hold / fadeOut / maskScale in build.mjs and the keynote-5 style;
//     face_crop.py pillar() / pillar_cmd() (FACE_PILLAR=1); prep.sh STABILIZE=1.
//   - Monk 3 + Headline (phantasic 2023064): master.fadeOut / fadeEnd in build/master.json and master.py --fadeout / --fadeend.
// The python and ffmpeg-filter checks are skipped (and say so) when OpenCV or libvidstab is missing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-rest-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 12, FPS = 30;
ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));

const text = "why does money matter so much. because time is remarkable and scary. the remarkable thing is scary. a community far away lives on an isolated island. money and time again. remarkable people keep going. it is scary but remarkable. thank you for watching.".split(" ");
const words = { segments: [{ start: 0, end: SEC, words: Array.from({ length: 38 }, (_, i) => ({ word: text[i % text.length], start: +(0.3 + i * 0.3).toFixed(2), end: +(0.55 + i * 0.3).toFixed(2) })) }] };
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 7 }, (_, i) => [i * 2, 300, 780, 340, 740, 450, 650]) };

let n = 0;
function project(reel) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "rest", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.4, zoom: {}, takes: [{ a: 0, b: SEC }], beats: [], ...reel }, null, 2));
  return dir;
}
// no packs or audio (lib/silent-library.mjs): a restored library/packs would turn keynote-4's leaks into pack clips
const build = (dir) => { const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary() } }); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const check = (label) => console.log(`ok    ${label}`);
const leakDivs = (h) => [...h.matchAll(/<div id="leak\d+" class="clip"[^>]*><\/div>/g)].map((m) => m[0]);
const python = ["py", "python3", "python"].find((c) => spawnSync(c, ["-c", "import cv2, numpy"], { stdio: "ignore" }).status === 0);

try {
  // ================= leaks: new keys, and the old flash when they are absent =================
  let dir = project({ style: "keynote-4", leaks: { every: 1 } });
  build(dir);
  let h = html(dir);
  let divs = leakDivs(h);
  assert.ok(divs.length >= 1, "keynote-4 still gets leaks");
  for (const d of divs) {
    assert.match(d, /data-duration="0\.9"/, "default clip length 0.9 s");
    assert.match(d, /mix-blend-mode:screen;/, "default blend screen");
    assert.match(d, /background:radial-gradient\(ellipse 120% 90% at 30% 40%/, "default centred glow");
  }
  assert.match(h, /tl\.to\("#leak0", \{ opacity: 0, duration: 0\.55, ease: "power2\.out" \}, [\d.]+\);/, "default 0.55 s burn-out");
  const mask14 = h.match(/mask-image:radial-gradient\(ellipse ([\d.]+)% ([\d.]+)%/);
  check("keynote-4: leaks unchanged without the new keys (0.9 s, screen, centred glow, 0.55 s burn-out)");

  dir = project({ style: "keynote-5", leaks: { every: 1 } });
  build(dir);
  h = html(dir);
  divs = leakDivs(h);
  assert.ok(divs.length >= 2, `keynote-5 leaks (${divs.length})`);
  for (const d of divs) {
    assert.match(d, /data-duration="1.45"/, "0.9 + hold 0.35 + (fadeOut 0.75 - 0.55) = 1.45 s");
  }
  check("keynote-5: leak clip is long enough for the hold and the slow burn-out");
  assert.match(divs[0], /mix-blend-mode:normal;/, "leaks.blend normal");
  assert.match(divs[0], /radial-gradient\(ellipse 95% 75% at 0% 38%, rgba\(255,150,40/, "edge shape: first flash from the left edge");
  assert.match(divs[1], /radial-gradient\(ellipse 95% 75% at 100% 38%, rgba\(255,150,40/, "edge shape: second flash from the right edge");
  assert.match(h, /ft\("#leak0", \{ opacity: 0 \}, \{ opacity: 0\.8,/, "leaks.peak 0.8");
  const t0 = Number(h.match(/ft\("#leak0",[^;]*?, ([\d.]+)\);/)[1]);
  const m = h.match(/tl\.to\("#leak0", \{ opacity: 0, duration: 0\.75, ease: "power2\.out" \}, ([\d.]+)\);/);
  assert.ok(m, "leaks.fadeOut 0.75");
  assert.ok(Math.abs(Number(m[1]) - (t0 + 0.22 + 0.05 + 0.35)) < 0.02, `leaks.hold: the burn-out starts 0.35 s after the old moment (${m[1]} vs flash at ${t0})`);
  const mask15 = h.match(/mask-image:radial-gradient\(ellipse ([\d.]+)% ([\d.]+)%/);
  assert.ok(mask14 && mask15 && Number(mask15[1]) < Number(mask14[1]) * 0.7, `leaks.maskScale 0.9 gives a smaller face hole than the default 1.5 (${mask15 && mask15[1]} vs ${mask14 && mask14[1]})`);
  check("keynote-5: edge shape alternating sides, blend normal, peak 0.8, hold, fadeOut, smaller face hole");

  dir = project({ style: "clean", leaks: { every: 1 } });
  build(dir);
  for (const d of leakDivs(html(dir))) assert.match(d, /data-duration="0\.9" .*mix-blend-mode:screen;/);
  check("a plain leaks block is the old flash on any other style");

  // ================= face_crop.py: pillar() / pillar_cmd() =================
  if (!python) console.log("skip  face_crop pillar checks: no python with OpenCV and numpy");
  else {
    const py = `
import sys, os
sys.path.insert(0, ${JSON.stringify(HERE)})
import numpy as np, face_crop as fc
W, H = 1920, 1080
def frame(lo=None, hi=None):
    f = np.zeros((H, W, 3), np.uint8)
    if lo is None: f[:] = 90
    else: f[:, lo:hi] = 160
    return f
assert fc.pillar(frame(420, 1500), W) == (420, 1499), fc.pillar(frame(420, 1500), W)
assert fc.pillar(frame(), W) is None, "a full frame is not pillarboxed"
studio = np.zeros((H, W, 3), np.uint8); studio[300:H, 800:1100] = 200       # a dark backdrop with a person: not full height
assert fc.pillar(studio, W) is None, "a person in a dark studio is not an insert"
assert fc.pillar(np.zeros((H, W, 3), np.uint8), W) is None, "an all-black frame"
assert fc.pillar(frame(60, 1860), W) is None, "bars under 8% of the width"
# pillar_cmd: 300 frames at 30 fps, an insert (420..1500) on frames 90..179 only, samples every 10 frames
class Cap:
    pos = 0
    def set(self, prop, v): self.pos = int(v)
    def read(self): return True, (frame(420, 1500) if 90 <= self.pos < 180 else frame())
n, fps, cw = 300, 30.0, 607
pills = {f: (420, 1499) for f in range(0, n, 10) if 90 <= f < 180}
out = os.path.join(sys.argv[1], "pillar.cmd")
r = fc.pillar_cmd(Cap(), fps, n, W, cw, H, 10, pills, lambda t: 300, out)
assert r.startswith("sendcmd=f=") and f"crop@c={cw}:{H}:300:0" in r, r
xs = [int(l.split()[3].rstrip(";")) for l in open(out).read().split("\\n") if l]
assert xs[10] == 300 and xs[250] == 300, "off the insert the window follows xat"
assert xs[120] == int((420 + 1500) / 2 - cw / 2), (xs[120], "on the insert it is centred on the picture")
assert xs[89] == 300 and xs[90] == xs[120] and xs[179] == xs[120] and xs[180] == 300, "the edges are found to the exact frame"
print("pillar ok")
`;
    const r = spawnSync(python, ["-c", py, root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /pillar ok/);
    check("face_crop.py: pillar() finds the picture, rejects a studio and a full frame; pillar_cmd() snaps to the insert exactly");
    // FACE_PILLAR is off by default: without the model the result is the same as before (the centre crop), with it or without it
    const src = path.join(root, "wide.mp4");
    ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", src);
    const a = spawnSync(python, [path.join(HERE, "face_crop.py"), src], { encoding: "utf8" });
    const b = spawnSync(python, [path.join(HERE, "face_crop.py"), src], { encoding: "utf8", env: { ...process.env, FACE_PILLAR: "1" } });
    assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
    assert.equal(a.stdout.trim(), "crop=202:360:219:0", "face_crop.py default result is the centre crop");
    assert.equal(a.stdout, b.stdout, "no face and no model: FACE_PILLAR changes nothing");
    check("face_crop.py: unchanged result without a face track, with and without FACE_PILLAR");
  }

  // ================= prep.sh STABILIZE =================
  const hasStab = /vidstabtransform/.test(execFileSync("ffmpeg", ["-hide_banner", "-filters"]).toString());
  if (!hasStab) console.log("skip  STABILIZE: ffmpeg has no libvidstab");
  else {
    const PREP = path.join(HERE, "prep.sh").split(path.sep).join("/");
    const proj = path.join(root, "prepproj").split(path.sep).join("/");
    const vid = path.join(root, "talk.mp4").split(path.sep).join("/");
    const prep = (env) => execFileSync("bash", [PREP, vid, proj, "9:16", "0"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let log = prep({});
    assert.ok(!/stabiliz/i.test(log), "STABILIZE unset: nothing stabilised");
    assert.ok(!fs.existsSync(path.join(proj, "build", "stab.mp4")));
    check("prep.sh: STABILIZE unset leaves the pipeline untouched");
    log = prep({ STABILIZE: "1" });
    assert.match(log, /stabilized \(vidstab, smoothing 150\)/, log);
    assert.ok(fs.statSync(path.join(proj, "build", "stab.mp4")).size > 0 && fs.statSync(path.join(proj, "build", "stab.trf")).size > 0);
    assert.ok(fs.existsSync(path.join(proj, "assets", "talk.mp4")));
    log = prep({ STABILIZE: "1", STAB_SMOOTH: "30", STAB_TRIPOD: "1" });
    assert.match(log, /smoothing 30/);
    check("prep.sh: STABILIZE=1 runs vidstab (smoothing and tripod options), the normalised talk.mp4 still comes out");
  }

  // ================= master.fadeOut / fadeEnd -> build/master.json, master.py --fadeout / --fadeend / --from-json =================
  const masterOf = (d) => JSON.parse(fs.readFileSync(path.join(d, "build", "master.json"), "utf8"));
  dir = project({ style: "headline-3" });
  build(dir);
  let mj = masterOf(dir);
  assert.equal(mj.fadeOut, 0.35); assert.equal(mj.postLimit, -3); assert.equal(mj.lufs, -15);
  const tail = JSON.parse(fs.readFileSync(path.join(dir, "build", "tail.json"), "utf8"));
  assert.ok(Math.abs(mj.fadeEnd - (tail.speech + 0.06)) < 0.002, `fadeEnd is speech end + 0.06 (${mj.fadeEnd} vs ${tail.speech})`);
  check("headline-3: master.fadeOut writes fadeEnd = speech end + 0.06 into build/master.json");
  dir = project({ style: "monk-4" });
  build(dir);
  assert.deepEqual(masterOf(dir), { lufs: -15, ratio: 2, threshold: -18, postLimit: -3.5 }, "no fadeOut: the style's master, as is");
  dir = project({ style: "headline-2" });
  build(dir);
  assert.ok(!fs.existsSync(path.join(dir, "build", "master.json")), "headline-2 sets no master");
  check("monk-4: master without fadeOut is written as is; headline-2 writes no master.json");

  const anyPython = ["py", "python3", "python"].find((c) => spawnSync(c, ["-c", "1"], { stdio: "ignore" }).status === 0);
  if (!anyPython) console.log("skip  master.py: no python");
  else {
    const MASTER = path.join(HERE, "master.py");
    ff("-f", "lavfi", "-i", "testsrc2=size=108x192:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=300:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(root, "m.mp4"));
    const rms = (file, a, b) => {
      const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ss", String(a), "-t", String(b - a), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 26 });
      const f = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 4)));
      return Math.sqrt(f.reduce((s, x) => s + x * x, 0) / Math.max(1, f.length));
    };
    const mast = (out, ...args) => { const r = spawnSync(anyPython, [MASTER, path.join(root, "m.mp4"), path.join(root, out), ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr + r.stdout); };
    const at = (f, a, b) => rms(path.join(root, f), a, b);
    mast("m-plain.mp4");
    mast("m-fade.mp4", "--fadeout", "0.6", "--fadeend", "3");
    const plainEnd = at("m-plain.mp4", 3.3, 3.9), plainMid = at("m-plain.mp4", 1, 1.5);
    assert.ok(plainEnd > 0.5 * plainMid, `no flag: no fade (${plainEnd} vs ${plainMid})`);
    const fMid = at("m-fade.mp4", 1, 1.5), fFade = at("m-fade.mp4", 2.7, 3), fAfter = at("m-fade.mp4", 3.2, 3.9);
    assert.ok(fMid > 0.05, "audio before the fade is intact");
    assert.ok(fFade < 0.75 * fMid, `the fade is under way before fadeend (${fFade} vs ${fMid})`);
    assert.ok(fAfter < 0.02 * fMid, `silence after fadeend (${fAfter})`);
    check("master.py: --fadeout/--fadeend fade the audio to silence at fadeend; no flag, no fade");
    fs.writeFileSync(path.join(root, "master.json"), JSON.stringify({ lufs: -15, ratio: 2, threshold: -18, postLimit: -3, fadeOut: 0.6, fadeEnd: 3 }));
    mast("m-json.mp4", "--from-json", path.join(root, "master.json"));
    assert.ok(at("m-json.mp4", 3.2, 3.9) < 0.02 * fMid, "--from-json applies fadeOut / fadeEnd");
    mast("m-json2.mp4", "--from-json", path.join(root, "master.json"), "--fadeout", "0");
    assert.ok(at("m-json2.mp4", 3.3, 3.9) > 0.5 * plainMid, "an explicit flag beats the file");
    check("master.py: --from-json reads build/master.json, explicit flags win");
  }

  console.log("\nall build-ahmed-rest checks passed");
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

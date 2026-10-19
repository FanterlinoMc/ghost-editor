#!/usr/bin/env node
// node scripts/build-relight.test.mjs
// reel.json `relight` (Empire depth relight, references/reel-json.md). The depth MODEL never runs here: every reel gets a STUB
// depth map made in this test (an ellipse of "near" on a "far" room), PHANTASIC_MODELS points at an empty folder (so a missed
// stub fails at once with "no depth model"), and npx refuses (so a missed matte stub never starts the cut-out model).
// Covers:
//   - lib/relight.mjs normalizeRelight: defaults, `true`, every die() on bad input
//   - opt-in: a reel without `relight` plays assets/talk.mp4 and writes no depth / relit file
//   - the build with a stub depth: the <video> tags and the hold still read assets/talk-relit-<hash>.mp4, audio keeps talk.mp4,
//     the relit file has the source's frame count, and its pixels show the look: red light from the left, blue from the right,
//     the subject (near) brighter relative to the room (far) than in the source - depth-correct falloff
//   - cached: a second build does not relight again and writes the same page; new params -> a new hash
//   - with `matte`: the cut-out tag reads assets/talk-matte-relit-<hash>.webm, which keeps the stub matte's alpha and carries
//     the relit colour
//   - the missing-model die(); relight.py's empire look on its own (--frame)
// The parts that run relight.py are skipped (and say so) when no python with numpy and OpenCV is found.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const RL = await import(pathToFileURL(path.join(HERE, "lib", "relight.mjs")).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-relight-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 3, FPS = 30, W = 108, H = 192;
ff("-f", "lavfi", "-i", `color=c=0x8a8a8a:size=${W}x${H}:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));
// the STUB depth map: an upright ellipse (the speaker, near = 230) on a far room (20), half size like depth_map.py's output
const DW = 54, DH = 96;
ff("-f", "lavfi", "-i", `color=c=black:size=${DW}x${DH}:rate=${FPS}:duration=${SEC},format=gray,geq=lum='if(lt(hypot((X-${DW / 2})/16\\,(Y-${DH * 0.55})/30)\\,1)\\,230\\,20)'`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "depth.mp4"));
// a stub cut-out with real alpha (the same ellipse opaque), VP9 + alpha like hyperframes remove-background writes
ff("-f", "lavfi", "-i", `color=c=0x8a8a8a:size=${W}x${H}:rate=${FPS}:duration=${SEC},format=yuva420p,geq=lum='p(X\\,Y)':cb='p(X\\,Y)':cr='p(X\\,Y)':a='if(lt(hypot((X-${W / 2})/32\\,(Y-${H * 0.55})/60)\\,1)\\,255\\,0)'`,
  "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", path.join(root, "matte.webm"));
const words = { segments: [{ start: 0, end: SEC, words: "light from the side not a new room".split(" ").map((w, i) => ({ word: w, start: 0.2 + i * 0.3, end: 0.4 + i * 0.3 })) }] };
let n = 0;
function project(reel, { depth = true, matte = false } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  if (depth) fs.copyFileSync(path.join(root, "depth.mp4"), path.join(dir, "assets", "talk-depth.mp4"));
  if (matte) {
    fs.copyFileSync(path.join(root, "matte.webm"), path.join(dir, "assets", "talk-matte.webm"));
    fs.writeFileSync(path.join(dir, "build", "headtop.json"), JSON.stringify(Array.from({ length: 20 }, (_, i) => [+(i / 5).toFixed(2), 40])));
  }
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 4 }, (_, i) => [i, 400, 1000, 340, 740, 560, 800]) }));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "relight", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0, takes: [{ a: 0, b: 1.4, hold: 0.2 }, { a: 1.6, b: SEC }], ...reel }));
  return dir;
}
const fakeBin = path.join(root, "fake-bin"); fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, "npx.cmd"), "@echo off\r\necho npx is disabled in build-relight.test.mjs: seed the matte 1>&2\r\nexit /b 97\r\n");
fs.writeFileSync(path.join(fakeBin, "npx"), "#!/bin/sh\necho 'npx is disabled in build-relight.test.mjs: seed the matte' >&2\nexit 97\n", { mode: 0o755 });
const noModels = path.join(root, "no-models"); fs.mkdirSync(noModels);
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
const SAFE_ENV = { ...process.env, PHANTASIC_LIB: silentLibrary(), PHANTASIC_MODELS: noModels, [pathKey]: fakeBin + path.delimiter + process.env[pathKey] };
const run = (dir, env = {}) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...SAFE_ENV, ...env } });
const build = (dir, env) => { const r = run(dir, env); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const fails = (dir, re, env) => { const r = run(dir, env); assert.notEqual(r.status, 0, "should have failed"); assert.match(r.stdout + r.stderr, re); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const check = (label) => console.log(`ok    ${label}`);
const frames = (f) => +execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", f]).toString().trim();
const rgbAt = (f, t, extra = []) => execFileSync("ffmpeg", ["-v", "error", ...extra, "-ss", String(t), "-i", f, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 24 });
// mean linear-light gain per channel of `b` over `a` inside a region (x0..x1, y0..y1 in 0..1 of the frame)
const gainIn = (a, b, [x0, x1, y0, y1]) => {
  const s = [[0, 0, 0], [0, 0, 0]];
  for (let y = Math.floor(y0 * H); y < y1 * H; y++) for (let x = Math.floor(x0 * W); x < x1 * W; x++) for (let c = 0; c < 3; c++) {
    const i = (y * W + x) * 3 + c; s[0][c] += (a[i] / 255) ** 2.2; s[1][c] += (b[i] / 255) ** 2.2;
  }
  return s[1].map((v, c) => v / s[0][c]);
};

{
  // ---------- normalizeRelight ----------
  assert.deepEqual(RL.normalizeRelight(true), { look: "empire", left: "#ff3a48", right: "#5a78ff", strength: 0.9, room: 0.3, roomDim: 0.15 });
  assert.deepEqual(RL.normalizeRelight({ strength: 1.2, left: "#00FF00" }), { ...RL.RELIGHT_DEFAULTS, strength: 1.2, left: "#00FF00" });
  assert.throws(() => RL.normalizeRelight("yes"), /^Error: relight must be true or an object \(got "yes"\)/);
  assert.throws(() => RL.normalizeRelight([]), /relight must be true or an object/);
  assert.throws(() => RL.normalizeRelight({ plate: "x.jpg" }), /relight: unknown key 'plate'/);
  assert.throws(() => RL.normalizeRelight({ look: "neon" }), /relight\.look must be "empire" \(got "neon"\)/);
  assert.throws(() => RL.normalizeRelight({ right: "blue" }), /relight\.right must be a #rrggbb colour \(got "blue"\)/);
  assert.throws(() => RL.normalizeRelight({ strength: 3 }), /relight\.strength must be a number 0\.\.2 \(got 3\)/);
  assert.throws(() => RL.normalizeRelight({ room: -0.1 }), /relight\.room must be a number 0\.\.1/);
  assert.throws(() => RL.normalizeRelight({ roomDim: "0.2" }), /relight\.roomDim must be a number 0\.\.0\.6/);
  check("normalizeRelight: defaults, true, unknown key / look / colour / ranges refused");
}

{
  // ---------- die() through the build (no python needed: these fail before any is looked for) ----------
  fails(project({ relight: { look: "warm" } }), /ERROR: relight\.look must be "empire"/);
  fails(project({ relight: 1 }), /ERROR: relight must be true or an object/);
  fails(project({ relight: {} }, { depth: false }), /ERROR: relight: no depth map at assets\/talk-depth-[0-9a-f]{8}\.mp4 and no depth model at .*no-models.*depth_map\.py --fetch/);
  fails(project({ relight: {} }), /ERROR: relight: PHANTASIC_PYTHON=.*no-such-python cannot import numpy, cv2/, { PHANTASIC_PYTHON: path.join(root, "no-such-python") });
  check("build die(): bad relight, and no depth map + no model (the model is never fetched or run by the build)");
}

{
  // ---------- opt-in: no relight key -> the recording plays as is ----------
  const dir = project({});
  build(dir);
  assert.match(html(dir), /<video id="take-0" src="assets\/talk\.mp4"/);
  assert.ok(!fs.readdirSync(path.join(dir, "assets")).some((f) => /relit/.test(f)), "no relit file without the key");
  const off = project({ relight: false });
  build(off);
  assert.equal(html(off), html(dir), "relight: false is the same as no key");
  check("opt-in: no relight (or relight: false) -> assets/talk.mp4, no relit file");
}

const python = [process.env.PHANTASIC_PYTHON, "python3", "python", "py"].filter(Boolean).find((c) => spawnSync(c, ["-c", "import cv2, numpy"], { stdio: "ignore" }).status === 0);
if (!python) {
  console.log("skip  build-relight: the relight.py parts (no python with OpenCV and numpy)");
} else {
  // ---------- relight.py on its own (--frame) ----------
  const png = path.join(root, "frame.png");
  const r = spawnSync(python, [path.join(HERE, "relight.py"), path.join(root, "talk.mp4"), path.join(root, "depth.mp4"), png, "--look", "empire", "--frame"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.statSync(png).size > 1000, "relight.py --frame wrote the side-by-side");
  check("relight.py --look empire --frame on the stub depth");

  // depth_map.py refuses a model file whose sha256 is not the manifest's, before loading it (a junk "model", never run)
  const junk = path.join(root, "junk-models"); fs.mkdirSync(junk);
  fs.writeFileSync(path.join(junk, "depth-anything-v2-small.onnx"), "not a model");
  const dm = spawnSync(python, [path.join(HERE, "depth_map.py"), path.join(root, "talk.mp4"), path.join(root, "d.mp4")], { encoding: "utf8", env: { ...process.env, PHANTASIC_MODELS: junk } });
  assert.notEqual(dm.status, 0);
  assert.match(dm.stderr, /does not match the sha256 in library\/models\.json \(afb6a5c2/);
  assert.ok(!fs.existsSync(path.join(root, "d.mp4")), "nothing written");
  check("depth_map.py: a model file with the wrong sha256 is refused before it is loaded");

  // ---------- the build with a stub depth ----------
  const dir = project({ relight: { strength: 1.2 } });
  const log = build(dir);
  const page = html(dir);
  const m = page.match(/<video id="take-0" src="(assets\/talk-relit-[0-9a-f]{8}\.mp4)"/);
  assert.ok(m, "take 0 plays the relit file: " + page.match(/<video id="take-0"[^>]*>/)?.[0]);
  const relit = m[1];
  assert.match(page, new RegExp(`<video id="take-1" src="${relit.replace(/[.]/g, "\\.")}"`), "take 1 too");
  assert.match(page, /<audio id="take-0-audio" src="assets\/talk\.mp4"/, "the voice stays the recording");
  assert.match(log, /relighting assets\/talk\.mp4/);
  assert.ok(!/depth map of/.test(log), "the stub depth is used, the model is not run");
  const relitAbs = path.join(dir, relit);
  assert.equal(frames(relitAbs), frames(path.join(dir, "assets", "talk.mp4")), "relit file keeps every frame");
  // the hold still is grabbed from the relit file (it is the media the tags play)
  const hold = execFileSync("ffmpeg", ["-v", "error", "-i", path.join(dir, "assets", "hold-0.jpg"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const plain = rgbAt(path.join(dir, "assets", "talk.mp4"), 1.3);
  const lit = rgbAt(relitAbs, 1.0);
  assert.notDeepEqual(gainIn(plain, hold, [0.3, 0.45, 0.45, 0.65]).map((g) => +g.toFixed(2)), [1, 1, 1], "the hold still is relit");
  // the look on a flat grey source: left half of the subject redder, right half bluer, the room darker than the subject
  const nl = gainIn(plain, lit, [0.30, 0.45, 0.40, 0.70]), nr = gainIn(plain, lit, [0.55, 0.70, 0.40, 0.70]);
  const farTop = gainIn(plain, lit, [0.05, 0.95, 0.0, 0.08]);
  assert.ok(nl[0] > nl[2] + 0.1, `left of the subject: red gain ${nl[0].toFixed(3)} > blue ${nl[2].toFixed(3)}`);
  assert.ok(nr[2] > nr[0] + 0.1, `right of the subject: blue gain ${nr[2].toFixed(3)} > red ${nr[0].toFixed(3)}`);
  const lum = (g) => 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  assert.ok(lum(nl) > lum(farTop) + 0.08 && lum(nr) > lum(farTop) + 0.08, `depth falloff: subject ${lum(nl).toFixed(3)} / ${lum(nr).toFixed(3)} vs room ${lum(farTop).toFixed(3)}`);
  assert.ok(lum(farTop) < 1, `the far room is dimmed (${lum(farTop).toFixed(3)}), never brightened`);
  check(`build: tags + hold read ${relit}; red left ${nl.map((g) => g.toFixed(2))}, blue right ${nr.map((g) => g.toFixed(2))}, room ${farTop.map((g) => g.toFixed(2))}`);

  // ---------- cached + deterministic, and the params are in the hash ----------
  const again = build(dir);
  assert.ok(!/relighting/.test(again), "second build reuses the relit file");
  assert.equal(html(dir), page, "same page twice");
  const sections = JSON.parse(fs.readFileSync(path.join(dir, "build", "sections.json"), "utf8"));
  const other = project({ relight: { strength: 0.5 } });
  build(other);
  const m2 = html(other).match(/src="(assets\/talk-relit-[0-9a-f]{8}\.mp4)"/);
  assert.ok(m2 && m2[1] !== relit, "other params -> another relit file");
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(other, "build", "sections.json"), "utf8")).globalHash, sections.globalHash, "relight params are in globalHash");
  check("cached on rebuild, same page; params change the file hash and globalHash");

  // ---------- with matte: the cut-out carries the relit colour and keeps its alpha ----------
  const md = project({ relight: { strength: 1.2 }, matte: true }, { matte: true });
  build(md);
  const mm = html(md).match(/<video id="matte-0" class="matte" src="(assets\/talk-matte-relit-[0-9a-f]{8}\.webm)"/);
  assert.ok(mm, "the cut-out reads the relit matte: " + html(md).match(/<video id="matte-0"[^>]*>/)?.[0]);
  const mAbs = path.join(md, mm[1]);
  const alpha = execFileSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-ss", "1", "-i", mAbs, "-frames:v", "1", "-vf", "alphaextract", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  assert.ok(alpha[Math.round(H * 0.55) * W + W / 2] > 200 && alpha[2 * W + 2] < 30, "alpha kept: opaque on the subject, clear in the corner");
  const mrgb = rgbAt(mAbs, 1.0, ["-c:v", "libvpx-vp9"]), lit2 = rgbAt(path.join(md, html(md).match(/<video id="take-0" src="([^"]+)"/)[1]), 1.0);
  const g = gainIn(lit2, mrgb, [0.40, 0.60, 0.45, 0.65]);
  assert.ok(g.every((v) => Math.abs(v - 1) < 0.06), `cut-out colour = relit colour on the subject (${g.map((v) => v.toFixed(3))})`);
  check(`matte: ${mm[1]} keeps the alpha and shows the relit subject`);

  // ---------- the depth cache is keyed on the recording's content (not its name) ----------
  const kd = project({ relight: {} }, { depth: false });
  const k1 = RL.depthRelOf(kd, "assets/talk.mp4");
  assert.equal(k1.override, false);
  assert.match(k1.rel, /^assets\/talk-depth-[0-9a-f]{8}\.mp4$/);
  fs.copyFileSync(path.join(root, "depth.mp4"), path.join(kd, k1.rel));      // stands in for depth_map.py's output under its key
  const kl = build(kd);
  assert.ok(!/depth map of/.test(kl), "keyed depth found, model not run");
  const r1 = html(kd).match(/src="(assets\/talk-relit-[0-9a-f]{8}\.mp4)"/)[1];
  // re-record: same name, same length, another picture -> a new depth key (the build asks for a new depth map instead of reusing
  // the old one), and once that exists, a new relit file
  ff("-f", "lavfi", "-i", `color=c=0x5a6a7a:size=${W}x${H}:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=300:duration=${SEC}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(kd, "assets", "talk.mp4"));
  const k2 = RL.depthRelOf(kd, "assets/talk.mp4");
  assert.notEqual(k2.rel, k1.rel, "new footage -> new depth key");
  fails(kd, new RegExp(`no depth map at ${k2.rel.replace(/\./g, "\\.")} and no depth model`));
  fs.copyFileSync(path.join(root, "depth.mp4"), path.join(kd, k2.rel));
  const kl2 = build(kd);
  const r2 = html(kd).match(/src="(assets\/talk-relit-[0-9a-f]{8}\.mp4)"/)[1];
  assert.notEqual(r2, r1, "new footage -> new relit file");
  assert.match(kl2, /relighting assets\/talk\.mp4/);
  assert.ok([k1.rel, k2.rel, r1, r2].every((f) => fs.existsSync(path.join(kd, f))), "both depth and both relit files exist");
  check(`depth keyed on content: re-recorded talk.mp4 -> ${k1.rel} becomes ${k2.rel}, relit ${r1} becomes ${r2}`);

  // ---------- a depth video with the wrong frame count is refused, not padded ----------
  const fc = project({ relight: {} }, { depth: false });
  ff("-i", path.join(root, "depth.mp4"), "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(fc, "assets", "talk-depth.mp4"));
  fails(fc, /ERROR: relight: relight\.py failed on assets\/talk\.mp4: relight\.py: depth video .* has a different frame count than .*ran out after 60 frames/);
  assert.ok(!fs.readdirSync(path.join(fc, "assets")).some((f) => /relit/.test(f)), "no relit file (nor .part) left behind");
  const fc2 = project({ relight: {} }, { depth: false });
  ff("-f", "lavfi", "-i", `color=c=gray:size=${DW}x${DH}:rate=${FPS}:duration=${SEC + 1}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(fc2, "assets", "talk-depth.mp4"));
  fails(fc2, /different frame count .*30 frames too many/);
  check("depth frame count != source: refused both ways (shorter, longer), nothing cached");

  // ---------- relight + a matteClip WINDOW cut-out (no whole-recording matte cached) ----------
  // Only recording 0.467-3.033 s (from frame 14) is cut out (assets/talk-matte@467-3033.webm); the cut-out must carry the relit
  // colour of those SAME frames. The source's grey steps 9 levels a frame (a 20-frame sawtooth), so every frame names its source
  // frame (mod 20) and a one-frame slip is visible. A fake npx writes a stub cut-out that keeps the window's own pixels, with
  // the ALPHA inside the ellipse = the frame's grey too (so the alpha names its frame), and like the real remove-background
  // window files (r_frame_rate 151/5, 1/1000 time base) its timestamps step 33 ms, not 1/30 s: they drift ~0.33 ms a frame,
  // so pairing by time slips a frame after ~50 frames while pairing by index does not. The invariant: frame j of the RELIT window cut-out shows
  // the same source frame as frame j of the un-lit window cut-out. Run twice: a source whose video starts at 0, and one whose
  // video starts at 0.033 s with the audio at 0 (as prep.sh's and phone files do; every decoder then repeats frame 0).
  if (process.platform !== "win32") {
    const wNpx = path.join(root, "win-npx"), wLog = path.join(root, "win-npx.log"); fs.mkdirSync(wNpx);
    fs.writeFileSync(path.join(wNpx, "npx"), `#!/bin/sh
in=""; out=""; prev=""
for a in "$@"; do [ "$prev" = "remove-background" ] && in="$a"; [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
echo "$in" >> "${wLog}"
exec ffmpeg -v error -y -i "$in" -vf "format=yuva420p,geq=lum='p(X\\,Y)':cb='p(X\\,Y)':cr='p(X\\,Y)':a='if(lt(hypot((X-${W / 2})/32\\,(Y-${H * 0.55})/60)\\,1)\\,lum(X\\,Y)\\,0)',setpts=N*33/(1000*TB)" -fps_mode passthrough -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 "$out"
`, { mode: 0o755 });
    const wEnv = { [pathKey]: wNpx + path.delimiter + SAFE_ENV[pathKey], MATTE_THREADS: "" };
    const lumas = (f, dec = []) => { const N = W * H, b = execFileSync("ffmpeg", ["-v", "error", ...dec, "-i", f, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 28 }); return Array.from({ length: Math.floor(b.length / N) }, (_, k) => b[k * N + Math.round(H * 0.55) * W + W / 2]); };
    for (const start of [0, 0.033]) {
      fs.writeFileSync(wLog, "");
      const wd = project({ relight: { strength: 1.2 }, matte: true, matteWindows: true, matteClip: true, takes: [{ a: 0, b: SEC }], beats: [{ type: "behind", text: "SIDE", at: 1.5, to: 2.0 }] }, { depth: false });
      fs.writeFileSync(path.join(wd, "build", "headtop.json"), JSON.stringify(Array.from({ length: 20 }, (_, i) => [+(i / 5).toFixed(2), 40])));
      const talk = path.join(wd, "assets", "talk.mp4"), raw = path.join(root, `saw-${start}.mp4`);
      ff("-f", "lavfi", "-i", `color=c=black:size=${W}x${H}:rate=${FPS}:duration=${SEC},format=yuv420p,geq=lum='30+mod(N\\,20)*9':cb=128:cr=128`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", raw);
      if (start) ff("-itsoffset", String(start), "-i", raw, "-i", raw, "-map", "0:v", "-map", "1:a", "-c", "copy", talk);
      else fs.copyFileSync(raw, talk);
      const st = +execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=start_time", "-of", "csv=p=0", talk]).toString().trim();
      assert.ok(Math.abs(st - start) < 0.002, `talk.mp4 video starts at ${st}, wanted ${start}`);
      // the stub depth with as many frames as relight.py decodes from the source (one more when frame 0 is repeated)
      const nDec = lumas(talk).length;
      ff("-i", path.join(root, "depth.mp4"), "-vf", `tpad=stop_mode=clone:stop=${nDec - 90},trim=end_frame=${nDec}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(wd, "assets", "talk-depth.mp4"));
      build(wd, wEnv);
      const wp = html(wd);
      assert.equal(fs.readFileSync(wLog, "utf8").trim().split("\n").length, 1, "remove-background ran once, on the window");
      const winRaw = path.join(wd, "assets", "talk-matte@467-3033.webm");
      assert.ok(fs.existsSync(winRaw) && !fs.existsSync(path.join(wd, "assets", "talk-matte.webm")), "window cut, no whole-recording matte");
      const wm = wp.match(/<video id="matte-0" class="matte" src="(assets\/talk-matte-relit-[0-9a-f]{8}\.webm)" data-start="1\.48" data-duration="0\.54" data-media-start="1\.013"/);
      assert.ok(wm, "the clipped cut-out reads the RELIT window file at the window offset: " + wp.match(/<video id="matte-0"[^>]*>/)?.[0]);
      const wAbs = path.join(wd, wm[1]), relitW = path.join(wd, wp.match(/<video id="take-0" src="([^"]+)"/)[1]);
      // source level (0..19) of each frame: the un-lit window from its own grey; the relit window by the nearest relit level
      // (the relit recording's subject-centre lumas fall in 20 clusters, one per level, in order: the stub depth does not move)
      const vp9 = ["-c:v", "libvpx-vp9"];
      // level of a luma = the index of the nearest of the 20 clusters (sorted) of a reference file's lumas
      const levels = (ref, what) => {
        const sorted = [...ref].sort((p, q) => p - q), centres = [];
        for (let i = 0, c = []; i <= sorted.length; i++) { if (i === sorted.length || (c.length && sorted[i] - c.at(-1) > 3)) { centres.push(c.reduce((x, y) => x + y, 0) / c.length); c = []; } if (i < sorted.length) c.push(sorted[i]); }
        assert.equal(centres.length, 20, `20 ${what} levels (${centres.map((c) => c.toFixed(0))})`);
        return (y) => centres.reduce((bi, c, k) => (Math.abs(c - y) < Math.abs(centres[bi] - y) ? k : bi), 0);
      };
      const rawL = lumas(winRaw, vp9), lvRaw = rawL.map(levels(rawL, "un-lit"));
      const lvLit = lumas(wAbs, vp9).map(levels(lumas(relitW), "relit"));
      const bad = lvLit.map((l, j) => [j, lvRaw[j], l]).filter(([, r, l]) => r !== l);
      // and the ALPHA, frame by frame: frame j of the relit window carries the alpha of frame j of the window cut-out
      const alphas = (f) => { const N = W * H, b = execFileSync("ffmpeg", ["-v", "error", ...vp9, "-i", f, "-vf", "alphaextract", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 28 }); return Array.from({ length: Math.floor(b.length / N) }, (_, k) => b[k * N + Math.round(H * 0.55) * W + W / 2]); };
      const aRaw = alphas(winRaw), aLvRaw = aRaw.map(levels(aRaw, "un-lit alpha")), aLit = alphas(wAbs), aLvLit = aLit.map(levels(aRaw, "un-lit alpha"));
      const badA = aLvLit.map((l, j) => [j, aLvRaw[j], l]).filter(([, r, l]) => r !== l);
      assert.equal(badA.length, 0, `start ${start}: relit window frame carries another frame's alpha than the window cut-out at [j, cut-out, relit] ${JSON.stringify(badA.slice(0, 5))} (${badA.length} frames)`);
      assert.equal(bad.length, 0, `start ${start}: relit window frame shows another source frame than the un-lit window at [j, unlit, relit] ${JSON.stringify(bad.slice(0, 5))}`);
      assert.equal(lvLit.length, lvRaw.length, "the relit window cut-out has as many frames as the window cut-out");
      // cached: a second build cuts and relights nothing, same page
      const wl2 = build(wd, wEnv);
      assert.ok(!/relit cut-out of/.test(wl2) && fs.readFileSync(wLog, "utf8").trim().split("\n").length === 1, "cached");
      assert.equal(html(wd), wp, "same page twice");
      check(`relight + matteClip window cut (video starts at ${start} s, ${nDec} frames decoded): ${wm[1]}, all ${lvLit.length} frames show the un-lit window's source frame and carry its alpha, cached`);
    }
  }
}
console.log("build-relight: all checks passed");

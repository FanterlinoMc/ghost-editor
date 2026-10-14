#!/usr/bin/env node
// node scripts/build-review-fixes.test.mjs
// The engine review fixes ported from phantasic engine/review-fixes (a30d106) onto the fork:
//   - tail hold: build/tail.json only when an outro exists and nothing full-frame covers it; tailhold.py holds the
//     last styled frame over the raw outro still
//   - behind-word legibility gate (spec.legibility.behind): off by default; moves a word above the head or draws it
//     in front of the speaker, and says so as a WARNING (never a failure)
//   - captions stay hidden under a page that runs to the end of speech
//   - watermark kept out of the top 8% of the frame
//   - stack contrast guard on a light card page
// Sources are tiny lavfi files, like build-blank.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs"), TAILHOLD = path.join(HERE, "tailhold.py");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-review-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 6, FPS = 30;
ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));

const words = { segments: [{ start: 0, end: SEC, words: "hello there this is the talking head speaking for a few seconds now".split(" ").map((w, i) => ({ word: w, start: +(0.3 + i * 0.35).toFixed(2), end: +(0.55 + i * 0.35).toFixed(2) })) }] };
const faceAt = (top, bottom, eyes, mouth) => ({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 5 }, (_, i) => [i * 2, top, bottom, 340, 740, eyes, mouth]) });

let n = 0;
function project(reel, { face = faceAt(300, 900, 480, 700), matte = false } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  if (matte) fs.writeFileSync(path.join(dir, "assets", "talk-matte.webm"), "stub");   // cached: build.mjs skips remove-background
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "review fixes", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0, music: null, style: "clean", zoom: {}, takes: [{ a: 0, b: SEC }], beats: [], ...reel }, null, 2));
  return dir;
}
const build = (dir) => { const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const tailPath = (dir) => path.join(dir, "build", "tail.json");
const check = (label) => console.log(`ok    ${label}`);

try {
  // ---- tail hold ----
  let dir = project({ outro: 2 });
  build(dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(tailPath(dir), "utf8")), { speech: 6, total: 8, fps: FPS, hold: true });
  check("outro with nothing over it writes tail.json {hold:true}");

  dir = project({ outro: 2, beats: [{ type: "endcard", at: 6, title: "Follow" }] });
  build(dir);
  assert.equal(fs.existsSync(tailPath(dir)), false);
  check("an end card over the outro: no tail.json");

  dir = project({ outro: 2, outroFade: true });
  build(dir);
  assert.equal(fs.existsSync(tailPath(dir)), false);
  check("outroFade: no tail.json");

  dir = project({ outro: 0 });
  build(dir);
  assert.equal(fs.existsSync(tailPath(dir)), false);
  check("no outro: no tail.json");

  dir = project({ outro: 2 });
  build(dir);
  assert.equal(fs.existsSync(tailPath(dir)), true);
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, "reel.json"), "utf8")), beats: [{ type: "endcard", at: 6 }] }));
  build(dir);
  assert.equal(fs.existsSync(tailPath(dir)), false);
  check("a stale tail.json is removed when the reel now ends on a page");

  // tailhold.py end to end: a 8 s render whose last 2 s are a different colour must come out with the 6 s frame held
  const rend = path.join(root, "reel.mp4");
  ff("-f", "lavfi", "-i", `color=c=red:size=108x192:rate=${FPS}:duration=6`, "-f", "lavfi", "-i", `color=c=blue:size=108x192:rate=${FPS}:duration=2`, "-f", "lavfi", "-i", "sine=frequency=300:duration=8",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", rend);
  const py = process.platform === "win32" ? ["py", ["-3"]] : ["python3", []];
  const tdir = project({ outro: 2 });
  build(tdir);
  execFileSync(py[0], [...py[1], TAILHOLD, rend, tailPath(tdir)], { stdio: "pipe" });
  const px = (t) => execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", rend, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdio: "pipe" });
  const [r7, , b7] = px(7.5), [r2] = px(2);
  assert.ok(r2 > 150 && r7 > 150 && b7 < 100, `outro should hold the red frame, got rgb(${r7},_,${b7})`);
  const dur = +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", rend], { encoding: "utf8" }).trim();
  assert.ok(Math.abs(dur - 8) < 0.1, `duration ${dur}`);
  check("tailhold.py holds the last styled frame over the outro, same length");

  // ---- behind-word legibility gate ----
  const behind = { type: "behind", at: 1, to: 4, text: "HELLO" };
  // head sits low in frame: default word position overlaps the head
  const lowHead = faceAt(900, 1500, 1000, 1300);
  dir = project({ matte: true, beats: [behind] }, { face: lowHead, matte: true });
  let out = build(dir);
  assert.doesNotMatch(out, /visible behind the head/);
  const plain = html(dir);
  check("legibility gate is OFF unless spec.legibility.behind is set");

  dir = project({ matte: true, legibility: { behind: 0.95 }, beats: [behind] }, { face: lowHead, matte: true });
  out = build(dir);
  assert.match(out, /behind word "HELLO" at 1: \d+% visible behind the head, moved above it/);
  assert.notEqual(html(dir), plain);
  check("a word hidden more than allowed moves above the head (warning)");

  // head high in frame: no headroom above it -> in front of the speaker
  dir = project({ matte: true, legibility: { behind: 0.95 }, beats: [behind] }, { matte: true });
  out = build(dir);
  assert.match(out, /no headroom, drawn in front of the speaker/);
  assert.match(html(dir), /text-shadow:0 6px 28px rgba\(0,0,0,\.45\)/);
  check("no headroom: drawn in front of the speaker with a soft shadow (warning)");

  // ---- captions stay hidden under a page that runs to the end of speech ----
  const scene = { type: "scene", kind: "stack", at: 4, to: 6, lead: "this is", key: "IT", bg: "accent" };
  dir = project({ outro: 2, beats: [scene] });
  build(dir);
  const capsBack = [...html(dir).matchAll(/"#caps", \{ autoAlpha: 1, duration: 0\.12 \}, ([0-9.]+)\)/g)].map((m) => +m[1]);
  assert.ok(capsBack.every((t) => t > 8), `captions faded back in at ${capsBack}`);
  dir = project({ outro: 2, beats: [{ ...scene, to: 5 }] });
  build(dir);
  const capsBack2 = [...html(dir).matchAll(/"#caps", \{ autoAlpha: 1, duration: 0\.12 \}, ([0-9.]+)\)/g)].map((m) => +m[1]);
  assert.ok(capsBack2.some((t) => t < 6), `a page ending mid-speech must still let captions back (${capsBack2})`);
  check("captions stay hidden under a page that runs to the end of speech, and only then");

  // ---- watermark out of the top 8% ----
  dir = project({ watermark: { text: "brand", y: 40 } });
  build(dir);
  assert.match(html(dir), /position:absolute;top:154px;right:60px/);
  dir = project({ watermark: { text: "brand", y: 400 } });
  build(dir);
  assert.match(html(dir), /position:absolute;top:400px;right:60px/);
  check("watermark is pushed below the top 8% and a lower y is untouched");

  // ---- stack contrast guard: a light card page gets a dark ink ----
  const stack = { type: "scene", kind: "stack", at: 1, to: 4, lead: "this is", key: "IT", bg: "card" };
  dir = project({ beats: [stack], brand: { accent: "#F4EFE6" } });
  build(dir);
  const lightHtml = html(dir);
  assert.match(lightHtml, /text-shadow:0 0 18px rgba\(255,255,255,\.7\)/);
  assert.doesNotMatch(lightHtml, /--ink:#fff/);
  dir = project({ beats: [stack], brand: { accent: "#7A1426" } });
  build(dir);
  assert.match(html(dir), /--ink:#fff/);
  assert.doesNotMatch(html(dir), /text-shadow:0 0 18px rgba\(255,255,255,\.7\)/);
  check("light card page: dark ink + soft halo; dark page unchanged");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("\nbuild review-fixes: ok");

#!/usr/bin/env node
// node scripts/build-ahmed-library.test.mjs
// Phase B1 of "merge the rest of Ahmed's work": the RENDERER features of his library bundle, each opt-in. Hand ports of phantasic
// engine/core (origin/main). One section per feature; a reel that does not set a new key builds exactly as before (the byte-identity
// gate covers that, this file checks that the feature itself is in the HTML).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-library-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 12, FPS = 30;
const mk = (name, freq) => ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, name));
mk("talk.mp4", 200); mk("talk-1.mp4", 300);

const text = "why does money matter so much. because time is remarkable and scary. the remarkable thing is scary. a community far away lives on an isolated island. money and time again. remarkable people keep going. it is scary but remarkable. thank you for watching.".split(" ");
const wordsFor = (n) => ({ segments: [{ start: 0, end: SEC, words: Array.from({ length: n }, (_, i) => ({ word: text[i % text.length], start: +(0.3 + i * 0.3).toFixed(2), end: +(0.55 + i * 0.3).toFixed(2) })) }] });
const faceAt = (left, right) => ({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 7 }, (_, i) => [i * 2, 300, 780, left, right, 450, 650]) });

let n = 0;
// matte: stub the cut-out files the build would otherwise cut with `npx hyperframes remove-background` (far too heavy for a test)
function project(reel, { second = false, matte = false, face1 = true } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(wordsFor(second ? 18 : 38)));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(faceAt(340, 740)));
  if (second) {
    fs.copyFileSync(path.join(root, "talk-1.mp4"), path.join(dir, "assets", "talk-1.mp4"));
    fs.writeFileSync(path.join(dir, "build", "words-1.whisper.json"), JSON.stringify(wordsFor(18)));
    if (face1) fs.writeFileSync(path.join(dir, "build", "face-1.json"), JSON.stringify(faceAt(200, 400)));
  }
  if (matte) {
    fs.writeFileSync(path.join(dir, "assets", "talk-matte.webm"), "stub");
    if (second && face1) fs.writeFileSync(path.join(dir, "assets", "talk-1-matte.webm"), "stub");
  }
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "lib", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.4, zoom: {}, takes: [{ a: 0, b: SEC }], beats: [], ...reel }, null, 2));
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8" });
const build = (dir) => { const r = run(dir); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const check = (label) => console.log(`ok    ${label}`);
const count = (s, re) => (s.match(re) || []).length;

try {
  // ================= ground beat =================
  let dir = project({ matte: true, beats: [{ type: "ground", at: 2, to: 5, paper: "grid", text: "MONEY", hideCaptions: true, lead: "a small line" }] }, { matte: true });
  let log = build(dir);
  let h = html(dir);
  const gi = h.indexOf('class="clip ground"');
  assert.ok(gi > 0 && gi < h.indexOf('id="matte-0"'), "the page sits behind the cut-out (between the plate and the matte)");
  assert.ok(h.includes("MONEY") && h.includes("a small line") && h.includes("background-size:54px 54px"), "word, lead line and grid paper");
  assert.ok(h.includes('tl.set("#b0", { autoAlpha: 0 }, 0); tl.set("#b0", { autoAlpha: 1 }, 2);'), "a cut: hidden at 0, shown at at");
  assert.ok(/tl\.set\("\.cw, \.cap-group[^"]*", \{ color: "#111"/.test(h), "captions switch to dark ink on a light page");
  assert.ok(!h.includes('id="b0-in"') && !h.includes('<div id="b0" class="clip layer"'), "a ground adds no overlay layer and no exit tween");
  const caps = [...h.matchAll(/tl\.to\("#caps", \{ autoAlpha: 0, duration: 0\.08 \}, ([\d.]+)\)/g)].map((m) => Number(m[1]));
  assert.ok(caps.some((t) => Math.abs(t - 2) < 0.01), "hideCaptions hides the captions from at");
  check("ground: behind the matte, word + lead, grid, dark caption ink, hideCaptions, no overlay layer");

  // frame 0: only the "show" set, never a hide and a show at the same instant
  dir = project({ matte: true, beats: [{ type: "ground", at: 0, to: 3, color: "#7a1020" }] }, { matte: true });
  build(dir); h = html(dir);
  assert.ok(h.includes('tl.set("#b0", { autoAlpha: 1 }, 0);') && !h.includes('tl.set("#b0", { autoAlpha: 0 }, 0)'), "ground from frame 0: one set, no hide");
  check("ground at frame 0: a single show set (no hide at the same instant)");

  // fade-in; ground pages skip the brand tint (look-ov), only when a ground exists
  dir = project({ matte: true, look: { tint: { color: "#123456" } }, beats: [{ type: "ground", at: 2, to: 4, paper: "cream", in: "fade" }] }, { matte: true });
  build(dir); h = html(dir);
  assert.ok(h.includes('ft("#b0", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 }, 2);'), "in: fade");
  assert.ok(/<div class="look-ov" style="position:absolute;inset:0;z-index:3/.test(h), "the brand tint is marked look-ov");
  assert.ok(h.includes('tl.set(".look-ov", { visibility: "hidden" }, 2);') && h.includes('tl.set(".look-ov", { visibility: "visible" }, 4);'), "tint hidden while the page is up");
  dir = project({ look: { tint: { color: "#123456" } } });
  build(dir); h = html(dir);
  assert.ok(!h.includes("look-ov"), "no ground: no look-ov markup at all");
  check("ground: fade-in, tint switched off while up, and no look-ov without a ground");

  // matteWindows: the cut-out only inside behind/ground windows
  dir = project({ matte: true, matteWindows: true, beats: [{ type: "ground", at: 3, to: 5, paper: "white" }] }, { matte: true });
  build(dir); h = html(dir);
  assert.ok(h.includes('tl.set(".matte", { autoAlpha: 0 }, 0);') && h.includes('tl.set(".matte", { autoAlpha: 1 }, 2.98);') && h.includes('tl.set(".matte", { autoAlpha: 0 }, 5.02);'), "matteWindows");
  check("matteWindows: the cut-out shows only in the ground window");

  // a ground needs the matte
  dir = project({ beats: [{ type: "ground", at: 2, to: 4, paper: "white" }] });
  let r = run(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /'ground' beat needs "matte": true/);
  check("ground without matte: refused with a clear message");

  // two recordings: per-take mattes (previously a die), and the ground sits behind both
  const TAKES2 = [{ a: 0, b: 6, src: "assets/talk.mp4" }, { a: 0, b: 6, src: "assets/talk-1.mp4" }];
  dir = project({ matte: true, takes: TAKES2, beats: [{ type: "ground", at: 1, to: 5, paper: "grid", src: "assets/talk.mp4" }] }, { second: true, matte: true });
  build(dir); h = html(dir);
  assert.ok(h.includes('id="matte-0" class="matte" src="assets/talk-matte.webm"') && h.includes('id="matte-1" class="matte" src="assets/talk-1-matte.webm"'), "each take reads its own recording's matte");
  check("ground, two recordings: take 0 reads talk-matte.webm, take 1 reads talk-1-matte.webm");

  // a recording with no face track has no cut-out: warned, not fatal
  dir = project({ matte: true, takes: TAKES2, beats: [{ type: "ground", at: { src: "assets/talk.mp4", t: 1 }, to: { src: "assets/talk-1.mp4", t: 3 }, paper: "white" }] }, { second: true, matte: true, face1: false });
  log = build(dir);
  assert.match(log, /ground at 1s: assets\/talk-1\.mp4 has no face track/);
  check("ground over a take with no face track: warned");

  // multi-source matte without a ground is still refused
  dir = project({ matte: true, takes: TAKES2 }, { second: true, matte: true });
  r = run(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /spec\.matte with 2 sources is not supported/);
  check("matte on two recordings with no ground/stage: still refused");

  console.log("\nall build-ahmed-library tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

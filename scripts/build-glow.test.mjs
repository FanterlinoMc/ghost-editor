#!/usr/bin/env node
// node scripts/build-glow.test.mjs
// Podcast Glow (style id podcast-glow + colour variants), hand-ported from phantasic engine/core
// (d8bb43a v0.1, 866dc8f v0.2, 6c66be0 v0.3, 4e89201 v0.4, e42f769 v0.5, 684837f colour themes):
//   - captions.style "glow": one word at a time, heavy yellow caps with a glow, fixed height, logged for caption_layout.json
//   - the `headline` beat (small white line + a HUGE condensed word), Anton loaded only when a headline exists
//   - spec.stage: the speaker cut out on a designed set, with windows / sets / sideFade / fixedScale / offsetY - and PER SOURCE:
//     each take reads the cut-out of its own recording, a recording with no face track keeps its plate
//   - "pack:<name>" sfx: a missing pack warns and is skipped (the fork ships none)
//   - glow_plan.py writes headline beats from a transcript
// The matte itself (hyperframes remove-background, an ONNX person-segmentation model) is not run here: the test places the
// cached matte and head-top files the build would otherwise create. Sources are tiny lavfi files.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs"), PLAN = path.join(HERE, "glow_plan.py");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-glow-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 12, FPS = 30;
const mk = (name, freq) => ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, name));
mk("talk.mp4", 200); mk("talk-1.mp4", 300);
ff("-f", "lavfi", "-i", `color=c=0x203040:size=108x192:rate=${FPS}:duration=3`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "set.mp4"));
const packDir = path.join(root, "pack");
fs.mkdirSync(packDir);
ff("-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", path.join(packDir, "s-hit.wav"));

const text = "so we have no idea what this really costs and nobody is dying to tell you the truth about it because the number is huge. then we measure the savings again and again until the value is clear to everyone in the room today. finally the answer is simple".split(" ");
const wordsFor = (n, t0 = 0.3) => ({ segments: [{ start: 0, end: SEC, words: Array.from({ length: n }, (_, i) => ({ word: text[i % text.length], start: +(t0 + i * 0.3).toFixed(2), end: +(t0 + 0.22 + i * 0.3).toFixed(2) })) }] });
const faceAt = (left, right) => ({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 7 }, (_, i) => [i * 2, 400, 1000, left, right, 560, 800]) });
const headTrack = (top) => Array.from({ length: 61 }, (_, i) => [+(i / 5).toFixed(2), top]);

let n = 0;
function project(reel, { second = false, face1 = true, matte = false } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.copyFileSync(path.join(root, "set.mp4"), path.join(dir, "assets", "set.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(wordsFor(second ? 18 : 40)));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(faceAt(340, 740)));
  if (second) {
    fs.copyFileSync(path.join(root, "talk-1.mp4"), path.join(dir, "assets", "talk-1.mp4"));
    fs.writeFileSync(path.join(dir, "build", "words-1.whisper.json"), JSON.stringify(wordsFor(18)));
    if (face1) fs.writeFileSync(path.join(dir, "build", "face-1.json"), JSON.stringify(faceAt(200, 400)));
  }
  if (matte) {   // the files the build would cut: a cached matte per recording and its head-top track
    fs.writeFileSync(path.join(dir, "assets", "talk-matte.webm"), "stub");
    fs.writeFileSync(path.join(dir, "build", "headtop.json"), JSON.stringify(headTrack(300)));
    if (second && face1) {
      fs.writeFileSync(path.join(dir, "assets", "talk-1-matte.webm"), "stub");
      fs.writeFileSync(path.join(dir, "build", "headtop-talk-1.json"), JSON.stringify(headTrack(500)));
    }
  }
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "glow", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.15, takes: [{ a: 0, b: SEC }], beats: [], ...reel }, null, 2));
  return dir;
}
// a refusing npx first on PATH: a reel that would cut a matte without a stub fails in a second instead of running remove-background
const noNpx = path.join(root, "no-npx");
fs.mkdirSync(noNpx);
fs.writeFileSync(path.join(noNpx, "npx"), "#!/bin/sh\necho 'npx refused in build-glow.test (stub the matte)' >&2\nexit 1\n", { mode: 0o755 });
fs.writeFileSync(path.join(noNpx, "npx.cmd"), "@echo npx refused in build-glow.test (stub the matte) 1>&2\r\n@exit /b 1\r\n");
const run = (dir, env = {}) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: noNpx + path.delimiter + process.env.PATH, PHANTASIC_LIB: silentLibrary(), PHANTASIC_SFX_PACK: path.join(root, "no-such-pack"), ...env } });   // no audio: see lib/silent-library.mjs
const build = (dir, env) => { const r = run(dir, env); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const jsonOf = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, "build", f), "utf8"));
const check = (label) => console.log(`ok    ${label}`);
const count = (s, re) => (s.match(re) || []).length;
const HEAD = { type: "headline", small: "we have", big: "no idea", at: 3, to: 5, smallAt: [3.1, 3.4], bigAt: 3.8, arrow: "left" };

try {
  // ---- single source, podcast-glow, a headline beat ----
  let dir = project({ style: "podcast-glow", beats: [HEAD, { ...HEAD, at: 7, to: 8.5, bigAt: 7.4, pos: "top", arrow: undefined, small: "", smallAt: [] }] }, { matte: true });
  let log = build(dir);
  let h = html(dir);
  assert.ok(count(h, /class="gw clip"/g) > 10, "one glow word per group");
  assert.match(h, /\.gw \{ position: absolute; left: 50%;[^}]*font-weight: 800/);
  assert.match(h, /class="gw clip" style="top:1230px;font-size:\d+px;color:#FFD21E"/, "fixedY 1230, accent yellow");
  assert.ok(!h.includes('class="cap-group'), "no regular caption groups");
  check("glow captions: one word per block at y 1230, yellow, glow css");
  assert.ok(h.includes('class="hl-b"') && h.includes("NO IDEA") && h.includes(">WE<") && h.includes(">HAVE<"), "headline markup");
  assert.ok(h.includes("font-family: Anton, Oswald") && /font-family: "Anton"; src: url\(assets\/fonts\/anton-latin\.woff2\)/.test(h), "Anton is declared when a headline exists");
  assert.ok(fs.existsSync(path.join(dir, "assets", "fonts", "anton-latin.woff2")));
  assert.ok(h.includes('id="b0-ar"'), "arrow on the first headline");
  assert.ok(/#b\d+-b", \{ autoAlpha: 0, scale: 1\.45/.test(h), "big word slams in");
  check("headline beat: small line, big Anton word, arrow, slam; Anton only because a headline exists");
  const lay = fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8");
  assert.ok(lay.includes('"mode": "glow"'), "glow blocks reach caption_layout.json");
  assert.match(log, /music 'deep-techno-ambience' is not available on disk \(music\.optional\)/);
  assert.ok(!h.includes('id="music-bed"'));
  check("caption_layout.json logs the glow blocks; the unshipped bed is skipped with a warning");

  // ---- a reel without a headline: no Anton, no .hl css, no glow ----
  dir = project({ style: "clean" });
  build(dir);
  h = html(dir);
  for (const needle of ["Anton", ".hl-b {", 'class="gw', "stage-bg", "stage-choke"]) assert.ok(!h.includes(needle), `clean must not contain ${needle}`);
  assert.ok(!fs.existsSync(path.join(dir, "assets", "fonts", "anton-latin.woff2")));
  check("a reel with no headline / glow / stage carries none of it");

  // ---- colour variant ----
  dir = project({ style: "podcast-glow-blue" });
  build(dir);
  assert.match(html(dir), /class="gw clip" style="top:1230px;font-size:\d+px;color:#3EA8FF"/);
  assert.ok(html(dir).includes("#1a6bff"), "variant tint");
  check("podcast-glow-blue extends podcast-glow (caption colour + tint)");

  // ---- pack: sfx ----
  dir = project({ style: "podcast-glow", beats: [{ ...HEAD, sfx: "pack:s-hit" }] });
  log = build(dir);
  assert.match(log, /pack:s-hit \(sound pack: [^)]*no-such-pack\)/, "missing pack is a warning");
  dir = project({ style: "podcast-glow", beats: [{ ...HEAD, sfx: "pack:s-hit" }] });
  build(dir, { PHANTASIC_SFX_PACK: packDir });
  const ev = jsonOf(dir, "sfx_events.json").events.find((e) => e.id === "pack:s-hit");
  assert.ok(ev && ev.role === "impact" && ev.src === "assets/sfx/s-hit.wav", "pack sound is mixed as an impact");
  check("pack:<name> sfx: missing pack warns and skips, a present pack mixes as an impact");

  // ---- stage, single source ----
  const STAGE = { windows: [{ at: 1, to: 4, set: "main" }, { at: 6, to: 9, set: "alt" }], sets: { main: { video: "assets/set.mp4", grid: "rgba(0,200,200,.4)", glow: "rgba(255,180,0,.3)" }, alt: { grid: "rgba(255,255,255,.2)", gridSize: 64 } }, sideFade: 12, fixedScale: 0.9, offsetY: 40 };
  dir = project({ style: "podcast-glow", stage: STAGE, beats: [{ ...HEAD, behind: true }] }, { matte: true });
  log = build(dir);
  h = html(dir);
  assert.ok(h.includes('id="stage-subj"') && h.includes("translateY(40px) scale(0.9)"), "subject offsetY / fixedScale");
  assert.ok(h.includes('<filter id="stage-choke"'));
  assert.ok(h.includes('id="matte-0" class="matte" src="assets/talk-matte.webm"') && h.includes('id="matte-r0"') && h.includes('id="matte-b0"'), "cut-out and light wraps");
  assert.ok(h.includes("#000 12%, #000 88%"), "sideFade");
  assert.ok(h.includes('id="stage-w0"') && h.includes('id="stage-w1"') && h.includes('id="stage-wv0"') && !h.includes('id="stage-wv1"'), "two windows, only the first has a set video");
  assert.ok(fs.existsSync(path.join(dir, "assets", "stage-set-main.mp4")));
  assert.ok(h.includes("tl.set('video[id^=\"take-\"], img[id^=\"hold-\"]', { opacity: 0 }, 1)"), "plate hidden inside a window");
  assert.ok(!/video\[id\^="take-"\], img\[id\^="hold-"\] \{ opacity: 0 !important/.test(h), "windows: the plate is not hidden for the whole reel");
  const behindIdx = h.indexOf('class="clip behind"');
  assert.ok(behindIdx > 0 && behindIdx < h.indexOf('id="stage-subj"'), "a behind headline sits between the plate and the cut-out");
  check("stage (windows, sets, sideFade, fixedScale, offsetY, light wraps) + a behind-the-head headline");

  dir = project({ style: "podcast-glow", stage: { video: "assets/set.mp4", grid: "rgba(0,200,200,.4)" } }, { matte: true });
  build(dir);
  h = html(dir);
  assert.ok(h.includes('id="stage-set"') && /video\[id\^="take-"\], img\[id\^="hold-"\] \{ opacity: 0 !important; \}/.test(h), "no windows: set under the speaker for the whole reel, plate hidden");
  assert.match(log + build(dir), /stage: subject head top 300px -> subject scale/);
  check("stage without windows: a set for the whole reel, plate hidden, subject scale from the head-top track");

  // ---- stage, two recordings: each take reads its own recording's cut-out ----
  const TAKES2 = [{ a: 0, b: 6, src: "assets/talk.mp4" }, { a: 0, b: 6, src: "assets/talk-1.mp4" }];
  dir = project({ style: "podcast-glow", stage: { fixedScale: 1 }, takes: TAKES2 }, { second: true, matte: true });
  build(dir);
  h = html(dir);
  assert.ok(h.includes('id="matte-0" class="matte" src="assets/talk-matte.webm"'), "take 0: the first recording's matte");
  assert.ok(h.includes('id="matte-1" class="matte" src="assets/talk-1-matte.webm"'), "take 1: the second recording's matte");
  assert.ok(h.includes('id="matte-r1"') && /id="matte-r1" class="matte-l matte-r" src="assets\/talk-1-matte\.webm"/.test(h));
  check("stage, two recordings: take 0 reads talk-matte.webm, take 1 reads talk-1-matte.webm");

  // the subject scale uses the highest head across BOTH recordings (300 and 500 -> 300)
  dir = project({ style: "podcast-glow", stage: {}, takes: TAKES2 }, { second: true, matte: true });
  assert.match(build(dir), /stage: subject head top 300px/);
  check("stage, two recordings: head-top read per recording, the highest wins");

  // a recording with no face track is not cut out and keeps its plate
  dir = project({ style: "podcast-glow", stage: { fixedScale: 1 }, takes: TAKES2 }, { second: true, face1: false, matte: true });
  const out = build(dir);
  h = html(dir);
  assert.ok(h.includes('id="matte-0"') && !h.includes('id="matte-1"') && !h.includes("talk-1-matte"), "no matte for the face-less recording");
  assert.ok(h.includes("#take-0, #hold-0") && !h.includes("#take-1, #hold-1"), "only the matted take's plate is hidden");
  assert.match(out, /1 of 2 takes cut out/);
  check("stage, a recording with no face track: not cut out, its plate stays");

  // plain spec.matte with two recordings is still refused
  dir = project({ style: "clean", matte: true, takes: TAKES2 }, { second: true });
  const bad = run(dir);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /spec\.matte with 2 sources is not supported/);
  check("spec.matte (no stage) with two recordings is still refused");

  // ---- sections mode, blank reel ----
  dir = project({ style: "podcast-glow", stage: { fixedScale: 1 }, beats: [HEAD] }, { matte: true });
  build(dir);
  const sec = path.join(dir, "build", "section-0.html");
  build(dir, { GE_SECTION_START: "0", GE_SECTION_END: "6", GE_SECTION_OUT: sec });
  const sh = fs.readFileSync(sec, "utf8");
  assert.ok(sh.includes('id="stage-subj"') && sh.includes('class="hl-b"') && sh.includes('class="gw clip"'));
  check("a section build carries the stage, the headline and the glow captions");
  dir = project({ style: "podcast-glow", origin: "blank", takes: [], source: undefined, words: undefined, face: undefined });
  build(dir);
  assert.ok(fs.existsSync(path.join(dir, "index.html")));
  check("blank reel with podcast-glow builds");

  // ---- glow.hookGround (style podcast-glow): the hook headline gets the speaker cut out over a dark grid page ----
  const HOOK = { type: "headline", pos: "top", small: "we have", big: "no idea", at: 1, to: 3, bigAt: 1.6, smallAt: [1.1, 1.3] };
  dir = project({ style: "podcast-glow", beats: [HOOK, { ...HEAD, at: 6, to: 8, bigAt: 6.6, smallAt: [6.1, 6.3] }] }, { matte: true });
  build(dir);
  h = html(dir);
  assert.ok(/class="clip ground" data-start="1" data-duration="2"/.test(h), "a ground page for exactly the hook's window");
  assert.ok(h.includes("linear-gradient(180deg, #141414 0%, #050505 100%)") && h.includes("rgba(255,255,255,.09) 1px") && h.includes("background-size:64px 64px"), "dark grid ground");
  assert.ok(h.includes('id="matte-0" class="matte" src="assets/talk-matte.webm"'), "the speaker is cut out");
  assert.ok(h.includes('tl.set(".matte", { autoAlpha: 0 }, 0);') && h.includes('tl.set(".matte", { autoAlpha: 1 }, 0.98);') && h.includes('tl.set(".matte", { autoAlpha: 0 }, 3.02);'), "the cut-out shows only while the page is up (matteWindows)");
  assert.equal(count(h, /class="clip ground"/g), 1, "one ground: the low headline gets none");
  assert.equal(count(h, /class="matte"/g), 1);
  assert.ok(h.includes('<video id="matte-0" class="matte" src="assets/talk-matte.webm" data-start="0.98" data-duration="2.04" data-media-start="0.98"'), "matteClip: the cut-out video covers only the hook window");
  check("glow.hookGround: the top hook headline gets a dark grid ground + the cut-out, shown (and extracted) only in its window");

  // matteClip on its own: two windows in one take -> two clipped videos with their media offsets; take 2 (from 6 s) shows none
  dir = project({ style: "clean", matte: true, matteWindows: true, matteClip: true, takes: [{ a: 0, b: 5 }, { a: 6, b: SEC }],
    beats: [{ type: "ground", at: 0.5, to: 1.5, color: "#111111" }, { type: "ground", at: 3, to: 4, color: "#111111" }] }, { matte: true });
  build(dir);
  h = html(dir);
  assert.equal(count(h, /class="matte"/g), 2);
  assert.ok(h.includes('id="matte-0" class="matte" src="assets/talk-matte.webm" data-start="0.48" data-duration="1.04" data-media-start="0.48"'));
  assert.ok(h.includes('id="matte-0-1" class="matte" src="assets/talk-matte.webm" data-start="2.98" data-duration="1.04" data-media-start="2.98"'));
  assert.ok(!h.includes('id="matte-1"'), "no window in take 1: no cut-out video there");
  // without matteClip the same reel keeps one full-length cut-out per take (unchanged)
  dir = project({ style: "clean", matte: true, matteWindows: true, takes: [{ a: 0, b: 5 }, { a: 6, b: SEC }],
    beats: [{ type: "ground", at: 0.5, to: 1.5, color: "#111111" }, { type: "ground", at: 3, to: 4, color: "#111111" }] }, { matte: true });
  build(dir);
  h = html(dir);
  assert.ok(h.includes('id="matte-0" class="matte" src="assets/talk-matte.webm" data-start="0" data-duration="5"') && h.includes('id="matte-1" class="matte"'));
  // a take transition keeps the full-length cut-out, with a warning
  dir = project({ style: "clean", matte: true, matteWindows: true, matteClip: true, takes: [{ a: 0, b: 5 }, { a: 6, b: SEC, transition: "blur" }],
    beats: [{ type: "ground", at: 0.5, to: 1.5, color: "#111111" }] }, { matte: true });
  const tlog = build(dir);
  assert.match(tlog, /matteClip: this reel has take transitions/);
  assert.ok(html(dir).includes('id="matte-1" class="matte"'));
  check("matteClip: the cut-out covers only its windows (per take, with media offsets); off or with a take transition it is full length");

  // the same reel without the key (style clean): no ground, no matte; and podcast-glow with no top headline cuts no matte
  // (the refusing npx on PATH and no stub: a matte cut would fail the build)
  dir = project({ style: "clean", beats: [HOOK] });
  build(dir);
  assert.ok(!html(dir).includes("class=\"clip ground\"") && !html(dir).includes("talk-matte"), "no key, no ground, no matte");
  dir = project({ style: "podcast-glow", beats: [HEAD] });
  build(dir);
  assert.ok(!html(dir).includes("talk-matte") && !html(dir).includes("class=\"clip ground\""), "no top headline: no matte is cut");
  // a reel that already has a ground on the hook keeps just that one; matteWindows false is respected
  dir = project({ style: "podcast-glow", matte: true, matteWindows: false, beats: [HOOK, { type: "ground", at: 1, to: 3, color: "#123456" }] }, { matte: true });
  build(dir);
  h = html(dir);
  assert.equal(count(h, /class="clip ground"/g), 1);
  assert.ok(h.includes("background:#123456") && !h.includes('tl.set(".matte"'), "the reel's own ground and matteWindows win");
  check("glow.hookGround: nothing added without the key, without a top headline, or over the reel's own ground");

  // a ramped take refuses a matte: the hook gets no ground (warned) and the reel still builds; an explicit "matte": false wins
  dir = project({ style: "podcast-glow", takes: [{ a: 0, b: 3, ramp: "rush" }, { a: 3, b: SEC }], beats: [{ ...HOOK, at: 4, to: 6, bigAt: 4.6, smallAt: [4.1, 4.3] }] });
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 3.5, end: SEC, words: Array.from({ length: 20 }, (_, i) => ({ word: text[i], start: +(3.6 + i * 0.4).toFixed(2), end: +(3.9 + i * 0.4).toFixed(2) })) }] }));
  let glog = build(dir);
  assert.match(glog, /glow\.hookGround: the reel has a ramped take, so the hook at 4s gets no grid ground/);
  assert.ok(!html(dir).includes("class=\"clip ground\"") && !html(dir).includes("talk-matte"), "ramp: no ground, no matte");
  dir = project({ style: "podcast-glow", matte: false, beats: [HOOK] });
  glog = build(dir);
  assert.match(glog, /glow\.hookGround: the reel sets "matte": false, so the hook at 1s gets no grid ground/);
  assert.ok(!html(dir).includes("class=\"clip ground\"") && !html(dir).includes("talk-matte"), "matte false: no ground, no matte");
  // a reel that sets "matte": true itself keeps its full-length cut-out (no matteWindows / matteClip forced on it)
  dir = project({ style: "podcast-glow", matte: true, beats: [HOOK] }, { matte: true });
  build(dir);
  h = html(dir);
  assert.ok(h.includes("class=\"clip ground\"") && h.includes('id="matte-0" class="matte" src="assets/talk-matte.webm" data-start="0" data-duration="12"') && !h.includes('tl.set(".matte"'));
  check("glow.hookGround: skipped with a warning on a ramped take or \"matte\": false; a reel's own matte stays full length");

  // matteClip across a take boundary: one window, two clipped pieces, each at its own media offset
  dir = project({ style: "clean", matte: true, matteWindows: true, matteClip: true, takes: [{ a: 0, b: 5 }, { a: 6, b: SEC }],
    beats: [{ type: "ground", at: 4.5, to: 6.5, color: "#111111" }] }, { matte: true });
  build(dir);
  h = html(dir);
  assert.equal(count(h, /class="matte"/g), 2);
  assert.ok(h.includes('id="matte-0" class="matte" src="assets/talk-matte.webm" data-start="4.48" data-duration="0.52" data-media-start="4.48"'), "take 0's piece: 4.48-5.0, media 4.48");
  assert.ok(h.includes('id="matte-1" class="matte" src="assets/talk-matte.webm" data-start="5" data-duration="0.52" data-media-start="6"'), "take 1's piece: 5.0-5.52, media 6.0");
  check("matteClip: a window across a take join gives one piece per take, each with its own media offset");

  // window cut: no cached whole-recording matte -> only the recording around the hook (+-1 s) is cut out, and the clipped
  // cut-out reads that file at the offset into it. A fake npx records what remove-background was given and writes a stub.
  if (process.platform !== "win32") {
    const fakeNpx = path.join(root, "fake-npx"), npxLog = path.join(root, "npx.log");
    fs.mkdirSync(fakeNpx);
    fs.writeFileSync(path.join(fakeNpx, "npx"), `#!/bin/sh
in=""; out=""; prev=""
for a in "$@"; do [ "$prev" = "remove-background" ] && in="$a"; [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
echo "$in" >> "${npxLog}"; ffprobe -v error -show_entries format=duration -of csv=p=0 "$in" >> "${npxLog}"; echo stub > "$out"
`, { mode: 0o755 });
    dir = project({ style: "podcast-glow", beats: [HOOK] });
    glog = build(dir, { PATH: fakeNpx + path.delimiter + process.env.PATH, MATTE_THREADS: "" });
    h = html(dir);
    const nl = fs.readFileSync(npxLog, "utf8").trim().split("\n");
    assert.equal(nl.length, 2, "remove-background ran once, on the window only");
    assert.ok(nl[0].endsWith(path.join("build", "matte-src@0-4000.mp4")) && Math.abs(+nl[1] - 4) < 0.05, `the window source is 0-4 s (${nl.join(" ")})`);
    assert.ok(fs.existsSync(path.join(dir, "assets", "talk-matte@0-4000.webm")) && !fs.existsSync(path.join(dir, "assets", "talk-matte.webm")), "no whole-recording matte");
    assert.ok(!fs.existsSync(path.join(dir, "build", "matte-src@0-4000.mp4")), "the trimmed source is removed");
    assert.ok(h.includes('<video id="matte-0" class="matte" src="assets/talk-matte@0-4000.webm" data-start="0.98" data-duration="2.04" data-media-start="0.98"'));
    // a second build reuses the cached window matte (npx not run again)
    build(dir, { PATH: fakeNpx + path.delimiter + process.env.PATH, MATTE_THREADS: "" });
    assert.equal(fs.readFileSync(npxLog, "utf8").trim().split("\n").length, 2, "cached");
    check("matteClip window cut: only the hook +-1 s of the recording is cut out, cached, and read at its offset");
  }

  // ---- glow.keepLow (style podcast-glow): a low headline on a close-up stays in the lower frame ----
  const closeUp = (dir) => fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 7 }, (_, i) => [i * 2, 40, 1320, 160, 930, 620, 960]) }));
  const LOW = { ...HEAD, at: 6, to: 8, bigAt: 6.6, smallAt: [6.1, 6.3] };
  const hlTop = (h) => [...h.matchAll(/class="hl" style="top:(\d+)px/g)].map((m) => +m[1]);
  dir = project({ style: "podcast-glow", beats: [LOW] });
  closeUp(dir);
  build(dir);
  h = html(dir);
  const [lowY] = hlTop(h);
  assert.ok(lowY >= 980, `a low headline on a close-up stays low (top ${lowY}px, was the top band at 260px)`);
  const bsz = +h.match(/class="hl-b" style="font-size:(\d+)px/)[1];
  assert.ok(lowY + 78 * 1.05 + bsz * 0.98 <= 1540 + 1, "its bottom stays inside the safe area + 40");
  assert.ok(!h.includes('id="b0-ar"'), "no arrow under the safe area");
  dir = project({ style: "podcast-glow", glow: { keepLow: false }, beats: [LOW] });
  closeUp(dir);
  build(dir);
  assert.deepEqual(hlTop(html(dir)), [260], "keepLow off: the old top-band fallback");
  dir = project({ style: "podcast-glow", beats: [LOW] });
  build(dir);
  const roomy = hlTop(html(dir))[0];
  dir = project({ style: "podcast-glow", glow: { keepLow: false }, beats: [LOW] });
  build(dir);
  assert.equal(hlTop(html(dir))[0], roomy, "a headline with room under the chin is placed exactly as before");
  check("glow.keepLow: a low headline on a close-up sits over the chest, not in the top band; with room it is unchanged");
  // the mouth guard: a face whose mouth sits low enough that the bottom-anchored block would cover it -> top band, warned
  dir = project({ style: "podcast-glow", beats: [LOW] });
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 7 }, (_, i) => [i * 2, 300, 1500, 160, 930, 900, 1380]) }));
  glog = build(dir);
  assert.deepEqual(hlTop(html(dir)), [260]);
  assert.match(glog, /headline "NO IDEA" at 6: glow\.keepLow would cover the mouth, so it goes to the top band/);
  check("glow.keepLow: a block that would cover the mouth falls back to the top band with a warning");

  // ---- glow_plan.py ----
  dir = project({ style: "podcast-glow", takes: [{ a: 0, b: SEC }] }, { matte: true });
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: SEC, words: "Why do you procrastinate? Because nobody is dying to start. We have no idea what it costs. The real problem is fear of failing. So stop waiting and begin today. Everything changes when you do.".split(" ").map((w, i) => ({ word: w, start: +(0.3 + i * 0.4).toFixed(2), end: +(0.6 + i * 0.4).toFixed(2) })) }] }));
  const py = [process.env.PYTHON, "python3", "python", "py"].filter(Boolean).find((c) => { const r = spawnSync(c, ["--version"], { encoding: "utf8" }); return !r.error && r.status === 0 && /Python 3/.test(r.stdout + r.stderr); });
  const pr = spawnSync(py, ["-I", PLAN, dir, "--dry"], { encoding: "utf8" });
  if (pr.error || pr.status !== 0) console.log(`skip  glow_plan.py (${pr.error ? pr.error.message : pr.stderr.split("\n").slice(-2)[0]})`);
  else {
    assert.match(pr.stdout, /low|left|top/);
    const wr = spawnSync(py, ["-I", PLAN, dir], { encoding: "utf8" });
    assert.equal(wr.status, 0, wr.stderr);
    const beats = JSON.parse(fs.readFileSync(path.join(dir, "reel.json"), "utf8")).beats;
    assert.ok(beats.length >= 2 && beats.every((b) => b.type === "headline" && b._glow && b.big && b.at < b.to), "planner wrote headline beats");
    build(dir);
    assert.ok(count(html(dir), /class="hl-b"/g) === beats.length, "the planned reel builds, one headline per beat");
    check("glow_plan.py writes headline beats that build");
  }

  console.log("\nall build-glow checks passed");
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

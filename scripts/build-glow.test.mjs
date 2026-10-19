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
const run = (dir, env = {}) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary(), PHANTASIC_SFX_PACK: path.join(root, "no-such-pack"), ...env } });   // no audio: see lib/silent-library.mjs
const build = (dir, env) => { const r = run(dir, env); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const jsonOf = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, "build", f), "utf8"));
const check = (label) => console.log(`ok    ${label}`);
const count = (s, re) => (s.match(re) || []).length;
const HEAD = { type: "headline", small: "we have", big: "no idea", at: 3, to: 5, smallAt: [3.1, 3.4], bigAt: 3.8, arrow: "left" };

try {
  // ---- single source, podcast-glow, a headline beat ----
  let dir = project({ style: "podcast-glow", beats: [HEAD, { ...HEAD, at: 7, to: 8.5, bigAt: 7.4, pos: "top", arrow: undefined, small: "", smallAt: [] }] });
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

  // ---- glow_plan.py ----
  dir = project({ style: "podcast-glow", takes: [{ a: 0, b: SEC }] });
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

#!/usr/bin/env node
// node scripts/build-iman-real-room.test.mjs
// premium-iman (Empire) keeps the speaker's REAL room (owner decision, 10 Oct 2026): no stage, no plate, no drawn neon set; the
// side light is the depth relight (`relight` look empire); the glowing type goes BEHIND the head with the cut-out as an invisible
// occluder (captions.behind with matte and no stage, references/reel-json.md "Type captions behind the head without a stage").
// The depth MODEL never runs (a stub depth video is placed as assets/talk-depth.mp4, PHANTASIC_MODELS is an empty folder) and the
// matte is never cut (a stub VP9+alpha cut-out is placed, npx refuses). Covers:
//   - no neon set / plate / props markup, the plate is not hidden, the takes play the real footage (relit), the cut-out is relit
//   - the type cards sit inside the camera wrappers between the takes and the cut-out (#capsb), hung from the head-top track so
//     the last line dips `overlap` under the crown; none are in the front caption layer
//   - captions.maxHidden caps the tuck; a hold ends a behind card; a whip / blur join tweens #capsb with the takes
//   - a tight close-up (crown near the top of the frame) gets its cards in front, placed by the placer, and #capsb stays empty
//   - relight from the style degrades (no depth model / no python -> a warning, an unrelit build); set in reel.json it still dies
//   - opt-in: captions.behind false, or no matte, writes no #capsb; a reel that sets `stage` itself still gets the old set path
// The relight parts need a python with numpy and OpenCV; without one the reel is built with "relight": false and says so.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-iman-room-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 6, FPS = 30, W = 108, H = 192;
ff("-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));
// stub depth (near ellipse on a far room) and a stub cut-out with real alpha (the same ellipse), like build-relight.test.mjs
ff("-f", "lavfi", "-i", `color=c=black:size=54x96:rate=${FPS}:duration=${SEC},format=gray,geq=lum='if(lt(hypot((X-27)/16\\,(Y-62)/30)\\,1)\\,230\\,20)'`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "depth.mp4"));
ff("-f", "lavfi", "-i", `color=c=0x8a8a8a:size=${W}x${H}:rate=${FPS}:duration=${SEC},format=yuva420p,geq=lum='p(X\\,Y)':cb='p(X\\,Y)':cr='p(X\\,Y)':a='if(lt(hypot((X-${W / 2})/32\\,(Y-${H * 0.65})/60)\\,1)\\,255\\,0)'`,
  "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", path.join(root, "matte.webm"));
const text = "the room stays real and the light comes from the side so the words sit behind your head".split(" ");
const words = { segments: [{ start: 0, end: SEC, words: Array.from({ length: 16 }, (_, i) => ({ word: text[i % text.length], start: +(0.2 + i * 0.34).toFixed(2), end: +(0.46 + i * 0.34).toFixed(2) })) }] };
let n = 0;
// crown: the head top (px, 1920 scale) the seeded head-top track reports for every sample
function project(reel, { crown = 640, depth = true } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  if (depth) fs.copyFileSync(path.join(root, "depth.mp4"), path.join(dir, "assets", "talk-depth.mp4"));
  fs.copyFileSync(path.join(root, "matte.webm"), path.join(dir, "assets", "talk-matte.webm"));
  fs.writeFileSync(path.join(dir, "build", "headtop.json"), JSON.stringify(Array.from({ length: SEC * 5 + 1 }, (_, i) => [+(i / 5).toFixed(2), crown])));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: SEC + 1 }, (_, i) => [i, crown + 60, crown + 560, 340, 740, crown + 260, crown + 420]) }));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "iman", style: "premium-iman", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0, takes: [{ a: 0, b: 2.9 }, { a: 3.1, b: SEC }], captions: { reds: ["real"] }, ...reel }));
  return dir;
}
const fakeBin = path.join(root, "fake-bin"); fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, "npx.cmd"), "@echo off\r\necho npx is disabled in build-iman-real-room.test.mjs: seed the matte 1>&2\r\nexit /b 97\r\n");
fs.writeFileSync(path.join(fakeBin, "npx"), "#!/bin/sh\necho 'npx is disabled in build-iman-real-room.test.mjs: seed the matte' >&2\nexit 97\n", { mode: 0o755 });
const noModels = path.join(root, "no-models"); fs.mkdirSync(noModels);
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
const SAFE_ENV = { ...process.env, PHANTASIC_LIB: silentLibrary(), PHANTASIC_MODELS: noModels, [pathKey]: fakeBin + path.delimiter + process.env[pathKey] };
const run = (dir, env = {}) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...SAFE_ENV, ...env } });
const build = (dir, env) => { const r = run(dir, env); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const fails = (dir, re, env) => { const r = run(dir, env); assert.notEqual(r.status, 0, "should have failed"); assert.match(r.stdout + r.stderr, re); };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const layout = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8")).blocks;
const check = (label) => console.log(`ok    ${label}`);
const count = (s, re) => (s.match(re) || []).length;
const capsbOf = (h) => { const i = h.indexOf('<div id="capsb">'); assert.ok(i >= 0, "#capsb is written"); const j = h.indexOf('<video id="matte-0"', i); assert.ok(j > i, "the cut-out comes after #capsb"); return h.slice(i, j); };
const frontCapsOf = (h) => { const m = h.match(/<div id="caps">([\s\S]*?)\n  <\/div>/); assert.ok(m, "the front caption layer is written"); return m[1]; };

const python = [process.env.PHANTASIC_PYTHON, "python3", "python", "py"].filter(Boolean).find((c) => spawnSync(c, ["-c", "import cv2, numpy"], { stdio: "ignore" }).status === 0);
const RL = python ? {} : { relight: false };
if (!python) console.log("skip  build-iman-real-room: the relight parts (no python with OpenCV and numpy); the reels are built with \"relight\": false");

try {
  // ---------- the default Empire reel: real room, side light, type behind the head ----------
  let dir = project({ ...RL });
  const log = build(dir);
  let h = html(dir);
  // no set: no stage background, no drawn practicals (neon bar / lamp), no light-wrap copies, no choke filter, no subject wrapper
  for (const re of [/id="stage-bg"/, /id="stage-subj"/, /class="matte-l/, /matte-[rb]\d/, /stage-choke/, /id="stage-fg/, /id="stage-w/, /box-shadow:0 0 18px #FF2A3A/i, /radial-gradient\(120% 70% at 22% 18%/])
    assert.ok(!re.test(h), `no neon set / plate markup: ${re}`);
  assert.ok(!/opacity: 0 !important/.test(h), "the plate is not hidden");
  assert.ok(!/^stage: /m.test(log), "the build does not run the stage");
  assert.ok(!/pk-grade-empire-noir/.test(h), "the empire-noir tone curve is gone (neutral grade)");
  assert.match(h, /#base \{ transform: scale\(1\); filter: contrast\(1\.12\) saturate\(\.92\); \}/, "neutral contrast grade on the footage");
  check("premium-iman: no stage, no plate, no neon bar / lamp / wraps, the plate shows, neutral grade");
  // the real footage plays, relit from the sides
  const takeRe = python ? /<video id="take-(\d)" src="(assets\/talk-relit-[0-9a-f]{8}\.mp4)"/g : /<video id="take-(\d)" src="(assets\/talk\.mp4)"/g;
  const takes = [...h.matchAll(takeRe)];
  assert.equal(takes.length, 2, "both takes play the speaker's own footage");
  assert.equal(count(h, /stage-set|url\(assets\/plate/g), 0, "no set video or plate picture in place of the room");
  if (python) {
    assert.match(log, /relighting assets\/talk\.mp4 \(relight empire;/, "relight runs (on the stub depth)");
    assert.ok(!/depth map of/.test(log), "the depth model is not run");
    assert.ok(fs.existsSync(path.join(dir, takes[0][2])), "the relit file exists");
    assert.match(h, /<video id="matte-0" class="matte" src="assets\/talk-matte-relit-[0-9a-f]{8}\.webm"/, "the occluder carries the relit colour");
    check("premium-iman: the takes play the relit real footage (empire side light), the cut-out is relit to match");
  } else assert.match(h, /<video id="matte-0" class="matte" src="assets\/talk-matte\.webm"/);
  // type behind the head: the cards sit inside the camera wrappers, after the takes, before the cut-out
  const iTake = h.indexOf('<video id="take-1"'), iCapsb = h.indexOf('<div id="capsb">'), iMatte = h.indexOf('<video id="matte-0"');
  assert.ok(iTake > 0 && iTake < iCapsb && iCapsb < iMatte, "order: takes < #capsb < cut-out");
  const push = h.slice(h.indexOf('<div id="push">'), h.indexOf("</div></div></div>", h.indexOf('<div id="push">')));
  assert.ok(push.includes('<div id="capsb">'), "#capsb is inside #push (it rides the punch-ins)");
  const behind = capsbOf(h), front = frontCapsOf(h);
  const nb = count(behind, /class="tc clip/g);
  assert.ok(nb >= 4, `type cards behind the head (${nb})`);
  assert.equal(count(front, /class="tc clip/g), 0, "no card in the front layer when the head leaves room");
  assert.match(behind, /class="tc clip tc-hot"/, "the red verdict card goes behind too");
  assert.match(h, /#capsb \{ position: absolute; left: 0; right: 0; top: 0; height: 0; \}/);
  assert.ok(!/#pip > #caps \{ z-index: 1; \}/.test(h), "not the stage z-order");
  const blocks = layout(dir);
  assert.equal(blocks.length, nb);
  for (const b of blocks) {
    assert.equal(b.mode, "behind");
    assert.ok(b.y >= 200, `block top ${b.y} under captions.safeTop`);
    assert.ok(b.y + b.h > 640 && b.y + b.h < 640 + b.h, `the block's last line dips under the crown (y ${b.y}, h ${b.h})`);
  }
  check(`premium-iman: ${nb} type cards inside the camera wrappers between the takes and the cut-out occluder, hung under the crown`);
  // captions.maxHidden 0.45 (the style): no card has more than 45% of its height under the crown; without the cap a one-line card tucks 0.8
  const hidden = (b, crown = 640) => (b.y + b.h - crown) / b.h;
  for (const b of blocks) assert.ok(hidden(b) > 0 && hidden(b) <= 0.45 + 0.01, `hidden ${hidden(b).toFixed(3)} of block at ${b.t0}`);
  assert.ok(blocks.some((b) => Math.abs(hidden(b) - 0.45) < 0.01), "the cap is what sets the tuck");
  const unc = project({ ...RL, captions: { reds: ["real"], maxHidden: 1 } }); build(unc);
  const ub = layout(unc).map((b) => hidden(b));   // overlap 0.8 of one line: 0.8 of a one-line card, 0.4 of a two-line card
  assert.ok(ub.every((x) => Math.abs(x - 0.8) < 0.01 || Math.abs(x - 0.4) < 0.01) && ub.some((x) => Math.abs(x - 0.8) < 0.01), "maxHidden 1: one-line cards tuck the full overlap 0.8: " + ub.map((x) => x.toFixed(3)));
  fails(project({ ...RL, captions: { maxHidden: 2 } }), /ERROR: captions\.maxHidden must be a number 0\.\.1 \(got 2\)/);
  check("captions.maxHidden: at most 45% of each card under the crown (overlap 0.8 otherwise), bad value refused");

  // a hold: the cut-out stops on the still, so a behind card ends where the hold starts, and a card starting in it goes in front
  dir = project({ ...RL, takes: [{ a: 0, b: 2.9, hold: 0.5 }, { a: 3.1, b: SEC }] });
  build(dir); h = html(dir);
  const HS = 2.9, HE = 3.4, lb = layout(dir);
  assert.ok(lb.some((b) => b.mode === "behind" && Math.abs(b.t1 - HS) < 0.002), "a behind card is cut at the hold");
  for (const b of lb.filter((b) => b.mode === "behind")) assert.ok(b.t1 <= HS + 0.001 || b.t0 >= HE - 0.001, `behind card ${b.t0}-${b.t1} does not cover the hold ${HS}-${HE}`);
  for (const m of capsbOf(h).matchAll(/data-start="([\d.]+)" data-duration="([\d.]+)"/g)) { const a = +m[1], d = +m[2]; assert.ok(a + d <= HS + 0.001 || a >= HE - 0.001, `#capsb card ${a}+${d} stays off the hold`); }
  check("hold: behind cards end where the hold starts (no card over the still without its cut-out)");

  // a whip join: #capsb whips / blurs out and in with the takes and the cut-out; a blur join likewise; no join, no tween
  dir = project({ ...RL, takes: [{ a: 0, b: 2.9 }, { a: 3.1, b: SEC, transition: "whip" }] });
  build(dir); h = html(dir);
  assert.match(h, /tl\.set\("#capsb", \{ autoAlpha: 1, filter: "blur\(0px\)", xPercent: 0 \}, 0\);/);
  const whipT = h.match(/tl\.to\("#take-0", \{ autoAlpha: 0, xPercent: -8, filter: "blur\(40px\)", duration: ([\d.]+), ease: "power1\.in" \}, ([\d.]+)\);/);
  assert.ok(whipT, "the take whips");
  assert.ok(h.includes(`tl.fromTo("#capsb", { autoAlpha: 1, filter: "blur(0px)", xPercent: 0 }, { autoAlpha: 0, filter: "blur(40px)", xPercent: -8, duration: ${whipT[1]}, ease: "power1.in", immediateRender: false }, ${whipT[2]});`), "#capsb whips out with the take, same time and length");
  assert.match(h, /tl\.fromTo\("#capsb", \{ autoAlpha: 0, filter: "blur\(40px\)", xPercent: 8 \}, \{ autoAlpha: 1, filter: "blur\(0px\)", xPercent: 0, duration: [\d.]+, ease: "power1\.out", immediateRender: false \}, 2\.9\);/, "and back in on the join");
  dir = project({ ...RL, takes: [{ a: 0, b: 2.9 }, { a: 3.1, b: SEC, transition: "blur" }] });
  build(dir); h = html(dir);
  assert.match(h, /tl\.fromTo\("#capsb", \{ autoAlpha: 1, filter: "blur\(0px\)", xPercent: 0 \}, \{ autoAlpha: 0, filter: "blur\(28px\)", xPercent: 0,/);
  dir = project({ ...RL }); build(dir);
  assert.ok(!/"#capsb"/.test(html(dir)), "no join transition: no #capsb tween");
  check("whip / blur join: #capsb blurs, fades (and whips) with the takes and the cut-out");

  // ---------- a tight close-up: no room above the crown -> the cards go in front, as without behind ----------
  dir = project({ ...RL }, { crown: 120 });
  build(dir); h = html(dir);
  assert.equal(count(capsbOf(h), /class="tc clip/g), 0, "nothing behind when the head touches the top");
  assert.ok(count(frontCapsOf(h), /class="tc clip/g) >= 4, "the cards are placed in front");
  assert.ok(layout(dir).every((b) => b.mode !== "behind"), "placed by the face-aware placer");
  check("premium-iman on a tight close-up: every card in front (placer), #capsb empty");

  // ---------- relight from the STYLE degrades; relight set by the REEL still dies ----------
  // no depth video and an empty PHANTASIC_MODELS: the style's relight is skipped with a warning, the reel builds unrelit
  dir = project({}, { depth: false });
  let out = build(dir); h = html(dir);
  assert.match(out, /WARNINGS:[\s\S]*relight \(from the style\) skipped, the reel is built unrelit: no depth map at assets\/talk-depth-[0-9a-f]{8}\.mp4 and no depth model at .*no-models/);
  assert.equal(count(h, /<video id="take-\d" src="assets\/talk\.mp4"/g), 2, "the takes play the unrelit footage");
  assert.match(h, /<video id="matte-0" class="matte" src="assets\/talk-matte\.webm"/, "the occluder is the plain cut-out");
  assert.ok(!fs.readdirSync(path.join(dir, "assets")).some((f) => /relit/.test(f)), "no relit file");
  assert.ok(count(capsbOf(h), /class="tc clip/g) >= 4, "the type still goes behind the head");
  const off = project({ relight: false }, { depth: false }); build(off);
  const gh = (d) => JSON.parse(fs.readFileSync(path.join(d, "build", "sections.json"), "utf8")).globalHash;
  assert.equal(h, html(off), "the degraded page is the relight: false page");
  assert.equal(gh(dir), gh(off), "the skipped relight is not in the section hash");
  // no python with the modules (depth video present): same degrade
  out = build(project({}), { PHANTASIC_PYTHON: path.join(root, "no-such-python") });
  assert.match(out, /relight \(from the style\) skipped, the reel is built unrelit: PHANTASIC_PYTHON=.*no-such-python cannot import numpy, cv2/);
  // the reel sets relight itself: the same causes still fail the build
  fails(project({ relight: {} }, { depth: false }), /ERROR: relight: no depth map at .*no depth model at .*no-models/);
  fails(project({ relight: { roomDim: 0.3 } }), /ERROR: relight: PHANTASIC_PYTHON=.*no-such-python cannot import numpy, cv2/, { PHANTASIC_PYTHON: path.join(root, "no-such-python") });
  check("relight from the style: no model / no python -> warning + unrelit build; relight in reel.json: still a die()");

  // ---------- opt-in ----------
  dir = project({ ...RL, captions: { reds: ["real"], behind: false } });
  build(dir); h = html(dir);
  assert.ok(!/capsb/.test(h), "captions.behind false: no #capsb");
  dir = project({ relight: false, matte: false });
  build(dir); h = html(dir);
  assert.ok(!/capsb/.test(h) && !/class="matte"/.test(h), "matte false: no #capsb, no cut-out");
  // a reel that wants the old neon set sets stage itself, and gets the stage path (type between the set and the speaker)
  dir = project({ relight: false, stage: { bg: "neon" } });
  build(dir); h = html(dir);
  assert.match(h, /id="stage-bg"/); assert.match(h, /#pip > #caps \{ z-index: 1; \} #pip > #base \{ z-index: 2; \}/);
  assert.ok(!/capsb/.test(h), "stage: no #capsb");
  check("opt-in: behind false / no matte write no #capsb; a reel's own stage still gets the set path");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("\nall build-iman-real-room tests passed");

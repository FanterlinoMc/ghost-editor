#!/usr/bin/env node
// node scripts/build-ahmed-premium.test.mjs
// Phase D: Ahmed's premium line, hand-ported from phantasic engine/core (engine/premium-kit, template-premium-iman / -signature /
// -belmar / -noir). Covers:
//   - lib/premium.mjs: speed ramps (curve, knots, warp), the SFX design pass (placement by peak, density, ducking, bad density)
//   - build.mjs: take.ramp (muted, no captions, E() through the warp, edit_truth `ramp`), scene.ramp, spec.transitions on #tx
//     (and its edit_truth `txTransitions`), the drop (ladder scenes + flashes + music.alignDrop), sound.completeMix, popSafe / wordGap,
//     wordReveal / cursor:false, PHANTASIC_PREVIEW_SCALE
//   - one small reel per premium style: premium-iman (Empire), premium-belmar (Prestige), premium-signature, premium-kit-demo,
//     and premium-noir (parity). The matte is NOT cut: the test places the cached matte and head-top files, so
//     `hyperframes remove-background` never runs. No paid call is made anywhere.
//   - every new die(): ramp on speech, ramp on the last take, ramp with a hold, ramp with stage, unknown ramp preset, ramp past the
//     end of the source, bad sfxDesign.density, bad transitions.kind, drop without shots / hold|at
//   - the python scripts: py_compile, --help, and a synthetic run of score.py, autoscore.py, prestige_score.py, noir_score.py,
//     signature_plan.py, relight.py + splice_matte.py on 3 frames, empire_finish.py's input check. Skipped (and says so) when no
//     python with numpy and OpenCV is found. The sound pack is a folder of tiny synthetic wavs made here.
// The library ships no audio, so the SFX the design pass places are skipped with the usual warning; their placement is tested on the
// pass itself with a stub addSfx.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const PK = await import(pathToFileURL(path.join(HERE, "lib", "premium.mjs")).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-premium-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 14, FPS = 30;
ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));
const text = "so we have no idea what this really costs and nobody is dying to tell you the truth about it because the number is huge then we measure the savings again and again until the value is clear to everyone".split(" ");
const wordsIn = (spans) => {
  const words = []; let i = 0;
  for (const [a, b] of spans) for (let t = a; t + 0.25 < b; t += 0.3) words.push({ word: text[i++ % text.length], start: +t.toFixed(2), end: +(t + 0.22).toFixed(2) });
  return { segments: [{ start: 0, end: SEC, words }] };
};
let n = 0;
function project(reel, { spans = [[0.3, 5]], matte = false, headTop = 300 } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(wordsIn(spans)));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 8 }, (_, i) => [i * 2, 400, 1000, 340, 740, 560, 800]) }));
  if (matte || reel.stage || reel.matte) {   // the files the build would cut: a cached matte and its head-top track
    fs.writeFileSync(path.join(dir, "assets", "talk-matte.webm"), "stub");
    fs.writeFileSync(path.join(dir, "build", "headtop.json"), JSON.stringify(Array.from({ length: 80 }, (_, i) => [+(i / 5).toFixed(2), headTop])));
  }
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "premium", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.15, takes: [{ a: 0, b: SEC }], ...reel }));
  return dir;
}
// Safety net: the build runs `npx hyperframes remove-background` (an ONNX model, minutes of CPU) when a stage / matte / behind beat has no
// cached matte. This test seeds the matte for every such reel, and ALSO puts an npx first on PATH that refuses, so a missed seed fails the
// build in a second instead of starting the model.
const fakeBin = path.join(root, "fake-bin"); fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, "npx.cmd"), "@echo off\r\necho npx is disabled in build-ahmed-premium.test.mjs: seed the matte 1>&2\r\nexit /b 97\r\n");
fs.writeFileSync(path.join(fakeBin, "npx"), "#!/bin/sh\necho 'npx is disabled in build-ahmed-premium.test.mjs: seed the matte' >&2\nexit 97\n", { mode: 0o755 });
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
// The gate builds against a library with no audio (lib/silent-library.mjs), so a developer with restored sounds gets CI's result.
const SAFE_ENV = { ...process.env, PHANTASIC_LIB: silentLibrary(), [pathKey]: fakeBin + path.delimiter + process.env[pathKey] };
const run = (dir, env = {}) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...SAFE_ENV, ...env } });
const build = (dir, env) => { const r = run(dir, env); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const fails = (dir, re) => { const r = run(dir); assert.notEqual(r.status, 0, "should have failed"); assert.match(r.stdout + r.stderr, re); };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const jsonOf = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, "build", f), "utf8"));
const check = (label) => console.log(`ok    ${label}`);
const count = (s, re) => (s.match(re) || []).length;
const near = (a, b, e = 0.01) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

{
  // ---------- lib/premium.mjs: speed ramps ----------
  const rush = PK.resolveRamp("rush");
  near(PK.speedAt(rush.curve, 0), 1); near(PK.speedAt(rush.curve, 0.5), 3); near(PK.speedAt(rush.curve, 1), 1);
  const mean = PK.meanSpeed(rush.curve);
  assert.ok(mean > 2 && mean < 3, `mean speed of rush ${mean}`);
  const knots = PK.rampKnots(rush.curve, 1.2);
  near(knots.at(-1)[0], 1.2); near(knots.at(-1)[1], 1.2 * mean, 0.02);
  assert.ok(knots.every((k, i) => i === 0 || (k[0] > knots[i - 1][0] && k[1] >= knots[i - 1][1])), "knots rise");
  const warp = PK.warpFn(knots);
  near(warp(0), 0); near(warp(knots.at(-1)[1]), 1.2); assert.ok(warp(knots[10][1]) < knots[10][1], "3x section: output time runs behind source time");
  assert.throws(() => PK.resolveRamp("nope"), /unknown ramp preset 'nope'/);
  assert.deepEqual(Object.keys(PK.RAMP_PRESETS), ["rush", "surge", "hit", "slowmo"]);
  check("premium.mjs ramps: presets, smoothstep curve, knots, warp, unknown preset");

  // ---------- lib/premium.mjs: the SFX design pass, with a stub addSfx ----------
  const timing = { "riser-1": { peak_t: 1.0, dur: 2 }, "cinematic-rumble-riser": { peak_t: 1.0, dur: 2 }, "cinematic-deep-boom": { peak_t: 0.1, dur: 1.5 }, "impact-1": { peak_t: 0.05, dur: 0.6 }, "whoosh-cine": { peak_t: 0.2, dur: 1 }, "click-1": { peak_t: 0, dur: 0.1 }, "tech-digital-whoosh": { peak_t: 0.1, dur: 0.5 }, "burn-whoosh-fast": { peak_t: 0.1, dur: 0.5 } };
  const design = (cfg, ev, words = []) => {
    const sfxEvents = [];
    const addSfx = (t, id, why, { db = 0 } = {}) => { const tm = timing[id]; if (!tm) return; sfxEvents.push({ t: Math.round(t * 1000) / 1000, id, role: "ui", vol: 1, dur: tm.dur, why, db }); };
    const logs = [];
    PK.sfxDesign(cfg, { majors: [], transitions: [], joins: [], textIns: [], punches: [], pops: [], ramps: [], ...ev }, { addSfx, sfxEvents, timing, words, voiceP95: -18, ROLE_DB: {}, TOTAL: 30, log: (m) => logs.push(m) });
    return { sfxEvents, logs };
  };
  let d = design({ density: "med" }, { majors: [10] });
  const riser = d.sfxEvents.find((e) => e.design === "riser"), hit = d.sfxEvents.find((e) => e.design === "hit"), tail = d.sfxEvents.find((e) => e.design === "tail");
  assert.ok(riser && hit && tail, "a major cut gets riser + hit + tail at med");
  near(riser.t, 9.0); near(riser.t + riser.dur, 10.04, 0.001); assert.equal(riser.fade, 0.06);
  near(hit.t, 9.9); near(tail.t, 10.12 - 0.2, 0.001);
  d = design({ density: "low" }, { majors: [10] });
  assert.ok(!d.sfxEvents.some((e) => e.design === "tail") && d.sfxEvents.some((e) => e.design === "riser"), "low: riser + hit, no tail");
  d = design({ density: "med" }, { transitions: [{ t: 5, kind: "whip" }], ramps: [{ t0: 2, peak: 3, end: 4 }] });
  assert.ok(d.sfxEvents.some((e) => e.design === "whip" && Math.abs(e.t - 4.9) < 0.001), "a whip transition gets a swish peaking on the cut");
  assert.ok(d.sfxEvents.some((e) => e.design === "ramp") === false, "burn-whoosh-tunnel is not in the stub timing: skipped, not fatal");
  // ducking: a loud non-impact sound over speech is capped under the voice
  const sfx2 = [];
  PK.sfxDesign({ density: "high", voiceGapDb: -8 }, { majors: [], transitions: [], joins: [], textIns: [], punches: [], pops: [3], ramps: [] },
    { addSfx: (t, id, why) => sfx2.push({ t, id, role: "ui", vol: 1, dur: 0.1, why }), sfxEvents: sfx2, timing, words: [{ start: 2.9, end: 3.4 }], voiceP95: -18, ROLE_DB: {}, TOTAL: 30, log: () => {} });
  assert.ok(sfx2.length && sfx2[0].vol < 0.2, `ducked under the voice (${sfx2[0]?.vol})`);
  assert.throws(() => design({ density: "loud" }, {}), /density must be low, med or high/);
  check("premium.mjs sfxDesign: riser > hit > tail on a cut, density, whip swish, missing sounds skipped, ducking, bad density");

  // ---------- premium-iman (Empire): real room + type captions behind the head + drop + alignDrop ----------
  // (relight is off here: this reel's cut-out is a text stub; the relight + occluder path is scripts/build-iman-real-room.test.mjs)
  const IMAN = { style: "premium-iman", relight: false, takes: [{ a: 0, b: 8, hold: 7 }], captions: { reds: ["idea", "huge"] }, drop: { hold: 0, shots: [{ self: 2 }, { self: 4 }, { self: 6 }] } };
  let dir = project(IMAN, { spans: [[0.3, 7.8]], matte: true });
  let log = build(dir);
  let h = html(dir);
  assert.match(h, /<div id="capsb"><div id="tc0" class="tc clip/, "captions.behind (no stage): the type sits between the footage and the cut-out occluder");
  assert.ok(!/id="stage-bg"/.test(h) && !/^stage: /m.test(log), "no neon set");
  assert.ok(count(h, /class="tc clip/g) >= 5, "one type card per phrase");
  assert.ok(count(h, /tl\.set\("#tc\d+-cur\d", \{ opacity: 0 \}, 0\)/g) >= 5, "cursor:false hides every cursor from frame 0");
  assert.ok(!/#tc0-cur0", \{ opacity: 1 \}/.test(h), "no blinking cursor");
  const chars0 = count(h, /id="tc0c\d+" class="tc-ch/g);
  assert.equal(count(h, /tl\.set\("#tc0c\d+", \{ display: "inline" \}/g), chars0, "wordReveal: every char of card 0 is revealed by a word-time set");
  check("premium-iman: cards behind the head over the real footage, cursor off, whole-word reveal");
  assert.match(log, /drop at 8\.1s: 13 cuts in 6\.17 s/);
  assert.equal(count(h, /id="dropflash-\d+"/g), 4, "a white flash on every third of the 12 later cuts");
  assert.match(log, /music: track 42\.65s lands on the drop at 8\.1s \(start 34\.55\), lift 13 dB/);
  assert.match(log, /music: 'head-bang' not on disk, skipped \(music\.optional\)/);
  assert.match(log, /sfx design \(med\)/);
  check("premium-iman: drop ladder + flashes, alignDrop, unshipped bed skipped, sfxDesign pass runs");
  let truth = jsonOf(dir, "edit_truth.json");
  assert.equal(truth.beats.filter((b) => b.type === "scene" && b.kind === "image").length, 13, "the ladder scenes are beats");
  assert.ok(truth.takes.every((t) => t.ramp === undefined) && truth.txTransitions === undefined, "no ramp / txTransitions keys when unset");
  const sfxev = jsonOf(dir, "sfx_events.json");
  assert.ok(Array.isArray(sfxev.events));
  assert.match(log, /sound\(s\) skipped, \d+ id\(s\) unavailable: .*cinematic-deep-boom/, "the drop boom is a missing-library warning, not a die");
  check("premium-iman: edit_truth lists the ladder scenes and no premium keys; missing sfx only warns");

  // a stage on Podcast Glow keeps its engine default (room 150)
  dir = project({ style: "podcast-glow", stage: {} }, { matte: true });
  assert.match(build(dir), /stage: subject head top 300px -> subject scale 0\.96/);
  check("stage.room stays 150 for every other style (podcast-glow subject scale 0.96)");

  // ---------- premium-belmar (Prestige) ----------
  dir = project({ style: "premium-belmar", takes: [{ a: 0, b: 4 }, { a: 4.5, b: 14 }], captions: { emph: ["idea"] }, drop: { at: 6, shots: [{ self: 1 }, { self: 3 }] }, outro: 2,
    beats: [{ type: "endcard", at: "outro+0", variant: "caps", title: "FOLLOW FOR MORE", accent: "FOLLOW" }] }, { spans: [[0.3, 3.8]] });
  log = build(dir); h = html(dir);
  assert.match(log, /grade preset belmar-teal/);
  assert.match(log, /drop at 5\.5s: 7 cuts in 2\.90 s \(ladder 15\/15\/12\/12\/12\/9\/12 f\)/);
  assert.equal(count(h, /id="dropflash-\d+"/g), 2, "flashEvery 3 over 6 later cuts");
  assert.ok(jsonOf(dir, "caption_layout.json").blocks.every((b) => b.mode === "lux"), "lux captions at a fixed height");
  assert.match(log, /sfx design \(low\)/);
  check("premium-belmar: belmar-teal grade, lux captions, drop.at ladder with flashes, low-density sfx pass");

  // ---------- premium-signature ----------
  dir = project({ style: "premium-signature", takes: [{ a: 0, b: 10 }], beats: [
    { type: "scene", kind: "image", self: 3, at: 3, to: 3.6, cutSfx: "click-1", in: "whip", pos: "72% 50%" },
    { type: "scene", kind: "concept", word: "TIME", at: 5, to: 6.4, engravings: ["chess", "hourglass"], tickSfx: "click-1" }] }, { spans: [[0.3, 9.5]] });
  log = build(dir); h = html(dir);
  assert.ok(jsonOf(dir, "caption_layout.json").blocks.every((b) => b.mode === "cluster"));
  assert.match(h, /object-position:72% 50%|<video[^>]*b0-img/, "scene.pos / self video");
  assert.match(log, /music: 'silent-descent' not on disk, skipped \(music\.optional\)/);
  assert.match(log, /sfx design \(high\)/);
  assert.ok(h.includes("-wf") || h.includes("pk-whip") || /b\d+-wf/.test(h), "a whip-in scene carries its per-scene blur filter");
  assert.match(h, /\.cw\.hs \{ font-style: italic/, "serifItalic");
  check("premium-signature: cluster captions, serif italic, cutSfx / tickSfx / pos / whip scene, unshipped bed skipped");

  // ---------- premium-kit-demo: ramps, scene ramp, transitions, popSafe ----------
  const DEMO = { style: "premium-kit-demo", takes: [{ a: 0, b: 4.5 }, { a: 5, b: 8, ramp: "rush" }, { a: 8.5, b: 13 }], beats: [{ type: "scene", kind: "image", self: 9, ramp: "hit", at: 2, to: 3.5 }] };
  dir = project(DEMO, { spans: [[0.3, 4.4], [8.6, 13]] });
  log = build(dir); h = html(dir);
  assert.match(log, /ramp take 1: 5-8 s source -> 1\.23 s \(1x\.\.3x\), muted/);
  assert.match(log, /ramp scene b0: 9\+2\.215 s source -> 1\.5 s \(0\.5x\.\.2\.6x\)/);
  assert.match(log, /transitions: whip@4\.5, zoom@5\.733/, "ramp boundaries always get a transition");
  assert.ok(fs.readdirSync(path.join(dir, "assets")).some((f) => /^ramp-take1-[0-9a-f]{10}\.mp4$/.test(f)) && fs.readdirSync(path.join(dir, "assets")).some((f) => /^ramp-b0-/.test(f)));
  assert.match(h, /<video id="take-1" src="assets\/ramp-take1-[0-9a-f]{10}\.mp4"[^>]*data-media-start="0"[^>]*muted/);
  assert.ok(!/id="take-1-audio"/.test(h) && /id="take-0-audio"/.test(h), "a ramped take has no audio tag");
  assert.ok(h.includes('id="tx"') && h.includes("pk-whip"), "#tx wrapper and the whip filter exist because of spec.transitions");
  // the ramp clip really is 1.233 s long
  const rampFile = fs.readdirSync(path.join(dir, "assets")).find((f) => /^ramp-take1-/.test(f));
  const rd = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(dir, "assets", rampFile)]).toString());
  near(rd, 1.233, 0.1);
  truth = jsonOf(dir, "edit_truth.json");
  assert.equal(truth.takes[1].ramp, "rush"); near(truth.takes[1].dur, 1.233, 0.001);
  assert.deepEqual(truth.txTransitions, [{ t: 4.5, kind: "whip" }, { t: 5.733, kind: "zoom" }]);
  assert.equal(truth.takes[0].ramp, undefined);
  near(truth.takes[2].start, 5.733, 0.001);
  assert.ok(!jsonOf(dir, "caption_layout.json").blocks.some((b) => b.t0 >= 4.5 && b.t1 <= 5.7), "no captions on the ramped take");
  assert.match(h, /scale: 1\.0\d+, duration: 0\.08/, "popSafe: long words pop less than 1.08");
  check("kit demo: take.ramp (muted, warped, no captions, edit_truth), scene.ramp, whip / zoom on #tx, txTransitions, popSafe");

  // E() maps a bare source time inside a ramped take through the warp: a beat at source 6.5 lands inside the 1.233 s edit span
  dir = project({ ...DEMO, style: "clean", beats: [{ type: "emoji", at: 6.5, to: 7, emoji: "fire" }] }, { spans: [[0.3, 4.4], [8.6, 13]] });
  build(dir);
  const eb = jsonOf(dir, "edit_truth.json").beats[0];
  assert.ok(eb.at > 4.5 && eb.at < 5.733, `a beat inside the ramp take maps through the warp (${eb.at})`);
  assert.ok(Math.abs(eb.at - (4.5 + 1.5)) > 0.2, "...and not through the linear mapping");
  check("E() maps source time inside a ramped take through the warp");

  // a join that carries its own take.transition (I-17) keeps it; spec.transitions skips that join
  dir = project({ style: "premium-kit-demo", transitions: { kind: "mix", every: 1 }, takes: [{ a: 0, b: 4.5 }, { a: 5, b: 9, transition: "blur" }, { a: 9.5, b: 13 }] }, { spans: [[0.3, 4.4], [5.1, 8.9], [9.6, 13]] });
  log = build(dir);
  assert.match(log, /transitions: whip@8\.5\n/, "every join is a candidate: only the one into take 2 (no take.transition of its own) is a #tx transition");
  assert.ok(!/transitions: .*@4\.5/.test(log), "the join with its own take.transition is skipped");
  truth = jsonOf(dir, "edit_truth.json");
  assert.equal(truth.takes[1].transition, "blur");
  assert.ok(!truth.txTransitions.some((x) => x.t === truth.takes[1].start));
  check("spec.transitions skips a join that has its own take.transition (I-17 wins)");

  // ---------- with real (synthetic) sounds: PHANTASIC_LIB points the build at a mini library ----------
  const lib = path.join(root, "lib");
  fs.mkdirSync(path.join(lib, "sfx"), { recursive: true }); fs.mkdirSync(path.join(lib, "music"), { recursive: true });
  const realMan = JSON.parse(fs.readFileSync(path.join(HERE, "..", "library", "sfx", "manifest.json"), "utf8"));
  const realTiming = JSON.parse(fs.readFileSync(path.join(HERE, "..", "library", "sfx", "timing.json"), "utf8"));
  const ids = ["riser-1", "cinematic-rumble-riser", "cinematic-deep-boom", "impact-1", "whoosh-cine", "pop-1", "pop-2", "tick-1", "click-1", "cinematic-cine-hit", "tech-camera-flash", "tech-digital-whoosh", "burn-whoosh-fast", "burn-whoosh-tunnel", "zoom-sweep-small", "zoom-sweep-short", "pop-whoosh-light"];
  const miniMan = {}, miniTiming = {};
  for (const id of ids) {
    miniMan[id] = { ...realMan[id], duration: Math.min(realMan[id].duration, 1.2) };
    if (realTiming[id]) miniTiming[id] = { ...realTiming[id], dur: Math.min(realTiming[id].dur, 1.2), peak_t: Math.min(realTiming[id].peak_t, 1.0) };
    ff("-f", "lavfi", "-i", `sine=frequency=${200 + ids.indexOf(id) * 40}:duration=${miniMan[id].duration}`, path.join(lib, "sfx", realMan[id].file));
  }
  fs.writeFileSync(path.join(lib, "sfx", "manifest.json"), JSON.stringify(miniMan));
  fs.writeFileSync(path.join(lib, "sfx", "timing.json"), JSON.stringify(miniTiming));
  fs.writeFileSync(path.join(lib, "music", "manifest.json"), JSON.stringify({}));
  const LIBENV = { PHANTASIC_LIB: lib };
  const tagsOf = (h2) => count(h2, /<audio id="sfx-\d+"/g);

  dir = project(IMAN, { spans: [[0.3, 7.8]], matte: true });
  log = build(dir, LIBENV);
  let ev = jsonOf(dir, "sfx_events.json").events;
  const boom = ev.find((e) => e.why === "drop boom"), rz = ev.find((e) => e.why.startsWith("drop riser"));
  near(boom.t, 8.1, 0.002);
  assert.ok(rz && rz.fade === 0.03, "the drop riser is cut with a short fade");
  near(rz.t + rz.dur, 8.1 - 0.1, 0.003);   // tops out DR.gap (3 f) before the boom
  assert.ok(ev.filter((e) => e.why === "drop flash cut").length === 4, "a camera flash sound on each white flash");
  h = html(dir);
  assert.match(h, new RegExp(`<audio id="sfx-\\d+" src="assets/sfx/cinematic-rumble-riser.wav"[^>]*data-automation=`), "the cut riser carries its fade lane");
  assert.ok(ev.some((e) => e.why.includes("type card")), "type-card sounds are in sfx_events.json");
  assert.equal(tagsOf(h), ev.filter((e) => !e.id.startsWith("meme:")).length, "sound.completeMix: every planned sound has an audio tag");
  check("with sounds on disk: drop boom / riser (cut + fade) / flash sounds, completeMix writes a tag for every event");
  dir = project({ ...IMAN, sound: { completeMix: false } }, { spans: [[0.3, 7.8]], matte: true });
  build(dir, LIBENV);
  ev = jsonOf(dir, "sfx_events.json").events;
  assert.ok(tagsOf(html(dir)) < ev.filter((e) => !e.id.startsWith("meme:")).length, "without completeMix the late sounds (type cards) have no tag, as before");
  check("sound.completeMix off: the early mix keeps its old behaviour (late sounds get no tag)");

  dir = project(DEMO, { spans: [[0.3, 4.4], [8.6, 13]] });
  build(dir, LIBENV);
  ev = jsonOf(dir, "sfx_events.json").events;
  const dz = ev.filter((e) => e.design);
  assert.ok(dz.some((e) => e.design === "riser" && e.fade === 0.06) && dz.some((e) => e.design === "hit") && dz.some((e) => e.design === "whip"), "riser > hit on the major cut, a swish on the whip");
  const ramped = dz.find((e) => e.design === "riser");
  near(ramped.t + ramped.dur, 2 + 0.04, 0.5);
  check("kit demo with sounds: riser (fade) + hit on the cut into B-roll / the ramp, swish on the whip");

  // ---------- premium-noir parity ----------
  dir = project({ style: "premium-noir", takes: [{ a: 0, b: 8 }] }, { spans: [[0.3, 7.8]] });
  log = build(dir); h = html(dir);
  assert.ok(jsonOf(dir, "caption_layout.json").blocks.every((b) => b.mode === "noir"));
  assert.match(log, /grade preset noir-film/); assert.ok(h.includes("letterbox") || h.includes('id="lb') || /pk-grade-noir-film/.test(h));
  assert.match(log, /music: 'silent-descent' not on disk, skipped \(music\.optional\)/);
  check("premium-noir: noir captions, noir-film grade, unshipped piano skipped (parity with the main branch's style file)");

  // ---------- PHANTASIC_PREVIEW_SCALE ----------
  dir = project({ style: "clean" });
  log = build(dir, { PHANTASIC_PREVIEW_SCALE: "0.5" }); h = html(dir);
  assert.match(log, /preview: 540x960/);
  assert.match(h, /<div id="stage" data-composition-id="main"[^>]*data-width="540" data-height="960"/);
  dir = project({ style: "clean" });
  build(dir);
  assert.ok(!html(dir).includes('id="stage" data-composition-id'), "no preview wrapper without the env var");
  check("PHANTASIC_PREVIEW_SCALE=0.5 writes the 540x960 stage; off by default");

  // ---------- the new die()s ----------
  fails(project({ ...DEMO, takes: [{ a: 0, b: 4.5 }, { a: 5, b: 8, ramp: "rush" }, { a: 8.5, b: 13 }] }, { spans: [[0.3, 8]] }), /take 1 has a ramp but contains speech/);
  fails(project({ style: "clean", takes: [{ a: 0, b: 4.5 }, { a: 5, b: 8, ramp: "rush" }] }, { spans: [[0.3, 4.4]] }), /can't be the last take or carry a hold/);
  fails(project({ style: "clean", takes: [{ a: 0, b: 4.5 }, { a: 5, b: 8, ramp: "rush", hold: 1 }, { a: 9, b: 12 }] }, { spans: [[0.3, 4.4]] }), /can't be the last take or carry a hold/);
  fails(project({ style: "podcast-glow", stage: {}, takes: [{ a: 0, b: 4.5 }, { a: 5, b: 8, ramp: "rush" }, { a: 9, b: 12 }] }, { spans: [[0.3, 4.4]], matte: true }), /take\.ramp is not supported with spec\.stage \/ spec\.matte/);
  fails(project({ style: "clean", takes: [{ a: 0, b: 4.5 }, { a: 5, b: 8, ramp: "warp9" }, { a: 9, b: 12 }] }, { spans: [[0.3, 4.4]] }), /take 1: unknown ramp preset 'warp9'/);
  fails(project({ style: "clean", sfxDesign: { density: "loud" } }), /sfxDesign\.density must be low, med or high \(got loud\)/);
  fails(project({ style: "clean", transitions: { kind: "spin" } }), /transitions\.kind must be whip, zoom or mix \(got spin\)/);
  fails(project({ style: "clean", drop: { hold: 0 } }), /drop needs shots/);
  fails(project({ style: "clean", drop: { shots: [{ self: 1 }] } }), /drop needs hold: <take index> or at: <source second>/);
  fails(project({ style: "clean", drop: { hold: 3, shots: [{ self: 1 }] } }), /drop\.hold 3: there is no take 3/);
  check("every new die(): ramp on speech / last take / hold / stage / unknown preset, bad density, bad transitions.kind, drop shape");

  // ---------- a reel that sets none of it is untouched ----------
  dir = project({ style: "clean" });
  log = build(dir); h = html(dir);
  for (const needle of ["pk-whip", 'id="tx"', "dropflash", "ramp-", "sfx design", "txTransitions"]) assert.ok(!(h + log + JSON.stringify(jsonOf(dir, "edit_truth.json"))).includes(needle), `clean must not contain ${needle}`);
  check("a clean reel carries none of the premium kit");
}

// ---------- python scripts ----------
const python = ["py", "python3", "python"].find((c) => spawnSync(c, ["-c", "import cv2, numpy"], { stdio: "ignore" }).status === 0);
const PYS = ["score", "autoscore", "prestige_score", "noir_score", "signature_plan", "relight", "splice_matte", "empire_finish"];
if (!python) {
  console.log("skip  premium python scripts: no python with OpenCV and numpy");
} else {
  const py = (script, args, opts = {}) => spawnSync(python, [path.join(HERE, script), ...args], { encoding: "utf8", ...opts });
  for (const s of PYS) {
    const r = spawnSync(python, ["-m", "py_compile", path.join(HERE, `${s}.py`)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${s}.py compiles: ${r.stderr}`);
    const h = py(`${s}.py`, ["--help"]);
    assert.equal(h.status, 0, `${s}.py --help: ${h.stderr}`);
    assert.ok(h.stdout.length > 100, `${s}.py --help prints its docstring`);
  }
  check("python: all 8 scripts compile and print --help (exit 0)");
  for (const s of PYS) {
    const src = fs.readFileSync(path.join(HERE, `${s}.py`), "utf8");
    const code = src.replace(/^"""[\s\S]*?"""/m, "");   // the docstring may say "zsh" or "Mac" in prose
    assert.ok(!/\/Users\/|\/home\/|~\/reels|\$HOME|zsh|\.venv\/bin/.test(code), `${s}.py has no Mac path or zsh call`);
  }
  check("python: no /Users, ~/reels, $HOME, zsh or .venv/bin path is left in the ports");

  // a tiny synthetic project: 6 s sine "voice", a 6 s video, words, a fake pack of 0.3 s wavs for ONE of the cues
  const P = path.join(root, "py"); fs.mkdirSync(path.join(P, "assets"), { recursive: true }); fs.mkdirSync(path.join(P, "build"), { recursive: true });
  ff("-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-f", "lavfi", "-i", "testsrc2=size=108x192:rate=30:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(P, "assets", "talk.mp4"));
  fs.copyFileSync(path.join(P, "assets", "talk.mp4"), path.join(P, "build", "reel.mp4"));
  const pack = path.join(root, "pack"); fs.mkdirSync(pack);
  ff("-f", "lavfi", "-i", "sine=frequency=110:duration=0.4", path.join(pack, "e-subboom-tail.wav"));
  ff("-f", "lavfi", "-i", "sine=frequency=880:duration=0.05", path.join(pack, "e-type-key.wav"));
  ff("-f", "lavfi", "-i", "sine=frequency=330:duration=3", path.join(root, "music.wav"));
  const aw = { segments: [{ words: [["so", 0.3], ["we", 0.6], ["have", 0.9], ["no", 1.2], ["idea", 1.6], ["what", 2.4], ["this", 2.7], ["costs", 3.0]].map(([word, start]) => ({ word, start, end: start + 0.2 })) }] };
  fs.writeFileSync(path.join(P, "build", "words.aligned.json"), JSON.stringify(aw));
  fs.writeFileSync(path.join(P, "reel.json"), JSON.stringify({ source: "assets/talk.mp4", takes: [{ a: 0, b: 5 }], captions: { emph: ["idea"] }, beats: [{ type: "endcard", at: 4, to: 4.8, arrow: false, font: "serif" }] }));
  fs.writeFileSync(path.join(P, "build", "sfx_events.json"), JSON.stringify({ events: [{ t: 1.6, why: "type card hit (red)" }, { t: 3.4, why: "drop boom" }, { t: 3.3, why: "drop riser (tops out before the gap)" }, { t: 3.5, why: "drop flash cut" }, { t: 1, why: "word pop" }, { t: 4.2, why: "end card" }] }));

  // autoscore -> score
  let r = py("autoscore.py", [P, path.join(P, "build", "reel.mp4"), "--pack", pack, "--music", path.join(root, "music.wav"), "-o", path.join(P, "build", "cues.json")]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /autoscore: \d+ cues, 1 verdicts, 1 interlude\(s\)/);
  const cues = JSON.parse(fs.readFileSync(path.join(P, "build", "cues.json"), "utf8"));
  assert.ok(cues.cues.length > 5 && cues.music && cues.beds.length >= 1 && cues.voice.takes[0][1] === 5);
  r = py("score.py", [path.join(P, "build", "cues.json")]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /scored -> .*reel-scored\.mp4  \(-1[34]\.\d LUFS, true peak -?[\d.]+ dBFS\); \d+ file\(s\) skipped/);
  assert.match(r.stderr, /WARNING: cue not found, skipped/, "a missing pack wav is a warning");
  assert.ok(fs.statSync(path.join(P, "build", "reel-scored.mp4")).size > 1000);
  const lufs = parseFloat(/\((-?[\d.]+) LUFS/.exec(r.stdout)[1]);
  assert.ok(Math.abs(lufs + 14) < 1.0, `loudness lands at -14 LUFS (${lufs})`);
  check("autoscore.py -> score.py: a cue sheet from build data, scored to -14 LUFS, missing pack wavs only warn");
  r = py("autoscore.py", [P, path.join(P, "build", "reel.mp4")], { env: { ...process.env, PHANTASIC_SFX_PACK: "" } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /no sound pack/);
  check("autoscore.py refuses to run with no pack path (no Mac default)");

  // noir / prestige
  r = py("noir_score.py", [P, path.join(P, "build", "reel.mp4"), "--pack", pack, "-o", path.join(P, "build", "noir.json")]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /noir_score: \d+ cues, 1 chapter card/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(P, "build", "noir.json"), "utf8")).music, undefined, "no --music = no music key");
  r = py("prestige_score.py", [P, path.join(P, "build", "reel.mp4"), "--music", path.join(root, "music.wav"), "--music-drop", "1.0", "-o", path.join(P, "build", "prestige.json")]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /prestige_score: \d+ cues, drop 3\.4, card 4\.2/);
  const pj = JSON.parse(fs.readFileSync(path.join(P, "build", "prestige.json"), "utf8"));
  assert.equal(pj.music.env.at(-1)[1], -4, "the bed ducks under the end card");
  assert.ok(pj.music.at > 2, "the track enters so that its drop lands on the boom");
  check("noir_score.py / prestige_score.py: cue sheets from build data (music only when given)");

  // signature_plan: reel + score
  const plan = path.join(P, "plan.json");
  fs.writeFileSync(plan, JSON.stringify({ project: P, title: "sig", takes: [[0, 5]], heroes: ["idea"], payoff: 1.6, cuts: [{ src: "assets/a.jpg", at: 2.4, to: 3.4, amb: "sea" }, { src: "assets/b.jpg", at: 3.6, to: 4.0 }] }));
  r = py("signature_plan.py", ["reel", plan]);
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /reel: 1 takes, 2 cuts, 2 zoom snaps/);
  const sr = JSON.parse(fs.readFileSync(path.join(P, "reel.json"), "utf8"));
  assert.equal(sr.style, "premium-signature"); assert.equal(sr.words, "build/words.aligned.json");
  assert.deepEqual(sr.captions.heroes, ["idea"]); assert.equal(sr.captions.heroFallback, "none");
  assert.deepEqual(sr.zoom.snaps, [[0, 1], [1.6, 1.18]]);
  assert.deepEqual(sr.beats.map((b) => b.type), ["scene", "scene", "mood"]);
  assert.equal(sr.beats[0].pos, "50% 50%"); assert.equal(sr.beats[0].captions, true);
  r = py("signature_plan.py", ["score", plan, path.join(P, "build", "reel.mp4"), "--pack", pack]);
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /score: \d+ cues, 0 beds/);
  r = py("signature_plan.py", ["score", plan, path.join(P, "build", "reel.mp4")], { env: { ...process.env, PHANTASIC_SFX_PACK: "" } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /no sound pack/);
  check("signature_plan.py: plan -> reel.json (style premium-signature, hero snaps, cut scenes, leak + mood) and -> cues.json");

  // relight + splice on 3 synthetic frames (1080x1920, so a few seconds)
  const S3 = path.join(root, "rl"); fs.mkdirSync(S3);
  ff("-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=0.1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(S3, "src.mp4"));
  ff("-f", "lavfi", "-i", "gradients=size=1080x1920:rate=30:duration=0.1:c0=0xffffff:c1=0x303030:nb_colors=2,format=gray", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(S3, "depth.mp4"));
  ff("-f", "lavfi", "-i", "color=c=white:s=1080x1920:r=30:d=0.1,format=yuva420p", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", path.join(S3, "orig.webm"));
  r = py("relight.py", [path.join(S3, "src.mp4"), path.join(S3, "depth.mp4"), path.join(S3, "relit.mp4"), "--look", "neon", "--no-auto"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(S3, "relit.mp4")) && fs.existsSync(path.join(S3, "relit-mask.mp4")), "relight writes the picture and its mask");
  r = py("relight.py", [path.join(S3, "src.mp4"), path.join(S3, "depth.mp4"), path.join(S3, "frame.png"), "--frame", "--look", "warm", "--no-auto"]);
  assert.equal(r.status, 0, r.stderr); assert.ok(fs.statSync(path.join(S3, "frame.png")).size > 1000, "--frame writes a before/after png");
  r = py("relight.py", [path.join(S3, "src.mp4"), path.join(S3, "depth.mp4"), path.join(S3, "x.mp4"), "--look", "disco"]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /--look must be neon, warm or empire/);
  r = py("splice_matte.py", [path.join(S3, "orig.webm"), path.join(S3, "relit.mp4"), path.join(S3, "relit-mask.mp4"), "0", path.join(S3, "out.webm")]);
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /frames \d+, relit \d+/);
  assert.ok(fs.statSync(path.join(S3, "out.webm")).size > 100, "splice writes a webm");
  r = py("splice_matte.py", [path.join(S3, "orig.webm"), path.join(S3, "relit.mp4"), path.join(S3, "relit-mask.mp4"), "0", path.join(S3, "orig.webm")]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /output must not be the input matte/);
  check("relight.py (neon + --frame warm) and splice_matte.py on synthetic 1080x1920 frames; bad look and in-place output refused");

  r = py("empire_finish.py", [P, path.join(S3, "src.mp4"), path.join(S3, "depth.mp4"), path.join(S3, "none.json"), path.join(S3, "o.mp4")]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /takes\.json not found/);
  check("empire_finish.py checks its inputs before it touches anything (it is not run end to end here: it renders and needs a depth map)");
}
console.log("\nbuild-ahmed-premium.test.mjs passed");
fs.rmSync(root, { recursive: true, force: true });

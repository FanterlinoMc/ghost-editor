#!/usr/bin/env node
// Is every frame of a `motion` beat a pure function of time? (docs/MOTION-GRAPHICS-SPEC.md, hard rule 2)
//
//   node scripts/motion-determinism.mjs [--variant busy|blur|room|layers] [--seek render|plain] [--capture beginframe|screenshot] [--no-reset] [--passes 3]
//                                       [--dir <project dir>] [--keep]
//
// Builds a synthetic keynote-3 reel with a busy hand-written motion beat (scripts/lib/motion-fixture.mjs),
// opens the composition in headless Chrome and seeks the paused GSAP timeline the way the renderer does
// (totalTime(t + .001, suppress); totalTime(t) - hyperframes' own renderSeek). For each sample time t:
//
//   reference   t reached by a forward sweep from 0
//   shuffled    t reached after detours to an earlier and a later time (inside and outside the beat)
//   reverse     t reached by sweeping backwards from the end
//   cold        t reached first thing in a freshly loaded page
//   repeat      t sought twice in a row
//
// and compares the screenshots byte for byte (PNG of identical pixels is identical bytes) and the motion
// subtree's DOM state (inline styles, attributes, text) element by element. Exit 1 on any mismatch.
//
// --seek plain uses tl.seek(t, true) (events suppressed): a diagnostic for what a player that suppresses
// callbacks would show; the count-up text is the thing that can differ.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { findPuppeteer, findChrome } from "./lib/browser.mjs";
import { serveVendoredInPage } from "./lib/vendor.mjs";
import { makeProject, BUSY_BEAT, BLUR_BEAT, ROOM_BEAT, ROOM_OVERLAP_BEATS, LAYERS_FIXTURE } from "./lib/motion-fixture.mjs";
import { ROOM_SCALE, roomFrames, roomWindows, roomScaleAt, roomCardAt } from "./lib/room.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true); };
const variant = opt("variant", "busy"), seekMode = opt("seek", "render"), passes = +opt("passes", 3);
const keep = !!opt("keep", false);
// --variant layers: reel.layers[] instead of a beat (BLANK-TIMELINE-SPEC.md, Stage 3) - a video PiP, an image logo,
// a sticker, a text box over the captions and a motion layer. Same questions, same capture; the state compared is
// every [data-layer-id] subtree, and there is no camera hold / making-room to assert. The PiP's <video> is taken out
// of the picture like all footage here, so its box gets a flat colour to have pixels of its own.
const isLayers = variant === "layers";
const beat = isLayers ? { at: 2.0, to: 8.0, elements: [{ id: "head" }] } : variant === "blur" ? BLUR_BEAT : variant === "room" ? ROOM_BEAT : BUSY_BEAT;
const HOLD_EXIT = beat.room === "below" ? 0.55 : 0.2;
const BEAT_AT = beat.at, BEAT_TO = beat.to, isRoom = variant === "room", FPS = 30;
const dir = opt("dir", path.join(os.tmpdir(), `motion-determinism-${variant}`));

// sample times, original = output seconds (one kept take): before, entrance, mid, exit, after
const SAMPLES = isLayers
  ? [0.5, 1.0, 1.15, 1.5, 2.1, 2.4, 3.0, 3.15, 4.0, 4.9, 5.1, 5.3, 6.4, 6.5, 7.0, 7.9, 8.0, 8.9, 9.5]   // each layer's enter, middle and exit, and the gaps
  : isRoom
  ? [1.0, 1.9, 2.0, 2.1, 2.175, 2.25, 2.35, 3.2, 4.0, 6.1, 6.25, 6.3, 6.4, 6.5, 6.567, 6.9, 8.0]   // room: before, start, MID-EASE-IN (2.0-2.35), held (to 6.217), exit fade (6.0-6.2), MID-EASE-OUT (6.217-6.567), after
  : [1.0, BEAT_AT, 2.15, 2.4, 3.1, 4.05, 5.1, 7.7, 7.9, BEAT_TO, 9.0];
// detour targets: outside before, inside, outside after
const DETOURS = isLayers ? [0, 0.7, 1.9, 2.9, 3.6, 4.6, 6.0, 7.5, 8.5, 9.9] : isRoom ? [0, 0.5, 1.5, 2.2, 3.3, 4.6, 5.95, 6.35, 7.5, 9.5] : [0, 0.5, 1.9, 2.9, 3.6, 4.6, 6.0, 7.95, 8.5, 9.9];

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
let seed = 0x9e3779b9;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

const proj = makeProject(dir, isLayers ? { layers: LAYERS_FIXTURE } : { beat });
const warns = proj.log.split("\n").filter((l) => /motion/i.test(l) && /(dropped|ignored|clamped|only the first|not allowed)/i.test(l));
if (warns.length) { console.error("the fixture beat produced compiler warnings (it should be clean):\n  " + warns.join("\n  ")); process.exit(2); }

// ---- the camera hold (owner decision: still camera under a motion beat; build.mjs "motion hold") ----
// The fixture is keynote-3, which inherits keynote's cadence and openPush. Build the same reel with no beat as
// the control: it must have cadence snaps inside the window [at, to + 0.2] (the "would-be" snaps) and an
// openPush; the reel with the beat must have neither, and every snap outside the window must be unchanged.
const holdFailures = [];
if (!isLayers) {
  const ctl = makeProject(dir + "-control", { beat: null });
  const readTruth = (p) => JSON.parse(fs.readFileSync(path.join(p.dir, "build", "edit_truth.json"), "utf8"));
  const withBeat = readTruth(proj), without = readTruth(ctl), FPSX = 30;
  const lo = Math.round(BEAT_AT * FPSX), hi = Math.round((BEAT_TO + HOLD_EXIT) * FPSX);
  const inWin = (s) => { const f = Math.round(s.t * FPSX); return f >= lo && f <= hi; };
  const wouldBe = without.snaps.filter(inWin);
  if (!wouldBe.length) holdFailures.push("control has no cadence snap inside the window: the hold is not being exercised");
  if (withBeat.snaps.some(inWin)) holdFailures.push(`snaps left inside the window: ${JSON.stringify(withBeat.snaps.filter(inWin))}`);
  const key = (s) => `${s.t}@${s.scale}`;
  const outside = (x) => x.snaps.filter((s) => !inWin(s)).map(key).join(",");
  if (outside(withBeat) !== outside(without)) holdFailures.push(`snaps outside the window changed:\n    control ${outside(without)}\n    beat    ${outside(withBeat)}`);
  if (!without.pushes.some((p) => p.start === 0)) holdFailures.push("control has no openPush: the openPush drop is not being exercised");
  if (withBeat.pushes.some((p) => p.start === 0)) holdFailures.push("openPush survived a beat that starts inside it");
  console.log(`  hold: control ${without.snaps.length} snaps (${wouldBe.length} inside ${BEAT_AT}-${BEAT_TO + HOLD_EXIT}), with beat ${withBeat.snaps.length}; openPush control=${without.pushes.some((p) => p.start === 0)} beat=${withBeat.pushes.some((p) => p.start === 0)}`);
}

const puppeteer = findPuppeteer();
// HOW A FRAME IS CAPTURED (what makes pixel equality a fair test; found by bisecting a 1-pixel flake):
// Chrome does not draw a frame from scratch. It re-rasters only invalid tiles and redraws only the damage rect, so a
// frame's pixels depend on the frames DRAWN BEFORE it (a stale anti-aliasing row at the edge of a fractional-translate
// layer, 39 vs 26 of 255 along one 630 px row of the card at t=2.15; a few levels along a dashed stroke). The DOM is
// identical in those cases - computed style and GSAP's attribute values match to the last digit, and this harness compares
// both. So this test asks the engine's question: is the state, and a FULL DRAW of it, a pure function of time?
//   1. Capture is driven like hyperframes' LINUX render container (captureMode "beginframe": HeadlessExperimental.beginFrame
//      with its flags). Local Windows/macOS renders use plain Page.captureScreenshot, which also races the async compositor:
//      the same state then screenshots as one of two images, ~5% of seeks.
//   2. A blank frame (#root hidden) is drawn BEFORE each seek, so every capture starts from the same predecessor whatever
//      the visiting order. Without it: 14/75 captures differ in one probe, 10-11/66 in the harness.
// What this does NOT claim: a forward render (frame N drawn right after N-1) differs from the blank-predecessor image on
// ~half the frames of the busy beat, by anti-aliasing levels. That residue is Chrome's incremental drawing, is repeatable
// for a given draw sequence (a fresh page started mid-range reproduces the forward pass, 61/61 frames), and is not
// removable from the engine: gsap force3D:false makes it worse (77/95 frames). --capture screenshot and --no-reset keep
// the unprotected behaviour, to reproduce the flake.
const captureMode = opt("capture", "beginframe"), resetFrame = captureMode === "beginframe" && !opt("no-reset", false);
const BEGINFRAME_ARGS = ["--deterministic-mode", "--enable-begin-frame-control", "--disable-new-content-rendering-timeout", "--run-all-compositor-stages-before-draw", "--disable-threaded-animation", "--disable-threaded-scrolling", "--disable-checker-imaging", "--disable-image-animation-resync", "--enable-surface-synchronization", "--disable-gpu-compositing", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: "shell", args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars", ...(captureMode === "beginframe" ? BEGINFRAME_ARGS : [])], defaultViewport: { width: 1080, height: 1920, deviceScaleFactor: 1 } });
const prefix = isLayers ? "ly-gfx_m" : fs.readFileSync(proj.html, "utf8").match(new RegExp(`id="(b\\d+)-${beat.elements[0].id}"`))?.[1];
if (!prefix || (isLayers && !fs.readFileSync(proj.html, "utf8").includes(`id="${prefix}-head"`))) throw new Error("motion elements not found in index.html");

// reset: draw a blank frame first. The seek must come AFTER it (`after`): a seek made while #root is hidden is not drawn
// from a blank state - the same 14/75 captures differ as with no reset at all.
async function grab(page, reset = false, after = null) {
  if (captureMode !== "beginframe") { if (after) await after(); return page.screenshot({ type: "png" }); }
  if (!page.__cdp) { page.__cdp = await page.createCDPSession(); await page.__cdp.send("HeadlessExperimental.enable"); page.__tick = 1000; await page.__cdp.send("HeadlessExperimental.beginFrame", { frameTimeTicks: page.__tick, interval: 33, noDisplayUpdates: true }); }
  const frame = async (shot) => {
    for (let a = 0; a < 10; a++) {   // a frame with no visual change returns no screenshot: ask again with the next tick
      page.__tick += 33;
      const r = await page.__cdp.send("HeadlessExperimental.beginFrame", { frameTimeTicks: page.__tick, interval: 33, ...(shot ? { screenshot: { format: "png" } } : {}) });
      if (!shot || r.screenshotData) return r.screenshotData && Buffer.from(r.screenshotData, "base64");
    }
    throw new Error("beginFrame returned no screenshot");
  };
  if (reset) { await page.evaluate(() => { document.getElementById("root").style.visibility = "hidden"; }); await frame(false); await page.evaluate(() => { document.getElementById("root").style.visibility = ""; }); }
  return after ? after().then(() => frame(true)) : frame(true);
}
async function open() {
  const page = await browser.newPage();
  await serveVendoredInPage(page);   // vendor/ answers anything the page names (no CDN)
  await page.evaluateOnNewDocument(() => { window.__timelines = {}; });   // the hyperframes runtime creates this registry; the composition only fills it
  await page.goto(pathToFileURL(proj.html).href, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__timelines && window.__timelines.main && window.tween, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready.then(() => 0));
  await page.evaluate((mode, roomRun, layersRun) => {
    const tl = window.__timelines.main; tl.pause();
    // The footage is not under test and a bare page has no runtime to seek it: an autoplaying <video> would
    // put a different frame in every screenshot. Take it out of the picture; the graphics sit over it anyway.
    for (const m of document.querySelectorAll("video, audio")) { m.pause(); m.removeAttribute("autoplay"); m.style.visibility = "hidden"; }
    document.body.style.background = "#222";
    if (roomRun) {   // footage stand-in: a static picture with a marked face, so the room transform changes real pixels
      document.getElementById("push").style.background = "#2a4a78";
      const f = document.createElement("div"); f.style.cssText = "position:absolute;left:340px;top:240px;width:400px;height:620px;background:#e8b48a;border:6px solid #fff;box-sizing:border-box"; document.getElementById("push").appendChild(f);
    }
    if (layersRun) for (const b of document.querySelectorAll("[data-layer-box]")) if (b.querySelector("video")) b.style.background = "#2e8b57";   // layers: the PiP's footage stand-in
    window.__seek = (t) => {
      if (mode === "plain") tl.seek(t, true); else { tl.totalTime(t + 0.001, true); tl.totalTime(t, false); }
      // the hyperframes runtime shows a .clip only inside [data-start, data-start + data-duration); do the same
      for (const c of document.querySelectorAll(".clip[data-start]")) {
        const s = +c.dataset.start, d = +c.dataset.duration;
        c.style.visibility = t >= s - 1e-6 && t < s + d - 1e-6 ? "" : "hidden";
      }
    };
    // computed (not inline) style: GSAP rewrites the style attribute the first time it touches an element, so
    // the attribute text differs between "never rendered" and "rendered" without any visible difference
    window.__state = (px) => {
      const out = {};
      for (const i of ["room", "roomfill", "caps", "ecaps"]) { const e = document.getElementById(i); if (e) { const cs = getComputedStyle(e); out["#" + i] = [cs.opacity, cs.transform, cs.visibility, cs.borderRadius, cs.boxShadow].join(" | "); } }
      if (layersRun) {   // every layer's wrapper subtree, keyed by its data-layer-id
        const walkL = (e, p) => {
          const cs = getComputedStyle(e);
          out[p + (e.id ? "#" + e.id : "")] = [cs.opacity, cs.transform, cs.filter, cs.clipPath, cs.visibility, cs.strokeDashoffset, cs.boxShadow, e.children.length === 0 ? e.textContent : ""].join(" | ");
          [...e.children].forEach((c, i) => walkL(c, p + "/" + i));
        };
        for (const w of document.querySelectorAll("[data-layer-id]")) walkL(w, "L:" + w.dataset.layerId);
        return out;
      }
      const root = document.getElementById(px + "-in");
      if (!root) return { "(missing)": "no root" };
      (function walk(e, p) {
        const cs = getComputedStyle(e);
        out[p + (e.id ? "#" + e.id : "")] = [cs.opacity, cs.transform, cs.filter, cs.clipPath, cs.visibility, cs.strokeDashoffset, e.children.length === 0 ? e.textContent : ""].join(" | ");
        [...e.children].forEach((c, i) => walk(c, p + "/" + i));
      })(root, "r");
      return out;
    };
  }, seekMode, isRoom, isLayers);
  return page;
}
async function at(page, t) {
  const png = await grab(page, resetFrame, () => page.evaluate((x) => window.__seek(x), t));
  const state = await page.evaluate((px) => window.__state(px), prefix);
  return { png, shot: sha(png), state, stateHash: sha(JSON.stringify(state)) };
}

const failures = [];
// determinism alone could pass on a consistently wrong answer: also pin the count-up to its known values
const EXPECT_COUNT = { 1.0: "0", 2.0: "0", 7.7: "1,500", 9.0: "1,500" };
async function expectCounts() {
  if (variant !== "busy") return;
  for (const [t, want] of Object.entries(EXPECT_COUNT)) {
    const st = ref.get(+t).state, a = Object.keys(st).find((k) => k.endsWith("#" + prefix + "-count-a"));
    const got = (a && st[a.slice(0, a.indexOf("#")) + "/0/0"]) || "";
    if (!got.endsWith("| " + want)) failures.push({ label: "expected", t, pixels: false, stateKeys: ["count"], detail: [`count text at t=${t}: want '${want}', got '${got.split("| ").pop()}'`] });
  }
  // the swoosh's draw (1.8..2.8 in, 4.0..4.8 out, beat-relative; beat starts at 2.0): hidden before, part-drawn
  // mid-way (NOT stuck at 1 - GSAP rounds a CSS px dashoffset to an integer), fully drawn, then hidden again
  const sw = (t) => { const st = ref.get(t).state; const k = Object.keys(st).find((x) => x.endsWith("#" + prefix + "-swoosh-s")); const f = (st[k] || "").split(" | "); return { vis: f[4], off: parseFloat(f[5]) }; };
  const want = [[2.15, (r) => r.vis === "hidden"], [4.05, (r) => r.vis === "visible" && r.off > 0.8 && r.off < 0.95], [5.1, (r) => r.vis === "visible" && r.off === 0], [7.7, (r) => r.vis === "hidden"]];
  for (const [t, ok] of want) if (!ok(sw(t))) failures.push({ label: "expected", t, pixels: false, stateKeys: ["swoosh"], detail: [`swoosh at t=${t}: ${JSON.stringify(sw(t))}`] });
}
const outDir = path.join(dir, "determinism-fail"); fs.rmSync(outDir, { recursive: true, force: true });
function compare(label, t, ref, got) {
  if (ref.shot === got.shot && ref.stateHash === got.stateHash) return true;
  const bad = Object.keys({ ...ref.state, ...got.state }).filter((k) => ref.state[k] !== got.state[k]);
  failures.push({ label, t, pixels: ref.shot !== got.shot, stateKeys: bad.slice(0, 6), detail: bad.slice(0, 2).map((k) => `${k}\n      ref: ${ref.state[k]}\n      got: ${got.state[k]}`) });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `t${t}-ref.png`), ref.png); fs.writeFileSync(path.join(outDir, `t${t}-${label}.png`), got.png);
  return false;
}

let checks = 0;
const page = await open();
const ref = new Map();
for (const t of SAMPLES) ref.set(t, await at(page, t));                       // forward sweep
await expectCounts();
if (keep) { fs.mkdirSync(path.join(dir, "shots"), { recursive: true }); for (const [t, r] of ref) fs.writeFileSync(path.join(dir, "shots", `t${t}.png`), r.png); }   // --keep: look at them
const distinct = new Set([...ref.values()].map((r) => r.shot)).size;

const hop = (t) => { const early = DETOURS.filter((d) => d < t - 0.05), late = DETOURS.filter((d) => d > t + 0.05); const pick = (a) => a[Math.floor(rnd() * a.length)]; const h = [pick(early), pick(late)].filter((x) => x !== undefined); return rnd() < 0.5 ? h : h.reverse(); };

for (let p = 0; p < passes; p++) {
  for (const t of shuffle(SAMPLES)) {                                          // shuffled, with detours either side
    for (const d of hop(t)) await page.evaluate((x) => window.__seek(x), d);
    checks++; compare(`shuffled${p}`, t, ref.get(t), await at(page, t));
  }
}
for (const t of [...SAMPLES].reverse()) { checks++; compare("reverse", t, ref.get(t), await at(page, t)); }   // backwards scrub
for (const t of SAMPLES) { await page.evaluate((x) => window.__seek(x), t); checks++; compare("repeat", t, ref.get(t), await at(page, t)); }   // same time twice
// the camera really is still: #snap and #push compute to the same transform at every frame of the window
if (!isLayers) {
  const cam = async (t) => { await page.evaluate((x) => window.__seek(x), t); return page.evaluate(() => ["snap", "push"].map((i) => getComputedStyle(document.getElementById(i)).transform).join(" ")); };
  const want = await cam(BEAT_AT);
  for (let f = Math.round(BEAT_AT * 30); f <= Math.round((BEAT_TO + HOLD_EXIT) * 30); f++) { const got = await cam(f / 30); if (got !== want) { holdFailures.push(`camera moved at t=${(f / 30).toFixed(3)}: ${want} -> ${got}`); break; } }
}
// ---- making room (docs/MOTION-GRAPHICS-SPEC.md "Making room"; maths in lib/room.mjs) ----
const roomFailures = [];
if (isRoom) {
  const truth = JSON.parse(fs.readFileSync(path.join(proj.dir, "build", "edit_truth.json"), "utf8"));
  const wins = roomWindows([roomFrames(BEAT_AT, BEAT_TO, FPS)], FPS);
  if (JSON.stringify(truth.room) !== JSON.stringify([{ start: +wins[0].tA.toFixed(3), end: +wins[0].tB.toFixed(3), scale: ROOM_SCALE }])) roomFailures.push(`edit_truth.room: ${JSON.stringify(truth.room)}`);
  const read = async (pg, t) => { await pg.evaluate((x) => window.__seek(x), t); return pg.evaluate(() => {
    const m = getComputedStyle(document.getElementById("room")).transform.match(/matrix\(([^)]+)\)/), r = document.getElementById("room").getBoundingClientRect();
    return { a: m ? +m[1].split(",")[0] : NaN, rect: [r.x, r.y, r.width, r.height], fill: getComputedStyle(document.getElementById("roomfill")).opacity, fillBg: getComputedStyle(document.getElementById("roomfill")).backgroundColor, radius: getComputedStyle(document.getElementById("room")).borderTopLeftRadius, shadow: getComputedStyle(document.getElementById("room")).boxShadow, caps: getComputedStyle(document.getElementById("ecaps") || document.getElementById("caps")).opacity,
      snapPush: ["snap", "push"].map((i) => getComputedStyle(document.getElementById(i)).transform).join(" ") }; }); };
  for (const t of SAMPLES) {
    const g = await read(page, t), want = roomScaleAt(t, wins), tA = wins[0].tA, tB = wins[0].tB;
    if (Math.abs(g.a - want) > 2e-3) roomFailures.push(`t=${t}: #room scale ${g.a}, want ${want.toFixed(5)}`);
    const wantRect = [540 + want * (0 - 540), 0, 1080 * want, 1920 * want];
    if (g.rect.some((v, i) => Math.abs(v - wantRect[i]) > 2)) roomFailures.push(`t=${t}: #room rect ${g.rect.map((v) => v.toFixed(1))}, want ${wantRect.map((v) => v.toFixed(1))}`);
    // the card AS RENDERED: corner radius x scale, shadow offset/blur x scale, alpha; same ease as the scale
    const cw = roomCardAt(t, wins), px = (g.radius.match(/[\d.]+/) || [0])[0] * ROOM_SCALE, sm = /rgba?\(([^)]+)\)\s+([-\d.]+)px\s+([-\d.]+)px\s+([-\d.]+)px/.exec(g.shadow);
    const sh = sm ? { a: sm[1].split(",").length > 3 ? +sm[1].split(",")[3] : 1, y: +sm[3] * ROOM_SCALE, b: +sm[4] * ROOM_SCALE } : { a: 0, y: 0, b: 0 };
    if (Math.abs(px - cw.radius) > 0.15) roomFailures.push(`t=${t}: card radius ${px.toFixed(2)} rendered px, want ${cw.radius.toFixed(2)}`);
    if (Math.abs(sh.y - cw.shadowY) > 0.15 || Math.abs(sh.b - cw.shadowBlur) > 0.3 || Math.abs(sh.a - cw.shadowAlpha) > 0.003) roomFailures.push(`t=${t}: card shadow ${JSON.stringify(sh)}, want ${JSON.stringify(cw)}`);
    if (t <= tA && g.shadow !== "none" && !/^rgba\(0, 0, 0, 0\) 0px 0px 0px/.test(g.shadow)) roomFailures.push(`t=${t}: shadow outside the window: ${g.shadow}`);
    if (t > tA + 0.02 && t < tB - 0.001 && +g.fill !== 1) roomFailures.push(`t=${t}: #roomfill opacity ${g.fill} inside the window`);
    if ((t < tA - 0.001 || t > tB + 0.02) && +g.fill !== 0) roomFailures.push(`t=${t}: #roomfill opacity ${g.fill} outside the window`);
    if (t >= tA + 0.15 && t <= tB - 0.1 && +g.caps !== 0) roomFailures.push(`t=${t}: captions visible (opacity ${g.caps}) inside the window`);
    if ((t < tA - 0.01 || t > tB + 0.2) && +g.caps !== 1) roomFailures.push(`t=${t}: captions hidden (opacity ${g.caps}) outside the window`);
  }
  const bg = (await read(page, 3)).fillBg;
  if (bg !== "rgb(17, 17, 17)") roomFailures.push(`fill is not the style's ink colour (#111111): ${bg}`);
  // the room composes OUTSIDE the camera: #snap and #push hold still through the window (the camera hold)
  const cams = new Set(); for (const t of [2.0, 2.2, 3.0, 4.0, 5.0, 6.0, 6.2, 6.4, 6.55]) cams.add((await read(page, t)).snapPush);
  if (cams.size !== 1) roomFailures.push(`camera moved during the room window: ${[...cams].join(" ; ")}`);
  console.log(`  room: ${SAMPLES.length} sample times checked against lib/room.mjs (scale, rect, fill, captions); window ${wins[0].tA.toFixed(3)}-${wins[0].tB.toFixed(3)}`);

  // two overlapping beats merge into ONE shrink: two #room tweens in all, never a dip back to 1 between them
  const ov = makeProject(dir + "-overlap", { beats: ROOM_OVERLAP_BEATS });
  const ovHtml = fs.readFileSync(ov.html, "utf8"), ovTruth = JSON.parse(fs.readFileSync(path.join(ov.dir, "build", "edit_truth.json"), "utf8"));
  const nTween = (ovHtml.match(/ft\("#room",/g) || []).length;
  if (nTween !== 2) roomFailures.push(`overlapping beats made ${nTween} #room tweens, want 2 (one shrink, one return)`);
  if (JSON.stringify(ovTruth.room) !== JSON.stringify([{ start: 2, end: 6.567, scale: ROOM_SCALE }])) roomFailures.push(`overlap edit_truth.room: ${JSON.stringify(ovTruth.room)}`);
  const pg2 = await browser.newPage();
  await serveVendoredInPage(pg2);   // GSAP from vendor/, not jsdelivr
  await pg2.evaluateOnNewDocument(() => { window.__timelines = {}; });
  await pg2.goto(pathToFileURL(ov.html).href, { waitUntil: "load", timeout: 60000 });
  await pg2.waitForFunction(() => window.__timelines && window.__timelines.main && window.tween, { timeout: 30000 });
  const scales = [], ovWins = roomWindows([[60, 197]], FPS);
  for (const t of [2.0, 2.2, 2.4, 3.0, 3.6, 4.0, 4.2, 4.3, 4.6, 5.0, 5.8, 6.0, 6.2, 6.3, 6.4, 6.6]) {
    const a = await pg2.evaluate((x) => { const tl = window.__timelines.main; tl.pause(); tl.totalTime(x + 0.001, true); tl.totalTime(x, false); const m = getComputedStyle(document.getElementById("room")).transform.match(/matrix\(([^)]+)\)/); return m ? +m[1].split(",")[0] : NaN; }, t);
    scales.push([t, +a.toFixed(4)]);
    if (Math.abs(a - roomScaleAt(t, ovWins)) > 2e-3) roomFailures.push(`overlap t=${t}: #room scale ${a}, want ${roomScaleAt(t, ovWins).toFixed(5)}`);
  }
  await pg2.close();
  if (scales.filter(([t]) => t >= 2.4 && t <= 6.2).some(([, a]) => Math.abs(a - ROOM_SCALE) > 2e-3)) roomFailures.push(`footage left 0.73 between the two overlapping beats: ${JSON.stringify(scales)}`);
  console.log(`  room overlap: 2 beats (2.0-4.55, 3.5-6.55) -> ${nTween} #room tweens, scale held ${ROOM_SCALE} from 2.35 to 6.217`);
}
await page.close();
for (const t of SAMPLES) {                                                  // cold: first seek in a fresh page
  const pg = await open(); checks++; compare("cold", t, ref.get(t), await at(pg, t)); await pg.close();
}
await browser.close();

console.log(`motion determinism: variant=${variant} seek=${seekMode} samples=${SAMPLES.length} (${distinct} distinct images) comparisons=${checks}`);
console.log(`  times: ${SAMPLES.join(", ")}   beat ${BEAT_AT}-${BEAT_TO}`);
if (distinct < SAMPLES.length - (isRoom ? 6 : 3)) { console.log("  FAIL: sample frames are nearly all identical - the beat is not visible, the test proves nothing"); process.exitCode = 2; }
if (roomFailures.length) { console.log(`  FAIL: making room\n   ${roomFailures.join("\n   ")}`); process.exitCode = 1; }
if (holdFailures.length) { console.log(`  FAIL: camera hold\n   ${holdFailures.join("\n   ")}`); process.exitCode = 1; }
if (failures.length) {
  console.log(`  FAIL: ${failures.length} mismatches (pixels differ: ${failures.filter((f) => f.pixels).length}); images in ${outDir}`);
  for (const f of failures.slice(0, 12)) console.log(`   ${f.label} t=${f.t} pixels=${f.pixels ? "DIFFER" : "same"} state keys: ${f.stateKeys.join(" ")}\n    ${f.detail.join("\n    ")}`);
  process.exitCode = 1;
} else if (!process.exitCode) console.log(`  PASS: every frame matched pixel for pixel and element for element`);
if (!keep && !failures.length && !process.exitCode) fs.rmSync(dir, { recursive: true, force: true });

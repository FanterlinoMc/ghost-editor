#!/usr/bin/env node
// Is every frame of a `motion` beat a pure function of time? (docs/MOTION-GRAPHICS-SPEC.md, hard rule 2)
//
//   node scripts/motion-determinism.mjs [--variant busy|blur] [--seek render|plain] [--passes 3]
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
import { makeProject, BUSY_BEAT, BLUR_BEAT, BEAT_AT, BEAT_TO } from "./lib/motion-fixture.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true); };
const variant = opt("variant", "busy"), seekMode = opt("seek", "render"), passes = +opt("passes", 3);
const keep = !!opt("keep", false);
const beat = variant === "blur" ? BLUR_BEAT : BUSY_BEAT;
const dir = opt("dir", path.join(os.tmpdir(), `motion-determinism-${variant}`));

// sample times, original = output seconds (one kept take): before, entrance, mid, exit, after
const SAMPLES = [1.0, BEAT_AT, 2.15, 2.4, 3.1, 4.05, 5.1, 7.7, 7.9, BEAT_TO, 9.0];
// detour targets: outside before, inside, outside after
const DETOURS = [0, 0.5, 1.9, 2.9, 3.6, 4.6, 6.0, 7.95, 8.5, 9.9];

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
let seed = 0x9e3779b9;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

const proj = makeProject(dir, { beat });
const warns = proj.log.split("\n").filter((l) => /motion/i.test(l) && /(dropped|ignored|clamped|only the first|not allowed)/i.test(l));
if (warns.length) { console.error("the fixture beat produced compiler warnings (it should be clean):\n  " + warns.join("\n  ")); process.exit(2); }

// ---- the camera hold (owner decision: still camera under a motion beat; build.mjs "motion hold") ----
// The fixture is keynote-3, which inherits keynote's cadence and openPush. Build the same reel with no beat as
// the control: it must have cadence snaps inside the window [at, to + 0.2] (the "would-be" snaps) and an
// openPush; the reel with the beat must have neither, and every snap outside the window must be unchanged.
const holdFailures = [];
{
  const ctl = makeProject(dir + "-control", { beat: null });
  const readTruth = (p) => JSON.parse(fs.readFileSync(path.join(p.dir, "build", "edit_truth.json"), "utf8"));
  const withBeat = readTruth(proj), without = readTruth(ctl), FPSX = 30;
  const lo = Math.round(BEAT_AT * FPSX), hi = Math.round((BEAT_TO + 0.2) * FPSX);
  const inWin = (s) => { const f = Math.round(s.t * FPSX); return f >= lo && f <= hi; };
  const wouldBe = without.snaps.filter(inWin);
  if (!wouldBe.length) holdFailures.push("control has no cadence snap inside the window: the hold is not being exercised");
  if (withBeat.snaps.some(inWin)) holdFailures.push(`snaps left inside the window: ${JSON.stringify(withBeat.snaps.filter(inWin))}`);
  const key = (s) => `${s.t}@${s.scale}`;
  const outside = (x) => x.snaps.filter((s) => !inWin(s)).map(key).join(",");
  if (outside(withBeat) !== outside(without)) holdFailures.push(`snaps outside the window changed:\n    control ${outside(without)}\n    beat    ${outside(withBeat)}`);
  if (!without.pushes.some((p) => p.start === 0)) holdFailures.push("control has no openPush: the openPush drop is not being exercised");
  if (withBeat.pushes.some((p) => p.start === 0)) holdFailures.push("openPush survived a beat that starts inside it");
  console.log(`  hold: control ${without.snaps.length} snaps (${wouldBe.length} inside ${BEAT_AT}-${BEAT_TO + 0.2}), with beat ${withBeat.snaps.length}; openPush control=${without.pushes.some((p) => p.start === 0)} beat=${withBeat.pushes.some((p) => p.start === 0)}`);
}

const puppeteer = findPuppeteer();
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: "shell", args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars"], defaultViewport: { width: 1080, height: 1920, deviceScaleFactor: 1 } });
const prefix = fs.readFileSync(proj.html, "utf8").match(new RegExp(`id="(b\\d+)-${beat.elements[0].id}"`))?.[1];
if (!prefix) throw new Error("motion elements not found in index.html");

async function open() {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { window.__timelines = {}; });   // the hyperframes runtime creates this registry; the composition only fills it
  await page.goto(pathToFileURL(proj.html).href, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__timelines && window.__timelines.main && window.gsap, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready.then(() => 0));
  await page.evaluate((mode) => {
    const tl = window.__timelines.main; tl.pause();
    // The footage is not under test and a bare page has no runtime to seek it: an autoplaying <video> would
    // put a different frame in every screenshot. Take it out of the picture; the graphics sit over it anyway.
    for (const m of document.querySelectorAll("video, audio")) { m.pause(); m.removeAttribute("autoplay"); m.style.visibility = "hidden"; }
    document.body.style.background = "#222";
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
      const root = document.getElementById(px + "-in");
      if (!root) return { "(missing)": "no root" };
      (function walk(e, p) {
        const cs = getComputedStyle(e);
        out[p + (e.id ? "#" + e.id : "")] = [cs.opacity, cs.transform, cs.filter, cs.clipPath, cs.visibility, cs.strokeDashoffset, e.children.length === 0 ? e.textContent : ""].join(" | ");
        [...e.children].forEach((c, i) => walk(c, p + "/" + i));
      })(root, "r");
      return out;
    };
  }, seekMode);
  return page;
}
async function at(page, t) {
  await page.evaluate((x) => window.__seek(x), t);
  const [png, state] = [await page.screenshot({ type: "png" }), await page.evaluate((px) => window.__state(px), prefix)];
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
{
  const cam = async (t) => { await page.evaluate((x) => window.__seek(x), t); return page.evaluate(() => ["snap", "push"].map((i) => getComputedStyle(document.getElementById(i)).transform).join(" ")); };
  const want = await cam(BEAT_AT);
  for (let f = Math.round(BEAT_AT * 30); f <= Math.round((BEAT_TO + 0.2) * 30); f++) { const got = await cam(f / 30); if (got !== want) { holdFailures.push(`camera moved at t=${(f / 30).toFixed(3)}: ${want} -> ${got}`); break; } }
}
await page.close();
for (const t of SAMPLES) {                                                    // cold: first seek in a fresh page
  const pg = await open(); checks++; compare("cold", t, ref.get(t), await at(pg, t)); await pg.close();
}
await browser.close();

console.log(`motion determinism: variant=${variant} seek=${seekMode} samples=${SAMPLES.length} (${distinct} distinct images) comparisons=${checks}`);
console.log(`  times: ${SAMPLES.join(", ")}   beat ${BEAT_AT}-${BEAT_TO}`);
if (distinct < SAMPLES.length - 3) { console.log("  FAIL: sample frames are nearly all identical - the beat is not visible, the test proves nothing"); process.exitCode = 2; }
if (holdFailures.length) { console.log(`  FAIL: camera hold\n   ${holdFailures.join("\n   ")}`); process.exitCode = 1; }
if (failures.length) {
  console.log(`  FAIL: ${failures.length} mismatches (pixels differ: ${failures.filter((f) => f.pixels).length}); images in ${outDir}`);
  for (const f of failures.slice(0, 12)) console.log(`   ${f.label} t=${f.t} pixels=${f.pixels ? "DIFFER" : "same"} state keys: ${f.stateKeys.join(" ")}\n    ${f.detail.join("\n    ")}`);
  process.exitCode = 1;
} else if (!process.exitCode) console.log(`  PASS: every frame matched pixel for pixel and element for element`);
if (!keep && !failures.length && !process.exitCode) fs.rmSync(dir, { recursive: true, force: true });

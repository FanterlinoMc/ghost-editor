#!/usr/bin/env node
// What does a motion beat cost to render?
//
//   node scripts/motion-cost.mjs [--reel <dir>|synthetic] [--runs 3] [--workers 1] [--passes 3]
//                                [--variants none,busy,busy-nb,blur] [--dir <scratch>] [--skip-render] [--skip-frames]
//
// Two measurements per variant, on a COPY of a keynote-3 reel (default D:/Projects/reels/wa-test-designer; the
// original is only read, never written; `--reel synthetic` uses lib/motion-fixture.mjs's generated clip instead):
//
//   1. full render wall-clock of `npx hyperframes@0.8.81 render` (the real renderer, video + audio + muxing), median
//      of --runs rounds. Rounds are interleaved (none, busy, busy-nb, blur, none, ...) so machine drift hits every
//      variant alike rather than one variant.
//   2. per-frame capture time in headless Chrome: for every frame, seek the GSAP timeline the way the renderer does
//      and take a screenshot (--capture screenshot, the Windows/macOS renderer) or a
//      HeadlessExperimental.beginFrame capture with the Linux container flags (--capture beginframe); median over --passes passes per frame, then mean / median / p95 of the frames inside
//      the beat span versus outside it. This bare page has NO video element (the footage cannot be seeked without
//      the hyperframes runtime), so it is the DOM + overlay cost only - what the beat adds, not what a frame costs
//      in the real renderer. The real-renderer per-frame figure is (variant wall - none wall) / beat frames.
//
//   none     the reel with no motion beat
//   busy     12 elements, 30 tweens, blur on 2 elements, draw, reveal by word and by char, count (BUSY_BEAT)
//   busy-nb  busy with its blur keys removed: busy - busy-nb is what blur costs inside a busy beat
//   room     busy with room: "below": footage shrunk to 0.73 on a rounded card with ink fill and shadow; window
//            2.0..8.55 s (frames 60..256), so room - busy is what the room card costs
//   blur     the blur limit case: 2 elements of 1000 x 1000 (48% of the canvas), blurred for the whole 6 s beat
//
// The copy is one 6 s beat at output 2.0..8.0 of a single take (the reel's last six takes merged into source
// 10.15..22.42), so the beat is not split by a cut. The render goes through runRender() (scripts/lib/vendor.mjs: GSAP from
// vendor/, and `cmd /c npx` on Windows, where npx is a .cmd shim).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { makeProject, BUSY_BEAT, BLUR_BEAT, stripBlur, BEAT_AT, BEAT_TO, BUILD_MJS } from "./lib/motion-fixture.mjs";
import { findPuppeteer, findChrome } from "./lib/browser.mjs";
import { runRender, serveVendoredInPage } from "./lib/vendor.mjs";

const HYPERFRAMES = "0.8.81";   // engine/tests/common.py HYPERFRAMES_VERSION
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true); };
const reelSrc = String(opt("reel", "D:/Projects/reels/wa-test-designer"));
const variants = String(opt("variants", "none,busy,busy-nb,blur,room")).split(",");
const workers = String(opt("workers", "1")), runs = +opt("runs", 3), passes = +opt("passes", 3);
const base = String(opt("dir", path.join(os.tmpdir(), "motion-cost")));
const BEATS = { none: null, busy: BUSY_BEAT, "busy-nb": stripBlur(BUSY_BEAT), blur: BLUR_BEAT, room: { ...BUSY_BEAT, room: "below" } };
const capture = String(opt("capture", "screenshot"));   // screenshot = hyperframes on Windows/macOS; beginframe = its Linux render container
const BEGINFRAME_ARGS = ["--deterministic-mode", "--enable-begin-frame-control", "--disable-new-content-rendering-timeout", "--run-all-compositor-stages-before-draw", "--disable-threaded-animation", "--disable-threaded-scrolling", "--disable-checker-imaging", "--disable-image-animation-resync", "--enable-surface-synchronization", "--disable-gpu-compositing", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const FPS = 30, SRC_A = 10.15, SRC_B = 22.42;   // the merged take of the real reel
const beatFrom = Math.round(BEAT_AT * FPS), beatTo = Math.round(BEAT_TO * FPS), beatFrames = beatTo - beatFrom;
// frames a variant's beat touches. The room window runs to + 0.55 s (grow-back after the exit).
const span = (v) => v === "room" ? [beatFrom, Math.round((BEAT_TO + 0.55) * FPS)] : [beatFrom, beatTo];

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });

// A copy of the reel with one beat (or none); returns { dir, html, seconds }.
function makeCopy(dir, beat) {
  if (reelSrc === "synthetic") { const p = makeProject(dir, { beat }); return { ...p, seconds: 10 }; }
  const real = JSON.parse(fs.readFileSync(path.join(reelSrc, "reel.json"), "utf8"));
  if (real.style !== "keynote-3") throw new Error(`${reelSrc} is style ${real.style}, not keynote-3`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  const talk = path.join(dir, "assets", "talk.mp4");
  if (!fs.existsSync(talk)) fs.copyFileSync(path.join(reelSrc, "assets", "talk.mp4"), talk);
  for (const f of fs.readdirSync(path.join(reelSrc, "build"))) {
    if (f === "designer-frames" || f === "designer-plan.json" || f === "edit_truth.json") continue;
    const from = path.join(reelSrc, "build", f);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(dir, "build", f));
  }
  const inTake = ([t]) => t >= SRC_A && t < SRC_B;   // zoom snaps are source seconds; keep the ones the merged take still has
  const zoom = { ...(real.zoom || {}), snaps: ((real.zoom || {}).snaps || []).filter(inTake), pushes: ((real.zoom || {}).pushes || []).filter((p) => inTake([p.at])) };
  const reel = { ...real, outro: 0, takes: [{ a: SRC_A, b: SRC_B }], zoom, beats: [] };
  if (beat) reel.beats = [{ ...beat, at: +(SRC_A + BEAT_AT).toFixed(2), to: +(SRC_A + BEAT_TO).toFixed(2) }];
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify(reel, null, 2));
  const r = run(process.execPath, [BUILD_MJS, "."], dir);
  if (r.status !== 0) throw new Error(`build.mjs failed in ${dir}\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-1500)}`);
  const bad = r.stdout.split("\n").filter((l) => /motion beat .* dropped/i.test(l));
  if (bad.length) throw new Error("the beat was dropped by build.mjs:\n  " + bad.join("\n  "));
  return { dir, html: path.join(dir, "index.html"), seconds: +(SRC_B - SRC_A).toFixed(2) };
}

const proj = {};
for (const v of variants) { if (!(v in BEATS)) throw new Error(`unknown variant ${v}`); proj[v] = makeCopy(path.join(base, v), BEATS[v]); }
const frames = Math.round(Object.values(proj)[0].seconds * FPS);
console.log(`reel ${reelSrc === "synthetic" ? "synthetic" : "copy of " + reelSrc}: ${frames} frames at ${FPS} fps, beat frames ${beatFrom}..${beatTo - 1} (${beatFrames}); hyperframes@${HYPERFRAMES}`);

// ---------- 1. full render wall-clock ----------
const wall = Object.fromEntries(variants.map((v) => [v, []]));
if (!opt("skip-render", false)) {
  for (let r = 0; r < runs; r++) for (const v of variants) {
    const out = `build/cost-${v}-${r}.mp4`;
    fs.rmSync(path.join(proj[v].dir, out), { force: true });
    const t0 = process.hrtime.bigint();
    const p = runRender(["-o", out, "-w", workers, "--quiet"], { cwd: proj[v].dir, version: HYPERFRAMES });   // GSAP from vendor/
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    if (p.status !== 0 || !fs.existsSync(path.join(proj[v].dir, out))) { console.error(`${v}: render failed (${p.status}) ${p.error}\n${p.stdout.slice(-1500)}\n${p.stderr.slice(-1500)}`); process.exit(1); }
    wall[v].push(sec);
    console.log(`  render ${v} round ${r + 1}: ${sec.toFixed(1)} s`);
  }
}

// ---------- 2. per-frame capture, in and out of the beat span ----------
const perFrame = {};
if (!opt("skip-frames", false)) {
  const puppeteer = findPuppeteer();
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: "shell", args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars", ...(capture === "beginframe" ? BEGINFRAME_ARGS : [])], defaultViewport: { width: 1080, height: 1920, deviceScaleFactor: 1 } });
  for (const v of variants) {
    const page = await browser.newPage();
    await serveVendoredInPage(page);   // vendor/ answers anything the page names (no CDN)
    await page.evaluateOnNewDocument(() => { window.__timelines = {}; });
    await page.goto(pathToFileURL(proj[v].html).href, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => window.__timelines && window.__timelines.main && window.tween, { timeout: 30000 });
    await page.evaluate(() => document.fonts.ready.then(() => 0));
    await page.evaluate(() => {
      const tl = window.__timelines.main; tl.pause();
      for (const m of document.querySelectorAll("video, audio")) { m.pause(); m.removeAttribute("autoplay"); m.style.visibility = "hidden"; }
      window.__seek = (t) => {
        tl.totalTime(t + 0.001, true); tl.totalTime(t, false);   // hyperframes' renderSeek
        for (const c of document.querySelectorAll(".clip[data-start]")) { const s = +c.dataset.start, d = +c.dataset.duration; c.style.visibility = t >= s - 1e-6 && t < s + d - 1e-6 ? "" : "hidden"; }
      };
    });
    const samples = Array.from({ length: frames }, () => []);
    for (let pass = 0; pass < passes + 1; pass++) {   // pass 0 is warm-up (fonts, raster caches) and is discarded
      for (let f = 0; f < frames; f++) {
        const t0 = process.hrtime.bigint();
        await page.evaluate((x) => window.__seek(x), f / FPS);
        if (capture !== "beginframe") await page.screenshot({ type: "jpeg", quality: 80 });
        else {   // like motion-determinism.mjs: HeadlessExperimental.beginFrame, asking again when a frame has no visual change
          if (!page.__cdp) { page.__cdp = await page.createCDPSession(); await page.__cdp.send("HeadlessExperimental.enable"); page.__tick = 1000; await page.__cdp.send("HeadlessExperimental.beginFrame", { frameTimeTicks: page.__tick, interval: 33, noDisplayUpdates: true }); }
          let got = false;
          for (let a = 0; a < 10 && !got; a++) { page.__tick += 33; got = !!(await page.__cdp.send("HeadlessExperimental.beginFrame", { frameTimeTicks: page.__tick, interval: 33, screenshot: { format: "jpeg", quality: 80 } })).screenshotData; }
          if (!got) throw new Error("beginFrame returned no screenshot");
        }
        if (pass > 0) samples[f].push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    }
    await page.close();
    perFrame[v] = samples.map(median);
    console.log(`  frames ${v}: done`);
  }
  await browser.close();
}

// ---------- report ----------
const f1 = (x) => x.toFixed(1);
if (runs && !opt("skip-render", false)) {
  console.log(`\n=== full render wall-clock, hyperframes@${HYPERFRAMES} -w ${workers}, ${frames} frames, ${runs} interleaved round(s) ===`);
  console.log("variant    runs (s)                    median s   vs none    beat-span ms/frame (delta / " + beatFrames + ")");
  const nm = wall.none && wall.none.length ? median(wall.none) : null;
  for (const v of variants) {
    const m = median(wall[v]), d = nm == null ? null : m - nm;
    console.log(`${v.padEnd(10)} ${wall[v].map(f1).join(", ").padEnd(27)} ${f1(m).padStart(7)}   ${d == null || v === "none" ? "".padStart(8) : ((d >= 0 ? "+" : "") + f1(d) + " s").padStart(8)}   ${d == null || v === "none" ? `${(m / frames * 1000).toFixed(0)} ms/frame overall` : ((d >= 0 ? "+" : "") + (d / (span(v)[1] - span(v)[0]) * 1000).toFixed(0) + " ms")}`);
  }
}
if (Object.keys(perFrame).length) {
  console.log(`\n=== per-frame capture (seek + jpeg screenshot, no video layer), median of ${passes} pass(es) per frame, ms ===`);
  console.log("variant     in beat: mean median   p95   max  |  outside: mean median   p95   max  |  in/out (mean)");
  for (const v of variants) {
    const [b0, b1] = span(v), a = perFrame[v], inside = a.slice(b0, b1), outside = [...a.slice(0, b0), ...a.slice(b1)];
    const row = (x) => [mean(x), median(x), pct(x, 0.95), Math.max(...x)].map((n) => f1(n).padStart(6)).join(" ");
    console.log(`${v.padEnd(10)}  ${row(inside)}  |  ${row(outside)}  |  ${(mean(inside) / mean(outside)).toFixed(2)}x`);
  }
  if (perFrame.none) {
    console.log("\nbeat minus none, same frames (isolates the beat from captions and camera): ms per frame inside the span");
    for (const v of variants) if (v !== "none") { const [b0, b1] = span(v); const d = perFrame[v].slice(b0, b1).map((x, i) => x - perFrame.none[b0 + i]); console.log(`  ${v.padEnd(8)} mean ${f1(mean(d))}  median ${f1(median(d))}  p95 ${f1(pct(d, 0.95))}  max ${f1(Math.max(...d))}`); }
  }
}

// Status, 12 Oct 2026: the script builds all five variants (none, busy, busy-nb, blur, room) without a dropped-beat
// warning (build.mjs words it "motion beat <id> dropped: <why>", which the regex matches; it prints on stdout under
// WARNINGS). NO TIMINGS WERE TAKEN: the laptop never reached the 900 MB free-RAM floor for >40 min (free 370-790 MB,
// CPU 100%, ~1.8 GB held by another user's browser), so no render or browser was launched.

#!/usr/bin/env node
// node scripts/build-chrome.test.mjs
// Chrome Motion (style ids gadzhi-motion / gadzhi-blue|green|red|yellow), hand-ported from phantasic engine/core
// (d132caa v0.1 gm-* scenes, 03ec790 themes, 0b5bd5a sourceGrade, 3910075 auto exposure, 4f02768 / 612ca40 / f1d4b0a objects):
//   - the gm-* scene kinds (gm-object, gm-kinetic, gm-flow, gm-counter, gm-nodes) and their css, only when a reel uses one
//   - spec.sourceGrade + auto exposure, PER RECORDING: each recording is graded from its own measurement
//   - captions.style "lux": fixed height, word-by-word reveal, one bloomed emphasis word that lands in one frame
//   - the gm-objects PNG pack, resolved from library/gm-objects
// Sources are tiny lavfi files, like build-review-fixes.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
// the object pack and its measured bounds (written by scripts/gm_bounds.mjs)
const LIB = path.join(HERE, "..", "library", "gm-objects");
const BOUNDS = JSON.parse(fs.readFileSync(path.join(LIB, "bounds.json"), "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-chrome-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 12, FPS = 30;
const mk = (name, vf) => ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
  "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, name));
mk("talk.mp4", "format=yuv420p");                                   // as shot
mk("talk-1.mp4", "eq=brightness=-0.35,format=yuv420p");              // a much darker second recording

const text = "let me tell you a secret about the return on investment because the number is a real surprise and everything depends on it today".split(" ");
const wordsFor = (n) => ({ segments: [{ start: 0, end: SEC, words: Array.from({ length: n }, (_, i) => ({ word: text[i % text.length], start: +(0.3 + i * 0.35).toFixed(2), end: +(0.55 + i * 0.35).toFixed(2) })) }] });
const faceAt = (l, r) => ({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 7 }, (_, i) => [i * 2, 400, 1000, l, r, 560, 800]) });

let n = 0;
function project(reel, { second = false } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(wordsFor(30)));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(faceAt(340, 740)));
  if (second) {
    fs.copyFileSync(path.join(root, "talk-1.mp4"), path.join(dir, "assets", "talk-1.mp4"));
    fs.writeFileSync(path.join(dir, "build", "words-1.whisper.json"), JSON.stringify(wordsFor(16)));
    fs.writeFileSync(path.join(dir, "build", "face-1.json"), JSON.stringify(faceAt(200, 400)));
  }
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "chrome", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.15, zoom: {}, takes: [{ a: 0, b: SEC }], beats: [], ...reel }, null, 2));
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8" });
const build = (dir) => { const r = run(dir); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const check = (label) => console.log(`ok    ${label}`);
const count = (s, re) => (s.match(re) || []).length;
const SCENES = [
  { type: "scene", kind: "gm-object", object: "target", text: "return on *investment*", textBelow: "^today", at: 1.5, to: 4 },
  { type: "scene", kind: "gm-kinetic", text: "a real *surprise*", at: 5, to: 6.5 },
  { type: "scene", kind: "gm-flow", title: "Costs", items: [{ icon: "dollar", label: "Setup", at: 7 }, { icon: "clock", label: "Monthly", at: 7.6 }], at: 6.8, to: 8.6 },
  { type: "scene", kind: "gm-counter", icon: "users", value: 2000, prefix: "$", label: "per month", at: 9, to: 10.4, countAt: 9.2 },
  { type: "scene", kind: "gm-nodes", nodes: [{ n: 1, at: 10.6 }, { n: 2, at: 10.9 }], object: "puzzle", pill: { text: "value", at: 11 }, at: 10.5, to: 11.9 },
];

try {
  // ---- every gm-* kind builds, with objects from library/gm-objects, and the css only because a gm scene exists ----
  let dir = project({ style: "gadzhi-motion", beats: SCENES });
  let log = build(dir);
  let h = html(dir);
  for (const cls of ["gm-paper", "gm-halo", "gm-objwrap", "gm-title", "gm-tile", "gm-card", "gm-num", "gm-chip", "gm-pill"]) assert.ok(h.includes(cls), `markup/css has ${cls}`);
  assert.ok(h.includes(".gm-t.k {"), "GM_CSS present");
  assert.ok(h.includes("--gm-ink:#4B1F7A"), "purple theme from gm.theme");
  assert.ok(fs.existsSync(path.join(dir, "assets", "target.png")) && fs.existsSync(path.join(dir, "assets", "puzzle.png")), "objects copied from library/gm-objects");
  // the pack and bounds.json agree, and it is the CC0 set (library/gm-objects/SOURCES.md): no brain, a puzzle instead
  const pngs = fs.readdirSync(LIB).filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/, "")).sort();
  assert.deepEqual(pngs, ["chart", "gears", "lightbulb", "puzzle", "rocket", "stopwatch", "target"], "the seven CC0 objects");
  assert.deepEqual(Object.keys(BOUNDS).sort(), pngs, "bounds.json covers exactly the PNGs");
  assert.ok(/3dicons/.test(fs.readFileSync(path.join(LIB, "SOURCES.md"), "utf8")), "SOURCES.md records where the objects come from");
  assert.ok(/return|investment/.test(h) && h.includes('class="gm-t k"'), "typed rows with a serif keyword");
  check("gm-object / kinetic / flow / counter / nodes build; GM_CSS only here; library objects copied");
  // legacy name: a saved reel with object "brain" (dropped 19 Oct 2026) renders the puzzle, laid out with the puzzle's own size
  const legacy = (o) => { const d = project({ style: "gadzhi-motion", beats: [{ ...SCENES[0], object: o }, { ...SCENES[4], object: o }] }); build(d); return { d, h: html(d) }; };
  const lb = legacy("brain"), lp = legacy("puzzle");
  assert.ok(fs.existsSync(path.join(lb.d, "assets", "puzzle.png")) && !fs.existsSync(path.join(lb.d, "assets", "brain.png")), "brain resolves to puzzle.png");
  const boxes = (hh) => [...hh.matchAll(/class="gm-(?:objwrap|obj|pill)" style="top:(\d+)px(?:;width:(\d+)px)?/g)].map((m) => m.slice(1).join("x"));
  assert.ok(boxes(lb.h).length >= 3, "the object boxes were found: " + boxes(lb.h));
  assert.deepEqual(boxes(lb.h), boxes(lp.h), "same object and pill layout as an explicit puzzle");
  check("legacy object name brain renders the puzzle");
  dir = project({ style: "gadzhi-blue", beats: [SCENES[1]] });
  build(dir);
  assert.ok(html(dir).includes("--gm-ink:#123E9C"), "blue theme");
  check("gadzhi-blue switches the gm theme");

  // ---- lux captions ----
  dir = project({ style: "gadzhi-motion", captions: { emph: ["secret", "investment"] } });
  build(dir);
  h = html(dir);
  assert.match(h, /class="cap-group clip" style="top:1100px/, "fixedY 1100 from the style");
  assert.ok(count(h, /class="w emph"/g) >= 2, "an emphasis word per line");
  assert.ok(h.includes("font-size: 1.5em; font-weight: 800"), "lux emphasis css");
  assert.ok(/"#cg\d+w\d+", \{ autoAlpha: 0 \}, \{ autoAlpha: 1, duration: 0\.12 \}/.test(h), "word reveal over revealDur");
  assert.ok(/duration: 0\.01 \}/.test(h), "the emphasis word lands in one frame");
  assert.ok(fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8").includes('"mode": "lux"'));
  assert.match(h, /id="cg0w0"[^>]*>(LET|Let|let)</);
  check("lux captions: fixed height, word reveal, one-frame emphasis word, logged");

  // ---- sourceGrade: baked into the footage, absent unless set ----
  dir = project({ style: "gadzhi-motion" });
  log = build(dir);
  h = html(dir);
  const gradedOf = (d) => fs.readdirSync(path.join(d, "assets")).filter((f) => /-graded-[0-9a-f]{8}\.mp4$/.test(f));
  assert.equal(gradedOf(dir).length, 1);
  assert.ok(h.includes(`id="take-0" src="assets/${gradedOf(dir)[0]}"`), "the take plays the graded file");
  assert.match(log, /exposure assets\/talk\.mp4: face-zone luma [\d.]+ -> gamma/);
  assert.ok(fs.readFileSync(path.join(dir, "build", "edit_truth.json"), "utf8").includes('"takes"'));
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, "build", "edit_truth.json"), "utf8"))).includes("graded"), "edit_truth keeps the original recording's name");
  check("sourceGrade: the take plays assets/talk-graded-<hash>.mp4; edit_truth unchanged");
  dir = project({ style: "clean" });
  build(dir);
  assert.equal(gradedOf(dir).length, 0);
  assert.ok(!html(dir).includes("-graded-") && !html(dir).includes(".gm-t") && !html(dir).includes("--gm-ink"));
  check("a reel without sourceGrade / gm scenes carries none of it");
  dir = project({ style: "gadzhi-motion", sourceExposure: false });
  log = build(dir);
  assert.ok(!/exposure assets/.test(log), "sourceExposure false: no measurement");
  check("sourceExposure: false skips the measurement");

  // ---- two recordings: each is graded from its own measurement ----
  const TAKES2 = [{ a: 0, b: 6, src: "assets/talk.mp4" }, { a: 0, b: 6, src: "assets/talk-1.mp4" }];
  dir = project({ style: "gadzhi-motion", takes: TAKES2 }, { second: true });
  log = build(dir);
  h = html(dir);
  const g = gradedOf(dir);
  assert.equal(g.length, 2, `two graded files: ${g}`);
  const g0 = g.find((f) => f.startsWith("talk-graded")), g1 = g.find((f) => f.startsWith("talk-1-graded"));
  assert.ok(g0 && g1);
  assert.ok(h.includes(`id="take-0" src="assets/${g0}"`) && h.includes(`id="take-1" src="assets/${g1}"`), "each take plays its own recording's graded file");
  const gam = [...log.matchAll(/exposure (\S+): face-zone luma ([\d.]+) -> gamma ([\d.]+)/g)].map((m) => ({ s: m[1], y: +m[2], g: +m[3] }));
  assert.equal(gam.length, 2);
  assert.ok(gam[1].y < gam[0].y - 20 && gam[1].g > gam[0].g, `the darker recording is measured darker and lifted more: ${JSON.stringify(gam)}`);
  assert.ok(h.includes('id="take-0-audio" src="assets/talk.mp4"') && h.includes('id="take-1-audio" src="assets/talk-1.mp4"'), "audio stays on the originals");
  const et = JSON.parse(fs.readFileSync(path.join(dir, "build", "edit_truth.json"), "utf8"));
  assert.deepEqual(et.sources, ["assets/talk.mp4", "assets/talk-1.mp4"]);
  check("two recordings: graded separately (own luma, own gamma, own file); edit_truth keeps the original names");

  // ---- cast neutralising (sourceNeutral): per recording, only where the style sets it ----
  assert.match(log, /cast assets\/talk\.mp4: mean chroma U [\d.]+ V [\d.]+ -> subtract/);
  assert.equal(count(log, /cast assets\//g), 2, "each recording is measured on its own");
  dir = project({ style: "hormozi" });
  assert.ok(!/cast assets/.test(build(dir)), "hormozi (a sourceGrade style without sourceNeutral) is not neutralised");
  check("sourceNeutral: a chroma measurement per recording; styles without it are untouched");

  // ---- gm layout from the object's measured edges ----
  const layoutOf = (beat) => { const d = project({ style: "gadzhi-motion", beats: [beat] }); build(d); const hh = html(d); return { objTop: +hh.match(/class="gm-objwrap" style="top:(\d+)px;width:(\d+)px/)[1], objW: +hh.match(/class="gm-objwrap" style="top:(\d+)px;width:(\d+)px/)[2], rows: [...hh.matchAll(/class="gm-row" style="top:(\d+)px/g)].map((m) => +m[1]) }; };
  // aspect (h / w) of a library object, from bounds.json; stopwatch is the tallest object in the pack
  const asp = (o) => BOUNDS[o].h / BOUNDS[o].w;
  const tall = layoutOf({ type: "scene", kind: "gm-object", object: "stopwatch", text: "IG|*Outreach* Pro", textBelow: "^tool", objY: 520, objW: 740, textY: 300, at: 1.5, to: 4 });
  assert.ok(tall.objTop >= tall.rows[1] + 190, `the object clears the second text row: object top ${tall.objTop}, rows ${tall.rows}`);
  assert.ok(tall.objTop + tall.objW * asp("stopwatch") <= 1601, "and still ends above the bottom limit (shrunk if needed)");
  const low = layoutOf({ type: "scene", kind: "gm-object", object: "target", text: "return on", at: 1.5, to: 4 });
  assert.equal(low.objTop, 560, "a layout that already clears the object is left as given");
  const pillTop = (obj) => { const d = project({ style: "gadzhi-motion", beats: [{ type: "scene", kind: "gm-nodes", nodes: [{ n: 1, at: 2 }], object: obj, pill: { text: "value", at: 2.5 }, at: 1.5, to: 4 }] }); build(d); const hh = html(d); return { pill: +hh.match(/class="gm-pill" style="top:(\d+)px/)[1], objW: +hh.match(/class="gm-obj" style="top:(\d+)px;width:(\d+)px/)[2], objY: +hh.match(/class="gm-obj" style="top:(\d+)px;width:(\d+)px/)[1] }; };
  const gp = pillTop("gears"), rp = pillTop("stopwatch");
  assert.ok(gp.pill >= gp.objY + gp.objW * asp("gears"), "the pill sits below the gears' bottom edge");
  assert.ok(rp.pill >= rp.objY + rp.objW * asp("stopwatch") && rp.pill + 100 <= 1741, "tall object: shrunk until object and pill fit, pill still below it");
  check("gm-object text clears tall objects; the gm-nodes pill sits below the object's measured bottom edge");

  // ---- sections hash follows sourceGrade; a section build carries gm css and graded media ----
  dir = project({ style: "gadzhi-motion", beats: [SCENES[1]] });
  build(dir);
  const out = path.join(dir, "build", "section-0.html");
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, GE_SECTION_START: "0", GE_SECTION_END: "8", GE_SECTION_OUT: out } });
  assert.equal(r.status, 0, r.stderr);
  const sh = fs.readFileSync(out, "utf8");
  assert.ok(sh.includes(".gm-t.k {") && /-graded-[0-9a-f]{8}\.mp4/.test(sh));
  const g1h = JSON.parse(fs.readFileSync(path.join(dir, "build", "sections.json"), "utf8")).globalHash;
  const dir2 = project({ style: "gadzhi-motion", sourceGrade: "eq=contrast=1.3", beats: [SCENES[1]] });
  build(dir2);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(dir2, "build", "sections.json"), "utf8")).globalHash, g1h, "changing the grade invalidates every section");
  check("section build carries gm css and graded media; the grade is part of the global hash");

  // ---- blank reel with a gm style ----
  dir = project({ style: "gadzhi-motion", origin: "blank", takes: [], source: undefined, words: undefined, face: undefined });
  build(dir);
  assert.ok(fs.existsSync(path.join(dir, "index.html")));
  check("blank reel with gadzhi-motion builds");

  // ---- gm-kinetic: a long word and a long line stay inside the frame (MAC-TASKS "Chrome Motion text overflow") ----
  // .gm-row is full width with text-align:center, but a nowrap line WIDER than the row overflows from its left edge
  // (centering only works when the content fits), so scaling it about the row's centre left it hanging off the right.
  // An over-wide row must be shrink-wrapped and centred on ITS OWN width (left:50% + translateX(-50%)) before the
  // fit scale; then its painted box is [540 - fit*W/2, 540 + fit*W/2] with fit*W <= 980, i.e. 50 px clear each side.
  const rowsOfKinetic = (text) => {
    const d = project({ style: "gadzhi-motion", beats: [{ type: "scene", kind: "gm-kinetic", text, at: 1.5, to: 4 }] });
    build(d);
    return [...html(d).matchAll(/<div class="gm-row" style="([^"]*)">/g)].map((m) => m[1]);
  };
  const overWide = (style, label) => {
    const fit = +(style.match(/scale\(([\d.]+)\)/) || [])[1];
    assert.ok(fit > 0 && fit < 1, `${label}: the row is scaled to fit (${style})`);
    assert.ok(/(^|;)left:50%;right:auto(;|$)/.test(style), `${label}: the row is shrink-wrapped from the frame centre (${style})`);
    assert.ok(style.includes(`transform:translateX(-50%) scale(${fit});transform-origin:50% 0`), `${label}: centred on its own width, then scaled (${style})`);
  };
  overWide(rowsOfKinetic("*unbelievably-transformational*")[0], "long serif word");
  overWide(rowsOfKinetic("^unbelievably-transformational")[0], "long sans word");
  overWide(rowsOfKinetic("the smallest habits quietly compound into everything")[0], "long multi-word line");
  const mixed = rowsOfKinetic("this is the *most* _incredibly_ ^important thing|so *real*");
  overWide(mixed[0], "long mixed line");
  assert.equal(mixed[1], "top:" + mixed[1].match(/^top:(\d+)px/)[1] + "px", "a row that fits keeps its exact markup (no fit, no centring change)");
  assert.deepEqual(rowsOfKinetic("so *real*"), ["top:520px"], "a fitting gm-kinetic line is unchanged");
  check("gm-kinetic long word / long line are centred on their own width and scaled inside 980 px; fitting rows unchanged");

  console.log("\nall build-chrome checks passed");
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

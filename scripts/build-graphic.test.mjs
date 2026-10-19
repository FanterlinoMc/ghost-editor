#!/usr/bin/env node
// node --test scripts/build-graphic.test.mjs
// PM3: a Prompt Motion graphic placed in a real build (references/reel-json.md "Prompt Motion graphic"): an overlay layer
// in its box, an insert that hides the captions, in / after (hold / loop / cut), one render per cache key, a layer that
// dies vs a beat that is dropped (exact texts), P3, edit_truth.json, and reels without graphics left alone.
// NO real render: GRAPHIC_TEST_DEPS swaps renderGraphic's external steps for scripts/fixtures/graphic-stub-deps.mjs
// (ffmpeg writes a tiny WebM / MP4 with the asked frame count; the graphic is never opened).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { goodGraphic, insertGraphic } from "./lib/graphic-fixtures.mjs";
import { reason, layerProblem, beatProblem, mapFrame } from "./lib/graphic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const STUB = path.join(HERE, "fixtures", "graphic-stub-deps.mjs");
const FIX = (f) => path.join(HERE, "fixtures", f);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-graphic-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
ff("-f", "lavfi", "-i", "testsrc2=size=108x192:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=200:duration=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));
const words = { segments: [{ start: 0, end: 8, words: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen".split(" ").map((w, i) => ({ word: w, start: 0.3 + i * 0.5, end: 0.6 + i * 0.5 })) }] };
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 5 }, (_, i) => [i * 2, 300, 900, 340, 740, 480, 700]) };
const GRAPHICS = {
  "card.html": goodGraphic({ duration: 2 }),                       // 1080x1080, 60 frames at 30 fps
  "full.html": insertGraphic(),                                     // 1080x1920, 2 s
  "bad.html": goodGraphic({ seekExtra: "var q = Math.random();" }), // G12
};

let n = 0;
function project(reel) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets", "graphics"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  for (const [f, t] of Object.entries(GRAPHICS)) fs.writeFileSync(path.join(dir, "assets", "graphics", f), t);
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "graphic test", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: 30, outro: 0, music: null, style: "clean", zoom: {}, beats: [], takes: [{ a: 0, b: 8 }], ...reel }, null, 2));
  return dir;
}
function build(dir, env = {}) {
  const count = path.join(dir, "renders.txt");
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, GRAPHIC_TEST_DEPS: STUB, GRAPHIC_STUB_COUNT: count, ...env } });
  // one renderGraphic = two stubbed `hyperframes render`s (a and b, the determinism check); count the first of each
  r.renders = fs.existsSync(count) ? fs.readFileSync(count, "utf8").split("\n").filter((l) => /\.a\.(webm|mp4)$/.test(l)) : [];
  return r;
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");
const truth = (dir) => JSON.parse(read(dir, "build/edit_truth.json"));
const frameCount = (file) => +execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]).toString().trim();
const card = (extra = {}) => ({ id: "card", kind: "graphic", html: "assets/graphics/card.html", pin: true, at: 1, by: "user", ...extra });

test("overlay layer: a timed <video> of the cached alpha WebM in its box, with z, opacity, fit; edit_truth kind graphic + mode", () => {
  const dir = project({ layers: [card({ box: { x: 100, y: 300, w: 600, h: 600 }, z: 3, opacity: 0.8, fit: "cover" })] });
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const html = read(dir, "index.html");
  const m = /<video id="ly-card_v" src="(assets\/graphics\/card-[0-9a-f]{16}\.webm)" data-start="1" data-duration="2" data-media-start="0" data-track-index="40" muted playsinline style="width:100%;height:100%;object-fit:cover;display:block"><\/video>/.exec(html);
  assert.ok(m, "the layer's <video>: the cached file, the window (dur defaults to the graphic's 2 s), media-start 0");
  assert.ok(fs.existsSync(path.join(dir, m[1])), "the rendered file is in assets/graphics/");
  assert.equal(frameCount(path.join(dir, m[1])), 60, "L = round(dur * fps)");
  assert.match(html, /data-layer-id="card" data-layer-kind="graphic" style="z-index:3"/);
  assert.match(html, /<div id="ly-card_box" class="lyr-box" data-layer-box="card" style="visibility:hidden;left:100px;top:300px;width:600px;height:600px;">/);
  assert.match(html, /ft\("#ly-card_box", \{"autoAlpha":0,"y":0\}, \{"autoAlpha":0\.8,"y":0,"duration":0\.001,"ease":"none","force3D":false\}, 0\.999\);/, "enter defaults to none, at its opacity, fully shown AT t0 (the 1 ms tween ends there)");
  assert.ok(!/<audio id="ly-card_a"/.test(html), "a graphic is silent");
  assert.ok(!/tl\.to\("#caps", \{ autoAlpha: 0/.test(html), "an overlay keeps the captions by default");
  assert.deepEqual(truth(dir).layers, [{ id: "card", kind: "graphic", start: 1, end: 3, z: 3, pin: true, mode: "overlay" }]);
  assert.equal(r.renders.length, 1);
  // the default box: the design size (1080x1080) centred on the canvas, fit contain
  const d2 = project({ layers: [card()] });
  const r2 = build(d2);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(read(d2, "index.html"), /style="visibility:hidden;left:0px;top:420px;width:1080px;height:1080px;"><video id="ly-card_v"[^>]*object-fit:contain/);
});

test("insert: an opaque full-frame MP4 over the footage, captions hidden by default (layer and beat); hideCaptions:false keeps them", () => {
  const dir = project({
    layers: [{ id: "full", kind: "graphic", html: "assets/graphics/full.html", mode: "insert", pin: true, at: 2, dur: 1.5, box: { x: 5, y: 5, w: 50, h: 50 } }],
    beats: [{ type: "graphic", id: "fb", html: "assets/graphics/full.html", mode: "insert", at: 5, to: 6.5 }],
  });
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const html = read(dir, "index.html");
  assert.match(html, /<div id="ly-full_box" class="lyr-box" data-layer-box="full" style="visibility:hidden;left:0px;top:0px;width:1080px;height:1920px;"><video id="ly-full_v" src="assets\/graphics\/full-[0-9a-f]{16}\.mp4" data-start="2" data-duration="1\.5"/);
  assert.ok(r.stdout.includes(`layer full: ${reason("GW4")}`), "GW4: the box of an insert is ignored");
  assert.match(html, /tl\.to\("#caps", \{ autoAlpha: 0, duration: 0\.08 \}, 1\.92\);/, "captions gone AT the insert layer's start (the fade ends there)");
  assert.match(html, /tl\.to\("#caps", \{ autoAlpha: 0, duration: 0\.08 \}, 4\.92\);/, "captions gone AT the insert beat's start");
  assert.match(html, /tl\.to\("#caps", \{ autoAlpha: 1, duration: 0\.12 \}, 3\.5\);/, "and back only from the insert layer's end (3.5)");
  assert.match(html, /tl\.to\("#caps", \{ autoAlpha: 1, duration: 0\.12 \}, 6\.5\);/, "and the beat's (6.5)");
  // the beat: untimed .layer wrapper above the other beats (z 5), box = the canvas, the <video> timed
  assert.match(html, /<div id="b\d+" class="layer" style="z-index:5"><div id="b\d+-in" class="graphic" data-graphic="full" data-graphic-mode="insert" style="position:absolute;left:0px;top:0px;width:1080px;height:1920px;overflow:hidden;visibility:hidden"><video id="b\d+-v" src="assets\/graphics\/full-[0-9a-f]{16}\.mp4" data-start="5" data-duration="1\.5" data-media-start="0"/);
  assert.ok(html.includes('{"autoAlpha":1,"duration":0.001,"ease":"none","force3D":false}, 4.999);'), "the beat's box is shown AT t0 (frame 150), not one frame late");
  assert.ok(/\{"autoAlpha":0,"duration":0\.001,"ease":"none","force3D":false,"immediateRender":false\}, 6\.499\);/.test(html), "and hidden at t1");
  const t = truth(dir);
  assert.deepEqual(t.layers, [{ id: "full", kind: "graphic", start: 2, end: 3.5, z: 0, pin: true, mode: "insert", hideCaptions: true }]);
  assert.deepEqual(t.beats.filter((b) => b.type === "graphic"), [{ type: "graphic", kind: null, at: 5, to: 6.5, in: null, out: null }]);
  // same layer + beat with hideCaptions:false: the captions stay
  const d2 = project({
    layers: [{ id: "full", kind: "graphic", html: "assets/graphics/full.html", mode: "insert", pin: true, at: 2, dur: 1.5, hideCaptions: false }],
    beats: [{ type: "graphic", id: "fb", html: "assets/graphics/full.html", mode: "insert", at: 5, to: 6.5, hideCaptions: false }],
  });
  const r2 = build(d2);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!/tl\.to\("#caps", \{ autoAlpha: 0/.test(read(d2, "index.html")), "no caption hide at all");
  assert.equal(truth(d2).layers[0].hideCaptions, undefined);
});

test("in / after: hold, loop and cut map the frames (the wrapper's bridge), each its own cache key; cut shortens the placement (GW2)", () => {
  // card is 2 s = 60 frames. A 3 s placement from in 0.5 s: L 90, inF 15
  const dir = project({ layers: [
    card({ id: "h", dur: 3, in: 0.5, after: "hold", box: { x: 0, y: 0, w: 500, h: 500 } }),
    card({ id: "l", dur: 3, in: 0.5, after: "loop", box: { x: 0, y: 600, w: 500, h: 500 } }),
    card({ id: "c", at: 4, dur: 3, in: 0.5, after: "cut", box: { x: 0, y: 1200, w: 500, h: 500 } }),
  ] });
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const html = read(dir, "index.html");
  const file = (id) => /<video id="ly-[a-z]+_v" src="([^"]+)"/.exec(html.slice(html.indexOf(`id="ly-${id}_v"`) - 20))[1];
  const files = ["h", "l", "c"].map(file);
  assert.equal(new Set(files).size, 3, "after and the frame count are in the cache key");
  assert.equal(r.renders.length, 3);
  // the wrapper pages carry the mapping the bridge applies: L, IN, D, AFTER
  const wrappers = fs.readdirSync(path.join(dir, "build", "graphics")).map((d) => read(dir, `build/graphics/${d}/index.html`));
  const params = wrappers.map((w) => /var FPS = 30, L = (\d+), IN = (\d+), D = (\d+), AFTER = "(\w+)"/.exec(w).slice(1).join(" ")).sort();
  assert.deepEqual(params, ["45 15 60 cut", "90 15 60 hold", "90 15 60 loop"]);
  // what those frames show (mapFrame is the bridge's formula): hold freezes on 59, loop wraps to 0, cut ends at 59
  const M = (after, j) => mapFrame(j, { inF: 15, D: 60, after });
  assert.deepEqual([M("hold", 0), M("hold", 44), M("hold", 45), M("hold", 89)], [15, 59, 59, 59]);
  assert.deepEqual([M("loop", 44), M("loop", 45), M("loop", 89)], [59, 0, 44]);
  assert.equal(frameCount(path.join(dir, files[2])), 45, "cut: L = D - inF");
  assert.ok(r.stdout.includes(`layer c: ${reason("GW2", { a: 3, b: 1.5 })}`), "GW2 word for word");
  const t = truth(dir).layers.find((l) => l.id === "c");
  assert.deepEqual([t.start, t.end], [4, 5.5], "cut: the placement ends with the graphic");
  assert.match(html, /<video id="ly-c_v" src="[^"]+" data-start="4" data-duration="1\.5"/);
});

test("one render per cache key: the same graphic placed twice (a layer and a beat) renders once; a second build renders nothing", () => {
  const dir = project({
    layers: [card({ box: { x: 0, y: 200, w: 540, h: 540 } })],
    beats: [{ type: "graphic", id: "again", html: "assets/graphics/card.html", at: 4, to: 6, box: { x: 540, y: 200, w: 540, h: 540 } }],
  });
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.renders.length, 1, "rendered once for both placements");
  const html = read(dir, "index.html");
  const srcs = [...html.matchAll(/<video id="(?:ly-card|b\d+)_?-?v" src="(assets\/graphics\/card-[0-9a-f]{16}\.webm)"/g)].map((m) => m[1]);
  assert.equal(srcs.length, 2);
  assert.equal(srcs[0], srcs[1], "both placements show the same file");
  fs.rmSync(path.join(dir, "renders.txt"));
  const again = build(dir);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.renders.length, 0, "the cached file is used as is");
  assert.ok(again.stdout.includes(`graphic card: cached ${srcs[0]}`));
  assert.equal(read(dir, "index.html"), html, "deterministic: the same page");
});

test("a static refusal: the layer dies, the beat is dropped with a warning (exact texts); P3 replaces the 20% box rule", () => {
  const G12 = reason("G12", { html: "assets/graphics/bad.html" });
  const d1 = project({ layers: [card({ html: "assets/graphics/bad.html" })] });
  const r1 = build(d1);
  assert.equal(r1.status, 1);
  assert.equal(r1.stderr.trim(), `ERROR: ${layerProblem("card", "assets/graphics/bad.html", G12)}`);
  assert.equal(r1.stderr.trim(), "ERROR: layer card: graphic assets/graphics/bad.html: graphic file assets/graphics/bad.html calls Math.random: use window.rng(seed)");
  assert.equal(r1.renders.length, 0, "nothing rendered");

  const d2 = project({ beats: [{ type: "graphic", id: "oops", html: "assets/graphics/bad.html", at: 2, to: 3 }] });
  const r2 = build(d2);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.stdout.includes(beatProblem("oops", "assets/graphics/bad.html", G12)));
  assert.ok(r2.stdout.includes("graphic oops: assets/graphics/bad.html: graphic file assets/graphics/bad.html calls Math.random: use window.rng(seed), dropped"));
  assert.ok(!read(d2, "index.html").includes("data-graphic="), "the beat is not placed");
  assert.equal(truth(d2).beats.filter((b) => b.type === "graphic").length, 0, "nor listed in edit_truth.json");
  // a beat without an id is named by its at
  const d3 = project({ beats: [{ type: "graphic", html: "assets/graphics/nope.html", at: 2.5 }] });
  const r3 = build(d3);
  assert.ok(r3.stdout.includes(`graphic 2.5: assets/graphics/nope.html: ${reason("G2", { html: "assets/graphics/nope.html" })}, dropped`), r3.stdout);

  // P3: 19% of the box inside the canvas refuses (layer dies, beat drops); 20% is fine
  const P3 = reason("P3", { W: 1080, H: 1920 });
  const out19 = { x: -810, y: 0, w: 1000, h: 1000 }, in20 = { x: -800, y: 0, w: 1000, h: 1000 };
  const d4 = project({ layers: [card({ box: out19 })] });
  const r4 = build(d4);
  assert.equal(r4.stderr.trim(), `ERROR: ${layerProblem("card", "assets/graphics/card.html", P3)}`);
  assert.equal(r4.stderr.trim(), "ERROR: layer card: graphic assets/graphics/card.html: graphic box shows less than 20% inside the 1080x1920 canvas");
  const d5 = project({ layers: [card({ box: in20 })], beats: [{ type: "graphic", id: "edge", html: "assets/graphics/card.html", at: 4, to: 5, box: out19 }] });
  const r5 = build(d5);
  assert.equal(r5.status, 0, r5.stderr);
  assert.ok(r5.stdout.includes(beatProblem("edge", "assets/graphics/card.html", P3)));
  // P1 and P2, the same way
  const d6 = project({ layers: [card({ mode: "pip" })] });
  assert.equal(build(d6).stderr.trim(), `ERROR: ${layerProblem("card", "assets/graphics/card.html", reason("P1", { v: "pip" }))}`);
  const d7 = project({ layers: [card({ dur: 61 })] });
  assert.equal(build(d7).stderr.trim(), `ERROR: ${layerProblem("card", "assets/graphics/card.html", reason("P2", { s: 61 }))}`);
});

test("a render refusal: the layer dies with the R text, the beat is dropped", () => {
  const refuse = FIX("graphic-refuse-deps.mjs");
  const R12 = reason("R12", { url: "http://1.1.1.1/" });
  const d1 = project({ layers: [card()] });
  const r1 = build(d1, { GRAPHIC_TEST_DEPS: refuse });
  assert.equal(r1.status, 1);
  assert.equal(r1.stderr.trim(), `ERROR: ${layerProblem("card", "assets/graphics/card.html", R12)}`);
  const d2 = project({ beats: [{ type: "graphic", id: "net", html: "assets/graphics/card.html", at: 2, to: 3 }] });
  const r2 = build(d2, { GRAPHIC_TEST_DEPS: refuse });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.stdout.includes(beatProblem("net", "assets/graphics/card.html", R12)));
  assert.ok(!read(d2, "index.html").includes("data-graphic="));
});

test("opt-in: a reel without graphics never runs the renderer and builds the same bytes as before graphics existed", () => {
  // the same reel twice: with GRAPHIC_TEST_DEPS pointing at a module that throws on import, and without it at all
  const boom = FIX("graphic-boom-deps.mjs");
  const reel = { layers: [{ id: "tx", kind: "text", pin: true, at: 1, dur: 2, text: "Plain", box: { x: 90, y: 1400, w: 900, h: 160 } }], beats: [] };
  const a = project(reel), b = project(reel);
  const ra = build(a, { GRAPHIC_TEST_DEPS: boom }), rb = spawnSync(process.execPath, [BUILD, "."], { cwd: b, encoding: "utf8" });
  assert.equal(ra.status, 0, ra.stderr);
  assert.equal(rb.status, 0, rb.stderr);
  for (const f of ["index.html", "build/edit_truth.json", "build/sections.json"]) assert.equal(read(a, f), read(b, f), f);
  assert.ok(!/data-graphic|data-layer-kind="graphic"|assets\/graphics/.test(read(a, "index.html")), "no graphic markup");
  assert.ok(!fs.existsSync(path.join(a, "build", "graphics")));
  // the golden reels (scripts/lib/golden-build-hashes.json) are checked byte for byte by scripts/byte-identity.mjs in the gate
});

test("GRAPHIC_TEST_DEPS guards: ignored outside node --test, only scripts/fixtures/, never a real Chrome key", () => {
  // 1. without NODE_TEST_CONTEXT the variable is ignored (the throwing module is never imported): the REAL renderer
  //    runs, here pointed at a Chrome that does not exist, so it refuses before any render (R12 "could not run")
  const env = { ...process.env, GRAPHIC_TEST_DEPS: FIX("graphic-boom-deps.mjs"), HYPERFRAMES_BROWSER_PATH: path.join(root, "no-such-chrome") };
  delete env.NODE_TEST_CONTEXT;
  const d1 = project({ layers: [card()] });
  const r1 = spawnSync(process.execPath, [BUILD, "."], { cwd: d1, encoding: "utf8", env });
  assert.equal(r1.status, 1);
  assert.ok(r1.stdout.includes("WARNING: GRAPHIC_TEST_DEPS is ignored outside node --test"), r1.stdout);
  assert.ok(!r1.stderr.includes("graphic deps loaded"), r1.stderr);
  assert.ok(r1.stderr.startsWith("ERROR: layer card: graphic assets/graphics/card.html: network lock probe could not run: "), r1.stderr);
  // 2. a module outside scripts/fixtures/ (here a byte-identical copy of the stub) kills the build
  const copy = path.join(root, "graphic-stub-deps.mjs");
  fs.copyFileSync(STUB, copy);
  const d2 = project({ layers: [card()] });
  const r2 = build(d2, { GRAPHIC_TEST_DEPS: copy });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /^ERROR: GRAPHIC_TEST_DEPS must name a module inside \S+\/scripts\/fixtures\/ \(got /);
  assert.equal(r2.renders.length, 0);
  // 3. a module claiming the real Chrome is keyed under the stub Chrome anyway: the launch line no longer matches, R13
  const d3 = project({ layers: [card()] });
  const r3 = build(d3, { GRAPHIC_TEST_DEPS: FIX("graphic-realver-deps.mjs") });
  assert.equal(r3.status, 1, r3.stdout);
  assert.equal(r3.stderr.trim(), `ERROR: ${layerProblem("card", "assets/graphics/card.html", reason("R13", { v: "152.0.7977.30", k: "0.0.0-stub" }))}`);
  assert.deepEqual(fs.readdirSync(path.join(d3, "assets", "graphics")).filter((f) => /\.(webm|mp4)$/.test(f)), [], "nothing cached");
});

test("across a take join: L = round((E(to) - E(at)) * fps); a default window ending in a removed gap drops the beat; P2 on the output window", () => {
  // takes 0-3 and 5-8 (a 2 s gap, too long to snap): source 2..6 is output 2..4
  const takes = [{ a: 0, b: 3 }, { a: 5, b: 8 }];
  const dir = project({ takes, beats: [
    { type: "graphic", id: "across", html: "assets/graphics/card.html", at: 2, to: 6, after: "loop", box: { x: 0, y: 300, w: 500, h: 500 } },
    { type: "graphic", id: "gap", html: "assets/graphics/card.html", at: 2.5 },                    // default to 4.5: in the gap
    { type: "graphic", id: "tail", html: "assets/graphics/card.html", at: 7.95, to: "end" },        // 0.05 s of output
  ] });
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const html = read(dir, "index.html");
  const m = /<video id="b\d+-v" src="(assets\/graphics\/card-[0-9a-f]{16}\.webm)" data-start="2" data-duration="2"/.exec(html);
  assert.ok(m, "the beat spans output 2..4 (source 2..6)");
  assert.equal(frameCount(path.join(dir, m[1])), 60, "L from the output window, not the 4 s source window");
  assert.deepEqual(truth(dir).beats.filter((b) => b.type === "graphic").map((b) => [b.at, b.to]), [[2, 4]]);
  assert.ok(r.stdout.includes("graphic gap: assets/graphics/card.html: E(4.5) for graphic: not inside any take, dropped"), r.stdout);
  assert.ok(r.stdout.includes(beatProblem("tail", "assets/graphics/card.html", reason("P2", { s: 0.05 }))), r.stdout);
});

test("sections.json: a graphic beat's cache key is in its section's hash", () => {
  const beat = (after) => ({ type: "graphic", id: "k", html: "assets/graphics/card.html", at: 1, to: 2, after });
  const hashes = ["hold", "loop", "hold"].map((after) => {
    const d = project({ beats: [beat(after)] });
    const r = build(d);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(read(d, "build/sections.json")).sections.map((x) => x.hash).join();
  });
  // hold and loop: the same at/to/in in edit_truth.json, a different file (key): only the graphics payload differs
  assert.notEqual(hashes[0], hashes[1]);
  assert.equal(hashes[0], hashes[2], "and the same key gives the same hash");
});

test("a graphic at 0 is visible on frame 0 by its own style (no show tween that cannot end before 0)", () => {
  const dir = project({ layers: [card({ at: 0, opacity: 0.5, box: { x: 0, y: 300, w: 500, h: 500 } })], beats: [{ type: "graphic", id: "z", html: "assets/graphics/card.html", at: 0, to: 1, box: { x: 500, y: 300, w: 500, h: 500 } }] });
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr);
  const html = read(dir, "index.html");
  assert.match(html, /data-layer-box="card" style="opacity:0\.5;left:0px;top:300px;width:500px;height:500px;"/);
  assert.ok(!html.includes('ft("#ly-card_box"'), "no show tween for the layer");
  assert.match(html, /<div id="(b\d+)-in" class="graphic" data-graphic="card" data-graphic-mode="overlay" style="position:absolute;left:500px;top:300px;width:500px;height:500px;overflow:hidden">/);
  const id = /<div id="(b\d+)-in" class="graphic"/.exec(html)[1];
  assert.ok(!html.includes(`ft("#${id}-in"`), "no show tween for the beat");
  assert.ok(html.includes(`tl.fromTo("#${id}-in", {"autoAlpha":1}, {"autoAlpha":0,"duration":0.001,"ease":"none","force3D":false,"immediateRender":false}, 0.999);`), "hidden at its end");
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

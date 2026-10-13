#!/usr/bin/env node
// node scripts/build-layers.test.mjs
// build.mjs on reel.layers[] (BLANK-TIMELINE-SPEC.md, Stage 3): a reel with all five layer kinds,
// anchor ripple through a real build, the duck lane on the take audio, and the failures that must stop a build.
// Sources are tiny lavfi files shaped like prep.sh's output (H.264 + stereo AAC).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-layers-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const enc = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest"];
ff("-f", "lavfi", "-i", "testsrc2=size=108x192:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=200:duration=8", ...enc, path.join(root, "talk.mp4"));
ff("-f", "lavfi", "-i", "testsrc=size=160x90:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=500:duration=3", ...enc, path.join(root, "pip.mp4"));
ff("-f", "lavfi", "-i", "testsrc=size=160x90:rate=30:duration=3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "silent.mp4"));
ff("-f", "lavfi", "-i", "color=c=red:size=64x64", "-frames:v", "1", path.join(root, "logo.png"));

const words = { segments: [{ start: 0, end: 8, words: "hello there this is a layered reel with a few words to caption".split(" ").map((w, i) => ({ word: w, start: 0.3 + i * 0.5, end: 0.6 + i * 0.5 })) }] };
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 5 }, (_, i) => [i * 2, 300, 900, 340, 740, 480, 700]) };

let n = 0;
function project(reel) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.copyFileSync(path.join(root, "pip.mp4"), path.join(dir, "assets", "pip.mp4"));
  fs.copyFileSync(path.join(root, "silent.mp4"), path.join(dir, "assets", "silent.mp4"));
  fs.copyFileSync(path.join(root, "logo.png"), path.join(dir, "assets", "logo.png"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "layers test", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: 30, outro: 0, music: null, style: "clean", zoom: {}, beats: [], ...reel }, null, 2));
  return dir;
}
const build = (dir) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8" });
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");
const truth = (dir) => JSON.parse(read(dir, "build/edit_truth.json"));

const LAYERS = [
  { id: "pip", kind: "video", src: "assets/pip.mp4", anchor: { take: 1, offset: 0.5 }, dur: 2.5, in: 0.2, box: { x: 640, y: 120, w: 380, h: 676 }, fit: "cover", radius: 24, shadow: true, z: 2, audio: "duck", enter: "pop", exit: "fade", by: "user" },
  { id: "logo", kind: "logo", src: "assets/logo.png", pin: true, at: 0, dur: 8, z: 5, by: "user" },
  { id: "gfx", kind: "motion", anchor: { take: 0, offset: 1 }, dur: 6, z: 3, enter: "slide-up", exit: "fade", by: "user",
    elements: [{ id: "title", shape: "text", text: "Twelve", x: 80, y: 500, w: 900, h: 200, size: 120, color: "#ffffff" }, { id: "bar", shape: "rect", x: 80, y: 720, w: 500, h: 14, fill: "accent" }],
    tweens: [{ target: "title", at: 0.2, dur: 0.5, from: { opacity: 0, y: 30 }, to: { opacity: 1, y: 0 } }] },
  { id: "tx", kind: "text", pin: true, at: 4, dur: 3, text: "Over captions", size: 70, color: "#ffffff", bg: "#000000aa", align: "center", box: { x: 90, y: 1400, w: 900, h: 160 }, z: 1, overCaptions: true, by: "user" },
  { id: "im", kind: "image", src: "assets/logo.png", pin: true, at: 1, dur: 2, box: { x: -40, y: 1500, w: 200, h: 200 }, fit: "contain", z: 0, enter: "none", exit: "none", by: "user" },
];
const TAKES = [{ a: 0, b: 3 }, { a: 4, b: 8 }];

try {
  // ---- all five kinds ----
  let dir = project({ takes: TAKES, layers: LAYERS });
  let r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  let html = read(dir, "index.html");
  for (const id of ["pip", "logo", "gfx", "tx", "im"]) assert.ok(html.includes(`data-layer-id="${id}"`), `data-layer-id ${id}`);
  for (const k of ["video", "logo", "motion", "text", "image"]) assert.ok(html.includes(`data-layer-kind="${k}"`), k);
  assert.ok(html.includes('data-el-id="title"') && html.includes('data-el-id="bar"'), "motion layer element ids");
  assert.ok(html.includes('data-layer-box="pip"') && html.includes('data-layer-text="tx"'));
  // anchors resolved against the take layout (take 1 starts at 3 s): pip 3.5..6, gfx 1..7
  let t = truth(dir);
  assert.deepEqual(t.layers.map((l) => [l.id, l.start, l.end, l.z]), [["pip", 3.5, 6, 2], ["logo", 0, 7, 5], ["gfx", 1, 7, 3], ["tx", 4, 7, 1], ["im", 1, 3, 0]]);
  // the reel is 7 s: the logo asked for 8 and was clamped
  assert.ok(r.stdout.includes("clamped to the reel"), "clamp warning");
  // containers: under captions (z 4) and over (z 9); caps in between
  const iLayers = html.indexOf('id="layers"'), iTop = html.indexOf('id="layers-top"'), iCaps = html.indexOf('id="caps"');
  assert.ok(iLayers > 0 && iTop > iCaps, "over-captions container comes after the captions");
  assert.ok(/#caps, #ecaps \{ z-index: 8; \}/.test(html));
  const under = html.slice(iLayers, iTop > 0 ? iTop : undefined);
  assert.ok(under.indexOf('data-layer-id="im"') < under.indexOf('data-layer-id="pip"') && under.indexOf('data-layer-id="pip"') < under.indexOf('data-layer-id="gfx"') && under.indexOf('data-layer-id="gfx"') < under.indexOf('data-layer-id="logo"'), "z order inside #layers: im(0) pip(2) gfx(3) logo(5)");
  assert.ok(html.slice(iTop).includes('data-layer-id="tx"'), "overCaptions layer is in the top container");
  // the video layer: timed <video> with the seek offset, and its sound as <audio>; take audio is ducked
  assert.match(html, /<video id="ly-pip_v" src="assets\/pip\.mp4" data-start="3\.5" data-duration="2\.5" data-media-start="0\.2"/);
  assert.match(html, /<audio id="ly-pip_a" src="assets\/pip\.mp4" data-start="3\.5"/);
  const lane1 = JSON.parse(/id="take-1-audio"[^>]*data-automation='([^']+)'/.exec(html)[1]).lanes[0].points;
  assert.ok(lane1.some((p) => p.v === 0.25), "take 1's audio lane ducks under the layer");
  const lane0 = JSON.parse(/id="take-0-audio"[^>]*data-automation='([^']+)'/.exec(html)[1]).lanes[0].points;
  assert.deepEqual(lane0.map((p) => p.v), [0, 1, 1, 0], "take 0 has no layer over it: not ducked");
  // explicit enter/exit tweens
  assert.match(html, /ft\("#ly-pip_box", \{"autoAlpha":0,"scale":0\.7\}, \{"autoAlpha":1,"scale":1,"duration":0\.3,"ease":"back\.out\(1\.7\)","force3D":false\}, 3\.5\)/);
  assert.match(html, /ft\("#ly-gfx_box", \{"autoAlpha":0,"y":60\}/);
  console.log("ok    a reel with all five layer kinds builds, resolves, orders and ducks");

  // ---- build twice: same bytes ----
  const again = project({ takes: TAKES, layers: LAYERS });
  assert.equal(build(again).status, 0);
  assert.equal(read(again, "index.html"), html);
  assert.equal(read(again, "build/edit_truth.json"), read(dir, "build/edit_truth.json"));
  console.log("ok    a layered build is reproducible");

  // ---- ripple: trim take 0 by 1 s, the anchored layers move 1 s earlier, the pinned ones stay ----
  dir = project({ takes: [{ a: 0, b: 2 }, { a: 4, b: 8 }], layers: LAYERS });
  r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  t = truth(dir);
  const byId = Object.fromEntries(t.layers.map((l) => [l.id, l]));
  assert.equal(byId.pip.start, 2.5); assert.equal(byId.gfx.start, 1);   // pip rode take 1 (2.5 = 2 + 0.5); gfx is anchored to take 0 and stays at +1
  assert.equal(byId.tx.start, 4); assert.equal(byId.im.start, 1);        // pinned: did not move
  console.log("ok    trimming an earlier take ripples anchored layers; pinned ones stay");

  // ---- a silent video layer with audio asked for: warns, builds, no <audio> ----
  dir = project({ takes: TAKES, layers: [{ id: "s", kind: "video", src: "assets/silent.mp4", pin: true, at: 1, dur: 2, box: { x: 0, y: 0, w: 300, h: 200 }, z: 0, audio: "mix", by: "user" }] });
  r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!read(dir, "index.html").includes('id="ly-s_a"'));
  assert.ok(r.stdout.includes("no audio stream"));
  // a video layer longer than its file is shortened, not left to play black
  dir = project({ takes: TAKES, layers: [{ id: "s", kind: "video", src: "assets/pip.mp4", pin: true, at: 1, dur: 5, in: 1, box: { x: 0, y: 0, w: 300, h: 200 }, z: 0, by: "user" }] });
  r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(read(dir, "index.html"), /id="ly-s_v" src="assets\/pip\.mp4" data-start="1" data-duration="2"/);
  console.log("ok    silent and short video layers");

  // ---- no layers key: no trace of the feature in the page ----
  dir = project({ takes: TAKES });
  assert.equal(build(dir).status, 0);
  html = read(dir, "index.html");
  assert.ok(!/lyr|data-layer|layers-top/.test(html));
  assert.ok(!("layers" in truth(dir)));
  console.log("ok    a reel without layers carries nothing of them");

  // ---- failures that must stop the build ----
  const fails = (layers, re) => { const d = project({ takes: TAKES, layers }); const x = build(d); assert.notEqual(x.status, 0, "should have failed: " + JSON.stringify(layers)); assert.match(x.stderr, re); };
  fails([{ id: "a", kind: "image", src: "assets/nope.png", pin: true, at: 0, dur: 1, box: { x: 0, y: 0, w: 5, h: 5 } }], /is not a file inside the project/);
  fails([{ id: "a", kind: "image", src: "assets/logo.png", anchor: { take: 5 }, dur: 1, box: { x: 0, y: 0, w: 5, h: 5 } }], /outside 0\.\.1/);
  fails([{ id: "a", kind: "wibble", pin: true, at: 0, dur: 1 }], /unknown kind/);
  fails("nope", /layers must be an array/);
  console.log("ok    bad layers stop the build with a reason");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("\nall build-layers tests passed");

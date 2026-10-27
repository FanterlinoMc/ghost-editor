#!/usr/bin/env node
// node --test scripts/graphic-behind.test.mjs
// mac-62: a graphic beat with mode "behind" in a real build (references/reel-json.md "Behind the speaker"): drawn between
// the picture and the speaker's cut-out, full-bleed over the face with no P4 / P5, the cut-out read from the frame-keyed
// cache (assets/matte-cache/<key>/), and the drops (matte false, a take transition), with their texts and records.
// NO real render and NO real cut-out: GRAPHIC_TEST_DEPS stubs the graphic render (scripts/fixtures/graphic-stub-deps.mjs)
// and the cache is seeded, so the build finds every frame it needs already cut (a missing frame would start
// hyperframes remove-background, which the "nothing cut" assertions would catch).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { goodGraphic } from "./lib/graphic-fixtures.mjs";
import * as MC from "./lib/matte-cache.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const STUB = path.join(HERE, "fixtures", "graphic-stub-deps.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-behind-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=108x192:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=200:duration=8",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-shortest", path.join(root, "talk.mp4")], { stdio: "pipe" });
const words = { segments: [{ start: 0, end: 8, words: "one two three four five six seven eight nine ten eleven twelve".split(" ").map((w, i) => ({ word: w, start: 0.3 + i * 0.6, end: 0.7 + i * 0.6 })) }] };
// the fixture face sits in the middle of the frame: a full-canvas overlay would be refused (P4), a behind graphic is not
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 5 }, (_, i) => [i * 2, 300, 900, 340, 740, 480, 700]) };
const BEHIND = { type: "graphic", id: "big", mode: "behind", html: "assets/graphics/word.html", at: 2, to: 4 };

let n = 0;
function project(reel, { seed = true } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets", "graphics"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "assets", "graphics", "word.html"), goodGraphic({ duration: 2 }));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "behind test", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json",
    fps: 30, outro: 0, music: null, style: "clean", zoom: {}, takes: [{ a: 0, b: 8 }], beats: [BEHIND], ...reel }, null, 2));
  if (seed) {   // the whole recording's frames, as two cached runs (so a piece reads across both)
    const key = MC.srcKey(path.join(dir, "assets", "talk.mp4"), 30), d = MC.cacheDir(dir, key);
    fs.mkdirSync(d, { recursive: true });
    for (const [a, b] of [[0, 75], [75, 240]]) fs.writeFileSync(path.join(d, `f${a}-${b}.webm`), "seeded");
  }
  return dir;
}
const build = (dir) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, GRAPHIC_TEST_DEPS: STUB } });
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

test("a behind graphic: full-bleed over the face, drawn under the cut-out, the cut-out read from the cache", () => {
  const dir = project({});
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = r.stdout + r.stderr, html = read(dir, "index.html");
  assert.doesNotMatch(out, /covers the speaker's face|crosses the caption band|dropped/, "no P4 / P5 for a behind graphic");
  assert.doesNotMatch(out, /cutting the speaker out/, "every frame was in the cache");
  assert.match(out, /behind cut-out: \d+ recording frames for 1 piece\(s\): \d+ cached, 0 cut now/);
  // order in the page: the picture, the behind graphic, then the cut-out
  const iTake = html.indexOf('id="take-0"'), iG = html.indexOf('class="behind-graphic"'), iM = html.indexOf('class="matte"');
  assert.ok(iTake > 0 && iG > iTake && iM > iG, `take ${iTake} < behind graphic ${iG} < matte ${iM}`);
  // full-bleed box, the graphic's <video> inside it
  assert.match(html, /<div id="b\d+" class="behind-graphic" style="position:absolute;inset:0;pointer-events:none"><div id="b\d+-in" class="graphic" data-graphic="word" data-graphic-mode="behind" style="position:absolute;left:0px;top:0px;width:1080px;height:1920px;/);
  // the cut-out: shown only around the span, read across the two cached runs (frames 75.. come from the second file)
  const vids = [...html.matchAll(/<video id="(matte-[^"]+)" class="matte" src="assets\/matte-cache\/[0-9a-f]{16}\/(f\d+-\d+)\.webm" data-start="([\d.]+)" data-duration="([\d.]+)" data-media-start="([\d.]+)"/g)].map((m) => m.slice(1));
  assert.deepEqual(vids.map((v) => v[1]), ["f0-75", "f75-240"]);
  const [a, b] = vids;
  assert.ok(Math.abs(+a[2] + +a[3] - +b[2]) < 0.0015, "the two pieces are back to back");
  assert.equal(+b[4], 0, "the second file is read from its first frame");
  assert.ok(+a[2] <= 2 && +b[2] + +b[3] >= 4, "the cut-out covers the graphic's window");
  assert.doesNotMatch(html, /talk-matte\.webm/, "never the whole-recording cut-out");
});

test("matte false or a take transition: the behind graphic is dropped with the reason, and nothing is cut", () => {
  for (const [reel, why] of [[{ matte: false }, 'the reel sets "matte": false'],
    [{ takes: [{ a: 0, b: 4 }, { a: 4.5, b: 8, transition: "blur" }] }, "a take transition (blur / whip) joins two takes"]]) {
    const dir = project(reel, { seed: false });
    const r = build(dir);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = r.stdout + r.stderr;
    assert.ok(out.includes(`graphic big: assets/graphics/word.html: a behind graphic needs the speaker cut out per span (${why}), dropped`), out);
    assert.doesNotMatch(out, /cutting the speaker out/);
    assert.equal(fs.existsSync(path.join(dir, "assets", "matte-cache")), false);
    const rec = JSON.parse(read(dir, "build/graphics-dropped.json"));
    assert.equal(rec.dropped?.[0]?.rule ?? rec[0]?.rule, "matte");
    assert.doesNotMatch(read(dir, "index.html"), /behind-graphic|class="matte"/);
  }
});

test("an overlay of the same full-canvas box is still refused over the face (P4)", () => {
  const dir = project({ beats: [{ ...BEHIND, mode: "overlay", box: { x: 0, y: 0, w: 1080, h: 1920 } }] }, { seed: false });
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout + r.stderr, /graphic big: assets\/graphics\/word\.html: graphic box covers the speaker's face at [\d.]+s \(40 px margin\), dropped/);
});

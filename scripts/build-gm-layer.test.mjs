#!/usr/bin/env node
// node --test scripts/build-gm-layer.test.mjs
// mac-79: Chrome Motion's five graphics as a LAYER, so they overlay live footage instead of replacing the
// speaker, and so MORE THAN ONE can be on screen at once.
//
// Why a layer and not "allow two scenes": measured first. Two gm SCENES already build today, overlapping or
// even on identical windows - nothing refuses them - but a scene is `inset: 0` with an opaque background, so
// the later one covers the earlier completely and you see ONE graphic. Rendered and checked a frame to be
// sure. "Two at once" is therefore not a rule to relax; it is a geometry problem, and a box solves it.
//
// gadzhi.mjs lays these out against a whole 1080x1920 canvas (two of its SVGs hardcode that viewBox), so the
// layer path calls the SAME builder and scales the result into the box with one CSS transform. The scene path
// is untouched, which is why byte-identity still holds on all four golden reels.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LAYER_KINDS } from "./lib/layers.mjs";
import { GM_KINDS } from "./lib/gadzhi.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const SEC = 12, FPS = 30;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gm-layer-"));
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4")], { stdio: "pipe" });
const WORDS = "let me tell you a secret about the return on investment because the number is a real surprise and everything depends on it today".split(" ");
const words = { segments: [{ start: 0, end: SEC, words: Array.from({ length: 30 }, (_, i) => ({ word: WORDS[i % WORDS.length], start: +(0.3 + i * 0.35).toFixed(2), end: +(0.6 + i * 0.35).toFixed(2) })) }] };
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 7 }, (_, i) => [i * 2, 400, 1000, 300, 780, 560, 800]) };
let n = 0;
function build(reel) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "gm layer", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json",
    fps: FPS, outro: 0, music: null, style: "gadzhi-motion", zoom: {}, takes: [{ a: 0, b: SEC }], beats: [], ...reel }, null, 2));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8" });
  return { r, html: r.status === 0 ? fs.readFileSync(path.join(dir, "index.html"), "utf8") : "", dir };
}
const counter = (o = {}) => ({ id: "cnt", kind: "gm", pin: true, at: 2, dur: 6, z: 3, by: "user",
  box: { x: 60, y: 220, w: 460, h: 700 }, gm: { kind: "gm-counter", icon: "dollar", value: 1200, label: "a month" }, ...o });
const object = (o = {}) => ({ id: "obj", kind: "gm", pin: true, at: 3.5, dur: 6, z: 2, by: "user",
  box: { x: 560, y: 900, w: 460, h: 700 }, gm: { kind: "gm-object", object: "target", text: "return on *investment*" }, ...o });

test("mac-79: gm is a layer kind, and every kind gmScene answers to is accepted", () => {
  assert.ok(LAYER_KINDS.includes("gm"), `LAYER_KINDS is ${LAYER_KINDS.join(", ")}`);
  assert.deepEqual(GM_KINDS, ["gm-object", "gm-kinetic", "gm-flow", "gm-counter", "gm-nodes"]);
});

test("mac-79: TWO Chrome Motion graphics are on screen at once, each in its own box", () => {
  const { r, html } = build({ layers: [counter(), object()] });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const gm = [...html.matchAll(/class="lyr-gm[^"]*"/g)];
  assert.equal(gm.length, 2, `both gm layers should be drawn, got ${gm.length}`);
  const ids = [...html.matchAll(/data-layer-id="([a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, ["cnt", "obj"]);
  // their windows overlap: 2..8 and 3.5..9.5, so there is a stretch with both up
  assert.ok(/--gm-ink/.test(html), "the Chrome Motion css must be written for a gm LAYER, not only a gm scene");
});

test("mac-79: the graphic is scaled into its box, uniformly, and centred - never stretched", () => {
  const { html } = build({ layers: [counter({ box: { x: 60, y: 220, w: 540, h: 960 } })] });
  const m = html.match(/class="lyr-gm[^"]*" style="([^"]*)"/);
  assert.ok(m, "the gm layer must carry its own transform");
  const s = +(m[1].match(/scale\(([0-9.]+)\)/) || [])[1];
  // 540/1080 = 0.5 and 960/1920 = 0.5: a uniform scale, so the box matches exactly
  assert.equal(s, 0.5, `uniform scale expected, got ${s} from ${m[1]}`);
  assert.ok(/width:1080px;height:1920px/.test(m[1]), "the inner canvas stays 1080x1920 and is transformed, not re-laid-out");
  assert.ok(/transform-origin:0 0/.test(m[1]), "the transform must be anchored so the offsets are exact");
});

test("mac-79: a non-uniform box letterboxes rather than distorting, and the graphic is centred in it", () => {
  const { html } = build({ layers: [counter({ box: { x: 0, y: 400, w: 1080, h: 600 } })] });
  const m = html.match(/class="lyr-gm[^"]*" style="([^"]*)"/);
  const s = +(m[1].match(/scale\(([0-9.]+)\)/) || [])[1];
  assert.equal(s, 0.313, `min(1080/1080, 600/1920) = 0.3125 -> 0.313, got ${s}`);
  const left = +(m[1].match(/left:(-?[0-9.]+)px/) || [])[1];
  assert.ok(left > 0, `a 1080-wide box holding a 338-wide graphic must centre it, got left:${left}`);
});

test("mac-79: a gm layer is refused clearly when it has no box or an unknown kind", () => {
  const noBox = build({ layers: [{ id: "x", kind: "gm", pin: true, at: 2, dur: 4, by: "user", gm: { kind: "gm-counter", value: 1 } }] });
  assert.notEqual(noBox.r.status, 0, "a gm layer with no box must die, like every other boxed kind");
  assert.match(noBox.r.stderr + noBox.r.stdout, /box must be/, "and say so");
  const badKind = build({ layers: [counter({ gm: { kind: "gm-nope" } })] });
  assert.notEqual(badKind.r.status, 0);
  assert.match(badKind.r.stderr + badKind.r.stdout, /gm\.kind/, "the message names the key that is wrong");
  const noGm = build({ layers: [{ id: "x", kind: "gm", pin: true, at: 2, dur: 4, by: "user", box: { x: 0, y: 0, w: 400, h: 400 } }] });
  assert.notEqual(noGm.r.status, 0);
  assert.match(noGm.r.stderr + noGm.r.stdout, /gm needs a `gm` object/);
});

test("mac-79: the SCENE path is untouched - a gm scene still builds full-frame with no box", () => {
  const { r, html } = build({ beats: [{ type: "scene", kind: "gm-counter", icon: "dollar", value: 1200, label: "a month", at: 2, to: 5 }] });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal([...html.matchAll(/class="lyr-gm/g)].length, 0, "a scene must not go through the layer path");
  assert.ok(/class="scene/.test(html) && /--gm-ink/.test(html), "it is still a full-frame scene with the gm css");
});

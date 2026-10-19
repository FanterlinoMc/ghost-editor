#!/usr/bin/env node
// node scripts/look-fx.test.mjs
// look.fx (opt-in style key, references/reel-json.md): the #fx wrapper that a popcard's camera defocus and a leak's bloom tween is
// written when the style sets look.fx: true, even with no look.refocus / duo energyPunch. A style without it builds as before (no #fx).
// Matte never cut: no stage / behind / matte key here, and an npx that refuses is first on PATH.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "look-fx-"));
const SEC = 8;
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=30:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(root, "talk.mp4")], { stdio: "pipe" });
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "npx"), "#!/bin/sh\necho 'npx refused in look-fx.test' >&2; exit 97\n", { mode: 0o755 });
const words = { segments: [{ start: 0, end: SEC, words: Array.from({ length: 24 }, (_, i) => ({ word: ["time", "is", "money", "and", "focus"][i % 5], start: +(0.3 + i * 0.3).toFixed(2), end: +(0.55 + i * 0.3).toFixed(2) })) }] };
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 5 }, (_, i) => [i * 2, 300, 780, 340, 740, 450, 650]) };
const BEATS = [{ type: "popcard", at: 2, to: 3.6, label: "focus", ui: { type: "target", title: "Focus" } }, { type: "leak", at: 5, to: 5.8 }];

let n = 0;
function build(extra) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "fx", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: 30, outro: 0, music: null, zoom: {}, takes: [{ a: 0, b: SEC }], beats: BEATS, ...extra }, null, 2));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return fs.readFileSync(path.join(dir, "index.html"), "utf8");
}
const check = (label) => console.log(`ok    ${label}`);
// the element the popcard's defocus tween and the leak's bloom tween aim at
const fxTweens = (h) => (h.match(/tl\.to\("#fx", \{ filter: "blur\(\d+px\) brightness\([\d.]+\)"/g) || []).length;
const hasFx = (h) => h.includes('<div id="fx">') && /#fx \{ position: absolute; inset: 0;/.test(h);

try {
  // 1. a style that sets look.fx (ui-story-ad--11 inherits it from pitch through ui-story-ad, and turns look.refocus off, podcast captions:
  //    before look.fx it had no #fx, so its popcard defocus and leak bloom tweened nothing)
  const on = build({ style: "library/ui-story-ad--11" });
  assert.ok(hasFx(on), "a style with look.fx gets the #fx wrapper and its CSS");
  assert.ok(fxTweens(on) >= 2, "the popcard defocus and the leak bloom tween #fx");
  assert.match(on, /tl\.to\("#fx", \{ filter: "blur\(9px\) brightness\(0\.72\)"/, "the popcard blur tween is there");
  // the popcard is drawn inside #fx's parent chain: the take video sits inside the #fx div
  const fxOpen = on.indexOf('<div id="fx">'), take = on.indexOf('class="clip take', fxOpen) >= 0 ? on.indexOf('class="clip take', fxOpen) : on.indexOf("<video", fxOpen);
  assert.ok(fxOpen > 0 && take > fxOpen, "the footage is inside #fx, so its blur reaches the speaker");
  check("style with look.fx (library/ui-story-ad--11): #fx written, the popcard blur / leak bloom tweens target it");

  // 1b. the opt-out: a pitch child (refocus false) that sets look.fx: false overrides the inherited true (deep merge) and gets NO #fx
  const optOut = build({ style: "library/ui-story-ad--11", look: { fx: false, refocus: false } });
  assert.ok(!optOut.includes('id="fx"') && !optOut.includes("#fx {"), "look.fx: false on a pitch child removes #fx");
  check("pitch child with look.fx: false and refocus false: no #fx (the opt-out)");

  // 2. the key itself, on a style that never had #fx: clean + reel look.fx true
  const cleanOn = build({ style: "clean", look: { fx: true } });
  assert.ok(hasFx(cleanOn), "look.fx: true writes #fx on clean");
  check("look.fx: true on clean: #fx written");

  // 3. without the key (or with anything but true) nothing changes: no #fx, and the build is the same bytes as with look.fx false
  const off = build({ style: "clean" }), offFalse = build({ style: "clean", look: { fx: false } }), offStr = build({ style: "clean", look: { fx: "yes" } });
  assert.ok(!off.includes('id="fx"') && !off.includes("#fx {"), "a style without look.fx has no #fx");
  assert.equal(offFalse, off, "look.fx: false builds the same bytes as no key");
  assert.equal(offStr, off, "look.fx must be exactly true");
  check("style without look.fx (clean): no #fx; look.fx false / non-boolean: identical bytes");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

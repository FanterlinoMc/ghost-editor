#!/usr/bin/env node
// node scripts/build-titlebox.test.mjs
// Pitch's `titlebox` beat (the hook title typed into an accent box near the top). Its page CSS (.tbox / .tbox-in) lived in
// phantasic engine/core (2fba97c) and was lost in the fork's port (b060367): the markup and the tween were ported, the CSS not,
// so the box sat at left 0 and the tween's xPercent -50 pushed half of it off the left edge for its whole run (mac-28).
//   - a reel with a titlebox beat writes .tbox (left 50%, so xPercent -50 centres it in the 1080 px frame) and .tbox-in
//   - a reel without one writes neither (opt-in: every other reel stays byte-identical)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-titlebox-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 6, FPS = 30;
ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));
const text = "today your child is due for four shots and i say it this way because studies show it works".split(" ");
const words = { segments: [{ start: 0, end: SEC, words: text.map((w, i) => ({ word: w, start: +(0.2 + i * 0.3).toFixed(2), end: +(0.42 + i * 0.3).toFixed(2) })) }] };
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 4 }, (_, i) => [i * 2, 400, 1000, 340, 740, 560, 800]) };

let n = 0;
function project(beats) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "tbox", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.15, takes: [{ a: 0, b: SEC }], beats }, null, 2));
  return dir;
}
const build = (dir) => {
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary(), PHANTASIC_SFX_PACK: path.join(root, "no-such-pack") } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return fs.readFileSync(path.join(dir, "index.html"), "utf8");
};
const rule = (html, sel) => { const m = new RegExp(`\\n\\s*${sel.replace(".", "\\.")} \\{([^}]*)\\}`).exec(html); return m && m[1]; };
const check = (label) => console.log(`ok    ${label}`);

try {
  const html = build(project([{ type: "titlebox", text: "the presumptive approach", at: 0.25, to: 4.2 }]));
  assert.match(html, /class="ov tbox"/, "the titlebox markup is written");
  const tbox = rule(html, ".tbox"), tin = rule(html, ".tbox-in");
  assert.ok(tbox, ".tbox has a CSS rule (it had none: the box sat at left 0, half off the left edge)");
  assert.match(tbox, /position:\s*absolute/);
  assert.match(tbox, /left:\s*50%/, ".tbox is anchored at the frame centre");
  // the tween settles at xPercent -50, x 0: left 50% - half the box width = centred, so the box is inside 0..1080 whenever it fits
  assert.match(html, /ft\("#b\d+-in", \{ xPercent: -50, x: -240[^}]*\}, \{ xPercent: -50, x: 0, y: 0, rotation: 0, scale: 1, autoAlpha: 1/, "the box settles centred (xPercent -50, x 0)");
  assert.ok(tin, ".tbox-in has a CSS rule");
  assert.match(tin, /display:\s*inline-block/, "the box grows with the typed letters");
  assert.match(tin, /white-space:\s*nowrap/, "the title stays on one line");
  assert.match(tin, /color:\s*#fff/);
  check("titlebox reel: .tbox (left 50%) + .tbox-in written, box settles centred");

  const plain = build(project([]));
  assert.equal(rule(plain, ".tbox"), null, "no titlebox beat: no .tbox CSS (opt-in)");
  assert.equal(rule(plain, ".tbox-in"), null);
  check("reel without a titlebox: no .tbox CSS (opt-in)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

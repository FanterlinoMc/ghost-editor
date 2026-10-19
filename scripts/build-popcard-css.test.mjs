#!/usr/bin/env node
// node scripts/build-popcard-css.test.mjs
// Pitch's `popcard` beat CSS. The beat's markup and tweens were ported from phantasic engine/core (2fba97c) in b060367, its
// page CSS was not (and 54a2f04, which spliced in MOTION_CSS, skipped the bars card's second .ui-bar rule because the
// window-bar .ui-bar selector already existed). Without them the card column sits at left 0 and the tween's xPercent -50
// pushes half of it off the left edge, the photo has no white frame, the label no font, and the bars card's bars are
// window-bar strips that grow from their middle.
//   group 1 (has popcard):           .popcard (left 50%, centred column), .popcard-img (white frame), .popcard-lab (Inter label)
//   group 2 (popcard with ui "bars"): .ui-bars .ui-bar { width 120px; transform-origin 50% 100% }, scoped so a scene kind "ui"
//     window card's title bar (.ui-win > .ui-bar) in the same reel keeps its full width (main's rule is unscoped and shrinks it)
//   opt-in: a reel without a popcard writes neither; a popcard with a non-bars ui card (tokens) writes no bars rule
import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-popcard-css-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 6, FPS = 30;
ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));
ff("-f", "lavfi", "-i", "color=c=0x406080:size=400x300", "-frames:v", "1", path.join(root, "pic.png"));
const text = "today your child is due for four shots and i say it this way because studies show it works".split(" ");
const words = { segments: [{ start: 0, end: SEC, words: text.map((w, i) => ({ word: w, start: +(0.2 + i * 0.3).toFixed(2), end: +(0.42 + i * 0.3).toFixed(2) })) }] };
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 4 }, (_, i) => [i * 2, 400, 1000, 340, 740, 560, 800]) };

let n = 0;
function project(beats) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.copyFileSync(path.join(root, "pic.png"), path.join(dir, "assets", "pic.png"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "popcard", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.15, takes: [{ a: 0, b: SEC }], beats }, null, 2));
  return dir;
}
const build = (dir) => {
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary(), PHANTASIC_SFX_PACK: path.join(root, "no-such-pack") } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return fs.readFileSync(path.join(dir, "index.html"), "utf8");
};
// every rule body for an exact selector, in page order
const rules = (html, sel) => [...html.matchAll(new RegExp(`(?:^|[\\n}])\\s*${sel.replace(/\./g, "\\.")} \\{([^}]*)\\}`, "g"))].map((m) => m[1]);
const check = (label) => console.log(`ok    ${label}`);
const PIC = { type: "popcard", src: "assets/pic.png", label: "shots", at: 1.0, to: 2.4 };
const TOKENS = { type: "popcard", ui: { type: "tokens", text: "How many tokens" }, label: "tokens", at: 1.0, to: 2.4 };
const WIN = { type: "scene", kind: "ui", title: "terminal", prompt: { text: "ls" }, lines: [{ text: "ok", at: 1.6 }], at: 1.0, to: 2.4 };
const BARS = { type: "popcard", ui: { type: "bars", title: "Uptake", labels: ["Ask", "Tell"] }, label: "more", at: 3.0, to: 4.4 };

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("group 1: popcard, popcard-img, popcard-lab", () => {
  const pic = build(project([PIC]));
  assert.match(pic, /class="ov popcard"/, "popcard markup is written");
  assert.match(pic, /class="popcard-img"/);
  assert.match(pic, /class="popcard-lab"/);
  const [pc] = rules(pic, ".popcard"), [img] = rules(pic, ".popcard-img"), [lab] = rules(pic, ".popcard-lab");
  assert.ok(pc, ".popcard has a CSS rule (it had none: the card sat at left 0, half off the left edge)");
  assert.match(pc, /position:\s*absolute/);
  assert.match(pc, /left:\s*50%/, ".popcard is anchored at the frame centre");
  assert.match(pc, /width:\s*max-content/);
  assert.match(pc, /flex-direction:\s*column/, "the label stacks under the picture");
  assert.match(pic, /ft\("#b\d+-in", \{ xPercent: -50, autoAlpha: 0[^}]*\}, \{ xPercent: -50, autoAlpha: 1/, "the tween centres the card (xPercent -50)");
  assert.ok(img, ".popcard-img has a CSS rule");
  assert.match(img, /border:\s*10px solid #fff/, "the white photo frame");
  assert.ok(lab, ".popcard-lab has a CSS rule");
  assert.match(lab, /font-family:\s*Inter/);
  assert.match(lab, /white-space:\s*nowrap/);
  assert.equal(rules(pic, ".ui-bars .ui-bar").length, 0, "no bars card: no bars rule");
  check("popcard reel: .popcard (left 50%) + .popcard-img + .popcard-lab written");
});

test("group 2: the bars UI card's .ui-bar", () => {
  const bars = build(project([BARS]));
  assert.match(bars, /class="ui-bars"/, "the bars card markup is written");
  const [bb] = rules(bars, ".ui-bars .ui-bar");
  assert.ok(bb, "the bars card's bar has a .ui-bars .ui-bar rule");
  assert.match(bb, /width:\s*120px/, "the bars-card bar is 120 px wide");
  assert.match(bb, /transform-origin:\s*50% 100%/, "the bar grows from its foot (scaleY tween)");
  assert.ok(bars.indexOf(".ui-bars .ui-bar {") > bars.indexOf(".ui-bar { height: 64px"), "it comes after the MOTION_CSS window-bar rule");
  check("bars popcard: .ui-bars .ui-bar (width 120, grows from the bottom) after the window-bar rule");
});

test("group 2: a window card in the same reel keeps its full-width title bar", () => {
  const both = build(project([WIN, BARS]));
  assert.match(both, /class="ui-win"[^>]*><div class="ui-bar">/, "the window card's title bar is written");
  assert.ok(rules(both, ".ui-bars .ui-bar").length === 1, "the bars rule is written");
  const plainBar = rules(both, ".ui-bar");
  assert.equal(plainBar.length, 1, "the only unscoped .ui-bar rule is the window bar's");
  assert.doesNotMatch(plainBar[0], /width:\s*120px/, "the window bar does not get the 120 px width");
  check("window card + bars popcard: the 120 px rule is scoped to .ui-bars, the window bar is untouched");
});

test("opt-in: no popcard, no popcard / bars CSS", () => {
  const plain = build(project([]));
  for (const s of [".popcard", ".popcard-img", ".popcard-lab"]) assert.equal(rules(plain, s).length, 0, `no popcard: no ${s} rule`);
  assert.equal(rules(plain, ".ui-bars .ui-bar").length, 0, "no popcard: no bars-card rule");
  check("reel without a popcard: no popcard / bars CSS (opt-in)");
});

test("opt-in: a non-bars ui popcard (tokens) writes no bars rule", () => {
  const tok = build(project([TOKENS]));
  assert.ok(rules(tok, ".popcard").length === 1, "the popcard group is written");
  assert.equal(rules(tok, ".ui-bars .ui-bar").length, 0, "no bars card: no bars rule");
  check("tokens popcard: popcard CSS, no bars rule");
});

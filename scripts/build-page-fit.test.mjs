#!/usr/bin/env node
// node --test scripts/build-page-fit.test.mjs
// mac-48: PAGE text fits the frame. `.hl-line`, `.sent-line`, `.sc-line` and `.sc-pill` are all
// `white-space: nowrap` with no shrink, and a page line IS the speaker's own words trimmed, so ordinary
// speech ran off both edges. Measured before the fix, with page lines taken from 6 real recordings' own
// transcripts: 44 of 96 lines off the canvas, worst 1547 px past the frame - even a 3-word highlight line
// ("most important tip" at 104 px) was ~1098 px wide. This is mac-47's fix for pages instead of captions.
// Two properties, because the first one alone is satisfied by shrinking everything:
//   1. a line too wide for the safe width shrinks,
//   2. a line that already fits is NOT touched (its markup stays byte-identical).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fitTextPx, pageW, reqW } from "./lib/motion.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const SEC = 14, FPS = 30;
// a real clause, from phantasic-mini/runs/breakdown-stress/13-cdc-casler-studio: the words a page line holds
const SAID = "pretty in-depth education of our physicians so that physicians understood the why a little bit more strongly before that education process".split(" ");
const LONG = "physicians understood the why a little";   // 6 real words - over the safe width at every page size
const SHORT = "the why";                                  // 2 short words - fits at every page size

function build(beats) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-fit-"));
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "assets", "talk.mp4")], { stdio: "pipe" });
  const words = { segments: [{ start: 0, end: SEC, words: SAID.map((w, i) => ({ word: w, start: +(0.3 + i * 0.5).toFixed(2), end: +(0.7 + i * 0.5).toFixed(2) })) }] };
  const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: SEC * 5 }, (_, i) => [i / 5, 0, 120, 700, 900, 40, 100]) };
  fs.writeFileSync(path.join(root, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(root, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(root, "reel.json"), JSON.stringify({ title: "page fit", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json",
    fps: FPS, outro: 0, music: null, style: "clean", zoom: {}, captions: { style: "none" }, takes: [{ a: 0, b: SEC }], beats }, null, 2));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return fs.readFileSync(path.join(root, "index.html"), "utf8");
}
// the size the engine actually drew each class at, in document order
const sizes = (html, cls, dflt) => [...html.matchAll(new RegExp(`<div (?:id="[^"]*" )?class="${cls}"(?: style="font-size:(\\d+)px)?`, "g"))].map((m) => (m[1] ? +m[1] : dflt));

test("mac-48: a highlight line too wide for the safe width shrinks, and one that fits is left alone", () => {
  const html = build([
    { type: "scene", kind: "highlight", at: 1, to: 3.2, lines: [{ text: LONG, at: 1 }] },
    { type: "scene", kind: "highlight", at: 4, to: 6.2, lines: [{ text: SHORT, at: 4 }] },
  ]);
  const got = sizes(html, "hl-line", 104);
  assert.equal(got.length, 2, `both highlight lines should be built, got ${JSON.stringify(got)}`);
  assert.ok(got[0] < 104, `"${LONG}" kept its full 104 px and runs off the frame (got ${got[0]} px)`);
  assert.equal(got[1], 104, `"${SHORT}" fits and must not be shrunk (got ${got[1]} px)`);
});

test("mac-48: the same holds for a sentence page, whose 64 px lives in the CSS and not inline", () => {
  const html = build([
    { type: "scene", kind: "sentence", at: 1, to: 3.2, lines: [LONG], text: "why" },
    { type: "scene", kind: "sentence", at: 4, to: 6.2, lines: [SHORT], text: "why" },
  ]);
  const got = sizes(html, "sent-line", 64);
  assert.equal(got.length, 2, `both sentence lines should be built, got ${JSON.stringify(got)}`);
  assert.ok(got[0] < 64, `"${LONG}" kept its full 64 px and runs off the frame (got ${got[0]} px)`);
  assert.equal(got[1], 64, `"${SHORT}" fits, so no inline font-size must be written at all (got ${got[1]} px)`);
});

test("mac-48: a card's lines and its pill both fit, and the pill's own 68 px of padding counts", () => {
  const html = build([{ type: "scene", kind: "card", at: 1, to: 4, lines: [{ text: LONG, at: 1 }, { text: SHORT, at: 2 }], pill: { text: LONG, at: 2.5 } }]);
  const lines = sizes(html, "sc-line", 96);
  assert.deepEqual([lines[0] < 96, lines[1] === 96], [true, true], `card lines: the long one shrinks, the short one does not (got ${JSON.stringify(lines)})`);
  const pill = sizes(html, "sc-pill", 92);
  assert.equal(pill.length, 1, "the pill should be built");
  assert.ok(pill[0] < 92, `the pill kept its full 92 px and runs off the frame (got ${pill[0]} px)`);
  // the padding is real: at the same text and width, a pill must end up no larger than a bare line
  assert.ok(fitTextPx(LONG, 92, 800, { pad: 68 }) < fitTextPx(LONG, 92, 800), "the pill's padding must make its fitted size strictly smaller");
});

test("mac-48: fitTextPx returns 0 for a line that fits, counts capitals wider, and never goes under its floor", () => {
  assert.equal(fitTextPx("the why", 64, 800), 0, "a line that fits is returned as 0 (leave it alone)");
  assert.equal(fitTextPx("", 64, 800), 0, "no text, nothing to fit");
  assert.equal(fitTextPx("the why", 0, 800), 0, "no size, nothing to fit");
  const lower = fitTextPx("physicians understood the why", 104, 800);
  const upper = fitTextPx("PHYSICIANS UNDERSTOOD THE WHY", 104, 800);
  assert.ok(upper > 0 && upper < lower, `upper case is wider per character, so it must shrink further (lower ${lower}, upper ${upper})`);
  assert.equal(fitTextPx("a".repeat(400), 104, 60, { floor: 24 }), 24, "the floor holds: text is never shrunk to nothing");
});

test("mac-48: the canvas width is never invented - reqW throws rather than assuming 1080", () => {
  assert.throws(() => reqW({}), /ctx\.W is required/, "a missing canvas width must be loud, not silently 1080");
  assert.throws(() => reqW({ W: 0 }), /ctx\.W is required/);
  assert.throws(() => pageW(undefined), /ctx\.W is required/);
  assert.equal(pageW({ W: 1080, sidePad: 150 }), 780, "the safe width is the canvas less both side insets");
  assert.equal(pageW({ W: 1920 }), 1920, "no sidePad means the whole canvas, not a 1080 fallback");
});

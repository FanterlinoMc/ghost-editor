#!/usr/bin/env node
// node --test scripts/build-keynote-fit.test.mjs
// The Keynote (styles/keynote.json), found by the Mac acceptance renders (mac-29):
//   1. a long line with a gold script keyword ("presumptive approach are") ran off the right edge of the frame and out of
//      its grey box. keynote sets captions.fitLine: 820 (the .eblock's own width), so the line shrinks to fit inside it
//      (to exactly floor(capSize * 820 / estimated width), which tells 820 from fitLine: true's 900).
//   2. on a close-up every block fell back to under-the-mouth on the grey box; the approved sample shows the box only on
//      its opening lines. keynote sets captions.backingUntil: 2, so blocks starting later get the heavy text shadow.
//      The same key on the cap-group caption path (a non-editorial style) is tested too.
// Sources are tiny lavfi files, like build-review-fixes.test.mjs; the face is a close-up so every block is "lower-face".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const STYLE = JSON.parse(fs.readFileSync(path.join(HERE, "..", "styles", "keynote.json"), "utf8"));
const SEC = 7, FPS = 30, W = 1080;

function buildReel(style = "keynote", captions = { keywords: { approach: "script" } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keynote-fit-"));
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "assets", "talk.mp4")], { stdio: "pipe" });
  const text = "today your child is due for presumptive approach are more likely to have their parents accept vaccines.".split(" ");
  const words = { segments: [{ start: 0, end: SEC, words: text.map((w, i) => ({ word: w, start: +(0.3 + i * 0.35).toFixed(2), end: +(0.6 + i * 0.35).toFixed(2) })) }] };
  // a close-up: the face fills the frame and the mouth is low, so the placer falls back to under the mouth for every block
  const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: SEC * 5 }, (_, i) => [i / 5, -150, 1550, 120, 960, 600, 1100]) };
  fs.writeFileSync(path.join(root, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(root, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(root, "reel.json"), JSON.stringify({ title: "keynote fit", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json",
    fps: FPS, outro: 0, music: null, style, zoom: {}, takes: [{ a: 0, b: SEC }], beats: [], captions }, null, 2));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: root, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary() } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  fs.rmSync(root, { recursive: true, force: true });
  return { html, stdout: r.stdout };
}

const { html, stdout } = buildReel();
const blocks = [...html.matchAll(/<div id="eb(\d+)" class="eblock clip([^"]*)" style="[^"]*" data-start="([\d.]+)"[^>]*>(.*?)<\/div>/g)]
  .map((m) => ({ i: +m[1], cls: m[2].trim(), start: +m[3], body: m[4] }));

test("keynote: a line with a long script keyword is shrunk to fit inside its caption box, which is inside the frame", () => {
  const [, left, right] = html.match(/\.eblock \{ position: absolute; left: (\d+)px; right: (\d+)px;/) || [];
  assert.ok(left && right, "the .eblock css (left/right) was not found");
  const boxW = W - +left - +right;
  assert.ok(+left >= 0 && boxW > 0);
  const lines = blocks.flatMap((b) => [...b.body.matchAll(/<span id="eb\d+l\d+" class="eline"( style="font-size:(\d+)px")?>(.*?)<\/span><\/span>/g)]);
  const key = lines.find((l) => /class="ew eser">approach</.test(l[3]));
  assert.ok(key, "the script keyword line was not built");
  // the same width estimate build uses for captions.fitLine (sans 0.56 em per character, script x serifScale x 0.85,
  // 0.26 em of word margins), at the font size the line is actually given
  const cap = STYLE.brand.capSize, serif = STYLE.brand.serifScale;
  const fitW = STYLE.captions.fitLine;
  assert.equal(typeof fitW, "number", "keynote.json must set captions.fitLine to a width in px");
  assert.ok(fitW <= boxW, `captions.fitLine ${fitW} is wider than the ${boxW}px caption box`);
  const px = key[2] ? +key[2] : cap;
  const estAt = (size) => [...(key[3] + "<").matchAll(/class="ew( eser)?">([^<]+)</g)].reduce((n, w) => n + (w[2].length * 0.56 * (w[1] ? serif * 0.85 : 1) + 0.26) * size, 0);
  assert.ok(px < cap, `the line "${key[3].replace(/<[^>]+>/g, " ").trim()}" kept the full ${cap}px size`);
  // exactly the size that fits fitLine (820), not fitLine: true's 900 (which would give a larger size here)
  assert.equal(px, Math.floor(cap * fitW / estAt(cap)), `the line got ${px}px; fitting ${fitW}px needs ${Math.floor(cap * fitW / estAt(cap))}px (900 would give ${Math.floor(cap * 900 / estAt(cap))}px)`);
  assert.ok(estAt(px) <= boxW, `the line is ~${Math.round(estAt(px))}px wide at ${px}px, wider than its ${boxW}px caption box`);
  // a short line is left alone
  assert.ok(lines.some((l) => !l[1]), "every line was shrunk; only the ones too wide for the box should be");
});

test("keynote: the grey box only on the opening block; later close-up blocks get the text shadow instead", () => {
  assert.ok(blocks.length >= 3, `expected at least 3 caption blocks, got ${blocks.length}`);
  for (const b of blocks) {
    if (b.start < (STYLE.captions.backingUntil ?? 2)) assert.equal(b.cls, "ebacked", `block ${b.i} at ${b.start}s should keep the grey box`);
    else assert.equal(b.cls, "eshadow", `block ${b.i} at ${b.start}s should drop the grey box for the text shadow`);
  }
  assert.ok(blocks.some((b) => b.cls === "ebacked") && blocks.some((b) => b.cls === "eshadow"));
  assert.match(html, /\.eshadow \.ew \{ text-shadow:/, "the .eshadow css is missing");
});

test("the close-up warning counts the blocks that really got the grey box", () => {
  const n = blocks.length, boxed = blocks.filter((b) => b.cls === "ebacked").length;
  assert.match(stdout, new RegExp(`${n} caption block\\(s\\) in close-up fallback \\(under the mouth, ${boxed} on the grey box, ${n - boxed} without it\\)`));
});

test("captions.backingUntil on the cap-group path (a non-editorial style): cap-backed before the time, cap-shadow after", () => {
  const until = 2.5;
  const { html: h } = buildReel("clean", { backingUntil: until });
  const groups = [...h.matchAll(/<div id="cg(\d+)" class="cap-group clip([^"]*)" style="[^"]*" data-start="([\d.]+)"/g)].map((m) => ({ i: +m[1], cls: m[2].trim(), start: +m[3] }));
  assert.ok(groups.length >= 3, `expected at least 3 caption groups, got ${groups.length}`);
  for (const g of groups) {
    if (g.start < until) assert.equal(g.cls, "cap-backed", `group ${g.i} at ${g.start}s should keep the grey box`);
    else assert.equal(g.cls, "cap-shadow", `group ${g.i} at ${g.start}s should drop the grey box for the text shadow`);
  }
  assert.ok(groups.some((g) => g.cls === "cap-backed") && groups.some((g) => g.cls === "cap-shadow"));
  assert.match(h, /\.cap-shadow \{ text-shadow:/, "the .cap-shadow css is missing");
  // without the key the same reel keeps the box on every close-up group (the old behaviour)
  const { html: h0 } = buildReel("clean", {});
  assert.ok(!/ cap-shadow"/.test(h0) && / cap-backed"/.test(h0));
});

test("mac-47: with fitLine off, an editorial line too wide for the canvas still shrinks (keynote-3 lowercase, pop upper-case)", () => {
  // keynote-3 pins fitLine: false and pop never sets it; both drew real lines off the right edge (keynote-3 up to 200 px,
  // pop up to 205 px, measured with caption-boxes.mjs on 3 real reels). A nowrap line starts at the .eblock's left edge
  // (130 px), so the canvas allows W - 170 px; pop's upper-case words are estimated at 0.86 em per capital.
  for (const style of ["keynote-3", "pop"]) {
    const { html } = buildReel(style, {});
    const lines = [...html.matchAll(/<span id="eb\d+l\d+" class="eline"( style="font-size:(\d+)px")?>(.*?)<\/span><\/span>/g)];
    const long = lines.find((l) => />presumptive</i.test(l[3]));
    assert.ok(long, `${style}: the "presumptive approach are" line was not built`);
    assert.ok(long[2], `${style}: the line "presumptive approach are" kept its full size and runs off the canvas`);
    assert.ok(lines.some((l) => !l[1]), `${style}: every line was shrunk; only the ones too wide for the canvas should be`);
  }
});

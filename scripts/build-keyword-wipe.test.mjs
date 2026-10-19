#!/usr/bin/env node
// node --test scripts/build-keyword-wipe.test.mjs
// The Keynote's gold script keyword (captions.keywords: script) writes itself on with a clip-path wipe (~0.45-0.56 s).
// Found on Linux staging (mac-39): a keyword at the END of a caption block, with the next block < 0.56 s away, never
// finished drawing ("manually" cut at "man"), because the wipe started with the word and ran past the block's end.
// motion.mjs fitWipe now ends the wipe before the block ends (shortened to the time left, with a floor; moved earlier
// only if the floor does not fit). The same write-on on the cluster path (captions.script) is checked too.
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
const SEC = 6, FPS = 30;
// "manually." ends its line and its block (punctuation); "now" starts the next block 0.29 s after the keyword starts
const WORDS = [["we", 0.3, 0.5], ["do", 0.6, 0.8], ["this,", 0.9, 1.1], ["all", 1.2, 1.4], ["manually.", 1.55, 1.8], ["now", 1.84, 2.0],
  ["it", 2.1, 2.2], ["runs", 2.3, 2.5], ["itself.", 2.6, 3.0], ["that", 3.4, 3.6], ["is", 3.7, 3.8], ["it.", 3.9, 4.2]];

function buildReel(style, captions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kw-wipe-"));
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "assets", "talk.mp4")], { stdio: "pipe" });
  const words = { segments: [{ start: 0, end: SEC, words: WORDS.map(([word, start, end]) => ({ word, start, end })) }] };
  fs.writeFileSync(path.join(root, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(root, "reel.json"), JSON.stringify({ title: "keyword wipe", source: "assets/talk.mp4", words: "build/words.whisper.json",
    fps: FPS, outro: 0, music: null, style, zoom: {}, takes: [{ a: 0, b: SEC }], beats: [], captions }, null, 2));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: root, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary() } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  fs.rmSync(root, { recursive: true, force: true });
  return html;
}

// the wipe tween of element `id`: [start, duration]
function wipeOf(html, id) {
  const m = html.match(new RegExp(`ft\\("#${id}", \\{ clipPath: "[^"]+" \\}, \\{ clipPath: "[^"]+", duration: ([\\d.]+), ease: "power1.inOut" \\}, ([\\d.-]+)\\)`));
  assert.ok(m, `no clip-path write-on tween for #${id}`);
  return [+m[2], +m[1]];
}

test("keynote: a script keyword at the end of a block finishes its write-on before the block ends", () => {
  const html = buildReel("keynote", { keywords: { manually: "script" } });
  const blk = [...html.matchAll(/<div id="eb(\d+)" class="eblock[^"]*" style="[^"]*" data-start="([\d.]+)" data-duration="([\d.]+)"[^>]*>(.*?)<\/div>/g)]
    .find((m) => /class="ew eser">manually\./.test(m[4]));
  assert.ok(blk, "the block holding the script keyword was not built");
  const [bs, be] = [+blk[2], +blk[2] + +blk[3]];
  const wid = blk[4].match(/<span id="(eb\d+l\d+w\d+)" class="ew eser">manually\./)[1];
  const [t, d] = wipeOf(html, wid);
  // the next block really starts before the old 0.45 s wipe could finish (the case this test is about)
  assert.ok(1.53 + 0.45 > be, `fixture no longer puts the keyword at a block end with too little time (block ends ${be})`);
  assert.ok(t + d <= be - 0.03, `the write-on runs ${t}..${r(t + d)} s but its block ends at ${be} s: the word is cut mid-draw`);
  assert.ok(t >= bs - 1e-9, `the write-on starts at ${t} s, before its block appears at ${bs} s`);
  assert.ok(d >= 0.2 - 1e-9, `the write-on was squeezed to ${d} s (floor 0.2)`);
});

test("cluster: a captions.script word at the end of a phrase finishes its write-on before the phrase ends", () => {
  const html = buildReel("monologue", { style: "cluster", script: ["manually"] });
  const ph = [...html.matchAll(/<div id="(cl\d+)" class="cl clip" style="[^"]*" data-start="([\d.]+)" data-duration="([\d.]+)"[^>]*>(.*?)<\/div><\/div>/g)]
    .find((m) => /class="cw [^"]*scr[^"]*"[^>]*>manually/.test(m[4]));
  assert.ok(ph, "the phrase holding the script word was not built");
  const [bs, be] = [+ph[2], +ph[2] + +ph[3]];
  const wid = ph[4].match(/<span id="(cl\d+w\d+)" class="cw [^"]*scr/)[1];
  const [t, d] = wipeOf(html, wid);
  // fixture guard: the unfitted wipe (build.mjs: max(0.35, min(0.7, end - start + 0.25)) from max(phrase start, start - 0.03))
  // really would run past the phrase end
  const base = Math.max(0.35, Math.min(0.7, 1.8 - 1.55 + 0.25)), t0 = Math.max(bs, 1.55 - 0.03);
  assert.ok(t0 + base > be, `fixture no longer puts the script word at a phrase end with too little time (phrase ends ${be})`);
  assert.ok(t + d <= be - 0.03, `the write-on runs ${t}..${r(t + d)} s but its phrase ends at ${be} s`);
  assert.ok(t >= bs - 1e-9, `the write-on starts at ${t} s, before its phrase appears at ${bs} s`);
  assert.ok(d >= 0.2 - 1e-9, `the write-on was squeezed to ${d} s (floor 0.2)`);
});

test("fitWipe leaves a wipe that already fits untouched (byte-identical markup for every other keyword)", async () => {
  const { fitWipe } = await import("./lib/motion.mjs");
  assert.deepEqual(fitWipe(8.59, 0.57, 10.367), [8.59, 0.57]);
  const [t, d] = fitWipe(1.53, 0.45, 1.79, { min: 1.25 });
  assert.ok(t + d <= 1.74 + 1e-9 && t >= 1.25 && d >= 0.2);
  // even the floor does not fit after the word: start earlier, never before the block
  const [t2, d2] = fitWipe(1.7, 0.45, 1.79, { min: 1.25 });
  assert.equal(d2, 0.2); assert.ok(Math.abs(t2 + d2 - 1.74) < 1e-9);
  // a block too short for the floor after `min`: the wipe runs from min to the limit (faster than 0.2 s) and still completes
  const [t3, d3] = fitWipe(1.0, 0.45, 1.1, { min: 1.0 });
  assert.equal(t3, 1.0); assert.ok(Math.abs(t3 + d3 - 1.05) < 1e-9, `ends at ${t3 + d3}, block limit 1.05`);
  // a start before `min` (a scriptDur lead-in before the word is visible) is moved to min and still ends by the limit
  const [t4, d4] = fitWipe(1.5, 0.28, 1.79, { min: 1.52 });
  assert.equal(t4, 1.52); assert.ok(t4 + d4 <= 1.74 + 1e-9, `ends at ${t4 + d4}, block limit 1.74`);
});

const r = (x) => Math.round(x * 1000) / 1000;

#!/usr/bin/env node
// node --test scripts/build-open-flash.test.mjs
// The open flash defaults to the reel's first frame (the first take's output start), not source time 0.
// Regression: a reel whose first take starts at 0.05 s crashed alif / ak-consulting-content with
// "E(0) for open flash: not inside any take".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-oflash-"));
const SEC = 6, FPS = 30;
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4")], { stdio: "pipe" });
const words = "so here is the thing about money and time that nobody tells you at all".split(" ");
let n = 0;
function project(reel) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: SEC, words: words.map((w, i) => ({ word: w, start: +(0.3 + i * 0.35).toFixed(2), end: +(0.6 + i * 0.35).toFixed(2) })) }] }));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "oflash", source: "assets/talk.mp4", words: "build/words.whisper.json", fps: FPS, outro: 0.4, zoom: {}, beats: [], ...reel }, null, 2));
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary() } });

for (const style of ["alif", "ak-consulting-content"]) {
  test(`${style}: first take at 0.05 s builds and the open flash lands at output 0`, () => {
    const dir = project({ style, takes: [{ a: 0.05, b: 2.5 }, { a: 3, b: SEC }] });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /open flash at 0s /);
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    assert.match(html, /<div id="oflash" class="clip" data-start="0" /);
  });
}

test("an explicit openFlash.at still resolves through the source clock", () => {
  const dir = project({ style: "alif", takes: [{ a: 0.05, b: 2.5 }, { a: 3, b: SEC }], openFlash: { at: 3.5 } });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /open flash at 2.967s /);   // take 0 is 74 frames (2.467 s), then 0.5 s into take 1
});

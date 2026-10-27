// mac-59: `build.mjs <project> --timeline` writes build/timeline.json { speech, outro, total, fps } - the reel's length,
// the style's outro included - without building anything, and a full build never writes that file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "timeline-"));
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=108x192:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=200:duration=8",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(root, "talk.mp4")]);
const words = { segments: [{ start: 0, end: 8, words: "one two three four five six seven eight nine ten".split(" ").map((w, i) => ({ word: w, start: 0.3 + i * 0.7, end: 0.8 + i * 0.7 })) }] };
let n = 0;
function project(reel) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true }); fs.mkdirSync(path.join(dir, "build"));
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "timeline", source: "assets/talk.mp4", words: "build/words.whisper.json",
    fps: 30, music: null, style: "clean", zoom: {}, beats: [], takes: [{ a: 0, b: 3 }, { a: 4, b: 7.5, hold: 0.4 }], ...reel }, null, 2));
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [path.join(HERE, "build.mjs"), ".", ...args], { cwd: dir, encoding: "utf8" });
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, "build", f), "utf8"));

test("--timeline equals the full build's own TOTAL, and writes nothing else", () => {
  const dir = project({ outro: 2 });
  const before = fs.readdirSync(path.join(dir, "build")).sort();
  const r = run(dir, "--timeline");
  assert.equal(r.status, 0, r.stderr);
  const t = read(dir, "timeline.json");
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").at(-1)), t, "the last stdout line is the same JSON");
  // 3 s + (3.5 s + a 0.4 s hold), in whole frames, then the reel's 2 s outro
  assert.deepEqual(t, { speech: 6.9, outro: 2, total: 8.9, fps: 30 });
  assert.deepEqual(fs.readdirSync(path.join(dir, "build")).sort(), [...before, "timeline.json"].sort(), "only timeline.json is new");
  assert.ok(!fs.existsSync(path.join(dir, "index.html")), "nothing is built");
  fs.rmSync(path.join(dir, "build", "timeline.json"));
  const b = run(dir);
  assert.equal(b.status, 0, b.stderr);
  const truth = read(dir, "edit_truth.json");
  assert.equal(truth.total, t.total); assert.equal(+truth.speech.toFixed(3), t.speech);
  assert.ok(!fs.existsSync(path.join(dir, "build", "timeline.json")), "a full build does not write timeline.json");
});

test("the outro is the style's when reel.json says nothing, the default 3 when neither does", () => {
  const style = (s) => { const dir = project({ style: s }); delete JSON.parse(fs.readFileSync(path.join(dir, "reel.json"), "utf8")).outro; const r = run(dir, "--timeline"); assert.equal(r.status, 0, r.stderr); return read(dir, "timeline.json"); };
  assert.equal(style("hormozi").outro, 0.15, "hormozi sets outro 0.15");
  assert.equal(style("hormozi").total, 7.05);
  assert.equal(style("clean").outro, 3, "clean sets none: build.mjs's default");
  const own = project({ style: "hormozi", outro: 1 });
  assert.equal((run(own, "--timeline"), read(own, "timeline.json")).outro, 1, "reel.json wins over the style");
});

test("a blank project: the 1 s black page", () => {
  const dir = project({ origin: "blank", takes: [] });
  const r = run(dir, "--timeline");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(dir, "timeline.json"), { speech: 0, outro: 0, total: 1, fps: 30 });
  assert.ok(!fs.existsSync(path.join(dir, "index.html")));
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

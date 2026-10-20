// node --test scripts/build-pitch-face.test.mjs
// Pitch (duo captions on a fixed chest line) on a very close selfie face: the face fills the frame, the chin sits at
// 1264-1476 px, so the chest line (1180 / energy 1120) lands on the mouth. No caption box may cross the eyes-to-chin
// band; on a medium shot (chin at 900) the words keep the style's fixed heights. Synthetic media only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitch-face-"));
const SEC = 10;
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=30:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(root, "talk.mp4")], { stdio: "pipe" });
const text = "so here is the thing every job is worth over a hundred pounds and the guarantee is risk free for you".split(" ");
const words = { segments: [{ start: 0, end: SEC, words: text.map((w, i) => ({ word: w, start: +(0.2 + i * 0.42).toFixed(2), end: +(0.5 + i * 0.42).toFixed(2) })) }] };
// samples [t, top, bottom, left, right, eyes, mouth]
const CLOSE = Array.from({ length: SEC * 5 + 1 }, (_, i) => [+(i * 0.2).toFixed(1), 560, 1264 + (i % 5) * 53, 220, 860, 960, 1180]);
const MEDIUM = Array.from({ length: SEC * 5 + 1 }, (_, i) => [+(i * 0.2).toFixed(1), 300, 900, 340, 740, 480, 700]);

function layout(name, samples) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true }); fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples }));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: name, source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json",
    fps: 30, style: "pitch", outro: 0, music: null, takes: [{ a: 0, b: SEC }], zoom: {}, beats: [], captions: { energy: [[3, 5.5]] } }));
  execFileSync(process.execPath, [path.join(HERE, "build.mjs"), "."], { cwd: dir, stdio: "pipe" });
  return JSON.parse(fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8")).blocks;
}

test("pitch on a close face: no caption box crosses the eyes-to-chin band", () => {
  const blocks = layout("close", CLOSE);
  assert.ok(blocks.length >= text.length - 2, "every word placed");
  assert.ok(blocks.some((b) => b.h > 100), "energy (big) words are in the fixture");
  for (const b of blocks) {
    const near = CLOSE.filter((s) => s[0] >= b.t0 - 0.2 && s[0] <= b.t1 + 0.2);
    const eyes = Math.min(...near.map((s) => s[5])), chin = Math.max(...near.map((s) => s[2]));
    assert.ok(b.y + b.h <= eyes || b.y >= chin, `block ${b.t0}-${b.t1} y=${b.y} h=${b.h} crosses the face band ${eyes}-${chin}`);
    assert.ok(b.y >= 220 && b.y + b.h <= 1500, `block ${b.t0} stays in the safe area`);
  }
});

test("pitch on a medium shot: the fixed chest line does not move", () => {
  const blocks = layout("medium", MEDIUM);
  for (const b of blocks) assert.ok(b.y === 1180 || b.y === 1120, `block ${b.t0} y=${b.y}`);
});

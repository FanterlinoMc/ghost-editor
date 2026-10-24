// caption-boxes.mjs (mac-51): x and width per caption block, measured in Chrome. The join is pure (always runs); the
// real-Chrome test skips without Chrome / puppeteer-core unless CI=1 or REQUIRE_CHROME=1, like build-caption-height.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { joinBoxes } from "./caption-boxes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED = process.env.CI === "1" || process.env.REQUIRE_CHROME === "1";

test("joinBoxes: elements join a block by start (to 0.006 s), a cluster's several elements are one union, no element gives null", () => {
  const blocks = [{ t0: 0.12, y: 1200 }, { t0: 1.4, y: 1200 }, { t0: 3 }];
  const page = [{ start: 0.12, x0: 230.4, x1: 849.6, y0: 1200.5, y1: 1283.2 }, { start: 1.403, x0: 100, x1: 300, y0: 1190, y1: 1250 }, { start: 1.404, x0: 500.2, x1: 700.9, y0: 1210, y1: 1290.1 }, { start: 2.9, x0: 1, x1: 2, y0: 1, y1: 2 }];
  assert.deepEqual(joinBoxes(blocks, page), [
    { t0: 0.12, y: 1200, x: 230, width: 620, drawnTop: 1200, drawnBottom: 1284 },
    { t0: 1.4, y: 1200, x: 100, width: 601, drawnTop: 1190, drawnBottom: 1291 },
    { t0: 3, x: null, width: null, drawnTop: null, drawnBottom: null },
  ]);
});

test("real Chrome: blocks get x and width, a centred block is centred, an overlong word is outside the canvas, a rebuild clears them", { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capbox-"));
  try {
    const dir = path.join(root, "p");
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true }); fs.mkdirSync(path.join(dir, "build"));
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=108x192:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=200:duration=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "assets", "talk.mp4")]);
    const said = ["we", "built", "this", "supercalifragilisticexpialidociously", "then", "we", "shipped", "it"];
    fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: 6, words: said.map((w, i) => ({ word: w, start: 0.2 + i * 0.6, end: 0.7 + i * 0.6 })) }] }));
    fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 4 }, (_, i) => [i * 2, 300, 900, 340, 740, 480, 700]) }));
    fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "capbox", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json",
      fps: 30, outro: 0, music: null, style: "clean", zoom: {}, beats: [], takes: [{ a: 0, b: 6 }], captions: { style: "clean", group: 3 } }));
    const build = () => spawnSync(process.execPath, [path.join(HERE, "build.mjs"), "."], { cwd: dir, encoding: "utf8" });
    assert.equal(build().status, 0);
    const before = fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8");
    assert.ok(!/"x"/.test(before) && !/"width"/.test(before) && !/"measured"/.test(before), "the build itself never writes x / width");
    const r = spawnSync(process.execPath, [path.join(HERE, "caption-boxes.mjs"), dir, "--check"], { encoding: "utf8" });
    if (r.status !== 0 && /ERROR:/.test(r.stderr)) { if (REQUIRED) assert.fail(r.stderr); return t.skip(r.stderr.trim()); }
    const res = JSON.parse(r.stdout.trim().split("\n").at(-1));
    const lay = JSON.parse(fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8"));
    assert.equal(lay.measured.by, "caption-boxes");
    assert.equal(res.measured, lay.blocks.length, "every block measured");
    assert.equal(res.unmatched, 0);
    const long = lay.blocks.findIndex((b, i) => res.outside.some((o) => o.i === i));
    assert.ok(long >= 0, `the overlong word is reported outside: ${JSON.stringify(res)}`);
    assert.equal(r.status, 1, "--check fails on it");
    assert.match(r.stderr, /caption block \d+ at [\d.]+s is drawn at x -?\d+\.\.\d+px, outside the 1080px canvas/);
    for (const [i, b] of lay.blocks.entries()) {
      assert.ok(Number.isInteger(b.x) && Number.isInteger(b.width) && b.width > 0, JSON.stringify(b));
      assert.ok(Number.isInteger(b.drawnTop) && b.drawnBottom > b.drawnTop, JSON.stringify(b));
      if (i !== long) assert.ok(Math.abs(b.x - (1080 - b.width) / 2) <= 2, `centred: ${JSON.stringify(b)}`);
    }
    assert.equal(build().status, 0);
    assert.equal(fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8"), before, "a rebuild writes the unmeasured file again, byte for byte");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

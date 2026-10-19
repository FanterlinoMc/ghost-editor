#!/usr/bin/env node
// Does a REAL HyperFrames render show the Lottie frame the spec says? (references/reel-json.md, "Lottie element")
//
//   node scripts/lottie-render-check.mjs [--dir <project dir>] [--keep]
//
// Re-run whenever the HyperFrames pin (or lottie-web) changes. motion-determinism.mjs --variant lottie seeks the GSAP
// timeline in a bare page; it has no HyperFrames runtime, so it cannot see HyperFrames' own Lottie adapter, which (if
// it ever finds our players again) re-seeks them to the composition time after our timeline. Only a render shows that.
//
// Builds the fixture reel (motion-fixture.mjs LOTTIE_BEAT: a hand-written file whose red 60 px square has its centre
// at x = 50 + 5 * frame inside a 400 px box at page x 340), renders it through runRender() (the vendor preload; the
// same path as scripts/render.mjs) under the shared render lock, and reads the square's left edge in every frame where
// it is fully visible: play-once from 2.9 s (after its fade/scale-in) and the loop from 2.0 s, both to 7.8 s (the
// exit fade). Each must equal lottieFrameAt(t). A frame where a caption covers the square is skipped, not guessed.
// Exit 1 on any mismatch or if fewer than MIN_MEASURED frames could be read for either player.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeProject, LOTTIE_BEAT, LOTTIE_FIXTURE, LOTTIE_FILE, lottieFrameAt } from "./lib/motion-fixture.mjs";
import { runRender } from "./lib/vendor.mjs";

const SELF = fileURLToPath(import.meta.url);
const LOCK = "/tmp/phantasic-render.lock";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true); };

// one render at a time on this machine: re-run self under lockf (macOS / BSD) unless already inside it
if (!process.env.LOTTIE_CHECK_LOCKED && process.platform !== "win32" && spawnSync("sh", ["-c", "command -v lockf"]).status === 0) {
  const r = spawnSync("lockf", ["-k", LOCK, process.execPath, SELF, ...argv], { stdio: "inherit", env: { ...process.env, LOTTIE_CHECK_LOCKED: "1" } });
  process.exit(r.status ?? 1);
}

const FPS = 30, MIN_MEASURED = 20;
const dir = opt("dir", path.join(os.tmpdir(), "lottie-render-check"));
const keep = !!opt("keep", false);
fs.rmSync(path.join(dir, "out.mp4"), { force: true });
makeProject(dir, { beat: LOTTIE_BEAT, files: { [LOTTIE_FILE]: LOTTIE_FIXTURE } });
const r = runRender(["-o", "out.mp4", "--quiet"], { cwd: dir });
const served = (r.stderr.match(/vendor: served \S+/g) || []).join("\n  ");
if (r.status !== 0) { console.error(`render failed: ${r.error || r.stderr.slice(-2000)}`); process.exit(1); }
console.log(`rendered ${path.join(dir, "out.mp4")}\n  ${served}`);

// rows of the squares (lottie y 200 +/- 30 in boxes at page y 300 and 900), the full box width
const BOX_X = 340, BOX_W = 400, ROWS = 80;
const PLAYERS = [
  { id: "once", y: 300 + 200 - ROWS / 2, from: 2.9 },
  { id: "loopy", y: 900 + 200 - ROWS / 2, from: 2.0 },
];
const TO = 7.8;
const strip = (y) => execFileSync("ffmpeg", ["-v", "error", "-i", path.join(dir, "out.mp4"), "-vf", `crop=${BOX_W}:${ROWS}:${BOX_X}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 30 });

let bad = 0;
for (const p of PLAYERS) {
  const buf = strip(p.y), per = BOX_W * ROWS * 3, n = buf.length / per;
  let ok = 0, covered = 0;
  const wrong = [];
  for (let f = 0; f < n; f++) {
    const t = f / FPS;
    if (t < p.from - 1e-9 || t >= TO) continue;
    // a column belongs to the square when >= 55 of its 80 rows are pure red; the square is one run of 57..61 columns
    const cols = [];
    for (let x = 0; x < BOX_W; x++) {
      let c = 0;
      for (let y = 0; y < ROWS; y++) { const i = f * per + (y * BOX_W + x) * 3; if (buf[i] > 200 && buf[i + 1] < 60 && buf[i + 2] < 60) c++; }
      if (c >= 55) cols.push(x);
    }
    const runs = [];
    for (const x of cols) { if (runs.length && x === runs[runs.length - 1].end + 1) runs[runs.length - 1].end = x; else runs.push({ start: x, end: x }); }
    const sq = runs.filter((u) => u.end - u.start + 1 >= 57 && u.end - u.start + 1 <= 61);
    if (sq.length !== 1) { covered++; continue; }
    const frame = Math.round((sq[0].start + BOX_X - 360) / 5);   // left edge = 340 + (50 + 5 * frame) - 30
    const want = lottieFrameAt(t)[p.id];
    if (frame === want) ok++; else wrong.push(`f${f} t=${t.toFixed(3)} shows ${frame}, want ${want}`);
  }
  console.log(`  ${p.id}: ${ok} frames match, ${wrong.length} wrong, ${covered} covered (skipped)`);
  for (const w of wrong.slice(0, 8)) console.log(`    ${w}`);
  if (wrong.length || ok < MIN_MEASURED) { bad++; if (ok < MIN_MEASURED) console.log(`    only ${ok} measurable frames (need ${MIN_MEASURED})`); }
}
if (!keep) fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? "LOTTIE RENDER CHECK: FAIL" : "LOTTIE RENDER CHECK: PASS");
process.exit(bad ? 1 : 0);

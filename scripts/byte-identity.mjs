#!/usr/bin/env node
// Byte-identity check: does an existing single-source reel still build to exactly the same bytes?
//
//   node scripts/byte-identity.mjs            compare against scripts/lib/golden-build-hashes.json
//   node scripts/byte-identity.mjs --record   (re)write the golden file from the current build.mjs
//   node scripts/byte-identity.mjs --keep     leave the scratch projects in $TMP for inspection
//
// Why it exists: the blank-timeline work (BLANK-TIMELINE-SPEC.md, Stage 1) loosened build.mjs so a
// source may have no transcript / face track, and a reel may have no takes. Every one of those
// relaxations sits on a path that single-source reels used to take unconditionally, so the promise
// "an existing reel builds exactly as before" needs a check, not a belief.
//
// The reels are synthetic and self-contained (like motion-determinism.mjs): a 10 s testsrc2 clip,
// hand-written words and a static face box. Each reel is built TWICE; a build that is not
// reproducible run-to-run would make the hashes meaningless, so that is an error in itself.
// Hashed per reel: index.html and every build/*.json build.mjs writes (edit_truth.json - the A1
// harness's ground truth - caption_layout.json, sfx_events.json, ...).
//
// The golden file was recorded with the build.mjs of designer/engine a4b0661 (before any blank
// work). Re-record it ONLY for a deliberate, reviewed change to single-source output.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUSY_BEAT, ROOM_BEAT } from "./lib/motion-fixture.mjs";
import { silentLibrary } from "./lib/silent-library.mjs";
import { measuredMatch, VOICE_TOL_DB } from "./lib/measured-match.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_MJS = path.join(HERE, "build.mjs");
const GOLDEN = path.join(HERE, "lib", "golden-build-hashes.json");
const argv = process.argv.slice(2);
const RECORD = argv.includes("--record"), KEEP = argv.includes("--keep");
const SECONDS = 10;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26, ...opts });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const wordsJson = () => {
  const text = "Every second of this synthetic clip carries a caption so the motion beat has real company on screen while it plays and then leaves again".split(" ");
  const step = (SECONDS - 0.6) / text.length;
  return { segments: [{ start: 0, end: SECONDS, words: text.map((w, i) => ({ word: w, start: +(0.3 + i * step).toFixed(2), end: +(0.3 + i * step + step * 0.8).toFixed(2) })) }] };
};
const faceJson = () => ({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 8 }, (_, i) => [i * 2, 300, 900, 340, 740, 480, 700]) });

const base = { title: "byte-identity", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: 30 };
const REELS = {
  // every beat-free path: captions, snaps, pushes, take-join transitions, a hold, the outro still
  edit: { ...base, style: "clean", outro: 2, music: null,
    takes: [{ a: 0, b: 3 }, { a: 4, b: 7, transition: "blur" }, { a: 7.5, b: 9.5, transition: "whip", hold: 0.5 }],
    zoom: { snaps: [[1.2, 1.1], [5, 1.12]], pushes: [{ at: 4.5, until: 6.5, z: 1.15 }] }, beats: [] },
  // the two determinism-harness variants, via their shared fixture beats
  busy: { ...base, style: "keynote-3", outro: 0, music: null, takes: [{ a: 0, b: SECONDS }], zoom: {}, beats: [BUSY_BEAT] },
  room: { ...base, style: "keynote-3", outro: 0, music: null, takes: [{ a: 0, b: SECONDS }], zoom: {}, beats: [ROOM_BEAT] },
  // no face track at all: the single-source fallback (fixed-height captions) must not move either
  noface: { ...base, face: "build/does-not-exist.json", style: "clean", outro: 0, music: null, takes: [{ a: 0, b: 6 }], zoom: {}, beats: [] },
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "byte-identity-"));
const src = path.join(root, "talk.mp4");
sh("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=360x640:rate=30:duration=${SECONDS}`, "-f", "lavfi", "-i", `sine=frequency=180:duration=${SECONDS}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30", "-c:a", "aac", "-shortest", "-movflags", "+faststart", "-y", src]);

function buildOnce(name, reel, tag) {
  const dir = path.join(root, `${name}-${tag}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(src, path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(wordsJson()));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(faceJson()));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify(reel, null, 2));
  // the golden hashes are the SHIPPED library (no audio): a fetched library/sfx would change every reel with a sound
  sh(process.execPath, [BUILD_MJS, "."], { cwd: dir, env: { ...process.env, PHANTASIC_LIB: silentLibrary() } });
  const out = {};
  out["index.html"] = sha(fs.readFileSync(path.join(dir, "index.html")));
  for (const f of fs.readdirSync(path.join(dir, "build")).sort()) {
    if (!f.endsWith(".json") || f === "words.whisper.json" || f === "face.json") continue;
    out[`build/${f}`] = sha(fs.readFileSync(path.join(dir, "build", f)));
  }
  return out;
}

const got = {};
let bad = 0, tolerated = 0, additive = 0;
for (const [name, reel] of Object.entries(REELS)) {
  const a = buildOnce(name, reel, "a"), b = buildOnce(name, reel, "b");
  if (JSON.stringify(a) !== JSON.stringify(b)) { console.error(`NOT REPRODUCIBLE: ${name} builds differently run to run`); bad++; }
  got[name] = a;
}

if (RECORD) {
  fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + "\n");
  console.log(`recorded ${Object.keys(got).length} reels -> ${path.relative(process.cwd(), GOLDEN)}`);
} else {
  const want = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  for (const name of Object.keys(REELS)) {
    for (const k of new Set([...Object.keys(want[name] || {}), ...Object.keys(got[name])])) {
      if ((want[name] || {})[k] === got[name][k]) continue;
      // build/geometry.json (the pixel check's input, references/pixel-check.md 2.2) is ADDITIVE: written after every
      // other output, from values they already hold, so it is not in the golden recorded before it existed. It is still
      // hashed above, so the run-to-run check covers it; every file the golden lists must match as before.
      if (k === "build/geometry.json" && !((want[name] || {})[k])) { additive++; continue; }
      const near = k === "build/sfx_events.json" && want[name]?.[k] ? measuredMatch(fs.readFileSync(path.join(root, `${name}-a`, k), "utf8"), want[name][k]) : null;
      if (near) { console.log(`within tolerance: ${name} ${k} (${near})`); tolerated++; continue; }
      console.error(`DIFFERS: ${name} ${k}`); bad++;
    }
  }
  console.log(bad ? `byte-identity: ${bad} problem(s)` : `byte-identity: ${Object.keys(REELS).length} reels, every output identical to the golden hashes${tolerated ? ` (${tolerated} measured voiceP95 within ${VOICE_TOL_DB} dB)` : ""}${additive ? ` (+ build/geometry.json, additive, reproducible run to run, in ${additive} reels)` : ""}`);
}
if (!KEEP) fs.rmSync(root, { recursive: true, force: true }); else console.log("kept " + root);
process.exit(bad ? 1 : 0);

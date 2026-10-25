#!/usr/bin/env node
// node --test scripts/build-sfx-variants.test.mjs
// mac-78: a bare sound id (whoosh / pop / impact) rotates through the variants that can PLAY. With whoosh-1 and -2 on
// disk but no whoosh-3, every third bare whoosh used to be silent; partial coverage must be quieter, never broken.
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
const SEC = 10;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-variants-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);

// a library with ONLY the named sound files on disk (manifests from the real one, audio from nowhere)
function libraryWith(files) {
  const silent = silentLibrary(), lib = path.join(root, `lib-${files.join("-") || "none"}`);
  fs.mkdirSync(lib);
  for (const e of fs.readdirSync(silent, { withFileTypes: true })) {
    if (e.name === "sfx") continue;
    fs.symlinkSync(fs.realpathSync(path.join(silent, e.name)), path.join(lib, e.name));
  }
  fs.mkdirSync(path.join(lib, "sfx"));
  for (const f of fs.readdirSync(path.join(silent, "sfx"))) fs.copyFileSync(path.join(silent, "sfx", f), path.join(lib, "sfx", f));
  for (const f of files) ff("-f", "lavfi", "-i", "sine=frequency=880:duration=0.9", "-ac", "2", path.join(lib, "sfx", f));
  return lib;
}
function build(lib) {
  const dir = fs.mkdtempSync(path.join(root, "p-"));
  fs.mkdirSync(path.join(dir, "assets")); fs.mkdirSync(path.join(dir, "build"));
  ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=30:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: SEC, words: Array.from({ length: 30 }, (_, i) => ({ word: "word", start: +(0.3 + i * 0.3).toFixed(2), end: +(0.55 + i * 0.3).toFixed(2) })) }] }));
  const beats = Array.from({ length: 6 }, (_, i) => ({ type: "emoji", emoji: "x", x: 600, y: 300, at: 1 + i * 1.3, to: 1.8 + i * 1.3, sfx: "whoosh" }));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "v", source: "assets/talk.mp4", words: "build/words.whisper.json", fps: 30, outro: 0, music: null, takes: [{ a: 0, b: SEC }], zoom: {}, beats }));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: lib } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { log: r.stdout + r.stderr, events: JSON.parse(fs.readFileSync(path.join(dir, "build", "sfx_events.json"), "utf8")).events.filter((e) => e.why === "emoji") };
}

test("two of three whoosh variants on disk: every bare whoosh plays, alternating 1, 2", () => {
  const { events, log } = build(libraryWith(["whoosh-1.wav", "whoosh-2.wav"]));
  assert.deepEqual(events.map((e) => e.id), ["whoosh-1", "whoosh-2", "whoosh-1", "whoosh-2", "whoosh-1", "whoosh-2"]);
  assert.ok(!/whoosh-3/.test(log), "whoosh-3 is never asked for, so never reported missing");
});

test("one variant on disk: all six play it", () => {
  assert.deepEqual(build(libraryWith(["whoosh-2.wav"])).events.map((e) => e.id), Array(6).fill("whoosh-2"));
});

test("none on disk: the rotation and the missing-sound report are exactly as before", () => {
  const { events, log } = build(libraryWith([]));
  assert.equal(events.length, 0);
  assert.match(log, /whoosh-1 \(whoosh-1\.wav\) x2/); assert.match(log, /whoosh-2 \(whoosh-2\.wav\) x2/); assert.match(log, /whoosh-3 \(whoosh-3\.wav\) x2/);
});

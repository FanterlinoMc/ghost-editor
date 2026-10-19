#!/usr/bin/env node
// node --test scripts/build-nosource-sfx.test.mjs
// A no-source sfx entry (library/sfx/manifest.json, duration null: paper-*, pen-*) must build exactly as if the entry were not
// in the manifest at all, on every install - also one where a file of that name sits in library/sfx. Two stub libraries are made
// in the OS temp folder, both holding a generated silent paper-quick.wav and pen-short.wav (the stray files) next to the stand-ins
// whoosh-cine.wav and tick-1.wav: one with the engine's real manifest, one with the no-source entries deleted (the manifest before
// they were added). folio-2 (sfxFallback paper-* -> whoosh-cine, pen-* -> tick-1) must play the stand-ins, clean (no fallback)
// must skip the ids with the same warning, and index.html + sfx_events.json must be byte-identical between the two libraries.
// No audio file is ever committed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nosource-sfx-"));
process.on("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } });
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 8, FPS = 30;
ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));
const words = { segments: [{ start: 0, end: SEC, words: Array.from({ length: 20 }, (_, i) => ({ word: ["every", "page", "lands", "here"][i % 4], start: +(0.3 + i * 0.36).toFixed(2), end: +(0.55 + i * 0.36).toFixed(2) })) }] };

const realMan = JSON.parse(fs.readFileSync(path.join(HERE, "..", "library", "sfx", "manifest.json"), "utf8"));
const realTiming = JSON.parse(fs.readFileSync(path.join(HERE, "..", "library", "sfx", "timing.json"), "utf8"));
const NOSOURCE = Object.keys(realMan).filter((id) => realMan[id].duration == null);
const STRAY = ["paper-quick", "pen-short"], STANDIN = { "paper-quick": "whoosh-cine", "pen-short": "tick-1" };
function stubLibrary(name, man) {
  const lib = path.join(root, name);
  fs.mkdirSync(path.join(lib, "sfx"), { recursive: true }); fs.mkdirSync(path.join(lib, "music"), { recursive: true });
  for (const id of [...STRAY, ...Object.values(STANDIN)]) ff("-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.4", path.join(lib, "sfx", `${id}.wav`));
  fs.writeFileSync(path.join(lib, "sfx", "manifest.json"), JSON.stringify(man));
  fs.writeFileSync(path.join(lib, "sfx", "timing.json"), JSON.stringify(realTiming));
  fs.writeFileSync(path.join(lib, "music", "manifest.json"), JSON.stringify({}));
  return lib;
}
const WITH = stubLibrary("lib-with", realMan);
const WITHOUT = stubLibrary("lib-without", Object.fromEntries(Object.entries(realMan).filter(([id]) => !NOSOURCE.includes(id))));

const fakeBin = path.join(root, "fake-bin"); fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, "npx"), "#!/bin/sh\necho 'npx is disabled in build-nosource-sfx.test.mjs' >&2\nexit 97\n", { mode: 0o755 });
fs.writeFileSync(path.join(fakeBin, "npx.cmd"), "@echo off\r\necho npx is disabled 1>&2\r\nexit /b 97\r\n");
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
let n = 0;
function build(style, lib) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true }); fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 5 }, (_, i) => [i * 2, 400, 1000, 340, 740, 560, 800]) }));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "nosource", style, source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS,
    takes: [{ a: 0, b: SEC }], outro: 0, music: null, sfx: [{ at: 2, id: "paper-quick" }, { at: 4, id: "pen-short" }] }));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: lib, [pathKey]: fakeBin + path.delimiter + process.env[pathKey] } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { log: r.stdout + r.stderr, html: fs.readFileSync(path.join(dir, "index.html"), "utf8"), events: fs.readFileSync(path.join(dir, "build", "sfx_events.json"), "utf8") };
}

test("the manifest's no-source entries are the duration-null paper/pen ids", () => {
  for (const id of STRAY) assert.ok(NOSOURCE.includes(id), `${id} is a no-source entry`);
});

test("folio-2 with stray paper-quick/pen-short files: plays the sfxFallback stand-ins, same bytes as without the entries", () => {
  const a = build("folio-2", WITH), b = build("folio-2", WITHOUT);
  const ev = JSON.parse(a.events).events.filter((e) => e.why === "manual");
  assert.deepEqual(ev.map((e) => [e.t, e.id]), [[2, "whoosh-cine"], [4, "tick-1"]]);
  assert.ok(ev.every((e) => e.dur > 0), "no zero-length clip");
  assert.doesNotMatch(a.html, /paper-quick|pen-short/);
  assert.equal(a.events, b.events, "sfx_events.json identical with and without the no-source entries");
  assert.equal(a.html, b.html, "index.html identical with and without the no-source entries");
});

test("clean (no sfxFallback) with the stray files: the ids are skipped with the no-entry warning, same bytes as without the entries", () => {
  const a = build("clean", WITH), b = build("clean", WITHOUT);
  assert.equal(JSON.parse(a.events).events.filter((e) => e.why === "manual").length, 0);
  assert.match(a.log, /paper-quick x1, pen-short x1/, "the warning names the bare ids, as for an id with no entry");
  assert.equal(a.events, b.events);
  assert.equal(a.html, b.html);
});

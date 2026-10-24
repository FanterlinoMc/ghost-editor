#!/usr/bin/env node
// node --test scripts/sfx-check.test.mjs
// mac-61: a sound id that resolves to no file must be loud somewhere. scripts/sfx_check.mjs is red (exit 1, one line per id)
// until every library/sfx id plays a file; SFX_STRICT=1 makes build.mjs exit 1 when a reel asks for a sound that plays
// nothing (without it the build warns and skips, as before). library/sfx/pack-map.json names, per id, the licensed pack
// file it comes from. Stub libraries are made in the OS temp folder with generated silent wavs; no audio is committed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check } from "./sfx_check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "library");
const CHECK = path.join(HERE, "sfx_check.mjs"), BUILD = path.join(HERE, "build.mjs");
const realMan = JSON.parse(fs.readFileSync(path.join(LIB, "sfx", "manifest.json"), "utf8"));
const realMap = JSON.parse(fs.readFileSync(path.join(LIB, "sfx", "pack-map.json"), "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-check-"));
process.on("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } });
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const wav = (p) => ff("-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.3", p);
let n = 0;
function stubLib(man, map, files) {
  const lib = path.join(root, `lib${n++}`);
  fs.mkdirSync(path.join(lib, "sfx"), { recursive: true }); fs.mkdirSync(path.join(lib, "music"), { recursive: true });
  fs.writeFileSync(path.join(lib, "sfx", "manifest.json"), JSON.stringify(man));
  fs.writeFileSync(path.join(lib, "sfx", "pack-map.json"), JSON.stringify(map));
  fs.copyFileSync(path.join(LIB, "sfx", "timing.json"), path.join(lib, "sfx", "timing.json"));
  fs.writeFileSync(path.join(lib, "music", "manifest.json"), "{}");
  for (const f of files) wav(path.join(lib, "sfx", f));
  return lib;
}
const MAN = { a: { file: "a.wav", role: "ui", duration: 0.3, peak_db: -1 }, b: { file: "b.wav", role: "whoosh", duration: 0.3, peak_db: -1 } };
const MAPPED = { ids: { a: { category: "clicks", packFile: "Sound Pack/a.wav" }, b: { category: "whooshes", packFile: "Sound Pack/b.wav" } } };

test("pack-map.json covers exactly the manifest's ids, names only, with the pack's licence line", () => {
  assert.deepEqual(Object.keys(realMap.ids).sort(), Object.keys(realMan).sort());
  assert.equal(realMap.pack, "editorsinventory");
  assert.match(realMap.licence, /Adish/);
  for (const [id, p] of Object.entries(realMap.ids)) {
    assert.ok(p.category === null || realMap.packCategories.includes(p.category), `${id}: category ${p.category} is a pack category`);
    assert.ok(p.packFile === null || (typeof p.packFile === "string" && !/^[a-z]+:\/\//i.test(p.packFile)), `${id}: packFile is a pack path, never a URL`);
  }
});

test("this repository holds no audio, so the real library is red with one line per id", () => {
  const r = spawnSync(process.execPath, [CHECK], { encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: LIB } });
  assert.equal(r.status, 1);
  const lines = r.stderr.split("\n").filter((l) => l.startsWith("SFX UNRESOLVED "));
  // an id with no pack file named is red on every machine, whatever is on disk
  const unnamed = Object.keys(realMan).filter((id) => !realMap.ids[id]?.packFile);
  for (const id of unnamed) assert.ok(lines.some((l) => l.startsWith(`SFX UNRESOLVED ${id}: `)), `${id} has its own line`);
  assert.match(r.stderr, /SFX UNRESOLVED impact-1: no pack category/);
  assert.match(r.stderr, /SFX UNRESOLVED whoosh-1: not mapped: pack category "whooshes"/);
});

test("every id mapped, measured and on disk: green", () => {
  const lib = stubLib(MAN, MAPPED, ["a.wav", "b.wav"]);
  assert.deepEqual(check({ lib }), { ids: 2, ok: ["a", "b"], bad: [] });
  assert.equal(spawnSync(process.execPath, [CHECK], { env: { ...process.env, PHANTASIC_LIB: lib } }).status, 0);
});

test("each way an id can play nothing is named", () => {
  const man = { ...MAN, c: { file: "c.wav", role: "ui", duration: null }, d: { file: "d.wav", role: "ui", duration: 0.3 }, e: { file: "e.wav", role: "ui", duration: 0.3 } };
  const map = { ids: { ...MAPPED.ids, c: { category: "clicks", packFile: "Sound Pack/c.wav" }, d: { category: "gears", packFile: null, proposal: "x" }, e: { category: null, packFile: null }, z: { category: null, packFile: null } } };
  const lib = stubLib(man, map, ["a.wav"]);
  const why = Object.fromEntries(check({ lib }).bad.map((b) => [b.id, b.why]));
  assert.match(why.b, /^file absent: library\/sfx\/b\.wav/);
  assert.match(why.c, /^not measured/);
  assert.match(why.d, /^not mapped: pack category "gears"/);
  assert.match(why.e, /^no pack category/);
  assert.match(why.z, /not in library\/sfx\/manifest\.json/);
  const pack = path.join(root, "pack"); fs.mkdirSync(path.join(pack, "Sound Pack"), { recursive: true });
  assert.match(check({ lib, pack }).bad.find((x) => x.id === "a").why, /^pack file absent: Sound Pack\/a\.wav/);
});

// a tiny reel asking for one present and one absent sound
const SEC = 4;
ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=30:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(root, "talk.mp4"));
function build(lib, env = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true }); fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: SEC, words: Array.from({ length: 8 }, (_, i) => ({ word: "word", start: 0.3 + i * 0.4, end: 0.55 + i * 0.4 })) }] }));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: [[0, 400, 1000, 340, 740, 560, 800]] }));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "strict", style: "clean", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: 30,
    takes: [{ a: 0, b: SEC }], outro: 0, music: null, sfx: [{ at: 0.5, id: "a" }, { at: 1.5, id: "b" }] }));
  const { SFX_STRICT, ...base } = process.env;
  return spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...base, PHANTASIC_LIB: lib, ...env } });
}

test("SFX_STRICT=1: a reel asking for a sound that plays nothing fails the build; without it the build warns as before", () => {
  const lib = stubLib(MAN, MAPPED, ["a.wav"]);
  const loose = build(lib);
  assert.equal(loose.status, 0, loose.stderr + loose.stdout);
  assert.match(loose.stdout, /1 sound\(s\) skipped, 1 id\(s\) unavailable: b \(b\.wav\) x1/);
  assert.doesNotMatch(loose.stderr, /SFX_STRICT/);
  const strict = build(lib, { SFX_STRICT: "1" });
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /SFX_STRICT: b \(b\.wav\) x1 plays nothing/);
  assert.doesNotMatch(strict.stderr, /SFX_STRICT: a /);
  const ok = build(stubLib(MAN, MAPPED, ["a.wav", "b.wav"]), { SFX_STRICT: "1" });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
});

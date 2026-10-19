#!/usr/bin/env node
// node --test scripts/sound-audit.test.mjs
// scripts/sound_audit.mjs reads only: the --audit walk finds every sound id a style names, --coverage reports which
// manifest ids have their file on disk, and .gitignore keeps every audio file and the licensed packs out of git.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { soundRefs, coverage } from "./sound_audit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("sound_audit --audit: soundRefs finds every sound id a style names", () => {
  const refs = soundRefs({
    sfxProfile: "restrained", sfxDb: -6,
    music: { id: "alif-match-b", fallback: "lo-fi-02", optional: true },
    pills: { sfx: "pop", sfxDb: -4 },
    sfxFallback: { "head-bang": "impact-1", "x-gone": "none" },
    drop: { riser: "my-riser", boom: false, cutSfx: "tech-camera-flash" },
    openFlash: { sfxIn: "burn-whoosh-fast", sfxOut: ["a", "b"] },
    beats: [{ sfx: "pack:s-hit" }, { sfx: "none" }],
    other: { music: { id: "auto" } },
  }).map((r) => `${r.kind} ${r.id} @${r.where}`).sort();
  assert.deepEqual(refs, [
    "music alif-match-b @music.id", "music lo-fi-02 @music.fallback",
    "pack pack:s-hit @beats.0.sfx",
    "sfx a @openFlash.sfxOut", "sfx b @openFlash.sfxOut", "sfx burn-whoosh-fast @openFlash.sfxIn",
    "sfx head-bang @sfxFallback key", "sfx impact-1 @sfxFallback.head-bang", "sfx my-riser @drop.riser",
    "sfx pop @pills.sfx", "sfx tech-camera-flash @drop.cutSfx", "sfx x-gone @sfxFallback key",
  ].sort());
});

test(".gitignore keeps every audio file and the licensed packs out of git", (t) => {
  const repo = path.join(HERE, "..");
  if (spawnSync("git", ["-C", repo, "rev-parse"], { stdio: "ignore" }).status !== 0) return t.skip("not a git checkout");
  const files = ["sfx/a.wav", "sfx/a.mp3", "sfx/a.m4a", "sfx/a.ogg", "sfx/a.flac", "sfx/a.aac", "sfx/a.wav.part",
    "music/a.mp3", "music/a.wav", "music/a.m4a", "music/a.ogg", "music/a.flac", "music/a.aac", "music/a.mp3.part",
    "packs/editorsinventory/leaks/a.mp4", "packs/editorsinventory/burns/b.mov"].map((f) => `library/${f}`);
  const r = spawnSync("git", ["-C", repo, "check-ignore", "--no-index", ...files], { encoding: "utf8" });
  const ignored = r.stdout.replace(/\r/g, "").split("\n").filter(Boolean).sort();
  assert.deepEqual(ignored, [...files].sort());
});

test("sound_audit --coverage: a manifest id counts only when its file is on disk", (t) => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "sound-audit-"));
  t.after(() => fs.rmSync(lib, { recursive: true, force: true }));
  for (const d of ["sfx", "music"]) fs.mkdirSync(path.join(lib, d));
  fs.writeFileSync(path.join(lib, "sfx", "manifest.json"), JSON.stringify({ a: { file: "a.wav" }, b: { file: "b.wav" } }));
  fs.writeFileSync(path.join(lib, "music", "manifest.json"), JSON.stringify({ bed: { file: "bed.mp3" } }));
  fs.writeFileSync(path.join(lib, "sfx", "a.wav"), "x");
  assert.deepEqual(coverage({ lib }).map((r) => `${r.kind} ${r.id} ${r.onDisk}`), ["sfx a true", "sfx b false", "music bed false"]);
});

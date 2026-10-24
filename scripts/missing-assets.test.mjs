#!/usr/bin/env node
// node --test scripts/missing-assets.test.mjs
// references/missing-assets.json is generated: it must equal `node scripts/missing_assets.mjs` byte for byte, so a style,
// manifest or engine change that adds or removes an asset reference (or moves one to another file) fails here until
// the file is regenerated. Moving a reference within a file does not (code sites carry no line numbers).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("references/missing-assets.json is what scripts/missing_assets.mjs prints", () => {
  const env = { ...process.env };
  delete env.PHANTASIC_LIB;   // the committed file describes the fork's own library/
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "missing_assets.mjs")], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const committed = fs.readFileSync(path.join(ROOT, "references", "missing-assets.json"), "utf8");
  assert.ok(r.stdout === committed, "references/missing-assets.json is stale: run node scripts/missing_assets.mjs > references/missing-assets.json");
});

// every sfx id a style or the engine names has a manifest entry (an id with no licensed file yet is an entry with source
// "none ...", listed under missing), except ids whose every code site checks the manifest first and plays another sound:
// adding one of those (vine-boom) would change which sound the build picks, so it stays out of the manifest
test("no sfx id is dangling except the guarded ones", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "missing_assets.mjs")], { cwd: ROOT, env: { ...process.env, PHANTASIC_LIB: "" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const sfx = JSON.parse(r.stdout).dangling.filter((d) => d.kind === "sfx");
  assert.deepEqual(sfx.filter((d) => !/every code site checks the manifest first/.test(d.effect)).map((d) => d.id), []);
  assert.deepEqual(sfx.map((d) => d.id), ["vine-boom"]);
});

test("the sound-line pattern matches riser / boom / tail only as whole keys (a `detail:` field is not a sound line)", () => {
  const src = fs.readFileSync(new URL("./missing_assets.mjs", import.meta.url), "utf8");
  const SOUND_LINE = eval(/^const SOUND_LINE = (\/.*\/);$/m.exec(src)[1]);
  for (const l of ['  detail: "no-room",', '{ thumbnail: "x" }', 'why: "a cocktail: x"']) assert.ok(!SOUND_LINE.test(l), l);
  for (const l of ['{ tail: "boom-1" }', '  boom: ["impact-1"],', 'riser: "cinematic-rumble-riser"', 'addSfx("whoosh-1")']) assert.ok(SOUND_LINE.test(l), l);
});

#!/usr/bin/env node
// node --test scripts/missing-assets.test.mjs
// references/missing-assets.json is generated: it must equal `node scripts/missing_assets.mjs` byte for byte, so a style,
// manifest or engine change that moves an asset reference fails here until the file is regenerated.
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

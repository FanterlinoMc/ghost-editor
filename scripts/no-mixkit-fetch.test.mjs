#!/usr/bin/env node
// node --test scripts/no-mixkit-fetch.test.mjs
// Mixkit is not used (library/SOURCES.md). Its download script, scripts/sfx_fetch.py, was removed and
// library_restore.py no longer fetches sound effects or music. This fails if either comes back: the script
// itself, anything that names or calls it, or a Mixkit download host anywhere outside the manifests (which
// keep their entries as records only).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/no-mixkit-fetch.test.mjs";
// records, not code: the manifests keep the Mixkit ids/urls the styles and tests name; SOURCES.md tells the story
const RECORDS = new Set(["library/sfx/manifest.json", "library/music/manifest.json", "library/SOURCES.md", SELF]);

function tracked() {
  const out = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\0").filter(Boolean);
}

function textOf(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null; // deleted in the work tree, or a submodule
  const b = fs.readFileSync(p);
  return b.includes(0) ? null : b.toString("utf8"); // skip binaries
}

// the checks, as a function of (path -> text), so the test below can prove they fire
export function offenders(files) {
  const bad = [];
  for (const [rel, t] of files) {
    if (RECORDS.has(rel) || t == null) continue;
    if (/sfx_fetch/.test(t)) bad.push(`${rel}: names sfx_fetch`);
    if (/mixkit\.co\b/i.test(t)) bad.push(`${rel}: names a Mixkit download host`);
  }
  return bad;
}

test("scripts/sfx_fetch.py is gone and not tracked", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "scripts", "sfx_fetch.py")), false);
  assert.equal(tracked().includes("scripts/sfx_fetch.py"), false);
});

test("no tracked file names sfx_fetch or a Mixkit download host (manifests and SOURCES.md excepted)", () => {
  const bad = offenders(tracked().map((rel) => [rel, textOf(rel)]));
  assert.deepEqual(bad, []);
});

test("library_restore.py downloads nothing: no curl, no urllib, no music url", () => {
  const t = fs.readFileSync(path.join(ROOT, "scripts", "library_restore.py"), "utf8");
  assert.doesNotMatch(t, /"curl"|urllib|urlopen|\["url"\]/);
});

test("the check fires: a caller, a doc line or a download URL is caught; the records are not", () => {
  const bad = offenders([
    ["scripts/x.py", 'subprocess.run([sys.executable, os.path.join(HERE, "sfx_fetch.py")])'],
    ["docs/X.md", "- Sounds: [Mixkit](https://mixkit.co/license/)"],
    ["scripts/y.mjs", 'fetch("https://assets.mixkit.co/active_storage/sfx/1/1-preview.mp3")'],
    ["library/music/manifest.json", '{"a": {"url": "https://assets.mixkit.co/music/1/1.mp3"}}'],
    ["scripts/z.py", "# Mixkit ids are kept as records"],
  ]);
  assert.deepEqual(bad, [
    "scripts/x.py: names sfx_fetch",
    "docs/X.md: names a Mixkit download host",
    "scripts/y.mjs: names a Mixkit download host",
  ]);
});

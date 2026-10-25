// node --test scripts/lib/caption-weak.test.mjs
// The engine's one weak-word list (mac-69): its shape, and that the JS and Python loaders read the same sets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WEAK, SWEAR, NEVER_KEY } from "./caption-weak.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(HERE, "caption-weak.json"), "utf8"));

test("the file: lower-case bare words, sorted, no duplicates", () => {
  for (const key of ["weak", "swear"]) {
    const xs = data[key];
    assert.ok(Array.isArray(xs) && xs.length > 0, key);
    assert.deepEqual(xs, [...new Set(xs)].sort(), `${key}: sorted and unique`);
    for (const w of xs) assert.match(w, /^[a-z]+(?:'[a-z]+)?$/, `${key}: ${w}`);
  }
  // taken verbatim from podcast_plan.py @5bd75fd; a change here is a decision, so it moves these numbers on purpose
  assert.equal(data.weak.length, 210);
  assert.equal(data.swear.length, 12);
});

test("the words the planner's old copy missed are in it", () => {
  for (const w of ["bullshit", "dick", "fucked", "piss", "fuck", "shit"]) assert.ok(NEVER_KEY.has(w), w);
  for (const w of ["anybody", "everybody", "somebody", "yes", "understanding", "actually", "you're"]) assert.ok(WEAK.has(w), w);
  assert.ok(!NEVER_KEY.has("money") && !NEVER_KEY.has("never"), "a real key word or a red word is not weak");
});

test("JS sets = the file; NEVER_KEY is the union", () => {
  assert.deepEqual([...WEAK].sort(), data.weak);
  assert.deepEqual([...SWEAR].sort(), data.swear);
  assert.equal(NEVER_KEY.size, new Set([...data.weak, ...data.swear]).size);
});

test("the Python loader reads the same sets", () => {
  const code = "import sys, json; sys.path.insert(0, sys.argv[1]); import caption_weak as c; " +
    "print(json.dumps([sorted(c.WEAK), sorted(c.SWEAR), len(c.NEVER_KEY)]))";
  const scripts = path.join(HERE, "..");
  // a missing python is a FAILURE here, not a skip: a check that finds nothing must not pass
  const tried = [];
  for (const py of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const r = spawnSync(py, ["-c", code, scripts], { encoding: "utf8" });
    tried.push(`${py}: ${r.error ? r.error.code : r.status}`);
    if (r.status !== 0) continue;
    const [w, s, n] = JSON.parse(r.stdout);
    assert.deepEqual(w, data.weak); assert.deepEqual(s, data.swear); assert.equal(n, NEVER_KEY.size);
    return;
  }
  assert.fail(`no python ran scripts/caption_weak.py (${tried.join(", ")})`);
});

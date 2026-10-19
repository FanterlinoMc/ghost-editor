#!/usr/bin/env node
// node --test scripts/export-public.test.mjs
// export_public.py refuses (exit 1, destination not written) when a committed sfx or music manifest entry has a source other
// than "none (needs a licensed source)" or "licensed pack: <name>" (library/SOURCES.md) - a `yt:` rip record or a third-party
// download URL must never reach the public edition. Runs against throwaway git repos in the OS temp folder, and checks that
// this repo's own HEAD passes. Needs git and any python 3 (stdlib only).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "export_public.py");
const python = ["python3", "py", "python"].find((c) => spawnSync(c, ["-c", "import sys; assert sys.version_info >= (3, 8)"], { stdio: "ignore" }).status === 0);
const NONE = "none (needs a licensed source)";

function repo(sfx, music) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "export-public-"));
  for (const [k, man] of [["sfx", sfx], ["music", music]]) {
    fs.mkdirSync(path.join(d, "library", k), { recursive: true });
    fs.writeFileSync(path.join(d, "library", k, "manifest.json"), JSON.stringify(man));
  }
  const git = (...a) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { stdio: "pipe" });
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "fixture");
  return d;
}
// imports export_public.py and runs main() with REPO pointed at the fixture repo
const HARNESS = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("export_public", sys.argv[1])
ep = importlib.util.module_from_spec(spec); spec.loader.exec_module(ep)
print(json.dumps(ep.manifest_problems(sys.argv[2])))
ep.REPO = sys.argv[2]
sys.argv = ["export_public.py", sys.argv[3]]
ep.main()
`;
const run = (repoDir, dest) => spawnSync(python, ["-c", HARNESS, SCRIPT, repoDir, dest], { encoding: "utf8" });

test("export_public.py refuses a manifest entry that is not no-source or the licensed pack, and writes nothing", { skip: !python && "no python 3" }, () => {
  const cases = [
    [{ a: { file: "a.wav", source: "yt:abc123" } }, {}, "sfx a yt: rip"],
    [{ a: { file: "a.wav", source: NONE } }, { bed: { file: "bed.mp3", source: "https://example.com/bed.mp3" } }, "music download URL"],
    [{ a: { file: "a.wav" } }, {}, "no source field"],
  ];
  for (const [sfx, music, label] of cases) {
    const d = repo(sfx, music), dest = path.join(d, "..", path.basename(d) + "-out");
    const r = run(d, dest);
    assert.equal(r.status, 1, `${label}: exit 1 (${r.stderr})`);
    assert.match(r.stderr, /refusing to export/, label);
    assert.equal(JSON.parse(r.stdout.trim()).length, 1, label);
    assert.equal(fs.existsSync(dest), false, `${label}: nothing written`);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("no-source and licensed-pack sources pass the check; so does this repo's HEAD", { skip: !python && "no python 3" }, () => {
  const d = repo({ a: { file: "a.wav", source: NONE }, b: { file: "b.wav", source: "licensed pack: some-pack" } }, { bed: { file: "bed.mp3", source: NONE } });
  const check = (repoDir) => JSON.parse(spawnSync(python, ["-c", `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("e",sys.argv[1]);e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
print(json.dumps(e.manifest_problems(sys.argv[2])))`, SCRIPT, repoDir], { encoding: "utf8" }).stdout);
  assert.deepEqual(check(d), []);
  assert.deepEqual(check(path.join(HERE, "..")), []);
  fs.rmSync(d, { recursive: true, force: true });
});

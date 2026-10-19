// node --test scripts/lib/direct-run.test.mjs
// Scripts that print or run only when executed directly must still do so through a symlinked path
// (macOS /tmp -> /private/tmp, or any linked checkout): the planner's test_designer_validate runs room.mjs this way.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "direct-run-")), "engine");
fs.symlinkSync(ROOT, link, process.platform === "win32" ? "junction" : "dir");   // a junction needs no admin rights on Windows
test.after(() => fs.rmSync(path.dirname(link), { recursive: true, force: true }));   // removes the link, never the repo it points to
const run = (rel) => execFileSync(process.execPath, [path.join(link, rel)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("room.mjs prints its JSON when run through a symlinked folder", () => {
  const spec = JSON.parse(run("scripts/lib/room.mjs"));
  assert.equal(spec.scale, 0.73);
});
test("room.mjs still prints nothing when imported", async () => {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(link, "scripts/lib/room.mjs")).href)})`], { encoding: "utf8" });
  assert.equal(out, "");
});

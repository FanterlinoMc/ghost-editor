// node --test scripts/lib/matte.test.mjs
// MATTE_THREADS: the parse, the onnxruntime preload (scripts/matte-ort-threads.cjs) and the build's check that it fired.
// No model: a fake onnxruntime-node and a stub tool stand in for hyperframes remove-background.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { matteThreads, cutMatteThreaded, writeAtomically, partPathOf, PRELOAD, MARK } from "./matte.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "matte-threads-test-"));
const p = (f) => path.join(root, f);
// a fake onnxruntime-node whose create() hands back the options it was given
fs.mkdirSync(p("node_modules/onnxruntime-node"), { recursive: true });
fs.writeFileSync(p("node_modules/onnxruntime-node/index.js"), "exports.InferenceSession = { create: async (p, o) => o };");
// the stub tool: STUB IN -o OUT. Loads the fake onnxruntime the way hyperframes does (require), creates a session,
// writes the options it got into OUT
fs.writeFileSync(p("stub.cjs"), `
const ort = require("onnxruntime-node");
const out = process.argv[process.argv.indexOf("-o") + 1];
ort.InferenceSession.create("m.onnx", { graphOptimizationLevel: "all" }).then((o) => require("fs").writeFileSync(out, JSON.stringify(o)));
`);
const tool = [process.execPath, [p("stub.cjs")]];

test("matteThreads: an integer >= 1, anything else is off", () => {
  for (const [v, n] of [["8", 8], [" 4 ", 4], ["1", 1], ["0", 0], ["-2", 0], ["2.5", 0], ["abc", 0], ["", 0], [undefined, 0], ["8x", 0]]) assert.equal(matteThreads(v), n, String(v));
});

test("MATTE_THREADS=4: onnxruntime gets 4 threads and no spinning, the patch says so, no warning", () => {
  const warns = [], out = p("a.json");
  const fired = cutMatteThreaded(tool, "in.mp4", out, { cwd: root, threads: 4, warn: (m) => warns.push(m) });
  assert.equal(fired, true);
  assert.deepEqual(warns, []);
  const o = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(o.intraOpNumThreads, 4);
  assert.equal(o.interOpNumThreads, 1);
  assert.equal(o.graphOptimizationLevel, "all");             // the tool's own options are kept
  assert.equal(o.extra.session.intra_op.allow_spinning, "0");
  // the line itself, as the tool's stderr carries it
  const r = spawnSync(process.execPath, ["-e", "require('onnxruntime-node').InferenceSession.create('m', {})"],
    { cwd: root, env: { ...process.env, MATTE_THREADS: "4", NODE_OPTIONS: `--require "${PRELOAD}"` }, encoding: "utf8" });
  assert.equal(r.stderr, "matte: onnxruntime 4 threads, spinning off\n");
});

test("a preload that does not take effect: the matte is still made, and the build is warned loudly", () => {
  const bogus = p("bogus.cjs").split(path.sep).join("/");
  fs.writeFileSync(bogus, "// does nothing, like the patch on an onnxruntime it no longer fits\n");
  const warns = [], out = p("b.json");
  const fired = cutMatteThreaded(tool, "in.mp4", out, { cwd: root, threads: 4, preload: bogus, warn: (m) => warns.push(m) });
  assert.equal(fired, false);
  assert.ok(fs.existsSync(out), "the tool still ran");
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).intraOpNumThreads, undefined);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^WARNING: MATTE_THREADS=4 .*speed-up is lost/);
});

test("the stderr line is MARK, and a failing tool still fails the build", () => {
  assert.equal(MARK, "matte: onnxruntime");
  fs.writeFileSync(p("fail.cjs"), "process.stderr.write('boom'); process.exit(3);");
  assert.throws(() => cutMatteThreaded([process.execPath, [p("fail.cjs")]], "in.mp4", p("c.json"), { cwd: root, threads: 2 }), /exited 3: boom/);
  assert.throws(() => cutMatteThreaded(tool, "in.mp4", p("d.json"), { cwd: root, threads: 0 }), /threads must be >= 1/);
});

test("build.mjs: unset MATTE_THREADS keeps the direct remove-background call, into the .part file", () => {
  const b = fs.readFileSync(path.join(path.dirname(PRELOAD), "build.mjs"), "utf8");
  assert.ok(b.includes("const threads = matteThreads();"));
  assert.ok(b.includes("writeAtomically(mp, (out) => {"));
  assert.ok(b.includes('else execFileSync(npx[0], [...npx[1], "hyperframes@0.8.81", "remove-background", path.resolve(proj, s), "-o", out], { stdio: ["ignore", "ignore", "pipe"], cwd: proj, maxBuffer: 1 << 28 });'));
});

test("writeAtomically: a finished matte arrives byte for byte; a killed one leaves nothing that looks cached", () => {
  const mp = p("talk-matte.webm");
  assert.equal(partPathOf(mp), p("talk-matte.part.webm"));
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) & 255));
  writeAtomically(mp, (out) => { assert.ok(out.endsWith(".webm")); fs.writeFileSync(out, bytes); });
  assert.ok(fs.readFileSync(mp).equals(bytes));
  assert.equal(fs.existsSync(partPathOf(mp)), false);
  const mp2 = p("other-matte.webm");
  fs.writeFileSync(partPathOf(mp2), "stale");                 // left by an earlier killed build: replaced, not appended to
  assert.throws(() => writeAtomically(mp2, (out) => { fs.appendFileSync(out, bytes.subarray(0, 100)); throw new Error("killed"); }), /killed/);
  assert.equal(fs.existsSync(mp2), false);
  assert.equal(fs.readFileSync(partPathOf(mp2)).length, 100);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

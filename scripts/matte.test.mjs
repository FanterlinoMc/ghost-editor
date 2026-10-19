// node --test scripts/matte.test.mjs
// The chunked matte (scripts/matte.mjs, MATTE_JOBS > 1) against a single run, with the model stubbed: the stub stands in
// for `hyperframes remove-background` (same decoder, same encoder commands, a made-up per-pixel mask instead of
// u2net), so the split / mask hand-back / final encode are tested on a 2 s 64x112 clip in seconds, with no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cutMatte, planChunks, encoderArgs, decoderArgs } from "./matte.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "matte-test-"));
const p = (f) => path.join(root, f);
const MATTE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "matte.mjs");

// The stub tool: STUB IN -o OUT. DROP=1 makes it lose the last frame (a broken tool the chunked path must catch).
const STUB = p("stub.mjs");
fs.writeFileSync(STUB, `
import { spawn, execFileSync } from "node:child_process";
import { encoderArgs, decoderArgs, probe } from ${JSON.stringify("file:///" + MATTE.split(path.sep).join("/"))};
const [src, , out] = process.argv.slice(2);
const { w, h, fps } = probe(src);
const fmt = out.endsWith(".webm") ? "webm" : "mov";
const enc = spawn("ffmpeg", ["-loglevel", "error", ...encoderArgs(fmt, w, h, fps, out, { renderer: "hyperframes", version: "0.8.81" })], { stdio: ["pipe", "ignore", "inherit"] });
const dec = spawn("ffmpeg", decoderArgs(src), { stdio: ["ignore", "pipe", "inherit"] });
let buf = Buffer.alloc(0), held = null;
const size = w * h * 3;
const emit = (f) => { const o = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) { o[i*4] = f[i*3]; o[i*4+1] = f[i*3+1]; o[i*4+2] = f[i*3+2]; o[i*4+3] = (f[i*3] * 7 + f[i*3+1] * 3 + f[i*3+2] + i) & 255; } enc.stdin.write(o); };
dec.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); while (buf.length >= size) { if (held) emit(held); held = Buffer.from(buf.subarray(0, size)); buf = buf.subarray(size); } });
dec.on("exit", () => { if (held && process.env.DROP !== "1") emit(held); enc.stdin.end(); });
enc.on("exit", (c) => process.exit(c));
`);
const tool = [process.execPath, [STUB]];
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
// decoded RGBA (alpha included) per frame, or with copy = true the coded packets per frame (the VP9 bitstream itself)
const md5s = (f, copy) => execFileSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", f, ...(copy ? ["-c", "copy"] : ["-pix_fmt", "rgba"]), "-f", "framemd5", "-"]).toString()
  .split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").map((x) => x.trim()));

const SRC = p("src.mp4");
ff("-f", "lavfi", "-i", "testsrc=size=64x112:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", SRC);
const SINGLE = p("single.webm");
execFileSync(tool[0], [...tool[1], SRC, "-o", SINGLE]);

test("planChunks: contiguous, in order, balanced, never more chunks than frames", () => {
  assert.deepEqual(planChunks(10, 3), [[0, 4], [4, 3], [7, 3]]);
  assert.deepEqual(planChunks(60, 1), [[0, 60]]);
  assert.deepEqual(planChunks(2, 6), [[0, 1], [1, 1]]);
  for (const [t, n] of [[300, 4], [1801, 6], [7, 7]]) {
    const c = planChunks(t, n);
    assert.equal(c.reduce((s, [, k]) => s + k, 0), t);
    c.forEach(([s], i) => i && assert.equal(s, c[i - 1][0] + c[i - 1][1]));
  }
});

test("encoderArgs reproduces the tool's webm command (hyperframes 0.8.81 buildEncoderArgs)", () => {
  assert.deepEqual(encoderArgs("webm", 1080, 1920, 30, "o.webm", { renderer: "hyperframes", version: "0.8.81" }).join(" "),
    "-y -f rawvideo -pix_fmt rgba -s 1080x1920 -r 30 -i - -c:v libvpx-vp9 -b:v 0 -crf 18 -deadline good -row-mt 1 -cpu-used 4 -auto-alt-ref 0 " +
    "-pix_fmt yuva420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -metadata:s:v:0 alpha_mode=1 -an " +
    "-metadata hyperframes_renderer=hyperframes -metadata hyperframes_version=0.8.81 o.webm");
});

for (const jobs of [2, 3, 7]) {
  test(`MATTE_JOBS=${jobs}: same frame count and every decoded RGBA frame identical to one run`, async () => {
    const out = p(`chunked-${jobs}.webm`);
    const r = await cutMatte(SRC, out, { jobs, tool, tmp: root });
    assert.equal(r.frames, 60);
    assert.equal(r.chunks, jobs);
    const a = md5s(SINGLE), b = md5s(out);
    assert.equal(b.length, a.length);
    assert.deepEqual(b, a);                                   // pts, duration, size and md5 of every frame
    // the coded packets too. (The files themselves differ in the random Matroska TrackUID, as two single runs do.)
    assert.deepEqual(md5s(out, true), md5s(SINGLE, true));
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.startsWith("matte-")), [], "temp folder removed");
  });
}

test("a chunk that comes back a frame short is fatal, and leaves no output", async () => {
  const out = p("short.webm");
  process.env.DROP = "1";
  try { await assert.rejects(cutMatte(SRC, out, { jobs: 2, tool, tmp: root }), /came back with 29 frames, 30 went in/); }
  finally { delete process.env.DROP; }
  assert.equal(fs.existsSync(out), false);
});

test("MATTE_JOBS unset: build.mjs still runs the tool directly (the chunked path is opt-in)", () => {
  const b = fs.readFileSync(path.join(path.dirname(MATTE), "build.mjs"), "utf8");
  assert.ok(b.includes("MATTE_JOBS"), "build.mjs reads MATTE_JOBS");
  assert.ok(b.includes('"hyperframes@0.8.81", "remove-background", path.resolve(proj, s), "-o", mp]'), "the direct single-process call is still there");
});

test.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

test("MATTE_THREADS: the tool gets the onnxruntime preload; unset leaves its environment alone", async () => {
  const { toolEnv } = await import("./matte.mjs");
  assert.equal(toolEnv(0), undefined);
  const e = toolEnv(4);
  assert.equal(e.MATTE_THREADS, "4");
  assert.match(e.NODE_OPTIONS, /--require ".*matte-ort-threads\.cjs"/);
  // the preload itself: injects the thread count and turns spinning off when the tool creates its session
  const fake = p("node_modules/onnxruntime-node");
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, "index.js"), "exports.InferenceSession = { create: async (p, o) => o };");
  const out = execFileSync(process.execPath, ["-e", "require('onnxruntime-node').InferenceSession.create('m', {graphOptimizationLevel:'all'}).then(o => console.log(JSON.stringify(o)))"],
    { cwd: root, env: e }).toString();
  const o = JSON.parse(out);
  assert.equal(o.intraOpNumThreads, 4);
  assert.equal(o.graphOptimizationLevel, "all");
  assert.equal(o.extra.session.intra_op.allow_spinning, "0");
});

test("jobs 1: one tool run straight to the output", async () => {
  const out = p("one.webm");
  await cutMatte(SRC, out, { jobs: 1, tool, tmp: root });
  assert.deepEqual(md5s(out), md5s(SINGLE));
});

test("pinFor: Linux chunks get disjoint CPU slices; other systems and no taskset get nothing", async () => {
  const { pinFor } = await import("./matte.mjs");
  const o = { platform: "linux", cpus: 8, hasTaskset: true };
  assert.deepEqual([0, 1].map((k) => pinFor(k, 2, o)), [["taskset", "-c", "0-3"], ["taskset", "-c", "4-7"]]);
  assert.deepEqual([0, 1, 2].map((k) => pinFor(k, 3, o)[2]), ["0-1", "2-3", "4-5"]);
  assert.deepEqual(pinFor(0, 12, o), ["taskset", "-c", "0-0"]);
  assert.deepEqual(pinFor(0, 2, { ...o, platform: "win32" }), []);
  assert.deepEqual(pinFor(0, 2, { ...o, platform: "darwin" }), []);
  assert.deepEqual(pinFor(0, 2, { ...o, hasTaskset: false }), []);
});

// node --test scripts/lib/graphic-place.test.mjs
// PM3 placement helpers without a build: a graphic beat's resolution (defaults, warnings, problems), the GW7 UI-zone
// test, and prepareGraphics' one-render-per-placement rule (with renderGraphic injected: no render).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGraphicBeat, prepareGraphics, crossesUi, centredBox, testDeps, FIXTURES_DIR, STUB_CHROME } from "./graphic-place.mjs";
import { reason } from "./graphic.mjs";
import { PLATFORMS } from "./safezone.mjs";

const meta = { duration: 2, size: { w: 1080, h: 1080 }, fonts: [], media: [] };
const ok = { ok: true, reasons: [], meta };
const ctx = { out: (t) => (typeof t === "number" ? t + 10 : (() => { throw new Error("E(x): not inside any take"); })()), fps: 30, W: 1080, H: 1920 };
const H = "assets/graphics/c.html";

test("a graphic beat: to defaults to at + the graphic's window from in; box centred; overlay keeps captions; warnings prefixed", () => {
  const g = resolveGraphicBeat({ type: "graphic", id: "k", html: H, at: 1, in: 0.5, audio: "mix", fps: 25 }, ok, ctx);
  assert.equal(g.problem, undefined);
  assert.deepEqual([g.t0, g.t1, g.L, g.inF, g.D, g.after, g.mode, g.fit, g.hideCaptions], [11, 12.5, 45, 15, 60, "hold", "overlay", "contain", false]);
  assert.deepEqual(g.box, centredBox(meta.size, 1080, 1920));
  assert.deepEqual(g.warnings, [`graphic k: ${reason("GW5")}`, `graphic k: ${reason("GW6")}`]);
  const ins = resolveGraphicBeat({ type: "graphic", at: 1, to: 4, html: H, mode: "insert", box: { x: 0, y: 0, w: 9, h: 9 }, after: "bounce" }, ok, ctx);
  assert.deepEqual([ins.box, ins.hideCaptions, ins.L, ins.after], [{ x: 0, y: 0, w: 1080, h: 1920 }, true, 90, "hold"]);
  assert.deepEqual(ins.warnings, [`graphic 1: ${reason("GW3", { v: "bounce" })}`, `graphic 1: ${reason("GW4")}`]);
});

test("a graphic beat's problems: the first one, worded as a dropped beat", () => {
  const P = (b, insp = ok) => resolveGraphicBeat({ type: "graphic", html: H, at: 1, ...b }, insp, ctx).problem;
  assert.equal(P({}, { ok: false, reasons: ["graphic file x does not exist"] }), `graphic 1: ${H}: graphic file x does not exist, dropped`);
  assert.equal(P({ id: "m", mode: "full" }), `graphic m: ${H}: ${reason("P1", { v: "full" })}, dropped`);
  assert.equal(P({ to: 1.05 }), `graphic 1: ${H}: ${reason("P2", { s: 0.05 })}, dropped`);
  assert.equal(P({ box: { x: 2000, y: 0, w: 100, h: 100 } }), `graphic 1: ${H}: ${reason("P3", { W: 1080, H: 1920 })}, dropped`);
  assert.equal(P({ fit: "fill" }), `graphic 1: ${H}: fit must be one of cover|contain, got "fill", dropped`);
  assert.equal(P({ at: "hold:9" }), `graphic "hold:9": ${H}: E(x): not inside any take, dropped`);
});

test("GW7: a box crossing the platform UI zone", () => {
  const ig = PLATFORMS.instagram;
  assert.equal(crossesUi({ x: 100, y: 300, w: 600, h: 600 }, ig, 1080, 1920), false);
  assert.equal(crossesUi({ x: 100, y: 200, w: 600, h: 600 }, ig, 1080, 1920), true, "into the top band");
  assert.equal(crossesUi({ x: 100, y: 1000, w: 600, h: 600 }, ig, 1080, 1920), true, "into the bottom band");
  assert.equal(crossesUi({ x: 400, y: 300, w: 600, h: 600 }, ig, 1080, 1920), true, "into the right column");
});

test("prepareGraphics: one render per distinct placement, results in job order, files project-relative", async () => {
  const calls = [];
  const render = async (o) => { calls.push(o); return { ok: o.mode !== "insert", file: `/p/assets/graphics/c-${o.frames}.webm`, key: `k${o.frames}`, cached: false, reasons: o.mode === "insert" ? ["refused"] : [], codes: [] }; };
  const j = (L, mode = "overlay") => ({ html: H, mode, L, inF: 0, after: "hold" });
  const res = await prepareGraphics([j(60), j(90), j(60), j(60, "insert")], { proj: "/p", W: 1080, H: 1920, fps: 30, render });
  assert.equal(calls.length, 3, "the repeated placement is rendered once");
  assert.deepEqual(calls.map((c) => [c.frames, c.inS, c.after, c.mode]), [[60, 0, "hold", "overlay"], [90, 0, "hold", "overlay"], [60, 0, "hold", "insert"]]);
  assert.deepEqual(res.map((r) => [r.ok, r.file]), [[true, "assets/graphics/c-60.webm"], [true, "assets/graphics/c-90.webm"], [true, "assets/graphics/c-60.webm"], [false, null]]);
  assert.equal(res[0], res[2], "the same result object");
});

test("a beat's P2 when its source window cannot be read: on the output window after mapping", () => {
  const out = (x) => (typeof x === "number" ? x + 10 : x === "end" ? 200 : x && x.src === "b" ? x.t : x.t + 10);
  const c = { ...ctx, out };
  const P = (b) => resolveGraphicBeat({ type: "graphic", html: H, ...b }, ok, c).problem;
  assert.equal(P({ at: 1, to: "end" }), `graphic 1: ${H}: ${reason("P2", { s: 189 })}, dropped`, "to: end -> 189 s of output");
  // two recordings: 1..5 reads as 4 s of source, but the output window is 5 - 11 = -6 s
  assert.equal(P({ at: { src: "a", t: 1 }, to: { src: "b", t: 5 } }), `graphic {"src":"a","t":1}: ${H}: ${reason("P2", { s: -6 })}, dropped`);
  assert.equal(P({ at: { src: "a", t: 1 }, to: { src: "a", t: 5 } }), undefined, "the same recording: the 4 s source window");
  // 1..65 would read as 64 s (over 60) if the two recordings were subtracted; the output window is 65 - 11 = 54 s: placed
  assert.equal(P({ at: { src: "a", t: 1 }, to: { src: "b", t: 65 } }), undefined, "two recordings: never a source window");
});

test("testDeps: only under node --test, only scripts/fixtures/, Chrome version forced to the stub's", async () => {
  const stub = path.join(FIXTURES_DIR, "graphic-realver-deps.mjs");
  assert.deepEqual(await testDeps({ GRAPHIC_TEST_DEPS: stub }), {}, "no NODE_TEST_CONTEXT: ignored");
  const d = await testDeps({ GRAPHIC_TEST_DEPS: stub, NODE_TEST_CONTEXT: "child-v8" });
  assert.equal(d.chromeVersion(), STUB_CHROME, "the module's real Chrome version is overridden");
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gdeps-")), "graphic-stub-deps.mjs");
  fs.copyFileSync(path.join(FIXTURES_DIR, "graphic-stub-deps.mjs"), outside);
  await assert.rejects(testDeps({ GRAPHIC_TEST_DEPS: outside, NODE_TEST_CONTEXT: "child-v8" }), /must name a module inside/);
  // a symlink inside scripts/fixtures/ that points outside is judged by its realpath
  if (process.platform === "win32") return;   // symlinks need privileges there
  const link = path.join(FIXTURES_DIR, ".graphic-link-test.mjs");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(outside, link);
  try { await assert.rejects(testDeps({ GRAPHIC_TEST_DEPS: link, NODE_TEST_CONTEXT: "child-v8" }), /must name a module inside/); }
  finally { fs.rmSync(link, { force: true }); }
});

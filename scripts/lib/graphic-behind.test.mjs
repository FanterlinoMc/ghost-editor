// mac-62: graphic mode "behind" (references/reel-json.md "Behind the speaker"): the placer, the contract exemption,
// the layer refusal and the frame-keyed cut-out cache (lib/matte-cache.mjs). The build itself: scripts/graphic-behind.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGraphicBeat, BEAT_MODES, MODES, renderMode } from "./graphic-place.mjs";
import { checkContractCoded, checkPlacement, reason } from "./graphic.mjs";
import { resolveLayers } from "./layers.mjs";
import * as MC from "./matte-cache.mjs";

const meta = { duration: 2, size: { w: 1080, h: 1920 }, fonts: [], media: [] };
const ok = { ok: true, reasons: [], meta };
const ctx = { out: (t) => t, fps: 30, W: 1080, H: 1920 };
const H = "assets/graphics/w.html";

test("behind is a beat mode, rendered as an overlay; the default box is the whole canvas", () => {
  assert.deepEqual(MODES, ["overlay", "insert"]);
  assert.deepEqual(BEAT_MODES, ["overlay", "insert", "behind"]);
  assert.deepEqual(["overlay", "insert", "behind"].map(renderMode), ["overlay", "insert", "overlay"]);
  const g = resolveGraphicBeat({ type: "graphic", html: H, at: 1, to: 3, mode: "behind" }, ok, ctx);
  assert.equal(g.problem, undefined);
  assert.deepEqual([g.mode, g.box, g.fit, g.hideCaptions, g.L], ["behind", { x: 0, y: 0, w: 1080, h: 1920 }, "contain", false, 60]);
  // a box is placed like an overlay's: P3 still applies, larger than the canvas is fine
  const big = resolveGraphicBeat({ type: "graphic", html: H, at: 1, to: 3, mode: "behind", box: { x: -100, y: -100, w: 1280, h: 2120 } }, ok, ctx);
  assert.deepEqual(big.box, { x: -100, y: -100, w: 1280, h: 2120 });
  const off = resolveGraphicBeat({ type: "graphic", html: H, at: 1, to: 3, mode: "behind", box: { x: 2000, y: 0, w: 100, h: 100 } }, ok, ctx);
  assert.match(off.problem, /shows less than 20% inside/);
  assert.deepEqual(checkPlacement({ mode: "behind", box: { x: 0, y: 0, w: 1080, h: 1920 } }), []);
});

test("behind is exempt from P4 (face) and P5 (captions) by construction; P6 still applies", () => {
  const face = { left: 300, top: 600, right: 780, bottom: 1200 };
  const geo = { faceAt: () => face, band: () => ({ top: 1300, bottom: 1500 }), capH: 128, total: 20, others: [] };
  const full = { box: { x: 0, y: 0, w: 1080, h: 1920 }, t0: 1, t1: 3 };
  assert.equal(checkContractCoded({ ...full, mode: "overlay" }, geo)[0].code, "P4");
  assert.deepEqual(checkContractCoded({ ...full, mode: "behind" }, geo), []);
  const p6 = checkContractCoded({ ...full, mode: "behind" }, { ...geo, others: [{ kind: "popcard beat", s: 2, e: 4 }] });
  assert.equal(p6[0].code, "P6");
});

test("a graphic layer cannot be behind", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "behind-layer-"));
  try {
    fs.mkdirSync(path.join(dir, "assets", "graphics"), { recursive: true });
    const r = (() => { try { return resolveLayers([{ id: "w", kind: "graphic", html: H, mode: "behind", pin: "start", at: 0, dur: 2 }], { takes: [{ start: 0, dur: 10 }], total: 10, fps: 30, W: 1080, H: 1920, graphic: () => ok }); } catch (e) { return e; } })();
    const text = r instanceof Error ? r.message : JSON.stringify(r);
    assert.match(text, /graphic mode 'behind' is a beat mode only/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the cut-out cache: margins, merging, reuse and splitting across files", () => {
  // two spans that overlap once the margin is added are one run; nothing cached: all cut
  const p1 = MC.planCuts([[100, 160], [162, 200]], []);
  assert.deepEqual(p1.cut, [[98, 202]]);
  assert.deepEqual(p1.frames, { needed: 104, cut: 104, reused: 0 });
  // the same spans again: nothing to cut
  assert.deepEqual(MC.planCuts([[100, 160], [162, 200]], [{ a: 98, b: 202 }]).frames, { needed: 104, cut: 0, reused: 104 });
  // a span moved 30 frames later: only the new frames are cut
  const moved = MC.planCuts([[130, 230]], [{ a: 98, b: 202 }]);
  assert.deepEqual(moved.cut, [[202, 232]]);
  assert.deepEqual(moved.frames, { needed: 104, cut: 30, reused: 74 });
  // clamped to the recording
  assert.deepEqual(MC.planCuts([[0, 10]], [], { total: 11 }).cut, [[0, 11]]);
  // a piece over two files: consecutive pieces, the file reaching furthest first
  assert.deepEqual(MC.splitAcross(120, 225, [{ a: 98, b: 202 }, { a: 202, b: 232 }]).map(({ a, b, file }) => [a, b, file.a]), [[120, 202, 98], [202, 225, 202]]);
  assert.equal(MC.splitAcross(120, 240, [{ a: 98, b: 202 }]), null);
  assert.deepEqual(MC.missingRanges([[0, 10]], [{ a: 2, b: 4 }, { a: 6, b: 8 }]), [[0, 2], [4, 6], [8, 10]]);
});

test("the cache lists finished files only, and its key follows the recording and the fps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matte-cache-"));
  try {
    for (const n of ["f10-20.webm", "f5-8.webm", "f30-40.part.webm", "f9-9.webm", "notes.txt"]) fs.writeFileSync(path.join(dir, n), "");
    assert.deepEqual(MC.listCached(dir).map((c) => c.name), ["f5-8.webm", "f10-20.webm"]);
    const f = path.join(dir, "rec.mp4");
    fs.writeFileSync(f, Buffer.alloc(3 << 20, 1));
    const k = MC.srcKey(f, 30);
    assert.match(k, /^[0-9a-f]{16}$/);
    assert.notEqual(MC.srcKey(f, 25), k);
    const b = fs.readFileSync(f); b[b.length - 1] = 2; fs.writeFileSync(f, b);
    assert.notEqual(MC.srcKey(f, 30), k);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

#!/usr/bin/env node
// The Lottie element (references/reel-json.md, "Lottie element"; lib/lottie.mjs + lib/motion-graphics.mjs):
//
//   node --test scripts/lottie.test.mjs
//
// - a real build of a reel with two Lottie elements: the player tag, ONE inlined copy of the file, the frame
//   drivers, the player named by its vendored URL; the same reel without them has no trace of Lottie
// - the frame driver itself, run in a sandbox against a recording fake player: whole frames, start, speed, hold, loop
// - every source problem the spec lists: dropped with its exact warning in a beat, a die() in a motion layer
// - the field warnings W1..W7 and their fallbacks
// The fixture animation is hand-written (motion-fixture.mjs LOTTIE_FIXTURE); no third-party file is used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { compileMotion } from "./lib/motion-graphics.mjs";
import { makeLottieResolver, lottieHead, inspectLottie, LOTTIE_URL, LOTTIE_MAX_BYTES } from "./lib/lottie.mjs";
import { renderLayer } from "./lib/layers.mjs";
import { makeProject, LOTTIE_BEAT, LOTTIE_FIXTURE, LOTTIE_FILE } from "./lib/motion-fixture.mjs";
import { LIBRARIES, VENDOR, PRELOAD, MARK } from "./lib/vendor.mjs";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lottie-test-"));
const FIX = JSON.stringify(LOTTIE_FIXTURE);
const clone = () => structuredClone(LOTTIE_FIXTURE);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// a project dir with assets/lottie/<name>.json files, for the resolver
function proj(files) {
  const d = fs.mkdtempSync(path.join(tmp, "p-"));
  for (const [n, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(d, "assets", "lottie"), { recursive: true });
    fs.writeFileSync(path.join(d, "assets", "lottie", n), typeof body === "string" ? body : JSON.stringify(body));
  }
  return d;
}
const SAFE = { top: 220, bottom: 420, right: 130, name: "Instagram Reels" };
const el = (o = {}) => ({ id: "anim", shape: "lottie", src: "assets/lottie/move.json", x: 340, y: 300, w: 400, h: 400, ...o });
const beat = (els) => ({ type: "motion", id: "m1", elements: els, tweens: [] });
const ctxFor = (dir, extra = {}) => ({ id: "b0", t0: 2, t1: 8, W: 1080, H: 1920, brand: {}, resolveImage: () => null, resolveLottie: makeLottieResolver(dir, path.join(dir, "lib")), safe: SAFE, ...extra });

// ---------------------------------------------------------------------------------------------------------------
test("a reel with Lottie elements: player tag, one inlined file, two drivers, a vendored player URL", () => {
  const dir = path.join(tmp, "build");
  const p = makeProject(dir, { beat: LOTTIE_BEAT, files: { [LOTTIE_FILE]: LOTTIE_FIXTURE } });
  const html = fs.readFileSync(p.html, "utf8");
  assert.equal(html.split(`<script src="${LOTTIE_URL}"></script>`).length - 1, 1, "the player is loaded once");
  const data = [...html.matchAll(/<script type="application\/json" id="(lottie-[0-9a-f]{12})">([^<]*)<\/script>/g)];
  assert.equal(data.length, 1, "two elements of one file share one inlined copy");
  assert.deepEqual(JSON.parse(data[0][2]), LOTTIE_FIXTURE, "the inlined data is the file");
  assert.equal(data[0][1], `lottie-${sha(FIX).slice(0, 12)}`);
  assert.ok(html.indexOf(LOTTIE_URL) < html.indexOf("const tl = gsap.timeline"), "the player loads before the timeline script");
  // HyperFrames' own Lottie adapter drives whatever window.lottie has registered from the composition time: the page
  // moves the player off that global right after loading it, so the timeline stays the only clock
  assert.ok(html.includes(`<script src="${LOTTIE_URL}"></script>\n<script>window.__geLottie = window.lottie; delete window.lottie; delete window.bodymovin;</script>`));
  assert.ok(!/[^_.]lottie\.loadAnimation/.test(html), "nothing registers through window.lottie");
  for (const id of ["once", "loopy"]) {
    assert.match(html, new RegExp(`<div id="b0-${id}-l" style="position:absolute;left:0;top:0;width:100%;height:100%"></div>`));
    assert.match(html, new RegExp(`__geLottie\\.loadAnimation\\(\\{ container: document\\.getElementById\\("b0-${id}-l"\\), renderer: "svg", loop: false, autoplay: false, animationData: JSON\\.parse\\(document\\.getElementById\\("${data[0][1]}"\\)\\.textContent\\)`));
  }
  assert.ok(html.includes("const go = (e) => { const p = Math.floor(Math.max(0, e) * 45 + 1e-3); a.goToAndStop(0 + Math.min(p, 59), true); return e; };"), "once: 30 fps x 1.5, holds frame 59");
  assert.ok(html.includes("const go = (e) => { const p = Math.floor(Math.max(0, e) * 30 + 1e-3); a.goToAndStop(0 + p % 60, true); return e; };"), "loopy: 30 fps, wraps at 60");
  assert.ok(html.includes(`tl.fromTo(o, { e: 0 }, { e: 5.5, duration: 5.5, ease: "none", immediateRender: false, modifiers: { e: go } }, 2.5);`), "once starts 0.5 s into the beat");
  assert.ok(html.includes(`tl.fromTo(o, { e: 0 }, { e: 6, duration: 6, ease: "none", immediateRender: false, modifiers: { e: go } }, 2);`), "loopy starts with the beat");
  assert.ok(!/autoplay: true|loop: true|\.play\(/.test(html), "the player never runs its own clock");
  const lw = LIBRARIES.find((x) => x.name === "lottie-web");
  assert.equal(lw.url, LOTTIE_URL, "the page's player URL is a vendored one (the render serves it from vendor/)");
  assert.equal(sha(fs.readFileSync(path.join(VENDOR, lw.file))), lw.sha256, "the fork's copy matches its manifest");
  assert.ok(fs.existsSync(path.join(VENDOR, lw.license)), "the licence ships with the file");
  assert.ok(!/lottie (src|file|box|fit|start|speed|loop|frames)|lottie elements are used/.test(p.log), "the fixture builds without lottie warnings");

  // opt-in: the same reel with no Lottie element carries no player, no data, no driver, no copy
  const dir2 = path.join(tmp, "build-none");
  const q = makeProject(dir2, { beat: { ...LOTTIE_BEAT, elements: [{ id: "t", shape: "text", x: 100, y: 400, w: 800, h: 200, text: "Plain text" }], tweens: [] }, files: { [LOTTIE_FILE]: LOTTIE_FIXTURE } });
  const html2 = fs.readFileSync(q.html, "utf8");
  assert.ok(!/lottie/i.test(html2), "no trace of lottie in a reel without the element");
});

// ---------------------------------------------------------------------------------------------------------------
// run a compiled graphic's lines against a fake player and a fake timeline; returns the driver(s)
function drive(r) {
  const anims = [], tweens = [];
  const sandbox = {
    window: {}, JSON, Math,
    document: { getElementById: (id) => (id.startsWith("lottie-") ? { textContent: FIX } : { id }) },
    __geLottie: { loadAnimation: (o) => { const a = { o, sub: null, frames: [], setSubframe(v) { this.sub = v; }, goToAndStop(f, isFrame) { this.frames.push([f, isFrame]); } }; anims.push(a); return a; } },
    tl: { fromTo: (t, from, to, at) => { if (to?.modifiers?.e) tweens.push({ t, from, to, at }); }, set() {} },
    ft() {},
  };
  vm.runInNewContext(r.lines.join("\n"), sandbox);   // every line the graphic puts on the page timeline
  return { anims, tweens };
}

test("the frame driver: whole frames, start, speed, hold, loop, frames segment", () => {
  const dir = proj({ "move.json": LOTTIE_FIXTURE });
  const r = compileMotion(beat([
    el({ id: "a", start: 0.5, speed: 1.5 }),
    el({ id: "b", y: 900, loop: true, frames: [10, 40] }),
    el({ id: "c", y: 1300, fit: "cover", speed: 0.5 }),
  ]), ctxFor(dir));
  assert.ok(r.ok, r.reason);
  const { anims, tweens } = drive(r);
  assert.equal(anims.length, 3);
  for (const a of anims) {
    assert.equal(a.o.renderer, "svg"); assert.equal(a.o.autoplay, false); assert.equal(a.o.loop, false); assert.equal(a.sub, false);
    assert.deepEqual(a.o.animationData, LOTTIE_FIXTURE);
    assert.deepEqual(a.frames[0], [a === anims[1] ? 10 : 0, true], "go(0) shows the first frame at load");
  }
  assert.equal(anims[2].o.rendererSettings.preserveAspectRatio, "xMidYMid slice", "cover");
  assert.equal(anims[0].o.rendererSettings.preserveAspectRatio, "xMidYMid meet", "contain (default)");
  const at = (i, e) => { anims[i].frames.length = 0; tweens[i].to.modifiers.e(e); return anims[i].frames[0][0]; };
  assert.deepEqual([tweens[0].at, tweens[0].to.e], [2.5, 5.5]);
  assert.deepEqual([tweens[1].at, tweens[1].to.e], [2, 6]);
  // a: 45 frames a second, holds 59
  assert.equal(at(0, 0), 0); assert.equal(at(0, 0.1), 4); assert.equal(at(0, 1 / 3), 15, "an exact frame boundary is that frame, not the one before");
  assert.equal(at(0, 1.3), 58); assert.equal(at(0, 1.32), 59); assert.equal(at(0, 5.5), 59, "play-once holds the last frame");
  assert.equal(at(0, -1), 0, "before the start: the first frame");
  // b: segment [10, 40) looping at 30 fps
  assert.equal(at(1, 0), 10); assert.equal(at(1, 29 / 30), 39);
  // GSAP rounds timeline times to 1e-7 s: reel frame 88 (t = 2.9333...) reaches the driver as e = 0.9333333, which is
  // frame 28 of a 30 fps file (a real render showed 27 with a 1e-6 margin)
  assert.equal(at(1, Math.round((88 / 30 - 2) * 1e7) / 1e7), 10 + 28); assert.equal(at(1, 1), 10, "wraps to first"); assert.equal(at(1, 1.5), 25);
  // c: half speed
  assert.equal(at(2, 1), 15); assert.equal(at(2, 1.99), 29);
  // the same time gives the same frame from any order
  const order = [3.3, 0.2, 5, 0.2, 3.3].map((e) => at(1, e));
  assert.equal(order[0], order[4]); assert.equal(order[1], order[3]);
});

// ---------------------------------------------------------------------------------------------------------------
// source problems: beat = dropped with the exact warning; layer = errors (die)
const bad = {
  "notjson.json": "{ this is not json",
  "notlottie.json": { a: 1 },
  "range.json": { ...clone(), fr: 0 },
  "image.json": (() => { const d = clone(); d.layers.push({ ty: 2, ind: 2, refId: "img_0" }); return d; })(),
  "text.json": (() => { const d = clone(); d.assets = [{ id: "pc", layers: [{ ty: 5, ind: 1 }] }]; return d; })(),
  "img-asset.json": (() => { const d = clone(); d.assets = [{ id: "img_0", w: 10, h: 10, u: "https://example.com/", p: "a.png", e: 0 }]; return d; })(),
  "footage.json": (() => { const d = clone(); d.assets = [{ id: "data_0", t: 3, u: "", p: "data.json", e: 0 }]; return d; })(),
  "fonts.json": (() => { const d = clone(); d.fonts = { list: [{ fName: "Roboto", fFamily: "Roboto", fStyle: "Regular", fPath: "https://fonts.googleapis.com/css?family=Roboto", origin: 1 }] }; return d; })(),
  "chars.json": (() => { const d = clone(); d.chars = [{ ch: "A", size: 12, style: "Regular", w: 50, data: {}, fFamily: "Roboto" }]; return d; })(),
  "precomp.json": (() => { const d = clone(); d.assets = [{ id: "comp_0", layers: [clone().layers[0]] }]; d.fonts = { list: [] }; d.chars = []; return d; })(),
  "expr.json": (() => { const d = clone(); d.layers[0].ks.r = { a: 0, k: 0, x: "var $bm_rt = time * 360;" }; return d; })(),
  "move.json": LOTTIE_FIXTURE,
};
const CASES = [
  ["L1", { src: "https://example.com/a.json" }, "lottie src 'https://example.com/a.json' is not an assets/ .json path inside the project or a library/lottie id"],
  ["L1", { src: "assets/../x.json" }, "lottie src 'assets/../x.json' is not an assets/ .json path inside the project or a library/lottie id"],
  ["L1", { src: "assets/lottie/a.lottie" }, "lottie src 'assets/lottie/a.lottie' is not an assets/ .json path inside the project or a library/lottie id"],
  ["L2", { src: "assets/lottie/nope.json" }, "lottie file assets/lottie/nope.json does not exist"],
  ["L7", { src: "assets/lottie/notjson.json" }, "lottie file assets/lottie/notjson.json is not valid JSON"],
  ["L8", { src: "assets/lottie/notlottie.json" }, "lottie file assets/lottie/notlottie.json is not a Lottie animation (needs numbers fr, ip, op, w, h and a layers array)"],
  ["L9", { src: "assets/lottie/range.json" }, "lottie file assets/lottie/range.json is out of range (fr 1..120, op > ip, op - ip <= 10000, w and h 1..8192)"],
  ["L10", { src: "assets/lottie/image.json" }, "lottie file assets/lottie/image.json has a layer of type 2 (only 0 precomp, 1 solid, 3 null and 4 shape are supported)"],
  ["L10", { src: "assets/lottie/text.json" }, "lottie file assets/lottie/text.json has a layer of type 5 (only 0 precomp, 1 solid, 3 null and 4 shape are supported)"],
  ["L13", { src: "assets/lottie/img-asset.json" }, "lottie file assets/lottie/img-asset.json has an asset without layers (an image or footage): only vector shapes are supported, nothing may be loaded"],
  ["L13", { src: "assets/lottie/footage.json" }, "lottie file assets/lottie/footage.json has an asset without layers (an image or footage): only vector shapes are supported, nothing may be loaded"],
  ["L13", { src: "assets/lottie/fonts.json" }, "lottie file assets/lottie/fonts.json has fonts: only vector shapes are supported, nothing may be loaded"],
  ["L13", { src: "assets/lottie/chars.json" }, "lottie file assets/lottie/chars.json has glyphs (chars): only vector shapes are supported, nothing may be loaded"],
  ["L11", { src: "assets/lottie/expr.json" }, "lottie file assets/lottie/expr.json uses expressions (not supported)"],
  ["L12", { x: 1010, y: 300 }, "lottie box shows less than 20% inside the 1080x1920 canvas"],
];
test("source problems in a beat: the element is dropped with the exact warning, the rest of the beat stands", () => {
  const dir = proj(bad);
  for (const [code, o, reason] of CASES) {
    const r = compileMotion(beat([el(o), { id: "keep", shape: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#ffffff" }]), ctxFor(dir));
    assert.ok(r.ok, `${code}: the beat survives`);
    assert.ok(r.warnings.includes(`motion m1: element anim: ${reason}, dropped`), `${code}: ${JSON.stringify(r.warnings)}`);
    assert.ok(!r.html.includes("b0-anim"), `${code}: the element is not on the page`);
    assert.equal(r.lottie.size, 0, `${code}: nothing inlined`);
    assert.deepEqual(r.errors, [], `${code}: a beat never errors`);
  }
});
test("source problems in a motion layer: renderLayer returns the error the build dies on", () => {
  const dir = proj(bad);
  const resolveLottie = makeLottieResolver(dir, path.join(dir, "lib"));
  for (const [code, o, reason] of CASES) {
    const l = { id: "gfx", kind: "motion", t0: 1, dur: 5, z: 1, elements: [el(o)], tweens: [] };
    const r = renderLayer(l, { W: 1080, H: 1920, brand: {}, esc: (s) => s, compileMotion, resolveColor: () => null, resolveImage: () => null, resolveLottie, safe: SAFE });
    assert.deepEqual(r.errors, [`layer gfx: element anim: ${reason}`], code);
  }
  // and a good one renders, with its data
  const r = renderLayer({ id: "gfx", kind: "motion", t0: 1, dur: 5, z: 1, elements: [el()], tweens: [] }, { W: 1080, H: 1920, brand: {}, esc: (s) => s, compileMotion, resolveColor: () => null, resolveImage: () => null, resolveLottie, safe: SAFE });
  assert.equal(r.errors, undefined); assert.equal(r.lottie.size, 1);
});
test("a real build dies on a motion layer's bad Lottie (L7), and names it", () => {
  const dir = path.join(tmp, "build-die");
  fs.mkdirSync(path.join(dir, "assets", "lottie"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "lottie", "bad.json"), "{ nope");
  const layers = [{ id: "gfx", kind: "motion", pin: true, at: 1, dur: 4, z: 1, by: "user", elements: [el({ src: "assets/lottie/bad.json" })], tweens: [] }];
  let err = null;
  try { makeProject(dir, { layers }); } catch (e) { err = e; }
  assert.ok(err, "the build fails");
  assert.match(String(err.stderr) + String(err.stdout), /layer gfx: element anim: lottie file assets\/lottie\/bad\.json is not valid JSON/);
  // a motion BEAT with the same file builds, and warns
  const dir2 = path.join(tmp, "build-drop");
  const p = makeProject(dir2, { beat: { ...LOTTIE_BEAT, elements: [el({ src: "assets/lottie/bad.json" }), { id: "keep", shape: "rect", x: 100, y: 400, w: 200, h: 200, fill: "#ffffff" }], tweens: [] }, files: { "assets/lottie/bad.json": "{ nope" } });
  assert.match(p.log, /motion lot: element anim: lottie file assets\/lottie\/bad\.json is not valid JSON, dropped/);
  assert.ok(!/lottie/i.test(fs.readFileSync(p.html, "utf8")), "nothing of the dropped element reaches the page");
});

test("a precomp asset (with layers) and empty fonts/chars are vector data: accepted", () => {
  const dir = proj(bad);
  const r = makeLottieResolver(dir, path.join(dir, "lib"))("assets/lottie/precomp.json");
  assert.ok(r.ok, r.reason);
});

test("ip/op are made whole: Bodymovin's op 60.0000024 loops 58, 59, 0 (never frame 60); far-off values go inward", () => {
  const frac = (ip, op) => { const d = clone(); d.ip = ip; d.op = op; return d; };
  const dir = proj({ "frac.json": frac(0, 60.0000024), "inward.json": frac(0.5, 59.5), "tiny.json": frac(0.0004, 59.9996), "empty.json": frac(0.4, 0.6) });
  const res = makeLottieResolver(dir, path.join(dir, "lib"));
  const a = res("assets/lottie/frac.json");
  assert.deepEqual([a.meta.ip, a.meta.op], [0, 60]);
  assert.deepEqual([JSON.parse(a.json).ip, JSON.parse(a.json).op], [0, 60], "the inlined copy carries the whole values");
  const b = res("assets/lottie/inward.json"); assert.deepEqual([b.meta.ip, b.meta.op], [1, 59]);
  const c = res("assets/lottie/tiny.json"); assert.deepEqual([c.meta.ip, c.meta.op], [0, 60]);
  assert.equal(res("assets/lottie/empty.json").reason, "lottie file assets/lottie/empty.json is out of range (fr 1..120, op > ip, op - ip <= 10000, w and h 1..8192)", "0.4..0.6 has no whole frame");
  // the loop driver over the fractional-op file
  const r = compileMotion(beat([el({ src: "assets/lottie/frac.json", loop: true })]), ctxFor(dir));
  assert.ok(r.ok, r.reason);
  const { anims, tweens } = drive(r);
  const at = (e) => { anims[0].frames.length = 0; tweens[0].to.modifiers.e(e); return anims[0].frames[0][0]; };
  assert.deepEqual([58, 59, 60, 61].map((f) => at(f / 30)), [58, 59, 0, 1]);
  // and a fractional ip: frames are counted from the whole ip, goToAndStop gets f - ip
  const r2 = compileMotion(beat([el({ src: "assets/lottie/inward.json", loop: true })]), ctxFor(dir));
  const d2 = drive(r2);
  d2.anims[0].frames.length = 0; d2.tweens[0].to.modifiers.e(58 / 30);
  assert.deepEqual(d2.anims[0].frames[0], [0, true], "58 frames into a 1..59 loop wraps to frame 1 = offset 0");
});

test("symlinks may not lead out of assets/ (L1)", () => {
  const dir = proj({ "move.json": LOTTIE_FIXTURE });
  const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
  fs.writeFileSync(path.join(outside, "x.json"), FIX);
  fs.symlinkSync(path.join(outside, "x.json"), path.join(dir, "assets", "lottie", "link.json"));
  fs.symlinkSync(outside, path.join(dir, "assets", "linkdir"));
  fs.symlinkSync(path.join(dir, "assets", "lottie", "move.json"), path.join(dir, "assets", "lottie", "inside.json"));
  const res = makeLottieResolver(dir, path.join(dir, "lib"));
  assert.equal(res("assets/lottie/link.json").reason, "lottie src 'assets/lottie/link.json' is not an assets/ .json path inside the project or a library/lottie id");
  assert.equal(res("assets/linkdir/x.json").reason, "lottie src 'assets/linkdir/x.json' is not an assets/ .json path inside the project or a library/lottie id");
  assert.ok(res("assets/lottie/inside.json").ok, "a link that stays inside assets/ is fine");
});

test("a deeply nested file is refused (L14), never an uncaught RangeError", () => {
  const n = 300000, deep = "[".repeat(n) + "]".repeat(n);
  const text = `{"fr":30,"ip":0,"op":60,"w":10,"h":10,"layers":[],"meta":${deep}}`;
  assert.ok(text.length < LOTTIE_MAX_BYTES);
  let r;
  assert.doesNotThrow(() => { r = inspectLottie(Buffer.from(text), "assets/lottie/deep.json"); });   // CP2 threw RangeError here
  assert.equal(r.reason, "lottie file assets/lottie/deep.json is nested more than 256 levels deep");
  const ok = clone(); let node = ok.layers[0].shapes; for (let i = 0; i < 60; i++) { const g = { ty: "gr", it: [] }; node.push(g); node = g.it; }
  assert.ok(inspectLottie(Buffer.from(JSON.stringify(ok)), "x").ok, "60 nested shape groups (deeper than real files) pass");
});

test("library ids: L3, L4, L5 and a good one", () => {
  const dir = proj({});
  const lib = path.join(dir, "lib");
  fs.mkdirSync(path.join(lib, "lottie"), { recursive: true });
  fs.writeFileSync(path.join(lib, "lottie", "manifest.json"), JSON.stringify({
    _: "comment", good: { sha256: sha(FIX) }, gone: { sha256: sha(FIX) }, changed: { sha256: "0".repeat(64) } }));
  fs.writeFileSync(path.join(lib, "lottie", "good.json"), FIX);
  fs.writeFileSync(path.join(lib, "lottie", "changed.json"), FIX);
  const res = makeLottieResolver(dir, lib);
  assert.equal(res("unknown").reason, "lottie id 'unknown' is not in library/lottie/manifest.json");
  assert.equal(res("gone").reason, "lottie library file gone.json is missing (restore the library)");
  assert.equal(res("changed").reason, "lottie library file changed.json does not match its manifest sha256");
  assert.equal(res("_").reason, "lottie src '_' is not an assets/ .json path inside the project or a library/lottie id");
  const g = res("good");
  assert.ok(g.ok); assert.deepEqual(g.meta, { fr: 30, ip: 0, op: 60, w: 400, h: 400 }); assert.equal(g.json, FIX);
});

test("L6: a file over 2 MiB", () => {
  const big = Buffer.alloc(LOTTIE_MAX_BYTES + 1, 32);
  assert.equal(inspectLottie(big, "assets/lottie/big.json").reason, `lottie file assets/lottie/big.json is ${LOTTIE_MAX_BYTES + 1} bytes (max 2097152)`);
});

// ---------------------------------------------------------------------------------------------------------------
test("field warnings W1..W7 keep the element with the named fallback", () => {
  const dir = proj({ "move.json": LOTTIE_FIXTURE });
  const one = (o, extra) => compileMotion(beat([el(o)]), ctxFor(dir, extra));
  const w = (o, want, extra) => { const r = one(o, extra); assert.ok(r.ok && r.html.includes("b0-anim-l"), `kept: ${want}`); assert.ok(r.warnings.includes(want), `${want}\n got ${JSON.stringify(r.warnings)}`); return r; };
  let r = w({ fit: "stretch" }, "motion m1: element anim: lottie fit 'stretch' is not contain, cover or fill, using contain");
  assert.ok(r.lines.join("\n").includes(`preserveAspectRatio: "xMidYMid meet"`));
  r = w({ start: 9 }, "motion m1: element anim: lottie start 9s is outside 0..5.95s, clamped");
  assert.ok(r.lines.join("\n").includes("}, 7.95);"), "clamped to 5.95 s after t0 = 2");
  w({ start: -1 }, "motion m1: element anim: lottie start -1s is outside 0..5.95s, clamped");
  r = w({ start: "soon" }, "motion m1: element anim: lottie start 'soon' is not a number, using 0");
  assert.ok(r.lines.join("\n").includes("}, 2);"), "start 0 = the beat's t0");
  r = w({ speed: 10 }, "motion m1: element anim: lottie speed 10 is outside 0.25..4, clamped");
  assert.ok(r.lines.join("\n").includes("Math.max(0, e) * 120 + 1e-3"), "30 fps x 4");
  r = w({ speed: "fast" }, "motion m1: element anim: lottie speed 'fast' is not a number, using 1");
  assert.ok(r.lines.join("\n").includes("Math.max(0, e) * 30 + 1e-3"));
  r = w({ loop: "yes" }, "motion m1: element anim: lottie loop must be true or false, using false");
  assert.ok(r.lines.join("\n").includes("Math.min(p, 59)"));
  for (const f of [[5, 5], [0, 61], [1.5, 20], [-1, 10], "0-10", [0]]) {
    r = w({ frames: f }, "motion m1: element anim: lottie frames must be [first, last] whole frames with 0 <= first < last <= 60, using [0, 60]");
    assert.ok(r.lines.join("\n").includes("a.goToAndStop(0 + Math.min(p, 59), true)"));
  }
  w({ y: 100 }, "motion m1: element anim: lottie box crosses the Instagram Reels UI zone");
  w({ y: 1300 }, "motion m1: element anim: lottie box crosses the Instagram Reels UI zone");
  w({ x: 600 }, "motion m1: element anim: lottie box crosses the Instagram Reels UI zone");
  assert.ok(!one({}).warnings.length, "a clean element: no warning");
  // W6: at most 3 per graphic
  r = compileMotion(beat([1, 2, 3, 4].map((i) => el({ id: `a${i}`, y: 230 + i * 300, h: 200 }))), ctxFor(dir));
  assert.ok(r.warnings.includes("motion m1: only the first 3 lottie elements are used"));
  assert.ok(r.html.includes("b0-a3-l") && !r.html.includes("b0-a4-l"));
  assert.equal(r.lottie.size, 1, "one file, inlined once");
  // the cap counts VALID elements: an invalid one first does not use up a place
  r = compileMotion(beat([el({ id: "bad", src: "assets/lottie/nope.json" }), ...[1, 2, 3].map((i) => el({ id: `a${i}`, y: 230 + i * 300, h: 200 }))]), ctxFor(dir));
  assert.ok(!r.warnings.includes("motion m1: only the first 3 lottie elements are used"), JSON.stringify(r.warnings));
  assert.ok(["a1", "a2", "a3"].every((i) => r.html.includes(`b0-${i}-l`)));
});

test("tweens on a Lottie box: node keys apply, draw and count are refused", () => {
  const dir = proj({ "move.json": LOTTIE_FIXTURE });
  const r = compileMotion({ ...beat([el()]), tweens: [
    { target: "anim", at: 0, dur: 0.5, from: { opacity: 0, scale: 0.5, y: 40 }, to: { opacity: 1, scale: 1, y: 0 } },
    { target: "anim", at: 1, dur: 0.5, from: { draw: 0 }, to: { draw: 1 } },
    { target: "anim", at: 1, dur: 0.5, from: { count: 0 }, to: { count: 5 } },
  ] }, ctxFor(dir));
  assert.ok(r.lines.some((l) => l.startsWith(`tl.fromTo("#b0-anim-a", {"y":40,"scale":0.5,"opacity":0}`)));
  assert.ok(r.warnings.includes("motion m1: tween 1: draw needs a stroked line, path, rect or ellipse, ignored on 'anim'"));
  assert.ok(r.warnings.includes("motion m1: tween 2: count needs an unsplit text element whose text is a number, ignored on 'anim'"));
});

test("inlined data cannot close its <script>", () => {
  const head = lottieHead(new Map([["lottie-x", JSON.stringify({ nm: "</script><script>alert(1)</script>" })]]));
  assert.equal(head.split("</script>").length - 1, 3, "only the player's, the global move's and the data block's own closing tags");
  assert.equal(JSON.parse(/id="lottie-x">(.*)<\/script>/.exec(head)[1]).nm, "</script><script>alert(1)</script>");
  assert.equal(lottieHead(new Map()), "", "nothing when unused");
});

test("lottie_light: no expression engine, no eval (why the light build)", () => {
  const lw = LIBRARIES.find((x) => x.name === "lottie-web");
  const src = fs.readFileSync(path.join(VENDOR, lw.file), "utf8");
  assert.ok(!/\beval\(|new Function\(/.test(src));
  assert.ok(src.includes("goToAndStop") && src.includes("setSubframe"));
});

test("the vendor preload fails closed for lottie_light too: an altered or missing copy is served as a throwing stub", () => {
  const lw = LIBRARIES.find((x) => x.name === "lottie-web");
  const fake = fs.mkdtempSync(path.join(tmp, "fake-fork-"));
  fs.mkdirSync(path.join(fake, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fake, "vendor", path.dirname(lw.file)), { recursive: true });
  fs.copyFileSync(PRELOAD, path.join(fake, "scripts", "vendor-offline.cjs"));
  fs.copyFileSync(path.join(VENDOR, "manifest.json"), path.join(fake, "vendor", "manifest.json"));
  const preload = path.join(fake, "scripts", "vendor-offline.cjs").split(path.sep).join("/");
  const probe = () => {
    const code = `(async () => { const r = await fetch(${JSON.stringify(lw.url)}); const b = Buffer.from(await r.arrayBuffer()); console.log(JSON.stringify({ sha: require("node:crypto").createHash("sha256").update(b).digest("hex"), head: b.subarray(0, 300).toString() })); })();`;
    const r = spawnSync(process.execPath, ["-e", code], { cwd: fake, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--require "${preload}"`, VENDOR_OFFLINE: "1" } });
    assert.equal(r.status, 0, r.stderr);
    return { ...JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr };
  };
  // the genuine copy is served
  fs.copyFileSync(path.join(VENDOR, lw.file), path.join(fake, "vendor", lw.file));
  let out = probe();
  assert.equal(out.sha, lw.sha256);
  assert.ok(out.stderr.includes(`${MARK} ${lw.url} from vendor/${lw.file}`), out.stderr);
  // altered, then missing: refused, a script that throws, and no MARK (so runRender fails the render)
  const refused = (o) => {
    assert.notEqual(o.sha, lw.sha256);
    assert.ok(o.head.startsWith(`/* vendor: REFUSED ${lw.url} */\nthrow new Error(`), o.head);
    assert.ok(!o.stderr.includes(MARK) && o.stderr.includes(`vendor: REFUSED ${lw.url}`), o.stderr);
  };
  fs.appendFileSync(path.join(fake, "vendor", lw.file), "\n// altered");
  refused(probe());
  fs.rmSync(path.join(fake, "vendor", lw.file));
  refused(probe());
});

test.after(() => { if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); });

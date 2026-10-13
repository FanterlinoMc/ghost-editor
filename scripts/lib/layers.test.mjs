#!/usr/bin/env node
// node scripts/lib/layers.test.mjs
// lib/layers.mjs: anchor resolution and ripple, pinning, clamping, z ordering, the enter/exit tween shapes,
// the duck lane, and what each kind renders. No browser, no ffmpeg.
import assert from "node:assert/strict";
import { resolveLayers, layerTweens, takeVolumeLane, duckWindows, renderLayer, layerTruth, logoBox, layersCss } from "./layers.mjs";
import { compileMotion, resolveColor } from "./motion-graphics.mjs";

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok    ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.message.split("\n").join("\n      ")}`); } };

const W = 1080, H = 1920, FPS = 30;
// three takes: 0..4, 4..9 (with a 0.5 s hold), 9.5..12
const mkTakes = (d0 = 4, d1 = 5) => [
  { start: 0, dur: d0, holdFrames: 0 },
  { start: d0, dur: d1, holdFrames: 15 },
  { start: d0 + d1 + 0.5, dur: 2.5, holdFrames: 0 },
];
const base = { kind: "image", src: "assets/a.png", box: { x: 0, y: 0, w: 100, h: 100 }, dur: 2, z: 1, by: "user" };
const run = (layers, takes = mkTakes(), total = 14) => resolveLayers(layers, { takes, total, fps: FPS, W });

test("an anchored layer starts at its take's start plus the offset", () => {
  const r = run([{ ...base, id: "a", anchor: { take: 1, offset: 1.2 } }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.layers[0].t0, 5.2);
  assert.equal(r.layers[0].t1, 7.2);
  assert.equal(r.layers[0].pin, false);
});

test("trimming an earlier take ripples an anchored layer, but not a pinned one", () => {
  const layers = [{ ...base, id: "a", anchor: { take: 1, offset: 1 } }, { ...base, id: "p", pin: true, at: 6 }];
  const before = run(layers, mkTakes(4, 5)).layers, after = run(layers, mkTakes(3, 5)).layers;
  assert.equal(before[0].t0, 5); assert.equal(after[0].t0, 4);        // moved 1 s earlier with its take
  assert.equal(before[1].t0, 6); assert.equal(after[1].t0, 6);        // pinned: did not move
});

test("the offset can reach into the hold, no further", () => {
  const r = run([{ ...base, id: "a", anchor: { take: 1, offset: 5.3 } }, { ...base, id: "b", anchor: { take: 1, offset: 9 } }]);
  assert.equal(r.layers[0].t0, 9.3);                                    // 4 + 5.3, inside take 1's 5 s + 0.5 s hold
  assert.equal(r.layers[1].t0, 9.5);                                    // clamped to the end of the span
  assert.ok(r.warnings.some((w) => /past the end of take 1/.test(w)));
});

test("a layer is clamped to the reel's length; one that cannot be shown is dropped", () => {
  const r = run([{ ...base, id: "a", pin: true, at: 13, dur: 5 }, { ...base, id: "b", pin: true, at: 20, dur: 1 }], mkTakes(), 14);
  assert.equal(r.layers[0].t0, 13); assert.equal(r.layers[0].t1, 14);
  assert.equal(r.layers[1].t0, 13.9);                                   // start pulled back so MIN_LAYER fits
  assert.equal(r.layers[1].t1, 14);
  const tiny = run([{ ...base, id: "c", pin: true, at: 13.95, dur: 0.01 }]);
  assert.equal(tiny.layers.length, 0);                                  // too short to show once clamped: dropped, with a warning
  assert.ok(tiny.warnings.some((w) => /dropped/.test(w)));
});

test("bad layers are errors, not silent drops", () => {
  const bad = (l, re) => { const r = run([l]); assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(l)} -> ${JSON.stringify(r.errors)}`); };
  bad({ ...base, id: "A" }, /id must match/);
  bad({ ...base, id: "a", kind: "gif" }, /unknown kind/);
  bad({ ...base, id: "a", dur: 0, pin: true, at: 0 }, /dur must be/);
  bad({ ...base, id: "a" }, /needs pin:true with at, or anchor/);
  bad({ ...base, id: "a", anchor: { take: 7 } }, /outside 0\.\.2/);
  bad({ ...base, id: "a", anchor: { take: 1.5 } }, /integer/);
  bad({ ...base, id: "a", pin: true, at: -1 }, /at must be/);
  bad({ ...base, id: "a", pin: true, at: 0, box: undefined }, /box must be/);
  bad({ ...base, id: "a", pin: true, at: 0, box: { x: 0, y: 0, w: 0, h: 5 } }, /box must be/);
  bad({ ...base, id: "a", pin: true, at: 0, src: "../x.png" }, /inside the project/);
  bad({ ...base, id: "a", pin: true, at: 0, src: "https://x/y.png" }, /inside the project/);
  bad({ ...base, id: "a", pin: true, at: 0, src: "assets/a.mp4" }, /wrong extension/);
  bad({ ...base, id: "a", pin: true, at: 0, enter: "spin" }, /enter must be/);
  bad({ ...base, id: "m", kind: "motion", pin: true, at: 0, elements: [] }, /elements/);
  bad({ ...base, id: "t", kind: "text", pin: true, at: 0, text: "  " }, /non-empty text/);
  const dup = run([{ ...base, id: "a", pin: true, at: 0 }, { ...base, id: "a", pin: true, at: 1 }]);
  assert.ok(dup.errors.some((e) => /duplicate id/.test(e)));
});

test("a logo defaults to pinned, the whole reel, a corner box and contain", () => {
  const r = run([{ id: "lg", kind: "logo", src: "assets/logo.png" }]);
  assert.deepEqual(r.errors, []);
  const l = r.layers[0];
  assert.equal(l.pin, true); assert.equal(l.t0, 0); assert.equal(l.t1, 14); assert.equal(l.fit, "contain");
  assert.deepEqual(l.box, logoBox(W));
  assert.ok(l.box.x + l.box.w <= W && l.box.y >= 0);
});

test("defaults: enter/exit fade, fit cover, z 0, opacity 1, audio off", () => {
  const l = run([{ id: "i", kind: "image", src: "assets/a.png", box: base.box, dur: 1, pin: true, at: 1 }]).layers[0];
  assert.deepEqual([l.enter, l.exit, l.fit, l.z, l.opacity, l.audio], ["fade", "fade", "cover", 0, 1, "off"]);
});

test("audio only means something on a video layer", () => {
  const img = run([{ ...base, id: "i", pin: true, at: 0, audio: "mix" }]);
  assert.equal(img.layers[0].audio, "off");
  const vid = run([{ ...base, id: "v", kind: "video", src: "assets/b.mp4", pin: true, at: 0, audio: "duck" }]);
  assert.equal(vid.layers[0].audio, "duck");
});

test("enter/exit tween shapes: explicit from and to, force3D false, about 0.3 s", () => {
  const l = (enter, exit, dur = 4) => ({ id: "x", t0: 2, t1: 2 + dur, dur, opacity: 0.8, enter, exit });
  const fade = layerTweens(l("fade", "fade"));
  assert.equal(fade.length, 2);
  assert.equal(fade[0], `ft("#ly-x_box", {"autoAlpha":0,"y":0}, {"autoAlpha":0.8,"y":0,"duration":0.3,"ease":"power1.out","force3D":false}, 2);`);
  assert.equal(fade[1], `tl.fromTo("#ly-x_box", {"autoAlpha":0.8}, {"autoAlpha":0,"duration":0.3,"ease":"power1.in","force3D":false,"immediateRender":false}, 5.7);`);
  assert.match(layerTweens(l("slide-up", "none"))[0], /"y":60.*"y":0,"duration":0\.3,"ease":"power3\.out"/);
  assert.match(layerTweens(l("pop", "fade"))[0], /"scale":0\.7.*"scale":1,"duration":0\.3,"ease":"back\.out\(1\.7\)"/);
  const none = layerTweens(l("none", "none"));
  assert.match(none[0], /"duration":0\.001/); assert.match(none[1], /"duration":0\.001.*, 5\.999\);$/);
  // a short layer: enter + exit never overlap
  const short = layerTweens(l("fade", "fade", 0.45));
  assert.match(short[0], /"duration":0\.15/); assert.match(short[1], /"duration":0\.15.*, 2\.3\);$/);
  // section origin
  assert.match(layerTweens(l("fade", "fade"), 2)[0], /, 0\);$/);
  for (const line of [...fade, ...short]) assert.ok(!/Date|random|repeat|yoyo/i.test(line));
});

test("take volume lane: untouched without a duck, ducked inside one, back at the end", () => {
  const plain = JSON.parse(takeVolumeLane(5, FPS)), same = JSON.parse(takeVolumeLane(5, FPS, 4, [[20, 22]]));
  assert.deepEqual(plain, same);                                         // a duck elsewhere changes nothing
  assert.deepEqual(plain.lanes[0].points.map((p) => p.v), [0, 1, 1, 0]);
  const d = JSON.parse(takeVolumeLane(5, FPS, 4, [[5, 7]])).lanes[0].points;
  const at = (t) => d.filter((p) => p.t <= t).at(-1).v;
  assert.equal(at(4.9 - 4), 1); assert.equal(at(6 - 4), 0.25); assert.equal(at(7.1 - 4), 1);
  assert.deepEqual(d.map((p) => p.t), [...d.map((p) => p.t)].sort((a, b) => a - b));   // monotonic
  assert.equal(d.at(-1).v, 0);                                           // still fades out at the take's end
});

test("duck windows merge and skip layers with no sound", () => {
  const w = duckWindows([
    { audio: "duck", t0: 2, t1: 3 }, { audio: "duck", t0: 3.1, t1: 5 }, { audio: "mix", t0: 8, t1: 9 },
    { audio: "duck", t0: 10, t1: 11, hasAudio: false }, { audio: "duck", t0: 12, t1: 13 },
  ]);
  assert.deepEqual(w, [[2, 5], [12, 13]]);
});

const ctx = { W, H, brand: { accent: "#D13F34" }, uiFont: "Geist", esc: (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"), compileMotion, resolveColor, resolveImage: (s) => (/^assets\//.test(s) ? s : null) };
const resolved = (l) => run([l]).layers[0];

test("a video layer: timed <video>, untimed wrapper, in as the seek offset, PiP box and radius", () => {
  const l = resolved({ id: "pip", kind: "video", src: "assets/b.mp4", pin: true, at: 3, dur: 4, in: 1.5, box: { x: 640, y: 120, w: 380, h: 676 }, radius: 24, shadow: true, z: 2, audio: "off" });
  const r = renderLayer(l, ctx, 0);
  assert.match(r.html, /<video id="ly-pip_v" src="assets\/b\.mp4" data-start="3" data-duration="4" data-media-start="1\.5" data-track-index="40" muted/);
  assert.match(r.html, /^<div id="ly-pip" class="lyr" data-layer-id="pip" data-layer-kind="video" style="z-index:2">/);   // untimed wrapper
  assert.match(r.html, /data-layer-box="pip" style="left:640px;top:120px;width:380px;height:676px;border-radius:24px;box-shadow:/);
  assert.equal(r.audio, "");
  assert.ok(r.lines.length === 2);
});

test("video audio: mix and duck add an <audio> from the same file; off and a silent file do not", () => {
  const mk = (audio, hasAudio) => renderLayer({ ...resolved({ id: "v", kind: "video", src: "assets/b.mp4", pin: true, at: 1, dur: 3, in: 2, box: base.box, audio }), hasAudio }, ctx, 1);
  assert.match(mk("mix", true).audio, /<audio id="ly-v_a" src="assets\/b\.mp4" data-start="1" data-duration="3" data-media-start="2" data-track-index="81" data-volume="1">/);
  assert.match(mk("duck", true).audio, /<audio/);
  assert.equal(mk("off", true).audio, "");
  const silent = mk("mix", false);
  assert.equal(silent.audio, ""); assert.ok(silent.warnings.some((w) => /no audio stream/.test(w)));
});

test("image and logo layers: timed wrapper, positioned <img>, object-fit", () => {
  const img = renderLayer(resolved({ id: "im", kind: "image", src: "assets/a.png", pin: true, at: 1, dur: 2, box: { x: 10, y: 20, w: 300, h: 200 }, fit: "contain", opacity: 0.5 }), ctx);
  assert.match(img.html, /class="lyr clip" data-start="1" data-duration="2" data-track-index="2" data-layer-id="im" data-layer-kind="image"/);
  assert.match(img.html, /<img id="ly-im_i" src="assets\/a\.png" style="width:100%;height:100%;object-fit:contain/);
  assert.match(img.lines[0], /"autoAlpha":0\.5/);
  const logo = renderLayer(resolved({ id: "lg", kind: "logo", src: "assets/l.png" }), ctx);
  assert.match(logo.html, /data-layer-kind="logo"/); assert.match(logo.html, new RegExp(`left:${W - 260}px;top:96px;width:200px;height:200px`));
});

test("a text layer: styled box, colour, size, alignment, optional backing; text is escaped", () => {
  const r = renderLayer(resolved({ id: "tx", kind: "text", pin: true, at: 0, dur: 3, text: 'Hello <b>"you"</b>', size: 80, color: "accent", align: "left", bg: "#000000cc", font: "Gloock", box: { x: 50, y: 900, w: 900, h: 200 } }), ctx);
  assert.match(r.html, /class="lyr-text" data-layer-text="tx" style="justify-content:flex-start;text-align:left;font-family:'Gloock',Geist,system-ui,sans-serif;font-size:80px;font-weight:700;color:#d13f34;background:rgba\(0,0,0,0\.8\);padding:/);
  assert.ok(r.html.includes("Hello &lt;b>&quot;you&quot;&lt;/b>"));
  assert.ok(!r.html.includes("<b>"));
});

test("a motion layer: same compiler, element ids as data-el-id, no 0.6-8 s limit", () => {
  const els = [{ id: "title", shape: "text", text: "Twelve seconds", x: 100, y: 400, w: 800, h: 200, size: 90, color: "#ffffff" }, { id: "bar", shape: "rect", x: 100, y: 620, w: 600, h: 12, fill: "accent" }];
  const tw = [{ target: "title", at: 0.2, dur: 0.5, from: { opacity: 0, y: 30 }, to: { opacity: 1, y: 0 } }];
  const l = resolved({ id: "m1", kind: "motion", pin: true, at: 1, dur: 12, elements: els, tweens: tw });
  const r = renderLayer(l, ctx);
  assert.ok(!r.dropped, r.warnings.join("; "));
  assert.match(r.html, /data-el-id="title"/); assert.match(r.html, /data-el-id="bar"/);
  assert.match(r.html, /id="ly-m1_m-title"/);
  assert.match(r.html, /data-layer-id="m1" data-layer-kind="motion"/);
  assert.ok(r.lines.some((x) => x.includes("#ly-m1_m-title")));
  // 12 s would be rejected as a beat
  assert.equal(compileMotion({ id: "m1", elements: els, tweens: tw }, { id: "b0", t0: 1, t1: 13, W, H, brand: {} }).ok, false);
  // a motion BEAT's markup has no data-el-id: byte-identity of existing reels
  assert.ok(!compileMotion({ id: "m1", elements: els, tweens: tw }, { id: "b0", t0: 1, t1: 4, W, H, brand: {} }).html.includes("data-el-id"));
});

test("z ordering: build sorts by z then array order (the sort build.mjs uses)", () => {
  const r = run([{ ...base, id: "top", pin: true, at: 0, z: 5 }, { ...base, id: "low", pin: true, at: 0, z: 1 }, { ...base, id: "low2", pin: true, at: 0, z: 1 }, { ...base, id: "mid", pin: true, at: 0, z: 3 }]);
  const order = [...r.layers].sort((x, y) => x.z - y.z || x.index - y.index).map((l) => l.id);
  assert.deepEqual(order, ["low", "low2", "mid", "top"]);
  for (const l of r.layers) assert.match(renderLayer(l, ctx).html, new RegExp(`style="z-index:${l.z}"`));
});

test("layer truth lists the resolved output times", () => {
  const r = run([{ ...base, id: "a", anchor: { take: 1, offset: 1 }, overCaptions: true }]);
  assert.deepEqual(layerTruth(r.layers), [{ id: "a", kind: "image", start: 5, end: 7, z: 1, pin: false, overCaptions: true }]);
});

test("layersCss is plain, deterministic text", () => { assert.equal(layersCss(), layersCss()); assert.match(layersCss(), /\.lyr \{/); });

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall layers tests passed");

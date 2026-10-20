// window.motion (references/reel-json.md "Motion helpers (v3.4)"): every helper, run from the injected snippet text
import test from "node:test";
import assert from "node:assert/strict";
import { MOTION_SNIPPET } from "./motion-helpers.mjs";
import * as G from "./graphic.mjs";

// the snippet text, run in this realm (sloppy, like a page <script>) on a stand-in window
const load = () => { const window = {}; new Function("window", MOTION_SNIPPET)(window); return window; };
const M = load().motion;
const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} ${a} != ${b}`);

test("easings: 0 -> 0, 1 -> 1, clamped, known midpoints, in/out/inOut monotonic (back overshoots)", () => {
  const names = ["linear", ...["quad", "cubic", "expo", "back"].flatMap((f) => ["In", "Out", "InOut"].map((k) => f + k))];
  assert.deepEqual(Object.keys(M.ease).sort(), names.sort());
  for (const n of names) {
    const f = M.ease[n];
    near(f(0), 0, 1e-12, n); near(f(1), 1, 1e-12, n);
    assert.equal(f(-3), f(0), n); assert.equal(f(7), f(1), n);
    if (!n.startsWith("back")) for (let i = 1; i <= 200; i++) assert.ok(f(i / 200) >= f((i - 1) / 200), `${n} monotonic at ${i}`);
  }
  near(M.ease.linear(0.25), 0.25); near(M.ease.quadIn(0.5), 0.25); near(M.ease.quadOut(0.5), 0.75); near(M.ease.quadInOut(0.5), 0.5);
  near(M.ease.cubicIn(0.5), 0.125); near(M.ease.cubicOut(0.5), 0.875); near(M.ease.cubicInOut(0.25), 0.0625);
  near(M.ease.expoOut(0.5), 1 - 2 ** -5); near(M.ease.expoIn(0.5), 2 ** -5); near(M.ease.expoInOut(0.5), 0.5);
  assert.ok(M.ease.backIn(0.2) < 0 && M.ease.backOut(0.8) > 1, "back overshoots");
  near(M.ease.backInOut(0.5), 0.5);
});

test("tween: clamped, numbers and arrays, ease by function or name, zero-length span is a step", () => {
  assert.equal(M.tween(0, 1, 2, 10, 20), 10); assert.equal(M.tween(3, 1, 2, 10, 20), 20); assert.equal(M.tween(1.5, 1, 2, 10, 20), 15);
  near(M.tween(1.5, 1, 2, 0, 100, M.ease.quadIn), 25); near(M.tween(1.5, 1, 2, 0, 100, "quadIn"), 25);
  assert.deepEqual(M.tween(0.5, 0, 1, [0, 10, 100], [10, 20, 0]), [5, 15, 50]);
  assert.equal(M.tween(0.99, 1, 1, 0, 9), 0); assert.equal(M.tween(1, 1, 1, 0, 9), 9);
  assert.throws(() => M.tween(0.5, 0, 1, [0], [1, 2]), /lengths/); assert.throws(() => M.tween(0.5, 0, 1, 0, 1, "bounce"), /unknown ease/);
});

test("keyframes: piecewise, clamped at both ends, the arriving keyframe's ease, arrays", () => {
  const k = [[1, 0], [2, 10, "quadIn"], [4, 30]];
  assert.equal(M.keyframes(0, k), 0); assert.equal(M.keyframes(1, k), 0); assert.equal(M.keyframes(2, k), 10);
  near(M.keyframes(1.5, k), 2.5); assert.equal(M.keyframes(3, k), 20); assert.equal(M.keyframes(4, k), 30); assert.equal(M.keyframes(9, k), 30);
  assert.deepEqual(M.keyframes(0.5, [[0, [0, 0]], [1, [2, 4]]]), [1, 2]);
  assert.equal(M.keyframes(5, [[1, 7]]), 7); assert.throws(() => M.keyframes(0, []), /at least one/);
});

test("stagger: local time per item", () => {
  assert.equal(M.stagger(0, 0.1, 1), 1); near(M.stagger(3, 0.1, 1), 0.7); near(M.stagger(2, 0.25, 1, 0.5), 0); assert.ok(M.stagger(4, 0.5, 1) < 0);
});

test("spring: from at t <= 0, settles to `to` (under, critical, over), velocity, pure", () => {
  for (const damping of [4, 10, 20, 40]) { // k 100, m 1: critical damping is 20
    const o = { stiffness: 100, damping, from: -50, to: 50 };
    assert.equal(M.spring(0, o), -50); assert.equal(M.spring(-1, o), -50);
    near(M.spring(12, o), 50, 1e-3, `damping ${damping}`);
    assert.equal(M.spring(0.37, o), M.spring(0.37, { ...o }), "pure");
  }
  assert.ok(M.spring(0.3, { damping: 4 }) > 1, "under-damped overshoots");
  for (let t = 0.01; t < 3; t += 0.01) { assert.ok(M.spring(t, { damping: 20 }) <= 1 + 1e-12); assert.ok(M.spring(t, { damping: 40 }) <= 1 + 1e-12); }
  near(M.spring(0.1, { damping: 20 }), 1 - Math.exp(-1) * 2); // critical: x0 (1 + w0 t) e^(-w0 t)
  // initial velocity: the first-step slope is ~ velocity
  near((M.spring(1e-6, { velocity: 30, from: 0, to: 0 }) - 0) / 1e-6, 30, 1e-2);
  assert.throws(() => M.spring(1, { stiffness: 0 }), /bad spring/);
});

test("countUp: decimals, prefix / suffix, separator, ease, rounding, no -0, locale independent", () => {
  assert.equal(M.countUp(1, 0, 1, 0, 1234567.891), "1,234,568");
  assert.equal(M.countUp(1, 0, 1, 0, 1234567.891, { decimals: 2, prefix: "$", suffix: " USD" }), "$1,234,567.89 USD");
  assert.equal(M.countUp(1, 0, 1, 0, 1234567, { separator: " " }), "1 234 567");
  assert.equal(M.countUp(1, 0, 1, 0, 1234567.5, { separator: "", decimals: 1, point: "," }), "1234567,5");
  assert.equal(M.countUp(0.5, 0, 1, 0, 100, { ease: "quadIn", suffix: "%" }), "25%");
  assert.equal(M.countUp(0, 0, 1, 0, 100), "0"); assert.equal(M.countUp(1, 0, 1, 0, 999), "999"); assert.equal(M.countUp(1, 0, 1, 0, 1000), "1,000");
  assert.equal(M.countUp(1, 0, 1, 0, -1234.5, { decimals: 1 }), "-1,234.5");
  assert.equal(M.countUp(1, 0, 1, 0, -0.004, { decimals: 2 }), "0.00");
  assert.equal(M.countUp(1, 0, 1, 0, 0.125, { decimals: 1 }), (0.125).toFixed(1));
});

test("pathPoint: M L H V Z, relative, Q / C, ends, angle, deterministic", () => {
  const L = "M0 0 L100 0 L100 100";
  assert.deepEqual(M.pathPoint(L, 0), { x: 0, y: 0, angle: 0 });
  assert.deepEqual(M.pathPoint(L, 0.25), { x: 50, y: 0, angle: 0 });
  assert.deepEqual(M.pathPoint(L, 0.75), { x: 100, y: 50, angle: 90 });
  assert.deepEqual(M.pathPoint(L, 1), { x: 100, y: 100, angle: 90 }); assert.deepEqual(M.pathPoint(L, 5), M.pathPoint(L, 1));
  assert.deepEqual(M.pathPoint("m10 10 h40 v40 h-40 z", 0.875), { x: 10, y: 30, angle: -90 });
  assert.deepEqual(M.pathPoint("M10 10 H50 V50", 0.5), { x: 50, y: 10, angle: 0 });
  const q = M.pathPoint("M0 0 Q50 100 100 0", 0.5); near(q.x, 50, 1e-6); near(q.y, 50, 1e-6); assert.ok(Math.abs(q.angle) < 3);
  const c = M.pathPoint("M0 0 C0 100 100 100 100 0", 0.5); near(c.x, 50, 1e-6); near(c.y, 75, 1e-6);
  near(M.pathPoint("M0 0 Q50 100 100 0", 1).x, 100); near(M.pathPoint("M0 0 C0 100 100 100 100 0", 0).angle, 90, 3);
  assert.deepEqual(M.pathPoint("M0 0 L10 0 M50 50 L60 50", 0.75), { x: 55, y: 50, angle: 0 }, "a move is not length");
  assert.deepEqual(M.pathPoint("M5 6", 0.5), { x: 5, y: 6, angle: 0 });
  assert.deepEqual(M.pathPoint(L, 0.3), M.pathPoint(L, 0.3));
  assert.throws(() => M.pathPoint("M0 0 A1 1 0 0 0 5 5", 1), /unsupported/);
});

test("window.motion and motion.ease cannot be replaced, changed or deleted", () => {
  const w = load(), m = w.motion;
  new Function("window", "window.motion = null; window.motion.ease = null; window.motion.ease.quadOut = null")(w); // sloppy: ignored
  assert.equal(w.motion, m);
  assert.throws(() => { w.motion = null; }, TypeError); // strict (this module): refused
  assert.throws(() => { Object.defineProperty(w, "motion", { value: 1 }); }, TypeError);
  assert.throws(() => { delete w.motion; }, TypeError); assert.equal(new Function("window", "return delete window.motion")(w), false);
  const d = Object.getOwnPropertyDescriptor(w, "motion"); assert.equal(d.writable, false); assert.equal(d.configurable, false);
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.ease));
  assert.throws(() => { m.ease.quadOut = () => 0; }, TypeError);
  assert.throws(() => { m.tween = () => 0; }, TypeError);
  assert.equal(m.ease.quadOut(0.5), 0.75);
});

test("the helpers use no clock, timer or randomness, and the snippet is small and in every wrapper", () => {
  assert.doesNotMatch(MOTION_SNIPPET, /Date|random|setTimeout|setInterval|requestAnimationFrame|performance/);
  assert.ok(MOTION_SNIPPET.length < 7000, `snippet ${MOTION_SNIPPET.length} bytes`);
  const meta = { duration: 1, size: { w: 100, h: 100 }, fonts: [], media: [] };
  const html = G.wrapperHtml({ html: "<html><body><script>window.duration=1;window.seek=function(){};</script></body></html>", meta, L: 30, D: 30 });
  const i = html.indexOf(MOTION_SNIPPET);
  assert.ok(i > 0 && i < html.indexOf("window.duration=1"), "injected before the graphic's scripts");
});

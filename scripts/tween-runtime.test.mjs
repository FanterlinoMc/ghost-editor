#!/usr/bin/env node
// node --test scripts/tween-runtime.test.mjs
// mac-65: the page's own tween runtime (scripts/lib/tween-runtime.js), which replaced GSAP. references/reel-json.md
// "Tween runtime". Three things are proven:
//   1. its eases are GSAP's: every ease name the engine writes, against GSAP 3.14.2's own values (fixtures/gsap-eases.json,
//      captured from gsap.min.js before it was removed), to 1e-9;
//   2. its semantics, on a hand-written page in Chrome: to() from the track's value at its start, restore before the first
//      tween, autoAlpha, repeat / yoyo, stagger, keyframes, modifiers (a count's text), onUpdate, the centred-element
//      reading (xPercent -50), the blur floor, non-numeric strings, plain-object targets, the timeline interface;
//   3. seek-determinism on built reels: the page after tl.totalTime(t) is the same whether t is sought in order, in a
//      shuffled order, or first on a fresh page (every computed style of every element compared as text).
// Chrome is needed for 2 and 3: skipped without it, a failure under CI=1 / REQUIRE_CHROME=1.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findPuppeteer, findChrome } from "./lib/browser.mjs";
import { makeProject, BUSY_BEAT, ROOM_BEAT } from "./lib/motion-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = fs.readFileSync(path.join(HERE, "lib", "tween-runtime.js"), "utf8");
const MUST = process.env.CI === "1" || process.env.REQUIRE_CHROME === "1";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tween-runtime-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

function vmRuntime() {
  const ctx = { console, Element: class {}, SVGElement: class {}, SVGSVGElement: class {} };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(RUNTIME, ctx);
  return ctx.tween;
}

test("every ease is GSAP 3.14.2's, to 1e-9 (fixtures/gsap-eases.json)", () => {
  const tw = vmRuntime(), fx = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "gsap-eases.json"), "utf8"));
  const bad = [];
  for (const [name, vals] of Object.entries(fx.eases)) {
    const f = tw.parseEase(name);
    fx.p.forEach((p, i) => { const d = Math.abs(f(p) - vals[i]); if (d > 1e-9) bad.push(`${name}(${p}) = ${f(p)}, GSAP ${vals[i]}`); });
  }
  assert.deepEqual(bad, []);
  assert.deepEqual(Object.keys(tw.unsupported), []);
  // an unknown ease is GSAP's default (power1.out), and listed
  assert.equal(tw.parseEase("wobble.out")(0.5), tw.parseEase("power1.out")(0.5));
  assert.ok(tw.unsupported["ease wobble.out"]);
});

test("plain-object targets, the timeline interface, seek order (no DOM)", () => {
  const tw = vmRuntime(), tl = tw.timeline({ paused: true });
  const o = { v: 0 }, seen = [];
  tl.fromTo(o, { v: 0 }, { v: 100, duration: 1, ease: "none", immediateRender: false, onUpdate: () => seen.push(o.v) }, 1);
  tl.to(o, { v: 50, duration: 1, ease: "none" }, 3);
  tl.set({}, {}, 5);
  assert.equal(tl.duration(), 5);
  assert.equal(tl.totalDuration(), 5);
  const at = (t) => { tl.totalTime(t, true); return o.v; };
  assert.deepEqual([at(4.5), at(0.5), at(1.5), at(2.5), at(3.5), at(0)], [50, 0, 50, 100, 75, 0]);   // to() starts from 100, its track's value at 3
  assert.equal(tl.time(), 0);
  tl.progress(0.5);
  assert.equal(tl.time(), 2.5);
  assert.equal(o.v, 100);
  assert.ok(seen.length >= 6, "onUpdate runs on every seek");
  assert.equal(tl.timeScale(), 1);
  assert.equal(tl.getChildren(true, true, true).length, 0);
  assert.equal(tl.pause(), tl);
});

// ---------- Chrome ----------
let browser = null, why = null;
try {
  const puppeteer = findPuppeteer(), chrome = findChrome();
  if (!puppeteer || !chrome) why = "no puppeteer-core / Chrome";
  else browser = await puppeteer.launch({ executablePath: chrome, headless: "shell", args: ["--no-sandbox", "--force-device-scale-factor=1"], defaultViewport: { width: 1080, height: 1920 } });
} catch (e) { why = `Chrome did not start: ${e.message}`; }
after(async () => { await browser?.close().catch(() => {}); });   // Chrome keeps the loop alive: closed when the tests are done
const skip = (t) => { if (MUST) assert.fail(why); t.skip(why); };

async function openDir(dir, file = "index.html") {
  const server = http.createServer((req, res) => {
    const f = path.join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || /\.(mp4|webm|mov|m4a|wav|mp3)$/i.test(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { window.__timelines = {}; });
  await page.goto(`http://127.0.0.1:${server.address().port}/${file}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!(window.__timelines && window.__timelines.main), { timeout: 15000 });
  // every face loaded before the first seek: a display:none text does not load its font, and a seek that shows it would
  // measure the fallback (a page-loading race, not a seek-order one; the renderer embeds the fonts before capture)
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map((f) => f.load().catch(() => null))); });
  return { page, close: async () => { await page.close(); server.close(); } };
}

const SEMANTICS = `<!doctype html><html><head><style>
  #root { position: relative; width: 1080px; height: 1920px; }
  .c { position: absolute; left: 50%; top: 100px; width: 400px; height: 100px; transform: translate(-50%, -50%); }
  .b { position: absolute; width: 10px; height: 10px; }
</style><script>${RUNTIME.replace(/<\/script/gi, "<\\/script")}</script></head><body><div id="root">
  <div id="a" class="b" style="opacity: 0.5"></div><div id="v" class="b"></div><div id="r" class="b"></div>
  <div class="s b"></div><div class="s b"></div><div class="s b"></div>
  <div id="k" class="b"></div><div id="cn" class="b"><span>0</span></div><div id="c" class="c"></div><div id="f" class="b"></div><div id="d" class="b">x</div>
</div><script>
  const tl = tween.timeline({ paused: true });
  tl.to("#a", { opacity: 1, duration: 1, ease: "none" }, 1);                                   // from the element's own 0.5
  tl.to("#a", { x: 100, duration: 1, ease: "none" }, 2);
  tl.set("#v", { autoAlpha: 0 }, 0);
  tl.fromTo("#v", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5, ease: "none", immediateRender: false }, 1);
  tl.fromTo("#r", { x: 0 }, { x: 100, duration: 1, ease: "none", repeat: 1, yoyo: true, immediateRender: false }, 0);
  tl.fromTo(".s", { y: 0 }, { y: 10, duration: 1, ease: "none", stagger: 0.5, immediateRender: false }, 0);
  tl.to("#k", { keyframes: [{ scale: 2, duration: 0.5, ease: "none" }, { scale: 1, duration: 0.5, ease: "none" }] }, 0);
  { const el = document.getElementById("cn").firstChild, o1 = { v: 0 }, o2 = { v: 10 };
    tl.fromTo(o1, { v: 0 }, { v: 10, duration: 1, ease: "none", immediateRender: false, modifiers: { v: (x) => { el.textContent = String(Math.round(x)); return x; } } }, 1);
    tl.fromTo(o2, { v: 10 }, { v: 20, duration: 1, ease: "none", immediateRender: false, modifiers: { v: (x) => { el.textContent = String(Math.round(x)); return x; } } }, 3); }
  tl.fromTo("#c", { scale: 0.5 }, { scale: 1, duration: 1, ease: "none", immediateRender: false }, 0);
  tl.fromTo("#f", { filter: "blur(8px)" }, { filter: "blur(0px)", duration: 1, ease: "back.out(3)", immediateRender: false }, 0);
  tl.fromTo("#d", { display: "block" }, { display: "none", duration: 1, immediateRender: false }, 1);
  tl.set({}, {}, 6);
  window.__timelines.main = tl;
</script></body></html>`;

test("semantics on a page (Chrome)", { timeout: 120000 }, async (t) => {
  if (!browser) return skip(t);
  const dir = path.join(root, "sem"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), SEMANTICS);
  const P = await openDir(dir);
  try {
    const at = (t) => P.page.evaluate((t) => {
      window.__timelines.main.totalTime(t, true);
      const cs = (id) => getComputedStyle(document.getElementById(id));
      const ss = [...document.querySelectorAll(".s")].map((e) => getComputedStyle(e).transform);
      return { a: [cs("a").opacity, cs("a").transform], v: [cs("v").opacity, cs("v").visibility], r: cs("r").transform, s: ss, k: cs("k").transform,
        cn: document.getElementById("cn").textContent, c: cs("c").transform, f: cs("f").filter, d: cs("d").display };
    }, t);
    const s0 = await at(0), s15 = await at(1.5), s05 = await at(0.5), s25 = await at(2.5), s35 = await at(3.5), s5 = await at(5), s03 = await at(0.3);
    // to(): from the element's own opacity (0.5), then the transform; before the first tween: the element's own value
    assert.deepEqual(s0.a, ["0.5", "none"]);
    assert.deepEqual(s15.a, ["0.75", "none"]);
    assert.deepEqual(s25.a, ["1", "matrix(1, 0, 0, 1, 50, 0)"]);
    // autoAlpha: hidden at 0 (the set at 0), inherit above
    assert.deepEqual(s0.v, ["0", "hidden"]);
    assert.deepEqual(s15.v, ["1", "visible"]);
    // repeat 1 + yoyo: there (1 s) and back (2 s)
    assert.equal(s05.r, "matrix(1, 0, 0, 1, 50, 0)");
    assert.equal(s15.r, "matrix(1, 0, 0, 1, 50, 0)");
    assert.equal(s25.r, "matrix(1, 0, 0, 1, 0, 0)");              // back at x 0: written as translate(0px, 0px), as GSAP does
    // stagger 0.5: the second starts at 0.5, the third at 1
    assert.deepEqual(s05.s, ["matrix(1, 0, 0, 1, 0, 5)", "matrix(1, 0, 0, 1, 0, 0)", "none"]);
    // keyframes: 1 -> 2 -> 1
    assert.equal(s03.k, "matrix(1.6, 0, 0, 1.6, 0, 0)");
    // two counts writing one text: before both "0", during the first its value, between "10", during the second its value
    assert.deepEqual([s0.cn, s15.cn, s25.cn, s35.cn, s5.cn], ["0", "5", "10", "15", "20"]);
    // a CSS translate(-50%, -50%) element: the tween's scale composes with xPercent / yPercent -50 (GSAP's reading)
    assert.equal(s05.c, "matrix(0.75, 0, 0, 0.75, -200, -50)");
    // back.out overshoots below blur(0): floored, never an invalid (dropped) value
    assert.ok(/^blur\((0|[\d.]+)px\)$/.test(s05.f) && parseFloat(s05.f.slice(5)) >= 0, s05.f);
    // a non-numeric string: its end value once its tween has started
    assert.deepEqual([s0.d, s15.d], ["block", "none"]);
    const un = await P.page.evaluate(() => Object.keys(window.tween.unsupported));
    assert.deepEqual(un, []);
  } finally { await P.close(); }
});

test("seek-determinism on built reels: in order, shuffled and fresh-page seeks give the same page (Chrome)", { timeout: 600000 }, async (t) => {
  if (!browser) return skip(t);
  const reels = [
    makeProject(path.join(root, "busy"), { beat: BUSY_BEAT, seconds: 10, style: "keynote-3" }),
    makeProject(path.join(root, "room"), { beat: ROOM_BEAT, seconds: 10, style: "keynote-3" }),
    makeProject(path.join(root, "clean"), { seconds: 6, style: "clean" }),
    makeProject(path.join(root, "podcast"), { seconds: 6, style: "podcast" }),
  ];
  // every property a tween writes, as computed, for every element (plus the SVG transform attribute and short texts)
  const snap = () => {
    const P = ["transform", "opacity", "visibility", "filter", "clip-path", "color", "background-position", "display", "transform-origin", "box-shadow",
      "text-shadow", "background-color", "font-weight", "width", "height", "--room-r", "--room-ix", "--room-ib"];
    const out = [];
    document.querySelectorAll("#root *").forEach((el) => {
      if (el.tagName === "VIDEO" || el.tagName === "AUDIO") return;
      const cs = getComputedStyle(el);
      out.push(P.map((p) => cs.getPropertyValue(p)).join(";"), el.getAttribute("transform") || "", el.getAttribute("stroke-dashoffset") || "", el.childElementCount ? "" : el.textContent.slice(0, 40));
    });
    return out.join("|");
  };
  const seekSnap = (page, t) => page.evaluate((t, s) => { window.__timelines.main.totalTime(t, true); return (0, eval)("(" + s + ")")(); }, t, snap.toString());
  for (const r of reels) {
    const P = await openDir(r.dir), ref = {};
    let times;
    try {   // a failed assertion must still close the page and its server (an open server keeps the test process alive)
      const D = await P.page.evaluate(() => window.__timelines.main.duration());
      times = Array.from({ length: 12 }, (_, i) => +((D * (i + 0.5)) / 12).toFixed(3));
      for (const tt of times) ref[tt] = await seekSnap(P.page, tt);
      for (const tt of [...times].reverse()) assert.equal(await seekSnap(P.page, tt), ref[tt], `${path.basename(r.dir)}: t=${tt} after a backwards seek`);
      for (const tt of [times[7], times[2], times[10], times[0]]) assert.equal(await seekSnap(P.page, tt), ref[tt], `${path.basename(r.dir)}: t=${tt} after a jump`);
    } finally { await P.close(); }
    for (const tt of [times[9], times[4]]) {
      const F = await openDir(r.dir);
      try { assert.equal(await seekSnap(F.page, tt), ref[tt], `${path.basename(r.dir)}: t=${tt} first on a fresh page`); } finally { await F.close(); }
    }
    assert.ok(!/gsap@|\bgsap\.(timeline|to|set|fromTo)\(/.test(fs.readFileSync(path.join(r.dir, "index.html"), "utf8")), "the page loads and calls no GSAP");
  }
});

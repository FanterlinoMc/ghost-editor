// node --test scripts/lib/graphic.test.mjs
// Prompt Motion graphic (PM2), fast and offline: the static rules (exact reason texts, first-failing order, scopes),
// the wrapper page (CSP, data-no-timeline, the hf-seek bridge run in a vm), the log rules, the cache key, the frame map,
// the Node offline preload and the Chrome shim. No hyperframes render here (scripts/graphic-isolation-check.mjs and
// scripts/graphic-determinism.mjs do real renders, outside the gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as G from "./graphic.mjs";
import * as RR from "./graphic-render.mjs";
import { DESIGNER_FONTS } from "./motion-graphics.mjs";
import { goodGraphic, insertGraphic, fetchAtRender, throwsInSeek } from "./graphic-fixtures.mjs";
const NR = { root: false }; // probe tests: the same under any uid (the gate may run as root)

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = "assets/graphics/graphic.html";
const insp = (html, o = {}) => G.inspectGraphic(html, o);
const first = (html, o) => { const r = insp(html, o); return r.ok ? "OK" : r.reasons[0]; };
// a minimal valid file with extra pieces in head / body / script / style
const doc = ({ head = "", body = "", script = "", style = "", dur = "window.duration = 2;", seek = "window.seek = function (t) {};" } = {}) =>
  `<!doctype html><html><head><style>${style}</style>${head}</head><body>${body}<script>${dur}\n${seek}\n${script}</script></body></html>`;
const R = (code, args = {}) => G.reason(code, { html: SRC, W: 1080, H: 1920, ...args });

test("the good fixture passes, with its meta", () => {
  const r = insp(goodGraphic());
  assert.equal(r.ok, true, r.reasons.join());
  assert.deepEqual(r.meta, { duration: 2, size: { w: 1080, h: 1080 }, fonts: ["Montserrat"], media: [] });
  assert.equal(insp(insertGraphic(), { mode: "insert" }).ok, true);
  assert.equal(insp(fetchAtRender()).ok, true, "a dynamic load passes the scan (the lock catches it)");
  assert.equal(insp(throwsInSeek()).ok, true);
  assert.equal(first(doc()), "OK");
});

test("G1-G4: src, file, size, document", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-test-"));
  fs.mkdirSync(path.join(proj, "assets", "graphics", "media"), { recursive: true });
  assert.equal(first(null, { projectDir: proj, html: "assets/graphics/../x.html" }), G.reason("G1", { html: "assets/graphics/../x.html" }));
  assert.equal(first(null, { projectDir: proj, html: "assets/graphics/Bad.html" }), G.reason("G1", { html: "assets/graphics/Bad.html" }));
  assert.equal(first(null, { projectDir: proj, html: "assets/graphics/nope.html" }), G.reason("G2", { html: "assets/graphics/nope.html" }));
  fs.writeFileSync(path.join(proj, SRC), doc());
  assert.equal(first(null, { projectDir: proj, html: SRC }), "OK");
  assert.equal(first(Buffer.alloc(2097153, 32)), R("G3", { bytes: 2097153 }));
  assert.equal(first(Buffer.from([0x3c, 0xff, 0xfe])), R("G4"));
  assert.equal(first("<html><body></body></html>"), R("G4"));
  assert.equal(first(doc({ body: "<head></head>" })), R("G4"));
  // G15-G17 media against the project
  assert.equal(first(doc({ body: '<img src="assets/graphics/media/a.png">' }), { projectDir: proj, html: SRC }), G.reason("G16", { path: "assets/graphics/media/a.png" }));
  fs.writeFileSync(path.join(proj, "assets/graphics/media/a.png"), Buffer.alloc(10));
  const ok = insp(doc({ body: '<img src="assets/graphics/media/a.png">' }), { projectDir: proj, html: SRC });
  assert.equal(ok.ok, true);
  assert.equal(ok.meta.media[0].path, "assets/graphics/media/a.png");
  fs.writeFileSync(path.join(proj, "assets/graphics/media/big.png"), Buffer.alloc(4194305));
  assert.equal(first(doc({ body: '<img src="assets/graphics/media/big.png">' }), { projectDir: proj, html: SRC }), G.reason("G17", { path: "assets/graphics/media/big.png", bytes: 4194305 }));
  fs.symlinkSync(path.join(proj, SRC), path.join(proj, "assets/graphics/media/link.png"));
  assert.equal(first(doc({ body: '<img src="assets/graphics/media/link.png">' }), { projectDir: proj, html: SRC }), G.reason("G16o", { path: "assets/graphics/media/link.png" }));
  assert.equal(first(doc({ body: '<img srcset="assets/graphics/media/a.png 2x">' }), { projectDir: proj, html: SRC }), R("G15", { value: "assets/graphics/media/a.png 2x" }));
  const nine = Array.from({ length: 9 }, (_, i) => { fs.writeFileSync(path.join(proj, `assets/graphics/media/m${i}.png`), "x"); return `<img src="assets/graphics/media/m${i}.png">`; }).join("");
  assert.equal(first(doc({ body: nine }), { projectDir: proj, html: SRC }), R("G17n", { n: 9 }));
  assert.equal(first(doc({ body: nine })), R("G17n", { n: 9 }), "the count needs no project files");
});

test("G5-G14, G19, G20, G25-G28: one refusal each, exact text and <match>", () => {
  const cases = [
    ["G5", doc({ head: '<script src="x.js"></script>' })],
    ["G5", doc({ head: '<script type="module">1</script>' })],
    ["G6", doc({ head: '<link rel="stylesheet" href="a.css">' })],
    ["G7", doc({ style: "@import 'a.css';" })],
    ["G7", doc({ style: "div { background: url(https://x/a.png) }" })],
    ["G7", doc({ body: '<div style="background:url(&quot;http://x&quot;)"></div>' })],
    ["G7", doc({ style: 'div { background: image-set("a.png" 1x) }' })],
    ["G8", doc({ script: "fetch('x')" }), { match: "fetch(" }],
    ["G8", doc({ script: "new WebSocket(u)" }), { match: "WebSocket" }],
    ["G8", doc({ script: "var p = new RTCPeerConnection()" }), { match: "RTCPeerConnection" }],
    ["G8", doc({ script: "import.meta.url" }), { match: "import.meta" }],
    ["G9", doc({ script: "eval('1')" }), { match: "eval(" }],
    ["G9", doc({ script: "[].constructor.constructor('x')" }), { match: ".constructor.constructor" }],
    ["G10", doc({ script: "setTimeout(f, 1)" }), { match: "setTimeout" }],
    ["G10", doc({ script: "requestAnimationFrame(f)" }), { match: "requestAnimationFrame" }],
    ["G11", doc({ script: "var d = new Date()" }), { match: "new Date" }],
    ["G11", doc({ script: "performance.now()" }), { match: "performance.now" }],
    ["G11", doc({ script: "e.timeStamp" }), { match: ".timeStamp" }],
    ["G12", doc({ script: "Math.random()" })],
    ["G13", doc({ style: "@keyframes spin { }" }), { match: "@keyframes" }],
    ["G13", doc({ style: "div { transition: all 1s }" }), { match: "transition:" }],
    ["G13", doc({ script: "el.animate([], 1)" }), { match: ".animate(" }],
    ["G13", doc({ body: '<svg><animate attributeName="x"/></svg>' }), { match: "<animate" }],
    ["G14", doc({ body: "<video></video>" }), { match: "<video" }],
    ["G14", doc({ body: "<IFRAME></IFRAME>" }), { match: "<IFRAME" }],
    ["G14", doc({ head: '<meta http-equiv="refresh" content="0">' }), { match: '<meta http-equiv="refresh' }],
    ["G19", doc({ script: "gsap.to(x, {})" }), { match: "gsap." }],
    ["G19", doc({ body: "<!-- GreenSock -->" }), { match: "GreenSock" }],
    ["G20", doc({ script: "c.getContext('webgl')" })],
    ["G25", doc({ script: "localStorage.x = 1" }), { match: "localStorage.x" }],
    ["G25", doc({ script: "location = 'x'" }), { match: "location =" }],
    ["G25", doc({ script: "window.open(u)" }), { match: "window.open" }],
    ["G25", doc({ script: "window['fe' + 'tch']" }), { match: "window[" }],
    ["G25", doc({ script: "open(u)" }), { match: "open(" }],
    ["G26", doc({ script: "window.rng = function () {}" })],
    ["G27", doc({ body: '<a href="https://x">x</a>' }), { match: '<a href=' }],
    ["G27", doc({ body: '<a href="#a" ping="https://x">x</a>' }), { match: " ping=" }],
    ["G28", doc({ script: "el['ani' + 'mate']()" }), { match: "l['ani' +" }],
    ["G28", doc({ script: "el[`x${a}`]" }), { match: "l[`x${" }],
  ];
  for (const [code, html, args = {}] of cases) assert.equal(first(html), R(code, args), `${code}: ${html.slice(0, 120)}`);
});

test("G15, G18, G21-G24: images, fonts, seek, duration, size", () => {
  assert.equal(first(doc({ body: '<img src="https://x/a.png">' })), R("G15", { value: "https://x/a.png" }));
  assert.equal(first(doc({ body: '<svg><image href="http://x/a.png"/></svg>' })), R("G15", { value: "http://x/a.png" }));
  assert.equal(first(doc({ body: '<svg><use href="#a"/></svg><img src="data:image/png;base64,AA">' })), "OK");
  assert.equal(first(doc({ style: "p { font-family: 'Comic Sans MS', serif }" })), R("G18", { name: "Comic Sans MS" }));
  assert.equal(first(doc({ style: "p { font: bold 40px/1.2 Arial }" })), R("G18", { name: "Arial" }));
  assert.equal(first(doc({ script: "ctx.font = '700 48px Papyrus'" })), R("G18", { name: "Papyrus" }));
  assert.equal(first(doc({ body: '<svg><text font-family="Wingdings">x</text></svg>' })), R("G18", { name: "Wingdings" }));
  const okFonts = insp(doc({ style: "@font-face { font-family: 'Mine'; src: url(data:font/woff2;base64,AA) } p { font-family: Mine, var(--f), 'instrument serif' !important } h1 { font: 800 1em/1 Inter, sans-serif }", script: "ctx.font = '48px Oswald'" }));
  assert.equal(okFonts.ok, true, okFonts.reasons.join());
  assert.deepEqual(okFonts.meta.fonts, ["Instrument Serif", "Inter", "Oswald"]);
  assert.equal(first(doc({ seek: "function seek(t) {}" })), R("G21"));
  assert.equal(first(doc({ dur: "window.duration = 40;" })), R("G22"));
  assert.equal(first(doc({ dur: "window.duration = .5;" })), R("G22"));
  assert.equal(first(doc({ dur: "window.duration = 2; window.duration = 3;" })), R("G22"));
  assert.equal(first(doc({ dur: "window.duration = 2" })), "OK", "end of line counts as the end of the statement");
  assert.equal(first(doc({ dur: "window.duration = 2\r" })), "OK", "CRLF / CR are normalised first");
  assert.equal(first(doc({ script: "window.size = { w: 1081, h: 100 };" })), R("G23"));
  assert.equal(first(doc({ script: "window.size = { w: 1080, h: 2000 };" })), R("G23"));
  assert.equal(first(doc({ script: "window.size = { w: 540, h: 960, };" })), "OK");
  assert.equal(first(doc({ script: "window.size = { w: 540, h: 960 };" }), { mode: "insert" }), R("G24", { w: 540, h: 960 }));
  assert.equal(insp(doc(), { mode: "insert" }).ok, true, "no window.size: the canvas");
});

test("order, scopes and unicode spaces", () => {
  assert.equal(first(doc({ script: "Math.random(); fetch(u)" })), R("G8", { match: "fetch(" }), "first failing rule in table order");
  assert.equal(first(doc({ body: "<p>We fetch (data) and setTimeout</p>" })), "OK", "page text is not scanned by the JS rules");
  assert.equal(first(doc({ script: "// setTimeout is not used" })), R("G10", { match: "setTimeout" }), "comments are scanned");
  assert.equal(first(doc({ script: "fetch (u)" })), R("G8", { match: "fetch (" }), "U+00A0 is a space");
  assert.equal(first(doc({ body: "<p>animation: none</p>" })), "OK", "STYLE is <style> and style=\"\" only");
  assert.equal(first(doc({ body: "<p>&#115;etTimeout</p>" })), "OK");
  assert.equal(G.inspectGraphic(doc(), {}).reasons.length, 0);
});

test("P1-P3 placement", () => {
  assert.deepEqual(G.checkPlacement({ mode: "corner" }), [G.reason("P1", { v: "corner" })]);
  assert.deepEqual(G.checkPlacement({ window: 61 }), [G.reason("P2", { s: 61 })]);
  assert.deepEqual(G.checkPlacement({ box: { x: 1000, y: 0, w: 1000, h: 100 } }), [G.reason("P3", { W: 1080, H: 1920 })]);
  assert.deepEqual(G.checkPlacement({ box: { x: 0, y: 0, w: 500, h: 500 }, window: 3 }), []);
  assert.deepEqual(G.checkPlacement({ mode: "insert", box: { x: 5000, y: 0, w: 10, h: 10 } }), []);
});

test("frames: hold, loop, cut, warnings", () => {
  const f = G.graphicFrames({ duration: 2, fps: 30 });
  assert.deepEqual([f.L, f.inF, f.D, f.after], [60, 0, 60, "hold"]);
  assert.equal(G.mapFrame(70, { inF: 0, D: 60, after: "hold" }), 59);
  assert.equal(G.mapFrame(70, { inF: 0, D: 60, after: "loop" }), 10);
  const c = G.graphicFrames({ duration: 2, fps: 30, inS: 0.5, after: "cut", frames: 90 });
  assert.equal(c.L, 45);
  assert.deepEqual(c.warnings, [G.reason("GW2", { a: 3, b: 1.5 })]);
  assert.deepEqual(G.graphicFrames({ duration: 2, after: "bounce" }).warnings, [G.reason("GW3", { v: "bounce" })]);
});

test("wrapper: CSP, root, fonts, rng before the graphic, media inlined, insert background", () => {
  const meta = insp(goodGraphic()).meta;
  const html = G.wrapperHtml({ html: goodGraphic(), meta, mode: "overlay", fps: 30, L: 75, inF: 0, D: 60, after: "hold" });
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'">`));
  assert.ok(html.includes('<div id="graphic-root" data-composition-id="graphic" data-width="1080" data-height="1080" data-start="0" data-duration="2.5" data-no-timeline>'));
  assert.ok(html.includes('add.call(window, "hf-seek"'));
  // integrity order: the pre-script (saved console.error, navigate trap, hf-seek listener) comes before ANY graphic script
  const pre = html.indexOf("var err = console.error.bind(console)");
  assert.ok(pre > 0 && pre < html.indexOf("window.rng = window.rng ||") && pre < html.indexOf('id="graphic-root"'), "pre-script first");
  assert.ok(html.indexOf("window.__graphicRefuse;") > html.indexOf('id="graphic-root"'), "load checks after the body");
  assert.ok(/@font-face \{ font-family: "Montserrat"; src: url\(data:font\/woff2;base64,/.test(html));
  assert.ok(!html.includes('font-family: "Inter"'), "only the families the file uses");
  assert.ok(html.indexOf("window.rng = function (seed)") < html.indexOf("window.rng = window.rng ||"), "the engine rng is defined first");
  assert.ok(html.includes("background: transparent"));
  const ins = G.wrapperHtml({ html: insertGraphic(), meta: insp(insertGraphic(), { mode: "insert" }).meta, mode: "insert", fps: 30, L: 60, inF: 0, D: 60, after: "hold" });
  assert.ok(ins.includes("background: #000") && ins.includes('data-width="1080" data-height="1920"'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-wrap-"));
  fs.mkdirSync(path.join(proj, "assets/graphics/media"), { recursive: true });
  fs.writeFileSync(path.join(proj, "assets/graphics/media/p.png"), Buffer.from([1, 2, 3]));
  const withImg = doc({ body: '<img src="assets/graphics/media/p.png">' });
  const m2 = insp(withImg, { projectDir: proj, html: SRC }).meta;
  const w2 = G.wrapGraphic({ buildDir: path.join(proj, "build"), id: "graphic", key: "ab".repeat(32), html: withImg, meta: m2, fps: 30, L: 60, inF: 0, D: 60 });
  assert.equal(w2.dir, path.join(proj, "build", "graphics", "graphic-abababababababab"));
  assert.ok(fs.readFileSync(w2.file, "utf8").includes('<img src="data:image/png;base64,AQID">'));
  // the build's @font-face loop and this one name families and ranges the same way
  const build = fs.readFileSync(path.join(here, "..", "build.mjs"), "utf8");
  for (const [k, v] of Object.entries(G.RANGES)) assert.ok(build.includes(`${k.includes("-") ? `"${k}"` : k}: "${v}"`), `RANGES.${k} matches build.mjs`);
  assert.ok(build.includes(JSON.stringify(G.FONT_NAMES).slice(1, 30).replace(/":"/g, '": "')), "FONT_NAMES matches build.mjs");
});

// run the bridge in a vm with a fake window and a tiny fake DOM: preScript, then a "graphic" step, then postScript.
// The default seek writes "t=<t>" into the root's markup (pure); seen records every call.
function bridge({ seek, duration = 2, size = { w: 1080, h: 1080 }, winDuration = duration, winSize = size, L = 90, inF = 0, D = 60, after = "hold", nav = true, graphic = "" }) {
  const listeners = {}, errors = [], seen = [], navListeners = [];
  const ctx = vm.createContext({ console: { error: (m) => errors.push(m) } });
  vm.runInContext(`
    function EventTarget() {} function Element() {} function Document() {} function HTMLCanvasElement() {}
    Object.defineProperty(Element.prototype, "innerHTML", { get: function () { return this._html; }, configurable: true });
    Element.prototype.getAttribute = function (n) { return this["_" + n] || null; };
    HTMLCanvasElement.prototype.toDataURL = function () { return this._px; };
    var root = Object.create(Element.prototype); root._html = "";
    var canvas = Object.create(HTMLCanvasElement.prototype); canvas._px = "blank";
    var document = Object.create(Document.prototype);
    document.documentElement = Object.create(Element.prototype); document.body = Object.create(Element.prototype);
    Document.prototype.getElementById = function (id) { return id === "graphic-root" ? root : null; };
    Document.prototype.querySelectorAll = function (q) { return q === "canvas" ? [canvas] : []; };
    var window = this;`, ctx);
  const window = ctx;
  Object.assign(window, { duration: winDuration, size: winSize });
  window.seek = seek === undefined ? (t) => { seen.push(t); ctx.root._html = "t=" + t; } : seek;
  if (nav) window.navigation = { tag: "nav" };
  ctx.EventTarget.prototype.addEventListener = function (n, f) { if (this === ctx.window || this === window) listeners[n] = f; else if (this === window.navigation) navListeners.push(f); };
  vm.runInContext(G.preScript({ fps: 30, L, inF, D, after }), ctx);
  if (graphic) vm.runInContext(graphic, ctx);
  vm.runInContext(G.postScript({ duration, size }), ctx);
  return { fire: (time) => listeners["hf-seek"]({ detail: { time } }), seen, errors, window, ctx,
    navigate: () => { let prevented = false; navListeners.forEach((f) => f({ cancelable: true, preventDefault: () => (prevented = true) })); return prevented; } };
}
test("bridge: frame map, refusals (R3, R4, R5, R11), integrity against the graphic", () => {
  const b = bridge({});
  b.fire(0);
  assert.equal(b.seen.length, 3 * G.ORDER_SAMPLES + 1, "the first hf-seek runs the seek-order check first (8 frames x 3 orders)");
  assert.deepEqual(b.seen.slice(0, G.ORDER_SAMPLES), [0, 8, 17, 25, 34, 42, 51, 59].map((k) => k / 30), "forward over frames 0..D-1");
  b.seen.length = 0;
  b.fire(0); b.fire(1); b.fire(2.5);
  assert.deepEqual(b.seen, [0, 1, 59 / 30], "hold: past the end shows the last frame");
  const l = bridge({ after: "loop", inF: 15 });
  l.fire(0); l.seen.length = 0;
  l.fire(2); assert.deepEqual(l.seen, [15 / 30], "loop: (in + j) mod D");
  assert.deepEqual(b.errors, []);
  const t = bridge({ seek: (x) => { if (x >= 1) throw new Error("boom"); } });
  t.fire(0.5); t.fire(1); t.fire(1.5);
  assert.deepEqual(t.errors, ["GRAPHIC-REFUSED: seek(1.133) threw: boom"], "reported once (the order check met the first throwing frame, 34/30)");
  // R6 at any length: state carried between seeks, in the markup or in a canvas
  let calls = 0;
  const st = bridge({ D: 30, seek: (x) => { calls++; st2.root._html = "n=" + calls + " t=" + x; } });
  var st2 = st.ctx;
  st.fire(0);
  assert.deepEqual(st.errors, ["GRAPHIC-REFUSED: seek order: frame 0 (t=0s) depends on the seeks before it"]);
  let acc = 0;
  const cv = bridge({ seek: (x) => { acc += x; cv.ctx.canvas._px = "px" + acc; cv.ctx.root._html = "t=" + x; } });
  cv.fire(0);
  assert.match(cv.errors[0] || "", /^GRAPHIC-REFUSED: seek order: frame \d+ \(t=[\d.]+s\) depends on the seeks before it$/, "canvas pixels are compared too");
  let c2 = 0;
  const forge = bridge({ seek: (x) => { c2++; forge.ctx.root._html = "n=" + c2; }, graphic: "HTMLCanvasElement.prototype.toDataURL = function () { return 'same'; }; Object.defineProperty(Element.prototype, 'innerHTML', { get: function () { return 'same'; } }); Document.prototype.getElementById = function () { return null; };" });
  forge.fire(0);
  assert.match(forge.errors[0] || "", /seek order: frame 0/, "replacing innerHTML / toDataURL / getElementById does not hide the state");
  const pure = bridge({ D: 1 });
  pure.fire(0);
  assert.deepEqual(pure.errors, [], "a one-frame graphic is fine");
  const p = bridge({ seek: () => ({ then() {} }) }); p.fire(0.1);
  assert.deepEqual(p.errors, ["GRAPHIC-REFUSED: seek(0.1) returned a Promise"]);
  assert.deepEqual(bridge({ seek: null }).errors, ["GRAPHIC-REFUSED: window.seek is not a function"]);
  assert.deepEqual(bridge({ winDuration: 3 }).errors, ["GRAPHIC-REFUSED: window.duration / window.size changed at load (static 2s 1080x1080, at load 3s 1080x1080)"]);
  const n = bridge({});
  assert.equal(n.navigate(), true, "a page-started navigation is cancelled");
  assert.deepEqual(n.errors, ["GRAPHIC-REFUSED: navigated"]);
  assert.deepEqual(bridge({ nav: false }).errors, ["GRAPHIC-REFUSED: navigation trap unavailable (no window.navigation)"]);
  // a graphic that stubs console.error and tries to replace the refusal function is still reported
  const tamper = bridge({ seek: () => { throw new Error("line1\nline2"); }, graphic: "Number.prototype.toFixed = function () { return 'X'; }; String.prototype.split = function () { return ['Y']; }; String = function () { return 'Z'; };" });
  tamper.fire(1);
  assert.deepEqual(tamper.errors, ["GRAPHIC-REFUSED: seek(0) threw: line1"], "toFixed / split / String replaced by the graphic do not change the refusal text");
  const silenced = bridge({ seek: () => { throw new Error("hidden"); }, graphic: "console.error = function () {}; try { window.__graphicRefuse = function () {}; } catch (e) {} EventTarget.prototype.addEventListener = function () {}; HTMLCanvasElement.prototype.toDataURL = function () { return 'same'; }; Object.defineProperty(Element.prototype, 'innerHTML', { get: function () { return 'same'; } });" });
  silenced.fire(0);
  assert.deepEqual(silenced.errors, ["GRAPHIC-REFUSED: seek(0) threw: hidden"]);
  const r5 = bridge({ graphic: "try { window.__graphicRefuse = function () {}; } catch (e) {} try { Object.defineProperty(window, '__graphicRefuse', { value: function () {} }); } catch (e) {} window.duration = 9;" });
  assert.deepEqual(r5.errors, ["GRAPHIC-REFUSED: window.duration / window.size changed at load (static 2s 1080x1080, at load 9s 1080x1080)"], "the refusal function cannot be replaced");
  const nav2 = bridge({ graphic: "console.error = function () {};" });
  assert.equal(nav2.navigate(), true);
  assert.deepEqual(nav2.errors, ["GRAPHIC-REFUSED: navigated"]);
});

test("log rules: R1, R2, R3, R4, R5, R11, R13 lines", () => {
  const log = [
    "\x1b[31m[Browser:ERROR] Refused to load the image 'https://example.com/a.png' because it violates the following Content Security Policy directive: \"img-src data:\".\x1b[0m",
    "vendor: blocked https://fonts.googleapis.com/css2?family=X",
    "[Browser:PAGEERROR] ReferenceError: x is not defined",
    "[Browser:ERROR] GRAPHIC-REFUSED: window.seek is not a function",
    "[Browser:ERROR] GRAPHIC-REFUSED: seek(1.2) threw: boom",
    "[Browser:ERROR] GRAPHIC-REFUSED: seek(0.1) returned a Promise",
    "[Browser:ERROR] GRAPHIC-REFUSED: window.duration / window.size changed at load (static 2s 1080x1080, at load 3s 1080x1080)",
    "[Browser:ERROR] GRAPHIC-REFUSED: navigated",
    "[Browser:ERROR] GRAPHIC-REFUSED: seek order: frame 12 (t=0.4s) depends on the seeks before it",
    "[INFO] nothing",
  ].join("\n");
  assert.deepEqual(RR.scanLog(log).map((x) => x.text), [
    G.reason("R1", { url: "https://example.com/a.png" }), G.reason("R1", { url: "https://fonts.googleapis.com/css2?family=X" }),
    G.reason("R2", { message: "ReferenceError: x is not defined" }), G.reason("R3"), G.reason("R4", { t: "1.2", message: "boom" }),
    G.reason("R4p", { t: "0.1" }), G.reason("R5", { a: "2s 1080x1080", b: "3s 1080x1080" }), G.reason("R11"), G.reason("R6o", { k: "12", t: "0.4" }),
  ]);
  // HyperFrames' own blob worker on the render server's origin is skipped; nothing else hides behind it
  const blob = (port, extra = "") => `[Browser:ERROR] Creating a worker from 'blob:http://localhost:${port}/2a57f48d-56eb-427a-9417-b714ca18358e' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'worker-src' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.${extra}`;
  const srv = "graphic-offline: render server localhost:61626";
  assert.deepEqual(RR.scanLog([srv, blob(61626)].join("\n")), [], "HyperFrames' own blob worker");
  assert.equal(RR.scanLog(blob(61626)).length, 1, "no recorded render server: refused");
  assert.equal(RR.scanLog([srv, blob(5000)].join("\n")).length, 1, "another origin: refused");
  assert.equal(RR.scanLog([srv, blob(61626, " Loading the image 'https://x/y.png' violates the following Content Security Policy directive")].join("\n")).length, 1, "text appended: refused");
  assert.deepEqual(RR.scanLog([srv, blob(61626), "[Browser:ERROR] Loading the image 'https://x/y.png' violates the following Content Security Policy directive: \"img-src data:\"."].join("\n")).map((x) => x.code), ["R1"], "a real violation next to it still refuses");
  assert.equal(RR.scanLog([srv, blob(61626).replace("blob:http://localhost:61626", "blob:https://evil.com")].join("\n")).length, 1);
  assert.equal(RR.launchedChrome("[BrowserManager] Browser launched (HeadlessChrome/152.0.7977.30, screenshot, gl=x)"), "152.0.7977.30");
  assert.equal(RR.compareFrames(["a", "b"], ["a", "b"], 30), null);
  assert.equal(RR.compareFrames(["a", "b", "c"], ["a", "x", "c"], 30), G.reason("R6", { i: 1, t: "0.033" }));
  assert.equal(RR.compareFrames(["a"], ["a", "b"], 30), G.reason("R6n", { a: 1, b: 2 }));
  assert.equal(RR.budgetFor(60), 29);
  assert.equal(RR.budgetFor(900), 155);
});

test("cache key v3: canonical JSON, stable, sensitive to every field, media order free", () => {
  const base = { html: "<html>x</html>", media: [["assets/graphics/media/b.png", "bb"], ["assets/graphics/media/a.png", "aa"]], fonts: ["Oswald", "Inter"], chrome: "152.0.7977.30", ffmpeg: "7.1.1", platform: "darwin-arm64", fps: 30, w: 1080, h: 1080, mode: "overlay", frames: 60, inF: 0, after: "hold" };
  const k = G.graphicKey(base);
  assert.equal(k.json, `{"after":"hold","chrome":"152.0.7977.30","ffmpeg":"7.1.1","fonts":["Inter","Oswald"],"fps":30,"frames":60,"h":1080,"html":"${G.sha256("<html>x</html>")}","in":0,"media":[["assets/graphics/media/a.png","aa"],["assets/graphics/media/b.png","bb"]],"mode":"overlay","platform":"darwin-arm64","quality":"looks","renderer":"hyperframes@0.8.81","v":3,"w":1080}`);
  assert.equal(k.key, G.sha256(k.json));
  assert.equal(G.graphicKey({ ...base, media: [...base.media].reverse(), fonts: ["Inter", "Oswald"] }).key, k.key);
  for (const [f, v] of Object.entries({ html: "<html>y</html>", media: [], fonts: ["Inter"], chrome: "153.0.0.1", ffmpeg: "7.1.2", platform: "linux-x64", quality: "draft", fps: 25, w: 1078, h: 1078, mode: "insert", frames: 61, inF: 1, after: "loop" }))
    assert.notEqual(G.graphicKey({ ...base, [f]: v }).key, k.key, `key changes with ${f}`);
  assert.throws(() => G.graphicKey({ ...base, fps: 29.97 }), /integer/);
  assert.equal(G.outputName("counter", k.key, "overlay"), `counter-${k.key.slice(0, 16)}.webm`);
  assert.equal(G.canonicalJson({ b: "é", a: [1, { d: 1, c: 2 }] }), '{"a":[1,{"c":2,"d":1}],"b":"\\u00e9"}');
});

test("offline preload: non-loopback refused and logged, loopback open, render origins recorded", async () => {
  const srv = http.createServer((q, r) => r.end("ok")).listen(0, "127.0.0.1");
  await new Promise((r) => srv.on("listening", r));
  const port = srv.address().port;
  const js = `const http = require("http"); const { get } = require("https"); const net = require("net");
    (async () => {
      const out = [];
      out.push(await (await fetch("http://127.0.0.1:${port}/")).text());
      try { await fetch("http://192.0.2.1:9/x", { signal: AbortSignal.timeout(3000) }); out.push("fetch open"); } catch (e) { out.push("fetch refused"); }
      await new Promise((ok) => get("https://192.0.2.1/i.png", () => { out.push("https open"); ok(); }).on("error", () => { out.push("https refused"); ok(); }));
      await new Promise((ok) => { const s = net.connect(443, "192.0.2.1"); s.on("connect", () => { out.push("net open"); ok(); }); s.on("error", () => { out.push("net refused"); ok(); }); });
      const s2 = http.createServer().listen(0, "127.0.0.1", () => { out.push("origins " + process.env.GRAPHIC_RENDER_ORIGINS.split(";").length); s2.close(); console.log(out.join(",")); });
    })();`;
  const r = await new Promise((ok) => { const c = spawn(process.execPath, ["--require", RR.PRELOAD, "-e", js], { env: { ...process.env, NODE_OPTIONS: "" } }); let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d)); c.on("close", () => ok({ o, e })); });
  srv.close();
  assert.equal(r.o.trim(), "ok,fetch refused,https refused,net refused,origins 2");
  assert.match(r.e, /vendor: blocked http:\/\/192\.0\.2\.1:9\/x/);
  assert.match(r.e, /vendor: blocked https:\/\/192\.0\.2\.1\/i\.png/);
  assert.match(r.e, /vendor: blocked tcp:\/\/192\.0\.2\.1:443/);
  assert.match(r.e, /graphic-offline: render server localhost:\d+/);
});

test("Chrome shim: our flags LAST, only exact loopback origins, the PID marker; probe (stubbed): R12 texts", () => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-shim-"));
  const fake = path.join(dir, "fake-chrome");
  fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });
  const shim = RR.chromeShim(path.join(dir, "s"), fake, { uid: 1000 });
  const idBin = path.join(dir, "idbin"); // `id -u` says 1000: the same result when the gate runs as root
  fs.mkdirSync(idBin);
  fs.writeFileSync(path.join(idBin, "id"), "#!/bin/sh\necho 1000\n", { mode: 0o755 });
  const args = (env) => spawnSync(shim, ["--headless", "--proxy-server=direct://", "x"], { encoding: "utf8", env: { PATH: `${idBin}:${process.env.PATH}`, ...env } }).stdout.trim().split("\n");
  const a = args({});
  assert.deepEqual(a.slice(0, 3), ["--headless", "--proxy-server=direct://", "x"], "the caller's arguments first");
  assert.deepEqual(a.slice(3), [...RR.CHROME_FLAGS, "--proxy-bypass-list=<-loopback>"], "ours last: Chrome keeps the last copy of a switch");
  assert.equal(args({ GRAPHIC_RENDER_ORIGINS: "localhost:5000;127.0.0.1:5000" }).pop(), "--proxy-bypass-list=<-loopback>;localhost:5000;127.0.0.1:5000");
  assert.equal(args({ GRAPHIC_RENDER_ORIGINS: "*;localhost:5000;evil.com:80;127.0.0.1:123456;127.0.0.1:99;localhost:;localhost:5x;<loopback>;localhost:*" }).pop(),
    "--proxy-bypass-list=<-loopback>;localhost:5000;127.0.0.1:99", "anything but localhost:<port> / 127.0.0.1:<port> is dropped");
  const mark = path.join(dir, "mark");
  args({ GRAPHIC_SHIM_MARK: mark });
  assert.match(fs.readFileSync(mark, "utf8"), /^\d+\n$/, "the shim appends its PID");
  // an inherited GRAPHIC_RENDER_ORIGINS never reaches a render's processes
  process.env.GRAPHIC_RENDER_ORIGINS = "*";
  try { assert.equal(RR.cleanEnv({ A: "1" }).GRAPHIC_RENDER_ORIGINS, undefined); } finally { delete process.env.GRAPHIC_RENDER_ORIGINS; }
  // the probe, stubbed
  const urls = RR.PROBE_URLS, lo = "http://localhost:4444/";
  const chromeOk = (extra = {}) => JSON.stringify({ lines: [...urls, lo].map((u) => `FAILED ${u} TypeError`), loopbackUrl: lo, loopbackHits: 0, ...extra });
  const nodeOk = urls.map((u) => `FAILED ${u} TypeError`).join("|");
  const stub = (chromeOut, nodeOut, seen = []) => (cmd, argv, o) => { seen.push(o.env); return argv.some((x) => String(x).endsWith("graphic-probe.mjs")) ? { stdout: chromeOut } : { stdout: nodeOut }; };
  const envs = [];
  process.env.GRAPHIC_RENDER_ORIGINS = "*";
  try { assert.equal(RR.probeNetwork({ user: NR, launcher: { argv: [] }, shim, spawn: stub(chromeOk(), nodeOk, envs) }).ok, true); } finally { delete process.env.GRAPHIC_RENDER_ORIGINS; }
  assert.ok(envs.length === 2 && envs.every((e) => !("GRAPHIC_RENDER_ORIGINS" in e)), "the probe's processes get no inherited origins");
  const reached = RR.probeNetwork({ user: NR, launcher: { argv: [] }, shim, spawn: stub(JSON.stringify({ lines: [`REACHED ${urls[0]}`, `FAILED ${urls[1]} TypeError`, `FAILED ${lo} TypeError`], loopbackHits: 0 }), nodeOk) });
  assert.equal(reached.refusal, G.reason("R12", { url: "http://1.1.1.1/" }));
  const loHit = RR.probeNetwork({ user: NR, launcher: { argv: [] }, shim, spawn: stub(chromeOk({ loopbackHits: 1 }), nodeOk) });
  assert.equal(loHit.refusal, G.reason("R12", { url: lo }), "a connection to the second localhost listener refuses");
  const timeout = RR.probeNetwork({ user: NR, launcher: { argv: [] }, shim, spawn: stub(JSON.stringify({ lines: [`FAILED ${urls[0]} TypeError`, `FAILED ${urls[1]} TimeoutError`, `FAILED ${lo} TypeError`], loopbackHits: 0 }), nodeOk) });
  assert.match(timeout.refusal, /^network lock probe could not run: Chrome: answered/, "a timeout is not proof of a block");
  const nodeTimeout = RR.probeNetwork({ user: NR, launcher: { argv: [] }, shim, spawn: stub(chromeOk(), `FAILED ${urls[0]} TypeError|UNKNOWN ${urls[1]} TimeoutError`) });
  assert.match(nodeTimeout.refusal, /^network lock probe could not run: Node/);
  const silent = RR.probeNetwork({ user: NR, launcher: { argv: [] }, shim, spawn: stub(JSON.stringify({ lines: [], error: "Chrome exited 1" }), nodeOk) });
  assert.equal(silent.refusal, G.reason("R12n", { message: "Chrome: Chrome exited 1" }));
  assert.equal(RR.probeNetwork({ user: NR, launcher: { argv: [] }, shim: null }).refusal, G.reason("R12n", { message: "no Chrome launcher shim (chrome-headless-shell not found, or Windows)" }));
  assert.deepEqual(RR.sandboxLauncher({ GRAPHIC_SANDBOX: '["sandbox-exec","-f","/p.sb"]' }).argv, ["sandbox-exec", "-f", "/p.sb"]);
  assert.deepEqual(RR.sandboxLauncher({}).argv, []);
  const bad = RR.sandboxLauncher({ GRAPHIC_SANDBOX: '["oops"' });
  assert.match(bad.error, /^GRAPHIC_SANDBOX is not a command/);
  assert.match(RR.probeNetwork({ user: NR, launcher: bad, shim }).refusal, /^network lock probe could not run: GRAPHIC_SANDBOX is not a command/);
});

// The root drop, run for real on any machine: the shim with a fake `id` (0 = root), a fake setpriv (perl: records its
// argv, then execs the rest in place, adding nothing to the environment, like the real one), a fake chown (records), a
// fake Chrome (node: records argv, env, cwd, PID). PATH holds ONLY these and the real chmod, so a real setpriv
// elsewhere on the machine is never found. The shim sits in a 0700 "project" dir (the server's project volume is not
// enterable by the dropped uid); the home is a separate temp dir, as chromeHome makes it.
const PERL = ["/usr/bin/perl", "/bin/perl"].find((p) => fs.existsSync(p));
function rootRig({ id = "0", setpriv = true, lock = true, home: withHome = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphic-root-")));
  const bin = path.join(dir, "bin"), rec = (n) => path.join(dir, `${n}.rec`);
  fs.mkdirSync(bin);
  const sh = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  sh("id", `echo ${id}`);
  sh("chown", `echo "$*" >> '${rec("chown")}'`);
  fs.symlinkSync(spawnSync("/bin/sh", ["-c", "command -v chmod"], { encoding: "utf8" }).stdout.trim(), path.join(bin, "chmod"));
  if (setpriv) fs.writeFileSync(path.join(bin, "setpriv"), `#!${PERL}
open(my $f, ">>", "${rec("setpriv")}"); print $f join("\\n", @ARGV), "\\n"; close($f);
my ($i) = grep { $ARGV[$_] eq "--" } 0..$#ARGV; my @c = @ARGV[$i + 1 .. $#ARGV]; exec { $c[0] } @c or exit 127;
`, { mode: 0o755 });
  const chrome = path.join(dir, "fake chrome");
  fs.writeFileSync(chrome, `#!${process.execPath}
require("fs").writeFileSync(${JSON.stringify(rec("chrome"))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid }));
`, { mode: 0o755 });
  const project = path.join(dir, "project");
  fs.mkdirSync(path.join(project, "build", "graphics"), { recursive: true });
  const home = path.join(dir, "chrome-home");
  fs.mkdirSync(home, { mode: 0o700 });
  const shim = RR.chromeShim(path.join(project, "build", "graphics", "shim"), chrome, { lock, home: withHome ? home : null });
  fs.chmodSync(project, 0o700);
  const profile = path.join(dir, "puppeteer-profile");
  fs.mkdirSync(profile, { mode: 0o700 });
  const run = (env = {}, args = ["--headless", `--user-data-dir=${profile}`, "x"]) => {
    for (const n of ["chown", "setpriv", "chrome", "mark"]) fs.rmSync(rec(n), { force: true });
    const r = spawnSync(shim, args, { encoding: "utf8", cwd: project, env: { PATH: bin, SECRET_TOKEN: "s3cret", DATABASE_URL: "postgres://u:p@h/db", GRAPHIC_SHIM_MARK: rec("mark"), ...env } });
    const read = (n, f = (x) => x) => (fs.existsSync(rec(n)) ? f(fs.readFileSync(rec(n), "utf8")) : null);
    return { status: r.status, stderr: r.stderr, chown: read("chown", (x) => x.trim().split("\n")), setpriv: read("setpriv", (x) => x.trim().split("\n")), chrome: read("chrome", JSON.parse), mark: read("mark", (x) => x.trim()) };
  };
  return { dir, chrome, shim, home, profile, project, run };
}
const IDS = { GRAPHIC_CHROME_UID: "1234", GRAPHIC_CHROME_GID: "5678" };

test("root drop: refused without valid ids, setpriv or a home, nothing started", { skip: process.platform === "win32" || !PERL }, () => {
  const g = rootRig();
  const refused = (r, text, why) => {
    assert.equal(r.status, 78, why);
    assert.equal(r.stderr.trim(), `graphic chrome shim: ${text}`, why);
    assert.deepEqual([r.setpriv, r.chrome, r.mark, r.chown], [null, null, null, null], `${why}: nothing ran, no PID marked`);
  };
  refused(g.run(), RR.ROOT_REFUSAL, "no ids");
  for (const bad of ["", "0", "00", "007", "-1", "1x", " 12", "12345678901", "4294967295"]) {
    refused(g.run({ ...IDS, GRAPHIC_CHROME_UID: bad }), RR.ROOT_REFUSAL, `uid '${bad}'`);
    refused(g.run({ ...IDS, GRAPHIC_CHROME_GID: bad }), RR.ROOT_REFUSAL, `gid '${bad}'`);
  }
  refused(g.run({ GRAPHIC_CHROME_UID: "1234" }), RR.ROOT_REFUSAL, "uid without gid");
  refused(rootRig({ setpriv: false }).run(IDS), RR.SETPRIV_REFUSAL, "no setpriv on PATH");
  refused(rootRig({ home: false }).run(IDS), "running as root: no home dir for the graphic Chrome (chromeShim needs one)", "no home");
  fs.rmSync(g.home, { recursive: true });
  fs.symlinkSync(g.dir, g.home);
  refused(g.run(IDS), `running as root: the graphic Chrome's home is not a directory: ${g.home}`, "home is a symlink");
  // the Node side: the same refusals, before anything is written
  const spDir = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-sp-"));
  fs.writeFileSync(path.join(spDir, "setpriv"), "#!/bin/sh\n", { mode: 0o755 });
  assert.deepEqual(RR.chromeUser({ ...IDS, PATH: spDir }, 1000), { root: false });
  assert.deepEqual(RR.chromeUser({ ...IDS, PATH: spDir }, 0), { root: true, uid: 1234, gid: 5678, setpriv: path.join(spDir, "setpriv") });
  for (const bad of [{}, { GRAPHIC_CHROME_UID: "1234" }, { ...IDS, GRAPHIC_CHROME_UID: "0" }, { ...IDS, GRAPHIC_CHROME_GID: "0" }, { ...IDS, GRAPHIC_CHROME_UID: "007" }, { ...IDS, GRAPHIC_CHROME_GID: "-5" }, { ...IDS, GRAPHIC_CHROME_UID: "4294967295" }])
    assert.deepEqual(RR.chromeUser({ ...bad, PATH: spDir }, 0), { root: true, error: RR.ROOT_REFUSAL }, JSON.stringify(bad));
  assert.deepEqual(RR.chromeUser({ ...IDS, PATH: g.dir }, 0), { root: true, error: RR.SETPRIV_REFUSAL });
  assert.equal(RR.probeNetwork({ user: { root: true, error: RR.ROOT_REFUSAL }, launcher: { argv: [] }, shim: g.shim }).refusal, G.reason("R12n", { message: RR.ROOT_REFUSAL }));
});

test("root drop: setpriv to the ids, empty env, cwd = home, our profile last, PID marker = Chrome's, nothing in the project", { skip: process.platform === "win32" || !PERL }, () => {
  const g = rootRig();
  const r = g.run({ ...IDS, GRAPHIC_RENDER_ORIGINS: "localhost:5000;evil.com:80" });
  assert.equal(r.status, 0, r.stderr);
  const bypass = "--proxy-bypass-list=<-loopback>;localhost:5000";
  const args = ["--headless", `--user-data-dir=${g.profile}`, "x"];
  const ours = `--user-data-dir=${g.home}/profile-${r.chrome.pid}`;
  assert.deepEqual(r.setpriv, ["--reuid=1234", "--regid=5678", "--clear-groups", "--inh-caps=-all", "--no-new-privs", "--", g.chrome, ...args, ...RR.ROOT_FLAGS, ...RR.CHROME_FLAGS, bypass, ours], "setpriv's argv, exactly");
  assert.deepEqual(r.chrome.argv, [...args, ...RR.ROOT_FLAGS, ...RR.CHROME_FLAGS, bypass, ours], "caller first, --no-sandbox etc., the lock flags, then our profile: the last --user-data-dir wins");
  if (process.platform === "darwin") delete r.chrome.env.__CF_USER_TEXT_ENCODING; // macOS adds it to every process
  assert.deepEqual(r.chrome.env, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: g.home, TMPDIR: g.home }, "nothing inherited: no SECRET_TOKEN, no DATABASE_URL, no GRAPHIC_*");
  assert.equal(r.chrome.cwd, g.home, "cwd: the home (the caller's cwd was the project)");
  assert.equal(r.mark, String(r.chrome.pid), "the marked PID is the final Chrome's (sh -> env -> setpriv -> chrome, all exec)");
  assert.deepEqual(r.chown, [`1234:5678 ${g.home}`], "only the home is handed over; puppeteer's profile is never touched");
  assert.equal(fs.statSync(g.home).mode & 0o777, 0o700);
  const inProject = [...r.chrome.argv, ...Object.values(r.chrome.env), r.chrome.cwd].filter((x) => x.includes(g.project));
  assert.deepEqual(inProject, [], "no argv, env or cwd of Chrome points into the project dir (the uid may not enter it)");
  // lock: false (the isolation check's baseline only): the same drop, no lock flags
  const bg = rootRig({ lock: false });
  const b = bg.run(IDS, ["--headless"]);
  assert.deepEqual(b.chrome.argv, ["--headless", ...RR.ROOT_FLAGS, `--user-data-dir=${bg.home}/profile-${b.chrome.pid}`]);
  assert.equal(b.chrome.env.SECRET_TOKEN, undefined);
});

test("root drop: not root, the launch is what it was (no setpriv, no extra flags, env inherited)", { skip: process.platform === "win32" || !PERL }, () => {
  const g = rootRig({ id: "501" });
  for (const env of [{}, IDS]) {
    const r = g.run(env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.chrome.argv, ["--headless", `--user-data-dir=${g.profile}`, "x", ...RR.CHROME_FLAGS, "--proxy-bypass-list=<-loopback>"]);
    assert.deepEqual([r.setpriv, r.chown, r.chrome.env.SECRET_TOKEN, r.mark, r.chrome.cwd], [null, null, "s3cret", String(r.chrome.pid), g.project]);
    assert.ok(!r.chrome.argv.includes("--no-sandbox"), "--no-sandbox only when dropped from root");
  }
  assert.deepEqual(rootRig({ id: "501", lock: false }).run({}, ["a"]).chrome.argv, ["a"]);
});

test("chromeHome: root only, a fresh 0700 dir under the temp dir owned by the uid; refused when others cannot reach it", () => {
  assert.equal(RR.chromeHome({ root: false }), null);
  if (process.platform === "win32") return;
  const me = { root: true, uid: process.getuid(), gid: process.getgid() }; // chown to ourselves works without root
  const base = fs.mkdtempSync("/tmp/graphic-home-base-"); // /tmp: every parent searchable (the macOS user temp dir is 0700)
  fs.chmodSync(base, 0o755);
  const h = RR.chromeHome(me, base);
  assert.equal(path.dirname(h), base);
  assert.match(path.basename(h), /^graphic-chrome-/);
  assert.deepEqual([fs.statSync(h).mode & 0o777, fs.statSync(h).uid], [0o700, process.getuid()]);
  fs.chmodSync(base, 0o700);
  assert.throws(() => RR.chromeHome(me, base), new RegExp(`^Error: running as root: ${base} is not searchable by other users`));
  assert.equal(RR.unsearchable(base), base);
  fs.chmodSync(base, 0o755);
  if (process.getuid() !== 0) {
    const before = fs.readdirSync(base).length;
    assert.throws(() => RR.chromeHome({ root: true, uid: 1, gid: 1 }, base), /EPERM/, "a failed chown throws");
    assert.equal(fs.readdirSync(base).length, before, "and leaves no dir behind");
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test("renderGraphic as root: refused before anything when the drop is not set up; the home is made, passed, removed", async () => {
  const calls = [];
  const bad = await rg({ chromeUser: () => ({ root: true, error: RR.ROOT_REFUSAL }), findChrome: () => { calls.push("find"); return "/fake/chrome"; } });
  assert.deepEqual([bad.r.ok, bad.r.codes, bad.r.reasons, bad.r.stage, bad.calls, calls], [false, ["R12"], [G.reason("R12n", { message: RR.ROOT_REFUSAL })], "setup", { render: 0, probe: 0 }, []]);
  assert.equal(fs.existsSync(path.join(bad.work, "build")), false, "nothing written");
  const root = { root: true, uid: 1234, gid: 5678, setpriv: "/x/setpriv" };
  for (const [name, over, ok] of [
    ["clean", {}, true],
    ["render fails", { runRender: async () => ({ status: 1, secs: 1, log: "boom", timedOut: false }) }, false],
    ["render times out", { runRender: async () => ({ status: -1, secs: 99, log: "killed after 99 s (render timeout)", timedOut: true }) }, false],
    ["probe refuses", { probeNetwork: () => ({ ok: false, lines: [], refusal: "x" }) }, false],
  ]) {
    let home = null, got = null, user = null;
    const x = await rg({ chromeUser: () => root, chromeHome: (u) => { home = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-chrome-")); assert.equal(u, root); return home; },
      chromeShim: (d, exe, o) => { got = o.home; return "/fake/shim"; }, probeNetwork: (o) => { user = o.user; return { ok: true, lines: [] }; }, ...over });
    assert.equal(x.r.ok, ok, `${name}: ${x.r.reasons}`);
    assert.equal(got, home, `${name}: the shim gets the home`);
    assert.ok(!home.startsWith(x.work), `${name}: the home is not under the project/build dir`);
    assert.equal(fs.existsSync(home), false, `${name}: the home is removed`);
    if (!over.probeNetwork) assert.equal(user.uid, 1234, "the probe is told who Chrome runs as");
  }
  const thrown = await rg({ chromeHome: () => { throw new Error("running as root: /x is not searchable by other users"); } });
  assert.deepEqual([thrown.r.reasons, thrown.calls.probe], [[G.reason("R12n", { message: "running as root: /x is not searchable by other users" })], 0]);
});

test("findChrome: the pinned build, else the highest cached build not above its major", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-home-"));
  const base = path.join(home, ".cache", "hyperframes", "chrome", "chrome-headless-shell");
  const mk = (v) => { const d = path.join(base, `mac_arm-${v}`, "sub"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell"), ""); return path.join(d, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell"); };
  mk("153.0.1.1"); const v99 = mk("99.10.0.1"); mk("99.9.0.1"); const pin = mk(RR.PINNED_CHROME);
  assert.equal(RR.findChrome({}, home), pin);
  fs.rmSync(path.dirname(path.dirname(pin)), { recursive: true });
  assert.equal(RR.findChrome({}, home), v99, "semantic order (99.10 > 99.9), 153 is above the ceiling");
  assert.equal(RR.findChrome({ HYPERFRAMES_BROWSER_PATH: "/x" }, home), "/x");
});

test("findChrome: GRAPHIC_CHROME_PATH first, and a broken one refuses instead of falling back", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-home-"));
  const exeName = process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  const cached = path.join(home, ".cache", "hyperframes", "chrome", "chrome-headless-shell", `mac_arm-${RR.PINNED_CHROME}`, "sub", exeName);
  fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, "");
  const pinned = path.join(home, "pinned", exeName);
  fs.mkdirSync(path.dirname(pinned), { recursive: true }); fs.writeFileSync(pinned, "#!/bin/sh\n"); fs.chmodSync(pinned, 0o755);
  const others = { HYPERFRAMES_BROWSER_PATH: "/other/hf", PRODUCER_HEADLESS_SHELL_PATH: "/other/producer" };
  // a symlink to the executable: checked, then resolved, so the shim runs exactly the checked file
  if (process.platform !== "win32") {
    const link = path.join(home, "link-chrome");
    fs.symlinkSync(pinned, link);
    assert.equal(RR.findChrome({ GRAPHIC_CHROME_PATH: link, ...others }, home), fs.realpathSync(pinned));
  }
  // wins over both env paths and over the cache
  assert.equal(RR.findChrome({ GRAPHIC_CHROME_PATH: pinned, ...others }, home), fs.realpathSync(pinned));
  assert.equal(RR.findChrome({ GRAPHIC_CHROME_PATH: pinned }, home), fs.realpathSync(pinned));
  // set but missing / a directory / not executable: a clear error, never another browser
  const missing = path.join(home, "nope", exeName);
  for (const bad of [missing, path.dirname(pinned)].concat(process.platform === "win32" ? [] : [(() => { const f = path.join(home, "noexec"); fs.writeFileSync(f, ""); fs.chmodSync(f, 0o644); return f; })()])) {
    assert.throws(() => RR.findChrome({ GRAPHIC_CHROME_PATH: bad, ...others }, home), { message: `GRAPHIC_CHROME_PATH=${bad} is not an executable file` });
    assert.throws(() => RR.findChrome({ GRAPHIC_CHROME_PATH: bad }, home), { message: `GRAPHIC_CHROME_PATH=${bad} is not an executable file` }, "no fallback to the cache");
  }
  // relative: refused even when it names an executable file in the current folder (the shim's exec would search PATH)
  const cwd = process.cwd();
  try {
    process.chdir(path.dirname(pinned));
    for (const rel of [exeName, `./${exeName}`]) assert.throws(() => RR.findChrome({ GRAPHIC_CHROME_PATH: rel, ...others }, home), { message: `GRAPHIC_CHROME_PATH=${rel} must be an absolute path` });
  } finally { process.chdir(cwd); }
  // unset (or empty): today's order
  assert.equal(RR.findChrome({ ...others }, home), "/other/hf");
  assert.equal(RR.findChrome({ PRODUCER_HEADLESS_SHELL_PATH: "/other/producer" }, home), "/other/producer");
  assert.equal(RR.findChrome({ GRAPHIC_CHROME_PATH: "" }, home), cached);
  assert.equal(RR.findChrome({}, home), cached);
  // renderGraphic: the throw is a setup refusal (R12n with the text), nothing probed or rendered
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-rg-"));
  const calls = { probe: 0, render: 0, shim: 0 };
  const r = await RR.renderGraphic({ content: goodGraphic(), html: "assets/graphics/good.html", outDir: path.join(work, "out"), buildDir: path.join(work, "build") }, {
    chromeUser: () => ({ root: false }),
    findChrome: () => RR.findChrome({ GRAPHIC_CHROME_PATH: missing, ...others }, home),
    chromeShim: () => { calls.shim++; return "/fake/shim"; }, chromeVersion: () => "152.0.7977.30", ffmpegVersion: () => "7.1.1",
    probeNetwork: () => { calls.probe++; return { ok: true, lines: [] }; }, runRender: async () => { calls.render++; return { status: 0, secs: 1, log: "" }; },
  });
  assert.deepEqual([r.ok, r.codes, r.reasons, r.stage, calls], [false, ["R12"], [G.reason("R12n", { message: `GRAPHIC_CHROME_PATH=${missing} is not an executable file` })], "setup", { probe: 0, render: 0, shim: 0 }]);
  // the render child never sees it (only this renderer reads it; normal reels must not)
  const prev = process.env.GRAPHIC_CHROME_PATH;
  process.env.GRAPHIC_CHROME_PATH = pinned;
  try { assert.equal(RR.cleanEnv({ X: "1" }).GRAPHIC_CHROME_PATH, undefined); } finally { if (prev === undefined) delete process.env.GRAPHIC_CHROME_PATH; else process.env.GRAPHIC_CHROME_PATH = prev; }
});

test("normal (non-graphic) Chrome lookup ignores GRAPHIC_CHROME_PATH", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "browser.mjs"), "utf8");
  assert.doesNotMatch(src, /GRAPHIC_CHROME_PATH/);
});

// renderGraphic with every external step injected: the guards, without a real render
function fakeDeps(over = {}) {
  const calls = { render: 0, probe: 0 };
  const deps = {
    chromeUser: () => ({ root: false }),
    findChrome: () => "/fake/chrome", chromeShim: () => "/fake/shim", chromeVersion: () => "152.0.7977.30", ffmpegVersion: () => "7.1.1",
    probeNetwork: () => { calls.probe++; return { ok: true, lines: [] }; },
    runRender: async ({ out, markFile }) => { calls.render++; fs.writeFileSync(out, "video"); fs.writeFileSync(markFile, "4242\n"); return { status: 0, secs: 1, log: "[BrowserManager] Browser launched (HeadlessChrome/152.0.7977.30, screenshot)\n" }; },
    frameMd5: () => Array(60).fill("m"), maxAlpha: () => 255, ...over,
  };
  return { deps, calls };
}
async function rg(over, opts = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-rg-"));
  const { deps, calls } = fakeDeps(over);
  const r = await RR.renderGraphic({ content: goodGraphic(), html: "assets/graphics/good.html", outDir: path.join(work, "out"), buildDir: path.join(work, "build"), ...opts }, deps);
  const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.(webm|mp4)$/.test(f)) : []);
  return { r, calls, work, out: files(path.join(work, "out")), side: files(path.join(work, "build", "graphics")) };
}
test("renderGraphic guards (injected): probe, versions, refusals delete everything, one atomic file on a clean run", async () => {
  const clean = await rg({});
  assert.equal(clean.r.ok, true, clean.r.reasons.join());
  assert.deepEqual(clean.out, [path.basename(clean.r.file)], "exactly one file, the final name (no .part left)");
  assert.deepEqual(clean.side, [], "the two render outputs are deleted");
  assert.equal(clean.calls.render, 2);
  const again = await RR.renderGraphic({ content: goodGraphic(), html: "assets/graphics/good.html", outDir: path.join(clean.work, "out"), buildDir: path.join(clean.work, "build") }, fakeDeps().deps);
  assert.equal(again.cached, true, "an existing file is used as is");

  const probe = await rg({ probeNetwork: () => ({ ok: false, lines: [], refusal: G.reason("R12", { url: "http://1.1.1.1/" }) }) });
  assert.deepEqual([probe.r.ok, probe.r.reasons, probe.calls.render, probe.out], [false, [G.reason("R12", { url: "http://1.1.1.1/" })], 0, []], "probe fails: the render never starts");
  const nochrome = await rg({ chromeVersion: () => null });
  assert.deepEqual([nochrome.r.reasons, nochrome.calls.probe, nochrome.calls.render], [[G.reason("R12n", { message: "the Chrome shim gave no --version" })], 0, 0]);
  const noffmpeg = await rg({ ffmpegVersion: () => null });
  assert.deepEqual([noffmpeg.r.codes, noffmpeg.calls.render], [["R12"], 0]);

  const withLog = (log, status = 0, mark = "4242\n") => async ({ out, markFile }) => { fs.writeFileSync(out, "video"); fs.writeFileSync(markFile, mark); return { status, secs: 1, log }; };
  const BL = "[BrowserManager] Browser launched (HeadlessChrome/152.0.7977.30, screenshot)\n";
  for (const [name, runRender, code] of [
    ["R1", withLog(BL + "vendor: blocked https://x/y.png"), "R1"],
    ["R10", withLog(BL + "boom", 1), "R10"],
    ["R13 version", withLog("[BrowserManager] Browser launched (HeadlessChrome/151.0.1.1, screenshot)"), "R13"],
    ["R13 no launch line", withLog("nothing"), "R13"],
    ["R13 not through the shim", withLog(BL, 0, ""), "R13"],
    ["R11", withLog(BL + "[Browser:ERROR] GRAPHIC-REFUSED: navigated"), "R11"],
  ]) {
    const x = await rg({ runRender });
    assert.equal(x.r.ok, false, name);
    assert.ok(x.r.codes.includes(code), `${name}: ${x.r.codes}`);
    assert.deepEqual([x.out, x.side, x.r.file], [[], [], null], `${name}: no final file, both render outputs deleted`);
  }
  const r6 = await rg({ frameMd5: (() => { let n = 0; return () => (n++ ? [...Array(59).fill("m"), "x"] : Array(60).fill("m")); })() });
  assert.deepEqual([r6.r.reasons, r6.out], [[G.reason("R6", { i: 59, t: "1.967" })], []]);
  const r6L = await rg({ frameMd5: () => Array(59).fill("m") });
  assert.deepEqual(r6L.r.reasons, [G.reason("R6L", { a: 59, L: 60 })]);
  const r9 = await rg({ maxAlpha: () => 0 });
  assert.deepEqual([r9.r.reasons, r9.out], [[G.reason("R9")], []]);
  const slow = await rg({ runRender: async ({ out, markFile }) => { fs.writeFileSync(out, "v"); fs.writeFileSync(markFile, "1\n"); return { status: 0, secs: 99, log: BL }; } });
  assert.ok(slow.r.codes.includes("R7"));
});

test("killChromes: only live, verified Chrome PIDs > 1; a group only when Chrome leads it", () => {
  const sent = [];
  const kill = (p) => sent.push(p);
  const info = (pid) => ({ 1: { exe: "chrome-headless-shell", pgid: 1 }, 4242: { exe: "node", pgid: 4242 }, 5555: { exe: "chrome-headless-shell", pgid: 5555 }, 6666: { exe: "chrome-headless-shell", pgid: 1 }, 7777: { exe: "launchd", pgid: 7777 } })[pid] || null;
  const r = RR.killChromes([1, 4242, 5555, 6666, 7777, 8888, 0, -1, NaN], { kill, info });
  assert.deepEqual(r, ["-5555", "5555", "6666"]);
  assert.deepEqual(sent, [-5555, 5555, 6666], "never 1, -1, a non-Chrome PID or a dead PID; a group only when Chrome leads it");
  assert.equal(RR.procInfo(1), null);
  assert.equal(RR.isChrome(process.pid), false, "this node process is not Chrome");
  assert.ok(RR.procInfo(process.pid) && RR.procInfo(process.pid).pgid > 0);
});

test("runRender: no inherited origins, the PID marker, a hung render is killed with its process group", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-run-"));
  const bin = path.join(dir, "fake-hf.cjs");
  fs.writeFileSync(bin, `const { spawn } = require("child_process");
    console.log("ORIGINS=" + process.env.GRAPHIC_RENDER_ORIGINS + " MARK=" + (process.env.GRAPHIC_SHIM_MARK ? "set" : "unset"));
    if (process.argv.includes("--hang")) { const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log("CHILD=" + c.pid); setInterval(() => {}, 1000); }`);
  process.env.GRAPHIC_RENDER_ORIGINS = "*";
  let r;
  try { r = await RR.runRender({ dir, out: "--x", mode: "overlay", fps: 30, launcher: { argv: [] }, shim: null, markFile: path.join(dir, "m"), bin, timeoutMs: 20000 }); }
  finally { delete process.env.GRAPHIC_RENDER_ORIGINS; }
  assert.match(r.log, /ORIGINS=undefined MARK=set/);
  assert.equal(r.timedOut, false);
  const t0 = Date.now();
  const h = await RR.runRender({ dir, out: "--hang", mode: "overlay", fps: 30, launcher: { argv: [] }, shim: null, markFile: path.join(dir, "m2"), bin, timeoutMs: 1500 });
  assert.equal(h.timedOut, true);
  assert.ok(Date.now() - t0 < 10000);
  const child = Number(/CHILD=(\d+)/.exec(h.log)[1]);
  await new Promise((ok) => setTimeout(ok, 300));
  assert.throws(() => process.kill(child, 0), "the grandchild in the render's process group is dead too");

  // the marker: a normal exit signals nothing; on a timeout only the verified Chrome is killed, never "1" or another PID
  const sleeper = () => { const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); c.unref(); return c.pid; };
  const chromeLike = sleeper(), other = sleeper();
  const info = (pid) => (pid === chromeLike ? { exe: "chrome-headless-shell", pgid: chromeLike } : pid === other ? { exe: "node", pgid: other } : null);
  const sent = [];
  const kill = (p, sig) => { sent.push(p); if (p === 1 || p === -1 || p === other || p === -other) throw new Error("must not signal " + p); return process.kill(p, sig); };
  const markBin = path.join(dir, "fake-hf-mark.cjs");
  fs.writeFileSync(markBin, `require("fs").writeFileSync(process.env.GRAPHIC_SHIM_MARK, "1\\n${chromeLike}\\n${other}\\n"); if (process.argv.includes("--hang")) setInterval(() => {}, 1000);`);
  const normal = await RR.runRender({ dir, out: "--x", mode: "overlay", fps: 30, launcher: { argv: [] }, shim: null, markFile: path.join(dir, "m3"), bin: markBin, timeoutMs: 20000, kill, info });
  assert.deepEqual([normal.timedOut, normal.killed, sent], [false, [], []], "a normal exit kills nothing");
  assert.doesNotThrow(() => process.kill(chromeLike, 0));
  const hung = await RR.runRender({ dir, out: "--hang", mode: "overlay", fps: 30, launcher: { argv: [] }, shim: null, markFile: path.join(dir, "m4"), bin: markBin, timeoutMs: 1500, kill, info });
  assert.equal(hung.timedOut, true);
  assert.deepEqual(hung.killed.slice(1), [`-${chromeLike}`, String(chromeLike)], "the hung Chrome (and the group it leads) is killed");
  assert.ok(!sent.includes(1) && !sent.includes(-1) && !sent.includes(other));
  await new Promise((ok) => setTimeout(ok, 300));
  assert.throws(() => process.kill(chromeLike, 0), "the hung Chrome is dead");
  assert.doesNotThrow(() => process.kill(other, 0), "the non-Chrome PID in the marker is alive");
  process.kill(other, "SIGKILL");
  // with a GRAPHIC_SANDBOX launcher the marked PIDs are not touched (they may be in another PID namespace)
  const chrome2 = sleeper();
  fs.writeFileSync(markBin, `require("fs").writeFileSync(process.env.GRAPHIC_SHIM_MARK, "${chrome2}\\n"); setInterval(() => {}, 1000);`);
  const info2 = (pid) => (pid === chrome2 ? { exe: "chrome-headless-shell", pgid: chrome2 } : null);
  const sb = await RR.runRender({ dir, out: "--x", mode: "overlay", fps: 30, launcher: { argv: ["env"] }, shim: null, markFile: path.join(dir, "m5"), bin: markBin, timeoutMs: 1500, kill, info: info2 });
  assert.equal(sb.timedOut, true);
  assert.doesNotThrow(() => process.kill(chrome2, 0), "launcher set: marked PIDs skipped");
  process.kill(chrome2, "SIGKILL");
});

test("rules.json is the source: parity with its cases.json, engine fonts = DESIGNER_FONTS", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(here, "..", "graphic-rules", "cases.json"), "utf8")).cases;
  const diff = Object.entries(cases).filter(([, c]) => G.staticFirst(c.html) !== (c.expect ?? null)).map(([k, c]) => `${k}: want ${c.expect}, got ${G.staticFirst(c.html)}`);
  assert.deepEqual(diff, []);
  assert.ok(Object.keys(cases).length >= 139);
  const J = JSON.parse(fs.readFileSync(G.RULES_JSON, "utf8"));
  assert.deepEqual(J.fonts.engine, DESIGNER_FONTS);
});

test("parity.mjs (node == Python == cases.json), when a Python is available", (t) => {
  const py = process.env.PYTHON || (process.platform === "win32" ? "py" : "python3");
  if (spawnSync(py, ["--version"]).status !== 0) return t.skip(`no ${py}`);
  const r = spawnSync(process.execPath, [path.join(here, "..", "graphic-rules", "parity.mjs")], { encoding: "utf8" });
  assert.match(r.stdout, /PARITY: PASS\s*$/, r.stdout.slice(-500));
});

test("REASONS are word for word the spec's tables (references/reel-json.md)", () => {
  const md = fs.readFileSync(path.join(here, "..", "..", "references", "reel-json.md"), "utf8");
  const sec = md.slice(md.indexOf("## Prompt Motion graphic"), md.indexOf("\n## ", md.indexOf("## Prompt Motion graphic") + 5));
  const PH = { html: "<html>", match: "<match>", bytes: "<bytes>", path: "<path>", n: "<n>", name: "<name>", value: "<value>", W: "<W>", H: "<H>", w: "<w>", h: "<h>",
    v: "<v>", s: "<s>", url: "<url>", message: "<message>", t: "<t>", a: "<a>", b: "<b>", i: "<i>", L: "<L>", code: "<code>", line: "<last log line>", k: "<k>",
    duration: "<duration>", platform: "<platform name>" };
  const MORE = { G16: ["G16o"], G17: ["G17n"], R4: ["R4p"], R6: ["R6n", "R6L", "R6o"], R12: ["R12n"] };
  const seen = new Set(), diffs = [];
  for (const line of sec.split("\n")) {
    const m = /^\| (G\d+|P\d+|R\d+|GW\d+)(?: \(v[\d.]+\))? \|/.exec(line);
    if (!m) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
    const id = m[1];
    const cell = id.startsWith("GW") || id.startsWith("P") ? cells[1] : cells[cells.length - 1];
    let texts = [...cell.matchAll(/`([^`]+)`/g)].map((x) => x[1].replace(/\\\|/g, "|")).filter((x) => x.includes(" "));
    if (id.startsWith("GW")) texts = texts.slice(0, 1);
    texts.forEach((want, n) => {
      const code = n === 0 ? id : (MORE[id] || [])[n - 1];
      if (!code || !G.REASONS[code]) { diffs.push(`${id}#${n}: no code for '${want}'`); return; }
      seen.add(code);
      const got = G.reason(code, { ...PH, L: code === "R6L" ? "<L>" : PH.L });
      if (got !== want) diffs.push(`${code}:\n  spec ${want}\n  code ${got}`);
    });
  }
  assert.deepEqual(diffs, []);
  const missing = Object.keys(G.REASONS).filter((c) => !seen.has(c));
  assert.deepEqual(missing, [], "every code in REASONS has its spec row");
});

test("CLI render lock: --lock / GRAPHIC_RENDER_LOCK re-run under lockf or flock, once", async () => {
  const L = await import("./graphic-lock.mjs");
  const argv = [process.execPath, "scripts/graphic-determinism.mjs", "g.html", "--lock", "/tmp/x.lock"];
  assert.deepEqual(L.lockCommand(argv, {}, { lockf: true, flock: false }).slice(0, 1), ["lockf"]);
  assert.deepEqual(L.lockCommand(argv, {}, { lockf: true }).at(1).slice(0, 2), ["-k", "/tmp/x.lock"]);
  assert.deepEqual(L.lockCommand(argv.slice(0, 3), { GRAPHIC_RENDER_LOCK: "/tmp/y" }, { lockf: false, flock: true }).slice(0, 1), ["flock"]);
  assert.equal(L.lockCommand(argv, { GRAPHIC_RENDER_LOCK_HELD: "/tmp/x.lock" }, { lockf: true }), null, "already held: run");
  assert.equal(L.lockCommand(argv.slice(0, 3), {}, { lockf: true }), null, "no lock asked for");
  assert.throws(() => L.lockCommand(argv, {}, { lockf: false, flock: false }), /neither lockf nor flock/);
});

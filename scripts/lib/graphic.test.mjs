// node --test scripts/lib/graphic.test.mjs
// Prompt Motion graphic (PM2), fast and offline: the static rules (exact reason texts, first-failing order, scopes),
// the wrapper page (CSP, data-no-timeline, the hf-seek bridge run in a vm), the log rules, the cache key, the frame map,
// the Node offline preload and the Chrome shim. No hyperframes render here (scripts/graphic-isolation-check.mjs and
// scripts/graphic-determinism.mjs do real renders, outside the gate).
import { test, after } from "node:test";
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
import { goodGraphic, insertGraphic, fetchAtRender, throwsInSeek, tinyFont } from "./graphic-fixtures.mjs";
// every temp dir a test makes is removed after the run (chmod first: some are made 0700 / 0711 on purpose)
const TMP = [];
const tmpd = (prefix) => { const d = fs.mkdtempSync(prefix); TMP.push(d); return d; };
after(() => {
  for (const d of TMP) {
    try { spawnSync("chmod", ["-R", "u+rwx", d]); } catch {}
    fs.rmSync(d, { recursive: true, force: true });
  }
});
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
  const proj = tmpd(path.join(os.tmpdir(), "graphic-test-"));
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
  const proj = tmpd(path.join(os.tmpdir(), "graphic-wrap-"));
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

// R14 in a vm: a fake DOM (text nodes under #graphic-root with a font-family, visibility, ::before / ::after) and a
// fake canvas 2d context, then the real preScript with the real coverage (glyphCoverage of the graphic's text)
function glyphPage({ texts = [], pseudo = null, draw = null, style = "", graphic = "", D = 60, families = [], boxes = false } = {}) {
  const errors = [], listeners = {};
  const ctx = vm.createContext({ console: { error: (m) => errors.push(m) } });
  vm.runInContext(`
    function EventTarget() {} function Node() {} function CharacterData() {} function Element() {} function Document() {}
    function HTMLCanvasElement() {} function TreeWalker() {} function CSSStyleDeclaration() {} function CanvasRenderingContext2D() {}
    Object.setPrototypeOf(Element.prototype, Node.prototype); Object.setPrototypeOf(CharacterData.prototype, Node.prototype);
    Object.defineProperty(Node.prototype, "parentElement", { get: function () { return this._parent; } });
    Object.defineProperty(CharacterData.prototype, "data", { get: function () { return this._data; } });
    Object.defineProperty(Element.prototype, "tagName", { get: function () { return this._tag; } });
    Object.defineProperty(Element.prototype, "innerHTML", { get: function () { return ""; } });
    Element.prototype.getAttribute = function () { return null; };
    Element.prototype.checkVisibility = function (o) { return !(o && o.opacityProperty && this._hidden); };
    Element.prototype.querySelectorAll = function () { return this._els; };
    HTMLCanvasElement.prototype.toDataURL = function () { return ""; };
    TreeWalker.prototype.nextNode = function () { return this._list[this._i++] || null; };
    Document.prototype.createTreeWalker = function (root, what) { var w = Object.create(TreeWalker.prototype); w._list = what === 4 ? root._texts : []; w._i = 0; return w; };
    Document.prototype.getElementById = function (id) { return id === "graphic-root" ? root : null; };
    Document.prototype.querySelectorAll = function () { return []; };
    CSSStyleDeclaration.prototype.getPropertyValue = function (p) { return this._p[p] || ""; };
    function getComputedStyle(el, ps) { var s = Object.create(CSSStyleDeclaration.prototype); s._p = ps ? ((el._pseudo || {})[ps] || { content: "none", "font-family": el._font }) : { "font-family": el._font }; return s; }
    Object.defineProperty(CanvasRenderingContext2D.prototype, "font", { get: function () { return this._font || "10px sans-serif"; }, set: function (v) { this._font = v; } });
    var drawn = [];
    CanvasRenderingContext2D.prototype.fillText = function (t) { drawn.push(String(t)); };
    CanvasRenderingContext2D.prototype.strokeText = function (t) { drawn.push(String(t)); };
    var root = Object.create(Element.prototype); root._tag = "DIV"; root._texts = []; root._els = [];
    var document = Object.create(Document.prototype); document.documentElement = root; document.body = root;
    var g = Object.create(CanvasRenderingContext2D.prototype);
    var window = this;`, ctx);
  if (boxes) vm.runInContext(`
    function Range() {}
    Range.prototype.selectNodeContents = function (n) { this._n = n; };
    Range.prototype.getBoundingClientRect = function () { return this._n._rect || { left: 10, top: 10, right: 100, bottom: 60, width: 90, height: 50 }; };
    Document.prototype.createRange = function () { return Object.create(Range.prototype); };
    Element.prototype.getBoundingClientRect = function () { return this === root ? { left: 0, top: 0, right: 1080, bottom: 1080, width: 1080, height: 1080 } : this._rect || { left: 10, top: 10, right: 100, bottom: 60, width: 90, height: 50 }; };`, ctx);
  for (const t of texts) {
    const el = Object.create(ctx.Element.prototype);
    Object.assign(el, { _tag: t.tag || "SPAN", _font: t.font || "Inter, sans-serif", _hidden: !!t.hidden, _pseudo: t.pseudo || null });
    const node = Object.create(ctx.CharacterData.prototype);
    Object.assign(node, { _parent: el, _data: t.text, _rect: t.rect });
    if (t.rect) el._rect = t.rect;
    ctx.root._texts.push(node); ctx.root._els.push(el);
  }
  ctx.EventTarget.prototype.addEventListener = function (n, f) { if (this === ctx.window) listeners[n] = f; };
  ctx.navigation = {};
  Object.assign(ctx, { duration: 2, size: { w: 1080, h: 1080 } });
  ctx.seek = (t) => { if (draw) draw(ctx, t); };
  const page = `<!doctype html><html><head><style>${style}</style></head><body></body></html>`;
  vm.runInContext(G.preScript({ fps: 30, L: 60, inF: 0, D, after: "hold", glyphs: G.glyphCoverage(page, undefined, families) }), ctx);
  if (graphic) vm.runInContext(graphic, ctx);
  return { fire: (time) => listeners["hf-seek"]({ detail: { time } }), errors, ctx };
}
test("R14 bridge: DOM text, ::before / ::after, canvas fillText / strokeText against the engine fonts' coverage", () => {
  const R14 = (line) => RR.scanLog(`[Browser:ERROR] ${line}`).map((x) => x.text);
  // the staging bug: a message bubble ending in an emoji
  const dom = glyphPage({ texts: [{ text: "Got it" }, { text: "See you at 5 \u{1F44B}" }] });
  dom.fire(0);
  assert.deepEqual(dom.errors, ['GRAPHIC-REFUSED: glyph {"cp":"1F44B","font":"Inter, sans-serif","text":"See you at 5 \u{1F44B}"}']);
  assert.deepEqual(R14(dom.errors[0]), ["character U+1F44B '\u{1F44B}' in \"See you at 5 \u{1F44B}\" isn't in Inter, sans-serif (no glyph; renders as a box)"]);
  // fine: accents, dashes, quotes, euro, Cyrillic, Polish, arrows the fonts have, whitespace, ZWJ, VS16, NBSP
  const ok = glyphPage({ texts: [{ text: "Café — naïve “ok” 5 € ½ ™ · ↑ Привет Łódź" }, { text: "a\u200db\ufe0f\u00a0c\n\t" }, { text: "x", font: '"Instrument Serif", serif' }] });
  ok.fire(0); ok.fire(1);
  assert.deepEqual(ok.errors, []);
  // a symbol no engine font has (→ U+2192, ✓ U+2713) is refused like an emoji
  const arrow = glyphPage({ texts: [{ text: "Record → Post" }] });
  arrow.fire(0);
  assert.deepEqual(R14(arrow.errors[0]), ["character U+2192 '→' in \"Record → Post\" isn't in Inter, sans-serif (no glyph; renders as a box)"]);
  // invisible text and <script> / <style> text are not drawn: not checked
  const hid = glyphPage({ texts: [{ text: "\u{1F44B}", hidden: true }, { text: "var s = '\u{1F680}';", tag: "SCRIPT" }, { text: "p{}\u{1F680}", tag: "style" }] });
  hid.fire(0);
  assert.deepEqual(hid.errors, []);
  // ::after content
  const ps = glyphPage({ texts: [{ text: "Done", pseudo: { "::after": { content: '"  \\"ok\\" \u2705"', "font-family": "Montserrat" } } }] });
  ps.fire(0);
  assert.deepEqual(R14(ps.errors[0]), ["character U+2705 '\u2705' in \"\"ok\" \u2705\" isn't in Montserrat (no glyph; renders as a box)"]);
  // canvas: the context's font, fillText and strokeText; drawn as before (the original still runs)
  const cv = glyphPage({ draw: (c, t) => { c.g.font = "600 64px Inter"; c.g.fillText("Sent", 0, 0); if (t > 0.5) c.g.strokeText("Sent \u{1F680}", 0, 0); } });
  cv.fire(0);
  assert.deepEqual(cv.errors, [], "frame 0 draws no emoji (the seek-order check's draws are not checked)");
  cv.fire(1);
  assert.deepEqual(R14(cv.errors[0]), ["character U+1F680 '\u{1F680}' in \"Sent \u{1F680}\" isn't in Inter (no glyph; renders as a box)"]);
  assert.ok(cv.ctx.drawn.includes("Sent \u{1F680}"));
  // the graphic cannot unwrap fillText
  const un = glyphPage({ graphic: "CanvasRenderingContext2D.prototype.fillText = function () {}; try { Object.defineProperty(CanvasRenderingContext2D.prototype, 'fillText', { value: function () {} }); } catch (e) {}", draw: (c) => c.g.fillText("\u{1F680}", 0, 0) });
  un.fire(0); un.fire(0.1);
  assert.equal(un.errors.length, 1);
  // a data: @font-face that HAS the glyph: fine in that family, refused in another
  const emo = `@font-face { font-family: "Emo"; src: url(data:font/ttf;base64,${tinyFont([[0x1f44b, 0x1f44b]]).toString("base64")}); }`;
  const own = glyphPage({ style: emo, texts: [{ text: "hi \u{1F44B}", font: "Emo, sans-serif" }] });
  own.fire(0);
  assert.deepEqual(own.errors, []);
  const other = glyphPage({ style: emo, texts: [{ text: "hi \u{1F44B}", font: "Inter" }] });
  other.fire(0);
  assert.equal(other.errors.length, 1);
  // a long line: the snippet is 30 code units each side, cut with an ellipsis, never through a surrogate pair
  const long = glyphPage({ texts: [{ text: "\u{1F600}".repeat(20) + "x".repeat(40) + "\u{1F44B}" + "y".repeat(40) }] });
  long.fire(0);
  const a = RR.glyphArgs(long.errors[0].slice("GRAPHIC-REFUSED: glyph ".length));
  assert.equal(a.cp, "1F600");
  assert.equal(a.snippet, "\u{1F600}".repeat(16) + "…", "30 code units after the character's 2");
  const cut = glyphPage({ texts: [{ text: "→x" + "\u{1F600}".repeat(20) }] });
  cut.fire(0);
  assert.equal(RR.glyphArgs(cut.errors[0].slice("GRAPHIC-REFUSED: glyph ".length)).snippet, "→x" + "\u{1F600}".repeat(14) + "…", "the cut at 31 would split a pair: one less");
  assert.equal(RR.glyphArgs("{bad json"), null);
  assert.deepEqual(RR.scanLog('[Browser:ERROR] GRAPHIC-REFUSED: glyph {bad').map((x) => x.code), ["R2"], "an unreadable glyph line is still a refusal");
});

test("R14 bridge: Arabic from the bundled face, canvas font parsing, off-viewport text", () => {
  const ar = "مرحبا بالعالم";
  const inInter = glyphPage({ families: ["Inter"], texts: [{ text: ar }, { text: ar, font: '"Noto Sans Arabic"' }] });
  inInter.fire(0);
  assert.deepEqual(inInter.errors, [], "Arabic in an engine family the page loads: the aliased Noto Sans Arabic face has it");
  const generic = glyphPage({ families: ["Inter"], texts: [{ text: ar, font: "sans-serif" }] });
  generic.fire(0);
  assert.match(generic.errors[0] || "", /"cp":"645","font":"sans-serif"/, "a generic-only stack would need a system font: refused");
  const none = glyphPage({ texts: [{ text: ar }] });
  none.fire(0);
  assert.equal(none.errors.length, 1, "no engine family inlined: no Arabic face either");
  // canvas: the family list after the size, a quoted family holding "12px " included
  const q = glyphPage({ draw: (c) => { c.g.font = 'italic 700 48px "My 12px Font", serif'; c.g.fillText("\u{1F680}", 0, 0); } });
  q.fire(0.5);
  assert.match(q.errors[0] || "", /"font":"\\"My 12px Font\\", serif"/);
  const em = glyphPage({ draw: (c) => { c.g.font = "bold 3em/1.2 Inter, sans-serif"; c.g.fillText("\u{1F680}", 0, 0); } });
  em.fire(0.5);
  assert.match(em.errors[0] || "", /"font":"Inter, sans-serif"/, "any CSS length and a line-height, not only 'px '");
  // off-viewport (wholly outside the root's box) or empty boxes are not drawn: skipped; partly inside: checked
  const off = glyphPage({ boxes: true, texts: [{ text: "\u{1F44B}", rect: { left: 1200, top: 10, right: 1300, bottom: 60, width: 100, height: 50 } }, { text: "\u{1F680}", rect: { left: 0, top: -90, right: 50, bottom: 0, width: 50, height: 90 } }] });
  off.fire(0);
  assert.deepEqual(off.errors, []);
  const part = glyphPage({ boxes: true, texts: [{ text: "\u{1F44B}", rect: { left: 1050, top: 10, right: 1150, bottom: 60, width: 100, height: 50 } }] });
  part.fire(0);
  assert.equal(part.errors.length, 1);
  const pseudoOff = glyphPage({ boxes: true, texts: [{ text: "ok", rect: { left: -500, top: 0, right: -10, bottom: 50, width: 490, height: 50 }, pseudo: { "::after": { content: '"\u2705"', "font-family": "Inter" } } }] });
  pseudoOff.fire(0);
  assert.deepEqual(pseudoOff.errors, []);
});

test("wrapper: the Arabic face first, as Noto Sans Arabic and under each used engine family, only with an engine family", () => {
  const meta = insp(goodGraphic()).meta;
  const html = G.wrapperHtml({ html: goodGraphic(), meta, fps: 30, L: 60, inF: 0, D: 60 });
  const iAr = html.indexOf('@font-face { font-family: "Noto Sans Arabic"'), iMa = html.indexOf('@font-face { font-family: "Montserrat"; src');
  assert.ok(iAr > 0 && iAr < iMa, "declared before the Latin faces");
  assert.equal((html.match(/unicode-range: U\+0600-06FF/g) || []).length, 2, "Noto Sans Arabic + Montserrat");
  assert.equal(G.fontFaceCss([]), "", "no engine family: nothing inlined");
});

test("G36: an emoji / pictograph written in the file is refused before any render; accents pass", () => {
  assert.equal(first(doc({ body: "<p>See you at 5 \u{1F44B}</p>" })), R("G36", { cp: "1F44B", ch: "\u{1F44B}" }));
  assert.equal(first(doc({ script: "var s = 'love \u2764\ufe0f';" })), R("G36", { cp: "2764", ch: "\u2764" }));
  assert.equal(first(doc({ body: "<p>Café — naïve “ok” € ½ ↑ Привет</p>" })), "OK");
  assert.equal(R("G36", { cp: "1F44B", ch: "x" }), "graphic file assets/graphics/graphic.html has the character U+1F44B 'x' (an emoji or symbol: no engine font has a glyph for it, it renders as a box)");
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

test("cache key v4: canonical JSON, stable, sensitive to every field, media order free", () => {
  const base = { html: "<html>x</html>", media: [["assets/graphics/media/b.png", "bb"], ["assets/graphics/media/a.png", "aa"]], fonts: ["Oswald", "Inter"], chrome: "152.0.7977.30", ffmpeg: "7.1.1", platform: "darwin-arm64", fps: 30, w: 1080, h: 1080, mode: "overlay", frames: 60, inF: 0, after: "hold" };
  const k = G.graphicKey(base);
  assert.equal(k.json, `{"after":"hold","chrome":"152.0.7977.30","ffmpeg":"7.1.1","fonts":["Inter","Oswald"],"fps":30,"frames":60,"h":1080,"html":"${G.sha256("<html>x</html>")}","in":0,"media":[["assets/graphics/media/a.png","aa"],["assets/graphics/media/b.png","bb"]],"mode":"overlay","platform":"darwin-arm64","quality":"looks","renderer":"hyperframes@0.8.81","v":4,"w":1080}`);
  assert.equal(k.key, G.sha256(k.json));
  assert.equal(G.graphicKey({ ...base, media: [...base.media].reverse(), fonts: ["Inter", "Oswald"] }).key, k.key);
  for (const [f, v] of Object.entries({ html: "<html>y</html>", media: [], fonts: ["Inter"], chrome: "153.0.0.1", ffmpeg: "7.1.2", platform: "linux-x64", quality: "draft", fps: 25, w: 1078, h: 1078, mode: "insert", frames: 61, inF: 1, after: "loop" }))
    assert.notEqual(G.graphicKey({ ...base, [f]: v }).key, k.key, `key changes with ${f}`);
  assert.throws(() => G.graphicKey({ ...base, fps: 29.97 }), /integer/);
  // launch: only a root render has it; absent / empty leaves the key exactly as above
  assert.equal(G.graphicKey({ ...base, launch: undefined }).json, k.json);
  assert.equal(G.graphicKey({ ...base, launch: "" }).key, k.key);
  const rk = G.graphicKey({ ...base, launch: RR.ROOT_LAUNCH });
  assert.equal(rk.json, k.json.replace(',"media"', `,"launch":"root-drop --no-sandbox --disable-dev-shm-usage --disable-gpu","media"`));
  assert.notEqual(rk.key, k.key);
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
  const dir = tmpd(path.join(os.tmpdir(), "graphic-shim-"));
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
  const dir = fs.realpathSync(tmpd(path.join(os.tmpdir(), "graphic-root-")));
  const bin = path.join(dir, "bin"), rec = (n) => path.join(dir, `${n}.rec`);
  fs.mkdirSync(bin);
  const sh = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  sh("id", `echo ${id}`);
  sh("chown", `echo "$*" >> '${rec("chown")}'`);
  fs.symlinkSync(spawnSync("/bin/sh", ["-c", "command -v chmod"], { encoding: "utf8" }).stdout.trim(), path.join(bin, "chmod"));
  fs.writeFileSync(path.join(bin, "setpriv"), `#!${PERL}
open(my $f, ">>", "${rec("setpriv")}"); print $f join("\\n", @ARGV), "\\n"; close($f);
my ($i) = grep { $ARGV[$_] eq "--" } 0..$#ARGV; my @c = @ARGV[$i + 1 .. $#ARGV]; exec { $c[0] } @c or exit 127;
`, { mode: 0o755 });
  const chrome = path.join(dir, "fake chrome");
  fs.writeFileSync(chrome, `#!${process.execPath}
require("fs").writeFileSync(${JSON.stringify(rec("chrome"))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid }));
`, { mode: 0o755 });
  const project = path.join(dir, "project");
  fs.mkdirSync(path.join(project, "build", "graphics"), { recursive: true });
  const parent = path.join(dir, "graphic-chrome-test"); // as chromeHome makes it: root 0711 parent, uid 0700 home
  const home = path.join(parent, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o711);
  const shim = RR.chromeShim(path.join(project, "build", "graphics", "shim"), chrome, { lock, home: withHome ? home : null, setpriv: setpriv === true ? path.join(bin, "setpriv") : setpriv || null });
  fs.chmodSync(project, 0o700);
  const profile = path.join(dir, "puppeteer-profile");
  fs.mkdirSync(profile, { mode: 0o700 });
  const run = (env = {}, args = ["--headless", `--user-data-dir=${profile}`, "x"]) => {
    for (const n of ["chown", "setpriv", "chrome", "mark"]) fs.rmSync(rec(n), { force: true });
    const r = spawnSync(shim, args, { encoding: "utf8", cwd: project, env: { PATH: bin, SECRET_TOKEN: "s3cret", DATABASE_URL: "postgres://u:p@h/db", GRAPHIC_SHIM_MARK: rec("mark"), ...env } });
    const read = (n, f = (x) => x) => (fs.existsSync(rec(n)) ? f(fs.readFileSync(rec(n), "utf8")) : null);
    return { status: r.status, stderr: r.stderr, chown: read("chown", (x) => x.trim().split("\n")), setpriv: read("setpriv", (x) => x.trim().split("\n")), chrome: read("chrome", JSON.parse), mark: read("mark", (x) => x.trim()) };
  };
  return { dir, bin, chrome, shim, home, profile, project, run };
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
  refused(rootRig({ setpriv: false }).run(IDS), RR.SETPRIV_REFUSAL, "no setpriv path given to the shim");
  refused(rootRig({ setpriv: "relative/setpriv" }).run(IDS), RR.SETPRIV_REFUSAL, "a relative setpriv path");
  refused(rootRig({ setpriv: "/nonexistent/setpriv" }).run(IDS), RR.SETPRIV_REFUSAL, "a setpriv path that is not there");
  const ne = rootRig();
  fs.chmodSync(path.join(ne.bin, "setpriv"), 0o644);
  refused(ne.run(IDS), RR.SETPRIV_REFUSAL, "a setpriv that is not executable");
  refused(rootRig({ home: false }).run(IDS), "running as root: no home dir for the graphic Chrome (chromeShim needs one)", "no home");
  // the attack: the uid swaps its home for a symlink to a root file between launches. The shim refuses, and it never
  // chowns or chmods anything (it has no chown / chmod at all), so nothing is handed over through the link.
  const target = path.join(g.dir, "passwd");
  fs.writeFileSync(target, "root:x:0:0\n", { mode: 0o644 });
  const before = fs.statSync(target);
  fs.rmSync(g.home, { recursive: true });
  fs.symlinkSync(target, g.home);
  refused(g.run(IDS), `running as root: the graphic Chrome's home is not a directory: ${g.home}`, "home swapped for a symlink to a file");
  fs.rmSync(g.home); fs.symlinkSync(g.dir, g.home);
  refused(g.run(IDS), `running as root: the graphic Chrome's home is not a directory: ${g.home}`, "home swapped for a symlink to a dir");
  assert.deepEqual([fs.statSync(target).mode, fs.statSync(target).uid], [before.mode, before.uid], "the link's target is untouched");
  assert.doesNotMatch(fs.readFileSync(g.shim, "utf8"), /\b(chown|chmod|chgrp|command -v)\b/, "the shim changes no owner or mode and looks nothing up on PATH");
  // the Node side: the same refusals, before anything is written
  const spDir = tmpd(path.join(os.tmpdir(), "graphic-sp-"));
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
  assert.equal(r.chown, null, "the shim chowns nothing (Node handed the home over at creation); puppeteer's profile is never touched");
  assert.equal(fs.statSync(g.home).mode & 0o777, 0o700);
  const inProject = [...r.chrome.argv, ...Object.values(r.chrome.env), r.chrome.cwd].filter((x) => x.includes(g.project));
  assert.deepEqual(inProject, [], "no argv, env or cwd of Chrome points into the project dir (the uid may not enter it)");
  // a decoy setpriv first on PATH is never run: the shim runs the absolute path Node found
  const decoy = path.join(g.dir, "decoy");
  fs.mkdirSync(decoy);
  fs.writeFileSync(path.join(decoy, "setpriv"), `#!/bin/sh\necho DECOY > '${path.join(g.dir, "decoy.rec")}'\nexit 1\n`, { mode: 0o755 });
  const d = g.run({ ...IDS, PATH: `${decoy}:${g.bin}` });
  assert.deepEqual([d.status, fs.existsSync(path.join(g.dir, "decoy.rec")), d.chrome && d.chrome.argv.at(-1)], [0, false, `--user-data-dir=${g.home}/profile-${d.chrome && d.chrome.pid}`]);
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

test("chromeHome: root only; <root 0711 mkdtemp>/home 0700, lchown'd (never chown), refused when others cannot reach it", () => {
  assert.equal(RR.chromeHome({ root: false }), null);
  if (process.platform === "win32") return;
  const me = { root: true, uid: process.getuid(), gid: process.getgid() }; // chown to ourselves works without root
  const base = tmpd("/tmp/graphic-home-base-"); // /tmp: every parent searchable (the macOS user temp dir is 0700)
  fs.chmodSync(base, 0o755);
  const calls = [];
  const [lchown, chown] = [fs.lchownSync, fs.chownSync];
  fs.lchownSync = (...a) => { calls.push(["lchown", ...a]); return lchown(...a); };
  fs.chownSync = (...a) => { calls.push(["chown", ...a]); return chown(...a); };
  let h;
  try { h = RR.chromeHome(me, base); } finally { Object.assign(fs, { lchownSync: lchown, chownSync: chown }); }
  const parent = path.dirname(h);
  assert.deepEqual([path.basename(h), path.dirname(parent)], ["home", base]);
  assert.match(path.basename(parent), /^graphic-chrome-/);
  assert.deepEqual([fs.statSync(parent).mode & 0o777, fs.statSync(parent).uid], [0o711, process.getuid()], "the parent: the caller's (root's), searchable, not writable by the uid");
  assert.deepEqual([fs.lstatSync(h).isDirectory(), fs.statSync(h).mode & 0o777], [true, 0o700]);
  assert.deepEqual(calls, [["lchown", h, me.uid, me.gid]], "one lchown of the fresh home, no chown (which follows links)");
  RR.releaseChromeHome(h, { root: false });
  assert.equal(fs.existsSync(parent), false, "release removes the parent");
  fs.chmodSync(base, 0o700);
  assert.throws(() => RR.chromeHome(me, base), new RegExp(`^Error: running as root: ${base} is not searchable by other users`));
  assert.equal(RR.unsearchable(base), base);
  fs.chmodSync(base, 0o755);
  if (process.getuid() !== 0) {
    assert.throws(() => RR.chromeHome({ root: true, uid: 1, gid: 1 }, base), /EPERM/, "a failed lchown throws");
    assert.deepEqual(fs.readdirSync(base), [], "and leaves no dir behind");
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test("releaseChromeHome: kills every process of the uid (as the uid) BEFORE removing the home; only our own dirs", () => {
  const user = { root: true, uid: 1234, gid: 5678, setpriv: "/x/setpriv" };
  const mk = () => { const p = tmpd(path.join(os.tmpdir(), "graphic-chrome-")); fs.mkdirSync(path.join(p, "home")); return path.join(p, "home"); };
  const h = mk();
  const seen = [];
  const scans = [];
  const r = RR.releaseChromeHome(h, user, { killer: ["/bin/kill", "-9", "-1"], scan: (u) => { scans.push(u); return []; }, spawn: (cmd, argv, o) => { seen.push({ argv: [cmd, ...argv], homeThere: fs.existsSync(h), env: o.env, cwd: o.cwd }); return { status: 0 }; } });
  assert.deepEqual(seen.map((x) => x.argv), [["/x/setpriv", "--reuid=1234", "--regid=5678", "--clear-groups", "--inh-caps=-all", "--no-new-privs", "--", "/bin/kill", "-9", "-1"]]);
  assert.deepEqual([r.ok, scans], [true, [1234, 1234]], "the uid's live processes are scanned before and after the kill");
  assert.deepEqual([seen[0].homeThere, seen[0].env, seen[0].cwd, r.kill[0]], [true, { PATH: "/usr/bin:/bin" }, "/", "/x/setpriv"], "the kill runs first, with no inherited env, from /");
  assert.equal(fs.existsSync(path.dirname(h)), false, "then the home's parent is gone");
  // not root: no kill; a path that is not <graphic-chrome-*>/home is never removed
  const h2 = mk();
  assert.deepEqual(RR.releaseChromeHome(h2, { root: false }, { spawn: () => assert.fail("no kill when not root"), scan: () => assert.fail("no scan") }), { ok: true, kill: null, left: [] });
  assert.equal(fs.existsSync(path.dirname(h2)), false);
  const other = tmpd(path.join(os.tmpdir(), "graphic-other-"));
  RR.releaseChromeHome(other, { root: false });
  assert.equal(fs.existsSync(other), true, "a dir that is not ours stays");
  assert.deepEqual(RR.releaseChromeHome(null, user, { spawn: () => assert.fail() }), { ok: true, kill: null, left: [] });
  // a kill that fails, or a survivor: the home is KEPT and ok is false, with the reason
  const K = ["/bin/kill", "-9", "-1"];
  for (const [name, spawnR, left, re] of [
    ["exec failure (exit 127)", { status: 127 }, [], /the kill \(\/x\/setpriv .* \/bin\/kill -9 -1\) failed: exit 127/],
    ["spawn error", { error: new Error("spawnSync /x/setpriv ENOENT"), status: null }, [], /failed: spawnSync \/x\/setpriv ENOENT/],
    ["killed by a signal", { status: null, signal: "SIGKILL" }, [], /failed: signal SIGKILL/],
    ["a survivor", { status: 0 }, [4242], /1 process\(es\) of uid 1234 still alive \(4242\)/],
    ["status 1 (nothing to signal) but a survivor", { status: 1 }, [77], /still alive \(77\)/],
  ]) {
    const hk = mk();
    const x = RR.releaseChromeHome(hk, user, { killer: K, spawn: () => spawnR, scan: () => left });
    assert.equal(x.ok, false, name);
    assert.match(x.error, re, name);
    assert.match(x.error, new RegExp(`^running as root: .*; the graphic Chrome's home is KEPT at ${hk}$`), name);
    assert.equal(fs.existsSync(hk), true, `${name}: the home is kept`);
    fs.rmSync(path.dirname(hk), { recursive: true });
  }
  const h1 = mk();
  assert.equal(RR.releaseChromeHome(h1, user, { killer: K, spawn: () => ({ status: 1 }), scan: () => [] }).ok, true, "exit 1 with nothing alive (kill -1 found nothing): released");
  assert.equal(fs.existsSync(h1), false);
  const hn = mk();
  assert.match(RR.releaseChromeHome(hn, { ...user, setpriv: null }, { scan: () => [] }).error, /no setpriv to kill/);
  assert.equal(fs.existsSync(hn), true);
  // the killer: the system kill (absolute, executable), else this node
  const kd = tmpd(path.join(os.tmpdir(), "graphic-kill-"));
  fs.writeFileSync(path.join(kd, "noexec"), "", { mode: 0o644 });
  fs.writeFileSync(path.join(kd, "kill"), "#!/bin/sh\n", { mode: 0o755 });
  assert.deepEqual(RR.uidKiller([path.join(kd, "missing"), path.join(kd, "noexec"), path.join(kd, "kill")]), [path.join(kd, "kill"), "-9", "-1"]);
  assert.deepEqual(RR.uidKiller([path.join(kd, "missing")]).slice(0, 2), [process.execPath, "-e"]);
});

test("uidProcesses: live processes of a real uid, zombies skipped", { skip: process.platform === "win32" }, async () => {
  assert.ok(RR.uidProcesses(process.getuid()).includes(process.pid));
  assert.deepEqual(RR.uidProcesses(4242424), []);
  // a zombie of ours: sh starts `sleep 0` and execs into a sleep that never reaps it
  const z = spawn("/bin/sh", ["-c", "sleep 0 & echo $!; exec sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
  const zpid = Number(await new Promise((r) => z.stdout.once("data", (d) => r(String(d).trim()))));
  let state = "";
  for (let i = 0; i < 30 && !state.startsWith("Z"); i++) { await new Promise((r) => setTimeout(r, 100)); state = spawnSync("ps", ["-o", "stat=", "-p", String(zpid)], { encoding: "utf8" }).stdout.trim(); }
  try {
    assert.match(state, /^Z/, "the child is a zombie");
    assert.ok(!RR.uidProcesses(process.getuid()).includes(zpid), "a zombie is not a live process");
    assert.ok(RR.uidProcesses(process.getuid()).includes(z.pid), "its live parent is");
  } finally { z.kill("SIGKILL"); }
});

test("holdHostLock: exclusive, released on release() and when the holder crashes; refuses a symlink; hostLockPath", { skip: process.platform === "win32" }, async () => {
  const dir = tmpd(path.join(os.tmpdir(), "graphic-lock-"));
  const file = path.join(dir, "graphic-chrome-1234.lock");
  fs.writeFileSync(file, "", { mode: 0o644 }); // an existing lock file with a wider mode is made 0600
  const a = await RR.holdHostLock(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  let got = false;
  const b = RR.holdHostLock(file).then((l) => { got = true; return l; });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(got, false, "the second waits");
  a.release();
  (await b).release();
  assert.equal(got, true);
  // a holder that is SIGKILLed: the pipe closes, the lock is free
  const mod = path.join(path.dirname(fileURLToPath(import.meta.url)), "graphic-render.mjs");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(mod)}); await m.holdHostLock(${JSON.stringify(file)}); console.log("HELD"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => child.stdout.once("data", r));
  const t0 = Date.now();
  const c = RR.holdHostLock(file);
  child.kill("SIGKILL");
  (await c).release();
  assert.ok(Date.now() - t0 < 5000, "free soon after the holder died");
  await assert.rejects(RR.holdHostLock(file, { timeoutMs: 300 }).then(async (l) => { const d = RR.holdHostLock(file, { timeoutMs: 300 }); try { await d; } finally { l.release(); } }), /not free after 0 s/);
  const link = path.join(dir, "link.lock");
  fs.symlinkSync(path.join(dir, "target"), link);
  await assert.rejects(RR.holdHostLock(link).then((l) => l.release()), /cannot use the host lock .*link\.lock/); // (released if it ever resolves: no hang)
  assert.equal(fs.existsSync(path.join(dir, "target")), false, "nothing created through the link");
  // hostLockPath: the first root-only dir (here "root" = us): owned, not group/world-writable; never a temp-dir fallback
  const me = process.getuid();
  const [open, grp, good, good2] = ["open", "grp", "good", "good2"].map((n) => { const d = path.join(dir, n); fs.mkdirSync(d); return d; });
  fs.chmodSync(open, 0o1777); fs.chmodSync(grp, 0o775); fs.chmodSync(good, 0o755); fs.chmodSync(good2, 0o700);
  const vlink = path.join(dir, "lock-link"); fs.symlinkSync(open, vlink); // like /var/lock -> /run/lock (1777)
  assert.equal(RR.hostLockPath(1234, { dirs: [path.join(dir, "missing"), open, grp, vlink, good, good2], owner: me }), path.join(good, "graphic-chrome-1234.lock"));
  assert.equal(RR.hostLockPath(1234, { dirs: [good2], owner: me }), path.join(good2, "graphic-chrome-1234.lock"));
  assert.equal(RR.hostLockPath(1234, { dirs: [good], owner: me + 1 }), null, "not owned by root: no");
  assert.equal(RR.hostLockPath(1234, { dirs: [open, grp, vlink], owner: me }), null, "nothing root-only: null (refused), no temp-dir fallback");
  if (RR.hostLockPath(4242) === null) await assert.rejects(RR.hostLock({ uid: 4242 }).then((l) => l.release()), { message: RR.NO_LOCK_DIR }, "no root-only dir here: refused with the reason");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderGraphic as root: refused before anything when the drop is not set up; home made, passed, released on every path; own cache key", async () => {
  const calls = [];
  const bad = await rg({ chromeUser: () => ({ root: true, error: RR.ROOT_REFUSAL }), findChrome: () => { calls.push("find"); return "/fake/chrome"; } });
  assert.deepEqual([bad.r.ok, bad.r.codes, bad.r.reasons, bad.r.stage, bad.calls, calls], [false, ["R12"], [G.reason("R12n", { message: RR.ROOT_REFUSAL })], "setup", { render: 0, probe: 0 }, []]);
  assert.equal(fs.existsSync(path.join(bad.work, "build")), false, "nothing written");
  const root = { root: true, uid: 1234, gid: 5678, setpriv: "/x/setpriv" };
  const lockFile = path.join(tmpd(path.join(os.tmpdir(), "graphic-lock-")), "graphic-chrome-1234.lock");
  const plain = await rg({});
  for (const [name, over, ok] of [
    ["clean", {}, true],
    ["render fails", { runRender: async () => ({ status: 1, secs: 1, log: "boom", timedOut: false }) }, false],
    ["render times out", { runRender: async () => ({ status: -1, secs: 99, log: "killed after 99 s (render timeout)", timedOut: true }) }, false],
    ["probe refuses", { probeNetwork: () => ({ ok: false, lines: [], refusal: "x" }) }, false],
    ["render throws", { runRender: async () => { throw new Error("boom"); } }, null],
  ]) {
    let home = null, got = null, user = null;
    const order = [];
    const deps = { chromeUser: () => root, chromeHome: (u) => { order.push("home"); assert.equal(u, root); home = tmpd(path.join(os.tmpdir(), "graphic-chrome-")) + "/home"; fs.mkdirSync(home); return home; },
      hostLock: async (u) => { assert.equal(u, root); const l = await RR.holdHostLock(lockFile); order.push("lock"); return { release: () => { order.push("unlock"); l.release(); } }; },
      sweepUid: (u) => { order.push("sweep"); assert.equal(u, root); return { ok: true, found: [] }; },
      releaseChromeHome: (h, u) => { order.push("release"); assert.equal(u, root); return RR.releaseChromeHome(h, u, { scan: () => [], spawn: () => { order.push("kill"); return { status: 0 }; } }); },
      chromeShim: (d, exe, o) => { got = o; return "/fake/shim"; }, probeNetwork: (o) => { user = o.user; return { ok: true, lines: [] }; }, ...over };
    let x;
    try { x = await rg(deps); } catch (e) { x = { r: { ok: null, reasons: [e.message] }, work: "" }; }
    assert.equal(x.r.ok, ok, `${name}: ${x.r.reasons}`);
    assert.deepEqual([got.home, got.setpriv], [home, "/x/setpriv"], `${name}: the shim gets the home and the absolute setpriv`);
    assert.ok(!x.work || !home.startsWith(x.work), `${name}: the home is not under the project/build dir`);
    assert.deepEqual(order, ["lock", "sweep", "home", "release", "kill", "unlock"], `${name}: lock, sweep leftovers, home, kill the uid's processes, unlock`);
    assert.equal(fs.existsSync(path.dirname(home)), false, `${name}: then the home is removed`);
    if (!over.probeNetwork) assert.equal(user.uid, 1234, "the probe is told who Chrome runs as");
    if (name === "clean") assert.notEqual(path.basename(x.r.file), path.basename(plain.r.file), "a root render is cached under another key than a plain one");
  }
  // the release fails (a survivor): the render FAILS, loudly, its file is not kept, the home stays, the lock goes
  {
    let home = null, unlocked = false;
    const err = console.error; const said = []; console.error = (m) => said.push(m);
    let x;
    try {
      x = await rg({ chromeUser: () => root, chromeHome: () => { home = tmpd(path.join(os.tmpdir(), "graphic-chrome-")) + "/home"; fs.mkdirSync(home); return home; },
        hostLock: async () => ({ release: () => { unlocked = true; } }), sweepUid: () => ({ ok: true, found: [] }),
        releaseChromeHome: (h, u) => RR.releaseChromeHome(h, u, { scan: () => [999], spawn: () => ({ status: 0 }) }) });
    } finally { console.error = err; }
    assert.equal(x.r.ok, false);
    assert.equal(x.r.stage, "release");
    assert.deepEqual(x.r.codes, ["R12"]);
    assert.match(x.r.reasons[0], /^graphic Chrome could not be cleaned up safely: running as root: 1 process\(es\) of uid 1234 still alive \(999\); the graphic Chrome's home is KEPT at /);
    assert.deepEqual([x.out, x.r.file], [[], null], "no final file kept from this render");
    assert.equal(fs.existsSync(home), true, "the home is kept");
    assert.equal(unlocked, true, "the lock is released anyway");
    assert.match(said.join("\n"), /^GRAPHIC RENDER UNSAFE: running as root: 1 process/);
    fs.rmSync(path.dirname(home), { recursive: true });
  }
  // leftovers of an earlier render (its Node SIGKILLed): killed first (logged); a survivor refuses, before any home
  {
    const lines = [];
    let unlocked = false;
    const swept = await rg({ chromeUser: () => root, hostLock: async () => ({ release: () => {} }), sweepUid: (u) => RR.sweepUid(u, { scan: (() => { let n = 0; return () => (n++ ? [] : [31, 32]); })(), spawn: () => ({ status: 0 }) }),
      chromeHome: () => null, releaseChromeHome: () => ({ ok: true }) }, { log: (l) => lines.push(l) });
    assert.equal(swept.r.ok, true, swept.r.reasons.join());
    assert.ok(lines.includes("killed 2 lingering process(es) of uid 1234 before the render"), lines.join("|"));
    const stuck = await rg({ chromeUser: () => root, hostLock: async () => ({ release: () => { unlocked = true; } }),
      sweepUid: (u) => RR.sweepUid(u, { scan: () => [77], spawn: () => ({ status: 0 }) }), chromeHome: () => assert.fail("no home while the uid has leftovers") });
    assert.deepEqual([stuck.r.ok, stuck.r.stage, stuck.calls.probe, unlocked], [false, "setup", 0, true]);
    assert.equal(stuck.r.reasons[0], G.reason("R12n", { message: `${RR.LINGERING} (1 process(es) of uid 1234 still alive (77))` }));
    const nokill = RR.sweepUid({ ...root, setpriv: "/x/setpriv" }, { scan: () => [], spawn: () => ({ status: 127 }) });
    assert.deepEqual([nokill.ok, nokill.error.startsWith(RR.LINGERING)], [false, true], "a sweep whose kill cannot run refuses too");
    assert.deepEqual(RR.sweepUid(root, { scan: () => [], spawn: () => ({ status: 1 }) }), { ok: true, found: [] }, "nothing there: fine");
  }
  // a lock that cannot be had: a setup refusal, no home
  const nolock = await rg({ chromeUser: () => root, hostLock: async () => { throw new Error("running as root: host lock /x: not free after 1800 s (another graphic render with this uid?)"); }, chromeHome: () => assert.fail("no home without the lock") });
  assert.deepEqual([nolock.r.stage, nolock.r.reasons, nolock.calls.probe], ["setup", [G.reason("R12n", { message: "running as root: host lock /x: not free after 1800 s (another graphic render with this uid?)" })], 0]);
  // two concurrent root renders with the same uid (the real lock, flock / lockf): serialised, home to release
  {
    const spans = [];
    const one = (tag) => rg({ chromeUser: () => root, hostLock: () => RR.holdHostLock(lockFile), sweepUid: () => ({ ok: true, found: [] }),
      chromeHome: () => { spans.push(`${tag}+`); const h = tmpd(path.join(os.tmpdir(), "graphic-chrome-")) + "/home"; fs.mkdirSync(h); return h; },
      releaseChromeHome: (h, u) => { spans.push(`${tag}-`); return RR.releaseChromeHome(h, u, { scan: () => [], spawn: () => ({ status: 0 }) }); },
      runRender: async ({ out, markFile }) => { await new Promise((r) => setTimeout(r, 150)); fs.writeFileSync(out, "video"); fs.writeFileSync(markFile, "4242\n"); return { status: 0, secs: 1, log: "[BrowserManager] Browser launched (HeadlessChrome/152.0.7977.30, screenshot)\n" }; } });
    const [a, b] = await Promise.all([one("A"), one("B")]);
    assert.deepEqual([a.r.ok, b.r.ok], [true, true]);
    assert.ok(spans.join(" ") === "A+ A- B+ B-" || spans.join(" ") === "B+ B- A+ A-", `serialised: ${spans.join(" ")}`);
  }
  fs.rmSync(path.dirname(lockFile), { recursive: true, force: true });
  const thrown = await rg({ chromeHome: () => { throw new Error("running as root: /x is not searchable by other users"); } });
  assert.deepEqual([thrown.r.reasons, thrown.calls.probe], [[G.reason("R12n", { message: "running as root: /x is not searchable by other users" })], 0]);
});

test("findChrome: the pinned build, else the highest cached build not above its major", () => {
  const home = tmpd(path.join(os.tmpdir(), "graphic-home-"));
  const base = path.join(home, ".cache", "hyperframes", "chrome", "chrome-headless-shell");
  const mk = (v) => { const d = path.join(base, `mac_arm-${v}`, "sub"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell"), ""); return path.join(d, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell"); };
  mk("153.0.1.1"); const v99 = mk("99.10.0.1"); mk("99.9.0.1"); const pin = mk(RR.PINNED_CHROME);
  assert.equal(RR.findChrome({}, home), pin);
  fs.rmSync(path.dirname(path.dirname(pin)), { recursive: true });
  assert.equal(RR.findChrome({}, home), v99, "semantic order (99.10 > 99.9), 153 is above the ceiling");
  assert.equal(RR.findChrome({ HYPERFRAMES_BROWSER_PATH: "/x" }, home), "/x");
});

test("findChrome: GRAPHIC_CHROME_PATH first, and a broken one refuses instead of falling back", async () => {
  const home = tmpd(path.join(os.tmpdir(), "graphic-home-"));
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
  const work = tmpd(path.join(os.tmpdir(), "graphic-rg-"));
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
  const work = tmpd(path.join(os.tmpdir(), "graphic-rg-"));
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

test("procInfo on Linux (stubbed /proc): exe unreadable to root (EACCES) -> argv[0], else the 15-char comm; real uid; killChromes checks the uid in root mode", () => {
  const SHELL = "/opt/chrome/chrome-headless-shell/linux64-152.0.7977.30/chrome-headless-shell-linux64/chrome-headless-shell";
  const eacces = () => { const e = new Error("EACCES: permission denied, readlink"); e.code = "EACCES"; throw e; };
  const enoent = () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; };
  // pid -> { exe?, cmdline?, comm, uid, pgid }; a missing key = that read throws (exe: EACCES, others: ENOENT)
  const PROCS = {
    101: { cmdline: `${SHELL}\0--headless\0`, comm: "chrome-headless", uid: 10101, pgid: 101 },      // dropped browser
    102: { cmdline: `${SHELL}\0--type=renderer\0`, comm: "chrome-headless", uid: 10101, pgid: 101 }, // its renderer
    103: { comm: "chrome-headless", uid: 10101, pgid: 103 },                                             // cmdline gone: comm
    104: { cmdline: `${SHELL}\0`, comm: "chrome-headless", uid: 0, pgid: 104 },                         // a root Chrome
    105: { cmdline: "/usr/bin/node\0x.js\0", comm: "node", uid: 10101, pgid: 105 },                     // reused PID
    106: { exe: "/usr/lib/chromium/chromium", comm: "chromium", uid: 1000, pgid: 106 },                  // exe readable
    107: { comm: "chrome", uid: 10101, pgid: 107 },                                                       // short comm: exact
    108: { comm: "chrome-headles", uid: 10101, pgid: 108 },                                               // 14 chars: not a truncation
  };
  const io = {
    read: (f) => {
      const [, pid, what] = /^\/proc\/(\d+)\/(\w+)$/.exec(f);
      const p = PROCS[pid];
      if (!p) enoent();
      if (what === "stat") return `${pid} (${p.comm}) S 1 ${p.pgid} ${p.pgid} 0 -1`;
      if (what === "status") return `Name:\t${p.comm}\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\nGroups:\t\nNStgid:\t${pid}\n`;
      if (what === "cmdline" && p.cmdline) return p.cmdline;
      enoent();
    },
    readlink: (f) => { const p = PROCS[/\/proc\/(\d+)\/exe/.exec(f)[1]]; if (p && p.exe) return p.exe; eacces(); },
  };
  const info = (pid) => RR.procInfo(pid, { platform: "linux", io, alive: (p) => { if (!PROCS[p]) throw new Error("ESRCH"); } });
  assert.deepEqual(info(101), { exe: "chrome-headless-shell", pgid: 101, uid: 10101, via: "cmdline" });
  assert.deepEqual(info(103), { exe: "chrome-headless", pgid: 103, uid: 10101, via: "comm" });
  assert.deepEqual(info(106), { exe: "chromium", pgid: 106, uid: 1000, via: "exe" });
  assert.equal(info(999), null, "dead");
  assert.equal(info(1), null);
  const sent = [];
  const all = [1, 101, 102, 103, 104, 105, 106, 107, 108, 999, 0];
  assert.deepEqual(RR.killChromes(all, { kill: (p) => sent.push(p), info }), ["-101", "101", "102", "-103", "103", "-104", "104", "-106", "106", "-107", "107"], "non-root: any verified Chrome (as before), found without /proc/<pid>/exe");
  assert.deepEqual(RR.killChromes(all, { kill: () => {}, info, uid: 10101 }), ["-101", "101", "102", "-103", "103", "-107", "107"], "root mode: only Chromes of GRAPHIC_CHROME_UID (not the root one, not uid 1000)");
  assert.deepEqual(RR.killChromes([105, 108], { kill: () => assert.fail("never"), info, uid: 10101 }), [], "a reused PID or a non-Chrome comm is never touched");
  assert.equal(RR.isChrome(102, info), true);
});

test("renderGraphic passes the dropped uid to runRender (root) and nothing (non-root)", async () => {
  const got = [];
  const runRender = async (o) => { got.push(o.chromeUid); fs.writeFileSync(o.out, "video"); fs.writeFileSync(o.markFile, "4242\n"); return { status: 0, secs: 1, log: "[BrowserManager] Browser launched (HeadlessChrome/152.0.7977.30, screenshot)\n" }; };
  const root = { root: true, uid: 10101, gid: 10101, setpriv: "/x/setpriv" };
  const r = await rg({ runRender, chromeUser: () => root, hostLock: async () => ({ release: () => {} }), sweepUid: () => ({ ok: true, found: [] }), chromeHome: () => null });
  assert.equal(r.r.ok, true, r.r.reasons.join());
  await rg({ runRender });
  assert.deepEqual(got, [10101, 10101, null, null]);
});

test("runRender: no inherited origins, the PID marker, a hung render is killed with its process group", { skip: process.platform === "win32" }, async () => {
  const dir = tmpd(path.join(os.tmpdir(), "graphic-run-"));
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
  // root mode (chromeUid): a marked Chrome of another uid is left alone, one of the dropped uid is killed
  const [mine, theirs] = [sleeper(), sleeper()];
  fs.writeFileSync(markBin, `require("fs").writeFileSync(process.env.GRAPHIC_SHIM_MARK, "${mine}\\n${theirs}\\n"); setInterval(() => {}, 1000);`);
  const info3 = (pid) => (pid === mine ? { exe: "chrome-headless-shell", pgid: 0, uid: 10101 } : pid === theirs ? { exe: "chrome-headless-shell", pgid: 0, uid: 0 } : null);
  const ru = await RR.runRender({ dir, out: "--x", mode: "overlay", fps: 30, launcher: { argv: [] }, shim: null, markFile: path.join(dir, "m6"), bin: markBin, timeoutMs: 1500, kill: (p, sig) => process.kill(p, sig), info: info3, chromeUid: 10101 });
  assert.deepEqual([ru.timedOut, ru.killed.slice(1)], [true, [String(mine)]], "only the dropped uid's Chrome");
  await new Promise((ok) => setTimeout(ok, 300));
  assert.throws(() => process.kill(mine, 0));
  assert.doesNotThrow(() => process.kill(theirs, 0), "another uid's Chrome is alive");
  process.kill(theirs, "SIGKILL");
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
    duration: "<duration>", platform: "<platform name>", cp: "<hex>", ch: "<char>", snippet: "<snippet>", font: "<font>" };
  const MORE = { G16: ["G16o"], G17: ["G17n"], R4: ["R4p"], R6: ["R6n", "R6L", "R6o"], R12: ["R12n", "R12c"] };
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

test("CLI render lock: a lock already held is reported (an outer lockf + --lock on one file would wait forever); the host lock is another file", { skip: process.platform === "win32" }, async () => {
  const L = await import("./graphic-lock.mjs");
  const dir = tmpd(path.join(os.tmpdir(), "graphic-busy-"));
  const p = path.join(dir, "render.lock");
  assert.equal(L.busyHint(p), null, "free: no hint");
  const held = await RR.holdHostLock(p); // stands in for an outer `lockf -k <p>`
  try { assert.match(L.busyHint(p) || "", /is held by another process: waiting\. If this command was itself started under lockf \/ flock on .*render\.lock, it waits for itself forever/); } finally { held.release(); }
  const own = { dirs: [dir], owner: process.getuid() };
  fs.chmodSync(dir, 0o755);
  assert.match(path.basename(RR.hostLockPath(1234, own)), /^graphic-chrome-1234\.lock$/, "the engine's host lock never names the CLIs' render lock");
  assert.notEqual(RR.hostLockPath(0, own), p);
});

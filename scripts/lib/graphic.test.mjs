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
  assert.ok(html.includes('window.addEventListener("hf-seek"'));
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

// run the bridge in a vm with a fake window; returns what seek saw and what console.error printed
function bridge({ seek, duration = 2, size = { w: 1080, h: 1080 }, winDuration = duration, winSize = size, L = 90, inF = 0, D = 60, after = "hold", nav = false }) {
  const listeners = {}, errors = [], seen = [];
  const navListeners = [];
  const window = { duration: winDuration, size: winSize, addEventListener: (n, f) => (listeners[n] = f), seek: seek === undefined ? (t) => seen.push(t) : seek,
    navigation: nav ? { addEventListener: (n, f) => navListeners.push(f) } : undefined };
  vm.runInNewContext(G.bridgeScript({ fps: 30, L, inF, D, after, duration, size }), { window, console: { error: (m) => errors.push(m) } });
  return { fire: (time) => listeners["hf-seek"]({ detail: { time } }), seen, errors, navigate: () => { let prevented = false; navListeners.forEach((f) => f({ cancelable: true, preventDefault: () => (prevented = true) })); return prevented; } };
}
test("bridge: frame map, refusals (R3, R4, R5, R11)", () => {
  const b = bridge({});
  b.fire(0); b.fire(1); b.fire(2.5);
  assert.deepEqual(b.seen, [0, 1, 59 / 30], "hold: past the end shows the last frame");
  const l = bridge({ after: "loop", inF: 15 });
  l.fire(2); assert.deepEqual(l.seen, [15 / 30], "loop: (in + j) mod D");
  assert.deepEqual(b.errors, []);
  const t = bridge({ seek: (x) => { if (x >= 1) throw new Error("boom"); } });
  t.fire(0.5); t.fire(1); t.fire(1.5);
  assert.deepEqual(t.errors, ["GRAPHIC-REFUSED: seek(1) threw: boom"], "reported once");
  const p = bridge({ seek: () => ({ then() {} }) }); p.fire(0.1);
  assert.deepEqual(p.errors, ["GRAPHIC-REFUSED: seek(0.1) returned a Promise"]);
  assert.deepEqual(bridge({ seek: null }).errors, ["GRAPHIC-REFUSED: window.seek is not a function"]);
  assert.deepEqual(bridge({ winDuration: 3 }).errors, ["GRAPHIC-REFUSED: window.duration / window.size changed at load (static 2s 1080x1080, at load 3s 1080x1080)"]);
  const n = bridge({ nav: true });
  assert.equal(n.navigate(), true, "a page-started navigation is cancelled");
  assert.deepEqual(n.errors, ["GRAPHIC-REFUSED: navigated"]);
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
    "[INFO] nothing",
  ].join("\n");
  assert.deepEqual(RR.scanLog(log).map((x) => x.text), [
    G.reason("R1", { url: "https://example.com/a.png" }), G.reason("R1", { url: "https://fonts.googleapis.com/css2?family=X" }),
    G.reason("R2", { message: "ReferenceError: x is not defined" }), G.reason("R3"), G.reason("R4", { t: "1.2", message: "boom" }),
    G.reason("R4p", { t: "0.1" }), G.reason("R5", { a: "2s 1080x1080", b: "3s 1080x1080" }), G.reason("R11"),
  ]);
  assert.equal(RR.launchedChrome("[BrowserManager] Browser launched (HeadlessChrome/152.0.7977.30, screenshot, gl=x)"), "152.0.7977.30");
  assert.equal(RR.compareFrames(["a", "b"], ["a", "b"], 30), null);
  assert.equal(RR.compareFrames(["a", "b", "c"], ["a", "x", "c"], 30), G.reason("R6", { i: 1, t: "0.033" }));
  assert.equal(RR.compareFrames(["a"], ["a", "b"], 30), G.reason("R6n", { a: 1, b: 2 }));
  assert.equal(RR.budgetFor(60), 29);
  assert.equal(RR.budgetFor(900), 155);
});

test("cache key v2: canonical JSON, stable, sensitive to every field, media order free", () => {
  const base = { html: "<html>x</html>", media: [["assets/graphics/media/b.png", "bb"], ["assets/graphics/media/a.png", "aa"]], fonts: ["Oswald", "Inter"], chrome: "152.0.7977.30", ffmpeg: "7.1.1", platform: "darwin-arm64", fps: 30, w: 1080, h: 1080, mode: "overlay", frames: 60, inF: 0, after: "hold" };
  const k = G.graphicKey(base);
  assert.equal(k.json, `{"after":"hold","chrome":"152.0.7977.30","ffmpeg":"7.1.1","fonts":["Inter","Oswald"],"fps":30,"frames":60,"h":1080,"html":"${G.sha256("<html>x</html>")}","in":0,"media":[["assets/graphics/media/a.png","aa"],["assets/graphics/media/b.png","bb"]],"mode":"overlay","platform":"darwin-arm64","quality":"looks","renderer":"hyperframes@0.8.81","v":2,"w":1080}`);
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

test("Chrome shim and probe (stubbed): flags, loopback only for the render server, R12 texts", () => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-shim-"));
  const fake = path.join(dir, "fake-chrome");
  fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });
  const shim = RR.chromeShim(path.join(dir, "s"), fake);
  const args = (env) => spawnSync(shim, ["--headless", "x"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } }).stdout.trim().split("\n");
  const a = args({});
  for (const f of RR.CHROME_FLAGS) assert.ok(a.includes(f), f);
  assert.ok(a.includes("--proxy-bypass-list=<-loopback>"), "no origin known: no loopback at all");
  assert.deepEqual(a.slice(-2), ["--headless", "x"]);
  assert.ok(args({ GRAPHIC_RENDER_ORIGINS: "localhost:5000;127.0.0.1:5000" }).includes("--proxy-bypass-list=<-loopback>;localhost:5000;127.0.0.1:5000"));
  const stub = (chromeOut, nodeOut) => (cmd, argv) => (argv.some((x) => String(x).endsWith("graphic-probe.mjs")) ? { stdout: chromeOut } : { stdout: nodeOut });
  const urls = RR.PROBE_URLS;
  const ok = RR.probeNetwork({ launcher: { argv: [] }, shim, spawn: stub(JSON.stringify({ lines: urls.map((u) => `FAILED ${u} TypeError`) }), urls.map((u) => `FAILED ${u}`).join("|")) });
  assert.equal(ok.ok, true);
  const reached = RR.probeNetwork({ launcher: { argv: [] }, shim, spawn: stub(JSON.stringify({ lines: [`REACHED ${urls[0]}`, `FAILED ${urls[1]} TypeError`] }), "") });
  assert.equal(reached.refusal, G.reason("R12", { url: "http://1.1.1.1/" }));
  const silent = RR.probeNetwork({ launcher: { argv: [] }, shim, spawn: stub(JSON.stringify({ lines: [], error: "Chrome exited 1" }), urls.map((u) => `FAILED ${u}`).join("|")) });
  assert.equal(silent.refusal, G.reason("R12n", { message: "Chrome: Chrome exited 1" }));
  assert.equal(RR.probeNetwork({ launcher: { argv: [] }, shim: null }).refusal, G.reason("R12n", { message: "no Chrome launcher shim (chrome-headless-shell not found, or Windows)" }));
  assert.deepEqual(RR.sandboxLauncher({ GRAPHIC_SANDBOX: '["sandbox-exec","-f","/p.sb"]' }).argv, ["sandbox-exec", "-f", "/p.sb"]);
  assert.deepEqual(RR.sandboxLauncher({}).argv, []);
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
  const SECOND = { G16: "G16o", G17: "G17n", R4: "R4p", R6: "R6n", R12: "R12n" };
  const seen = new Set(), diffs = [];
  for (const line of sec.split("\n")) {
    const m = /^\| (G\d+|P\d+|R\d+|GW\d+)(?: \(v[\d.]+\))? \|/.exec(line);
    if (!m) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
    const id = m[1];
    const cell = id.startsWith("GW") || id.startsWith("P") ? cells[1] : cells[cells.length - 1];
    let texts = [...cell.matchAll(/`([^`]+)`/g)].map((x) => x[1].replace(/\\\|/g, "|"));
    if (id.startsWith("GW")) texts = texts.slice(0, 1);
    texts.forEach((want, n) => {
      const code = n === 0 ? id : SECOND[id];
      if (!code || !G.REASONS[code]) { diffs.push(`${id}#${n}: no code for '${want}'`); return; }
      seen.add(code);
      const got = G.reason(code, PH);
      if (got !== want) diffs.push(`${code}:\n  spec ${want}\n  code ${got}`);
    });
  }
  assert.deepEqual(diffs, []);
  const missing = Object.keys(G.REASONS).filter((c) => !seen.has(c));
  assert.deepEqual(missing, [], "every code in REASONS has its spec row");
});

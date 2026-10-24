#!/usr/bin/env node
// node --test scripts/build-caption-height.test.mjs
// mac-45: the caption placer reserved `size x 1.3` for every block (75 px for Broadsheet's 58 px "clipping" caption).
// The clipping box is drawn taller: Gloock at line-height 1.08 plus 6 + 12 px of box padding (80.64 px), and the
// group's tilt (`rotate` on top of translateX(-50%), about the group's centre) lowers or lifts the box by up to
// (width + 40) x sin(tilt). On a real close-up reel (m41c B1) a 3-word lower-face block cg7 (4 + 3 + 4 letters, tilt -1.6deg)
// was drawn 90 px tall at top 1425 and ended at 1515.5, 15 px into Instagram's bottom UI band (safe bottom 1500);
// pixel check PX11 found it. The placer's hysteresis then also held a taller block at a shorter one's y.
//   - model: the reserved band for a cg7-shaped block (stand-in text of the same letters per word and drawn width, 335 px),
//     size and tilt covers what Chrome drew (constants measured once, below); an emoji run is modelled at or over too
//   - build: the same close-up, that block at the same index: every block's band ends inside the safe area
//   - real Chrome: every drawn box lies inside the band the placer reserved for it, and above the bottom UI band
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";
import { findPuppeteer, findChrome } from "./lib/browser.mjs";
import { findChrome as findPinnedChrome } from "./lib/graphic-render.mjs";
import { clippingExtent, drawnExtent, wordPieces, EMOJI_EM } from "./lib/caption-metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const SEC = 9;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "caption-height-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

// m41c B1's cg7, measured in Chrome (getBoundingClientRect of #cg7in, Gloock loaded, 1080x1920 at DPR 1, the B1
// index.html built at 50228c6): top 1425 -> box 1424.46 .. 1515.51, so 0.54 px above the group's top and 90.51 below.
// The stand-in "cats run fast" (same 4/3/4 letters) lays out at the same 335 px group width and measured the same
// 0.54 / 90.51 in this test's reel at 78c1a4b.
const CG7 = { words: ["cats", "run", "fast"], size: 58, deg: -1.6, maxWidth: 1080 - 2 * 130, up: 0.54, down: 90.51 };

test("model: the band reserved for a B1 cg7-shaped block covers the box Chrome drew (and the old 1.3 x size did not)", () => {
  const e = clippingExtent(CG7.words, CG7);
  assert.equal(e.lines, 1);
  assert.ok(e.down >= CG7.down && e.down - CG7.down < 1, `down: model ${e.down} vs drawn ${CG7.down}`);
  assert.ok(e.up >= CG7.up && e.up - CG7.up < 1, `up: model ${e.up} vs drawn ${CG7.up}`);
  assert.ok(CG7.size * 1.3 < CG7.down - 15, "the old estimate was 15 px short");
  // the geometry alone: an untilted box is its height; a tilt lowers one end by (w + 2 padX) x sin
  assert.deepEqual(drawnExtent({ w: 300, h: 80, deg: 0, padX: 20 }), { up: 0, down: 80 });
  const t = drawnExtent({ w: 300, h: 80, deg: -2, padX: 20 });
  assert.ok(Math.abs(t.down - (40 + 40 * Math.cos(2 * Math.PI / 180) + 320 * Math.sin(2 * Math.PI / 180))) < 1e-9, JSON.stringify(t));
  // a group too wide for the line wraps: two lines of Gloock
  assert.equal(clippingExtent(["photographers", "recommended", "illustrations"], { size: 58, maxWidth: 820 }).lines, 2);
});

test("model: the line count is an upper bound over how Chromes wrap an emoji run (Windows drew 4 lines where packing gave 3)", () => {
  // Windows Chrome (Segoe UI Emoji): "to be" + 22 emoji in one word drew 4 lines; greedy packing at every emoji gave 3.
  // The model takes the worst over every set of break opportunities inside an emoji word: at 1.5 em that is 5 lines
  // (chunks just over half a line, one per line), never fewer than any real Chrome. mac-48: a word wider than a line is
  // an inline-block as wide as the line, so it cannot share a line: "to be" takes line 1 and the run its own 5 (6)
  const run = "😂".repeat(22);
  assert.equal(clippingExtent(["to", "be", run], { size: 58, maxWidth: 820 }).lines, 6);
  // ...and the word after a wrapped one starts a new line (the 2-of-420 Noto case: "photographers👍🏽🇺🇸💯🎉👍👍🏽” 👍")
  assert.equal(clippingExtent([run, "ok"], { size: 58, maxWidth: 820 }).lines, 6);
  assert.ok(clippingExtent(["to", "be", run], { size: 58, maxWidth: 820, emojiEm: 1.373 }).lines >= 4, "Segoe's advance: at least Windows' 4");
  assert.equal(clippingExtent([run], { size: 58, maxWidth: 820 }).lines, 5);
  // plain text: one piece per word, no choice, plain greedy (B1 shapes stay 1 line, a long group 2)
  assert.equal(clippingExtent(["cats", "run", "fast"], { size: 58, maxWidth: 820 }).lines, 1);
  assert.equal(clippingExtent(["photographers", "recommended", "illustrations"], { size: 58, maxWidth: 820 }).lines, 2);
  // an emoji is one unbreakable unit (ZWJ sequences, flags, skin tones, VS16), and the punctuation Chrome never breaks
  // beside sticks to it: "(😂)", "😂!", "“🔥”"
  assert.deepEqual(wordPieces("a👨‍👩‍👧b🇺🇸👍🏽❤️x"), ["a", "👨‍👩‍👧", "b", "🇺🇸", "👍🏽", "❤️", "x"]);
  assert.deepEqual(wordPieces("lol(😂),ok"), ["lol", "(😂),", "ok"]);
  assert.deepEqual(wordPieces("“🔥”😂!"), ["“🔥”", "😂!"]);
  assert.deepEqual(wordPieces("lol"), ["lol"]);
});

test("model: a long emoji run uses the cheap bound - fast, and never below the exact search", () => {
  const t0 = performance.now();
  const huge = clippingExtent(["😂".repeat(3000)], { size: 58, maxWidth: 820 });
  const ms = performance.now() - t0;
  assert.ok(ms < 50, `3000 emoji modelled in ${ms.toFixed(1)} ms`);
  assert.ok(huge.lines >= Math.ceil(3000 * 1.5 * 58 / 820), `${huge.lines} lines`);
  for (const words of [["😂".repeat(64)], ["to", "be", "😂🔥(✨)".repeat(16)], ["no", "👍👨‍👩‍👧🇺🇸".repeat(21), "ok"]]) {
    const exact = clippingExtent(words, { size: 58, maxWidth: 820 }).lines, cheap = clippingExtent(words, { size: 58, maxWidth: 820, exactPieces: 0 }).lines;
    assert.ok(cheap >= exact, `${words.join(" ").slice(0, 20)}: cheap ${cheap} < exact ${exact}`);
  }
});

function build() {
  const talk = path.join(root, "talk.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=30:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", talk], { stdio: "pipe" });
  // 8 groups of 3; group 7 (odd: tilted -1.6deg, the side that drops) is the cg7 stand-in. Neutral text, B1's word shapes.
  const text = "today your garden is due for four plants and i say it this way because some builders have shown that photographers cats run fast".split(" ");
  const words = { segments: [{ start: 0, end: SEC, words: text.map((w, i) => ({ word: w, start: +(0.2 + i * 0.33).toFixed(2), end: +(0.45 + i * 0.33).toFixed(2) })) }] };
  // a close-up the whole time (B1's face: above the frame to below the safe bottom): every block goes lower-face
  const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 6 }, (_, i) => [i * 2, -200, 1520, 120, 960, 540, 1040]) };
  const dir = path.join(root, "reel");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(talk, path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "ch", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: 30, style: "broadsheet", outro: 0, music: null,
    takes: [{ a: 0, b: SEC }], zoom: {}, beats: [], captions: { style: "clipping", group: 3, y: 1150, size: 58, maxHold: 1.6, tilt: 1.6 } }, null, 2));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary(), PHANTASIC_SFX_PACK: path.join(root, "no-such-pack") } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { dir, html: fs.readFileSync(path.join(dir, "index.html"), "utf8"), layout: JSON.parse(fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8")) };
}
let built;
const reel = () => (built ??= build());
const tops = (h) => [...h.matchAll(/<div id="cg(\d+)" class="cap-group clip" style="top:(\d+)px;rotate:(-?[\d.]+)deg"/g)].map((m) => ({ i: +m[1], top: +m[2], deg: +m[3] }));

test("build: B1's close-up - every clipping block's reserved band ends inside the safe area, cg7 included", () => {
  const { html, layout } = reel();
  const gs = tops(html);
  assert.equal(gs.length, layout.blocks.length);
  assert.ok(gs.length >= 8, `groups: ${gs.length}`);
  assert.match(html, /id="cg7w0" class="w">cats<\/span><wbr><span id="cg7w1" class="w">run<\/span><wbr><span id="cg7w2" class="w">fast</, "cg7 is the stand-in");
  assert.equal(gs[7].deg, -1.6);
  for (const g of gs) {
    const b = layout.blocks[g.i];
    assert.equal(b.mode, "lower-face", `cg${g.i}: ${b.mode}`);
    assert.ok(b.y + b.h <= layout.safeBottom, `cg${g.i}: band ${b.y}+${b.h} past ${layout.safeBottom}`);
    assert.ok(g.top >= b.y && g.top - b.y <= 20, `cg${g.i}: top ${g.top} sits in its band from ${b.y}`);
  }
  const cg7 = layout.blocks[7];
  assert.ok(cg7.h >= 91, `cg7 reserves ${cg7.h} px (drawn 91.05)`);
});

// CI=1 or REQUIRE_CHROME=1: no Chrome / puppeteer-core / GSAP is a FAILURE, not a skip (a skipped test still exits 0)
const REQUIRED = process.env.CI === "1" || process.env.REQUIRE_CHROME === "1";
const skipOrFail = (t, why) => { if (REQUIRED) throw new Error(`real Chrome required (CI / REQUIRE_CHROME): ${why}`); return t.skip(why); };
test("real Chrome: every drawn caption box lies inside its reserved band, above the bottom UI band", { timeout: 120000 }, async (t) => {
  let puppeteer, chrome;
  // Chrome: CHROME, else the pinned shell the graphic renderer uses (GRAPHIC_CHROME_PATH, HYPERFRAMES_BROWSER_PATH, the
  // pinned build in the caches - the Linux server sets GRAPHIC_CHROME_PATH), else any cached headless shell
  // Chrome FIRST (no Chrome: skip or fail at once), then puppeteer-core; required runs give the npx fallback 20 s, not npm's
  // ~5 min offline wait
  try { chrome = (process.env.CHROME && fs.existsSync(process.env.CHROME) && process.env.CHROME) || findPinnedChrome() || findChrome(); } catch (e) { return skipOrFail(t, e.message); }
  try { puppeteer = findPuppeteer({ npxTimeout: REQUIRED ? 20000 : undefined }); } catch (e) { return skipOrFail(t, e.message); }
  const { dir, html, layout } = reel();
  const TYPES = { ".html": "text/html", ".woff2": "font/woff2", ".mp4": "video/mp4", ".js": "text/javascript" };
  // EMOJI_FONT=<a .ttf> (mac-48): lay the captions out with THAT emoji font instead of this OS's, to reproduce another
  // host on this one (the server's Noto Color Emoji on a Mac, say). Served at /__emoji-font and put after the caption
  // font in the family list, so text keeps its face and only emoji fall through to it.
  const EMOJI_FONT = process.env.EMOJI_FONT && fs.existsSync(process.env.EMOJI_FONT) ? process.env.EMOJI_FONT : null;
  const server = http.createServer((req, res) => {
    if (EMOJI_FONT && new URL(req.url, "http://x").pathname === "/__emoji-font") { res.writeHead(200, { "content-type": "font/ttf" }); return fs.createReadStream(EMOJI_FONT).pipe(res); }
    const f = path.join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await puppeteer.launch({ executablePath: chrome, headless: "shell", args: ["--no-sandbox", "--force-device-scale-factor=1"], defaultViewport: { width: 1080, height: 1920, deviceScaleFactor: 1 } });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { window.__timelines = {}; });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load", timeout: 60000 });
    try { await page.waitForFunction(() => window.__timelines && window.__timelines.main && window.gsap, { timeout: 30000 }); }
    catch { return skipOrFail(t, "GSAP did not load (offline?)"); }
    if (EMOJI_FONT) {
      await page.addStyleTag({ content: `@font-face { font-family: "EmojiFontTest"; src: url(/__emoji-font) format("truetype"); }
        .cap-group, .cap-group * { font-family: Gloock, "EmojiFontTest", "Noto Sans Arabic", Georgia, serif !important; }` });
      const ok = await page.evaluate(async () => (await document.fonts.load('58px "EmojiFontTest"', "\u{1F602}")).length > 0);
      assert.ok(ok, `EMOJI_FONT ${EMOJI_FONT} did not load`);
      console.log(`emoji font forced: ${path.basename(EMOJI_FONT)}`);
    }
    const got = await page.evaluate(async (n) => {
      await document.fonts.load('58px "Gloock"', "cats run fast"); await document.fonts.ready;
      const tl = window.__timelines.main; tl.pause();
      return Array.from({ length: n }, (_, i) => {
        const g = document.getElementById(`cg${i}`);
        tl.seek(+g.dataset.start + 0.3);   // after the 0.12 s pop-in
        const r = document.getElementById(`cg${i}in`).getBoundingClientRect();
        return { i, y0: r.top, y1: r.bottom, font: document.fonts.check('58px "Gloock"') };
      });
    }, tops(html).length);
    for (const g of got) {
      const b = layout.blocks[g.i];
      assert.equal(g.font, true);
      assert.ok(g.y1 <= layout.safeBottom + 0.05, `cg${g.i}: drawn to ${g.y1}, safe bottom ${layout.safeBottom}`);
      assert.ok(g.y0 >= b.y - 0.05 && g.y1 <= b.y + b.h + 0.05, `cg${g.i}: drawn ${g.y0}..${g.y1}, reserved ${b.y}..${b.y + b.h}`);
    }
    assert.ok(got[7].y1 - got[7].y0 > 90, `cg7 is drawn ${got[7].y1 - got[7].y0} px tall`);
    // emoji fall back to whatever emoji font this OS has (Apple 1.0 em, Segoe ~1.37, Noto ~1.275, none: a .notdef box):
    // the model's constant EMOJI_EM bounds THIS machine's advance, and an untilted clipping block of them, laid out by
    // the page's own CSS, is modelled at or over its drawn height (and line count)
    const adv = await page.evaluate((em) => Object.fromEntries(em.map((e) => {
      const g = document.createElement("div"); g.className = "cap-group"; g.style.top = "100px";
      g.innerHTML = `<span style="letter-spacing:0">${e.repeat(10)}</span>`;
      document.getElementById("cg0").parentElement.appendChild(g);
      const w = g.firstChild.getBoundingClientRect().width / 10 / 58; g.remove(); return [e, w];
    })), ["😂", "🔥", "👍", "🎉", "🚀", "🇺", "🏽"]);
    console.log(`emoji advance on this machine (em): ${JSON.stringify(Object.fromEntries(Object.entries(adv).map(([k, v]) => [k, +v.toFixed(3)])))}, model ${EMOJI_EM}`);
    for (const [e, v] of Object.entries(adv)) assert.ok(v <= EMOJI_EM, `${e}: this machine draws ${v} em, over the model's ${EMOJI_EM}`);
    // randomized line breaking (mac-45 CP5): 420 seeded groups of words, emoji runs, ZWJ / flag / skin-tone units and
    // punctuation glued to emoji ("(😂)", "😂!", "“🔥”"), laid out by the page's CSS. The model runs at THIS machine's
    // own emoji advance (emojiEm = the widest measured above: Apple 1.0) - no 1.5 em slack - and must never count fewer
    // lines than Chrome draws
    let seed = 45;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const W = ["lol", "ok", "wait", "what", "no", "yes", "this", "is", "fire", "so", "good", "really", "amazing", "photographers", "the"];
    const E = ["😂", "🔥", "👍", "❤️", "🎉", "👨‍👩‍👧", "🇺🇸", "👍🏽", "✨", "💯"];
    const OP = ["(", "“", '"', "¿", "["], CL = [")", "!", "?", ",", ".", "…", "”", '"', "]"];
    const token = () => { const r = rnd(); if (r < 0.4) return pick(W); let e = ""; for (let n = 1 + Math.floor(rnd() * (rnd() < 0.3 ? 14 : 3)); n > 0; n--) e += pick(E); return (rnd() < 0.3 ? pick(OP) : "") + e + (rnd() < 0.35 ? pick(CL) : ""); };
    const groups = Array.from({ length: 420 }, () => Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => Array.from({ length: 1 + Math.floor(rnd() * (rnd() < 0.5 ? 1 : 3)) }, token).join("")));
    const drawnLines = await page.evaluate((gs) => gs.map((ws) => {
      const g = document.createElement("div"); g.className = "cap-group"; g.style.top = "100px";
      const inn = document.createElement("div"); inn.className = "cap-in"; g.appendChild(inn);
      inn.innerHTML = ws.map((w) => `<span class="w">${w.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join("<wbr>");
      document.getElementById("cg0").parentElement.appendChild(g);
      const h = inn.getBoundingClientRect().height; g.remove();
      return (h - 18) / (58 * 1.08);   // the box is 18 px of padding plus one 62.64 px line box per line
    }), groups);
    const emojiEm = Math.max(...Object.values(adv));
    const under = [];
    let over = 0;
    groups.forEach((ws, i) => { const m = clippingExtent(ws, { size: 58, maxWidth: 820, emojiEm }).lines; if (m < drawnLines[i] - 0.02) under.push(`${ws.join(" ")}: model ${m}, drawn ${drawnLines[i]}`); else if (m > drawnLines[i] + 0.02) over++; });
    console.log(`random wrap at emojiEm ${emojiEm.toFixed(3)}: ${groups.length} groups, ${under.length} under-counted, ${over} over-counted`);
    assert.deepEqual(under, [], "the model never counts fewer lines than Chrome draws");
    for (const words of [["😂😂😂", "lol", "🔥🔥"], [Array(22).fill("😂").join("")], Array(22).fill("🔥")]) {
      const drawn = await page.evaluate((ws) => {
        const g = document.createElement("div"); g.className = "cap-group"; g.style.top = "100px";
        const inn = document.createElement("div"); inn.className = "cap-in"; g.appendChild(inn);
        inn.innerHTML = ws.map((w) => `<span class="w">${w}</span>`).join("<wbr>");
        document.getElementById("cg0").parentElement.appendChild(g);
        const h = inn.getBoundingClientRect().height, w = g.getBoundingClientRect().width; g.remove();
        return { h, w };
      }, words);
      const e = clippingExtent(words, { size: 58, maxWidth: 820 });
      assert.ok(e.h >= drawn.h - 0.05, `${words.join(" ").slice(0, 30)}: modelled ${e.h} (${e.lines} line(s)), drawn ${drawn.h}`);
      assert.ok(e.w >= drawn.w - 0.05 || e.lines > 1, `${words.join(" ").slice(0, 30)}: modelled width ${e.w}, drawn ${drawn.w}`);
    }
    // wrapped blocks at both tilt signs (a wrapped group is max-width wide, so its tilt reaches further than its longest
    // line): placed the way build.mjs places one - band at Y, the group's top ceil(up) into it - the drawn box stays in
    // [Y, Y + ceil(up) + ceil(down)]
    const Y = 300, maxWidth = 1080 - 2 * 130;
    const cases = [["photographers", "recommended", "illustrations"], ["extraordinary", "photographers", "recommended", "illustrations", "everywhere"], ["to", "be", Array(22).fill("😂").join("")]];
    for (const words of cases) for (const deg of [-1.6, 1.6 * 0.7]) {
      const e = clippingExtent(words, { size: 58, maxWidth, deg });
      const top = Y + Math.ceil(e.up), end = Y + Math.ceil(e.up) + Math.ceil(e.down);
      const d = await page.evaluate((ws, top, deg) => {
        const g = document.createElement("div"); g.className = "cap-group"; g.style.cssText = `top:${top}px;rotate:${deg}deg`;
        const inn = document.createElement("div"); inn.className = "cap-in"; g.appendChild(inn);
        inn.innerHTML = ws.map((w) => `<span class="w">${w}</span>`).join("<wbr>");
        document.getElementById("cg0").parentElement.appendChild(g);
        const r = inn.getBoundingClientRect(), lines = Math.round((g.offsetHeight - 18) / (58 * 1.08)), w = g.offsetWidth; g.remove();
        return { y0: r.top, y1: r.bottom, lines, w };
      }, words, top, deg);
      const tag = `${words.join(" ").slice(0, 24)} @ ${deg}deg (${d.lines} line(s) drawn, ${e.lines} modelled, group ${d.w} px)`;
      if (d.lines > 1) assert.equal(d.w, maxWidth, `${tag}: a wrapped group is max-width wide`);
      assert.ok(d.y1 <= end + 0.05, `${tag}: drawn to ${d.y1}, band ends ${end}`);
      assert.ok(d.y0 >= Y - 0.05, `${tag}: drawn from ${d.y0}, band starts ${Y}`);
    }
  } finally { await browser.close(); server.close(); }
});

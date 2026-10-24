#!/usr/bin/env node
// node --test scripts/build-caption-wrapper.test.mjs
// mac-42: Broadsheet's "clipping" captions pop in with a scale tween. It used to target the caption group #cgN,
// which is centred by CSS (left: 50%; transform: translateX(-50%)); GSAP then rewrites that -50% as px, guessed
// from the group's width at the moment it first reads it - before or after the caption webfont loaded, per render.
// The box landed up to ~50 px right of centre, differently run to run. The fix is structural: #cgN only places and
// centres and tilts (static CSS), an inner #cgNin carries the box and the pop-in tween, and nothing ever animates #cgN.
//   - build: the markup, the CSS and every tween line of a broadsheet reel; a clean reel keeps the one-box markup
//   - real Chrome: the caption font is held back by the server while the timeline is first seeked (the race, forced);
//     after it lands, every outer group is untouched by GSAP and every box is centred on x = 540
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const SEC = 4;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "caption-wrapper-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

function build(style, extra = {}) {
  const talk = path.join(root, "talk.mp4");
  if (!fs.existsSync(talk)) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=30:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", talk], { stdio: "pipe" });
  const text = "that i recommend so that most of them tend to be".split(" ");
  const words = { segments: [{ start: 0, end: SEC, words: text.map((w, i) => ({ word: w, start: +(0.2 + i * 0.33).toFixed(2), end: +(0.45 + i * 0.33).toFixed(2) })) }] };
  const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 3 }, (_, i) => [i * 2, 400, 1000, 340, 740, 560, 800]) };
  const dir = path.join(root, style + (extra.captions ? "-x" : ""));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(talk, path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "cw", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: 30, style, outro: 0, music: null, takes: [{ a: 0, b: SEC }], zoom: {}, beats: [], ...extra }, null, 2));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary(), PHANTASIC_SFX_PACK: path.join(root, "no-such-pack") } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { dir, html: fs.readFileSync(path.join(dir, "index.html"), "utf8") };
}

const groupsOf = (h) => [...h.matchAll(/<div id="cg(\d+)" class="cap-group clip([^"]*)" style="([^"]*)"[^>]*>(<div id="cg(\d+)in" class="cap-in([^"]*)"(?: style="([^"]*)")?>)?/g)]
  .map((m) => ({ i: +m[1], cls: m[2], style: m[3], inner: !!m[4], innerI: m[5] && +m[5], innerCls: m[6], innerStyle: m[7] }));
// every GSAP call in the page script whose target is a caption group element itself, "#cg3" (not "#cg3in", "#cg3w1")
const groupTweens = (h) => h.match(/(?:\bft|\btl\.\w+|\bgsap\.\w+)\(\s*"#cg\d+"/g) || [];

test("build: broadsheet puts the box and the pop-in on an inner #cgNin; the outer #cgN is never animated", () => {
  const { html: h } = build("broadsheet");
  const gs = groupsOf(h);
  assert.ok(gs.length >= 3, `caption groups: ${gs.length}`);
  for (const g of gs) {
    assert.ok(g.inner && g.innerI === g.i, `cg${g.i}: wraps its words in #cg${g.i}in`);
    // the outer's own style is static placement only: top, the tilt, and (placer) translateX(-50%) scale(s)
    assert.match(g.style, /^top:\d+px(;rotate:-?[\d.]+deg)?(;transform:translateX\(-50%\) scale\([\d.]+\);transform-origin:50% 0)?$/, `cg${g.i}: ${g.style}`);
    assert.equal(g.innerStyle, undefined, `cg${g.i}: the inner box has no inline style (the tilt is the outer's)`);
    assert.equal(g.cls.trim(), "", `cg${g.i}: the look classes (cap-backed / cap-shadow) are on the inner box`);
  }
  assert.ok(gs.some((g) => /;rotate:-[\d.]+deg/.test(g.style)) && gs.some((g) => /;rotate:[\d.]+deg/.test(g.style)), "the tilt alternates, on the outer");
  assert.deepEqual(groupTweens(h), [], "no tween or set targets an outer caption group");
  const pops = [...h.matchAll(/ft\("#cg(\d+)in", \{ scale: 0\.9 \}, \{ scale: 1, duration: 0\.12, ease: "back\.out\(2\.5\)" \}/g)].map((m) => +m[1]);
  assert.deepEqual(pops, gs.map((g) => g.i), "one pop-in per group, on its inner box");
  // the centring stays on the outer (base rule); the clipping rule does not touch transform; the box is on .cap-in
  assert.match(h, /\.cap-group \{ position: absolute; left: 50%; transform: translateX\(-50%\);/);
  const clipRule = h.match(/\.cap-group \{ font-family: Gloock[^}]*\}/)?.[0];
  assert.ok(clipRule && !/transform|background|padding/.test(clipRule), clipRule);
  assert.match(h, /\.cap-in \{ margin: 0 -20px; background: #141210; padding: 6px 20px 12px; box-shadow: [^}]*\}/, "the -20px margins cancel the 20px side padding");
});

test("build: other caption styles keep the single-box group (no inner wrapper)", () => {
  for (const style of ["clean", "premium-noir"]) {
    const { html: h } = build(style);
    const gs = groupsOf(h);
    assert.ok(gs.length >= 1, `${style}: caption groups ${gs.length}`);
    assert.ok(gs.every((g) => !g.inner), `${style}: no inner wrapper`);
    assert.ok(!h.includes("cap-in"), `${style}: no .cap-in`);
  }
});

test("real Chrome: the caption font arrives AFTER the first seek, and every box is still centred", { timeout: 120000 }, async (t) => {
  let puppeteer, chrome;
  try { puppeteer = findPuppeteer(); chrome = findChrome(); } catch (e) { return t.skip(e.message); }
  const { dir, html } = build("broadsheet", { captions: { style: "clipping", group: 3, y: 1150, size: 58, tilt: 1.6 } });
  assert.match(html, /@font-face \{ font-family: "Gloock"; src: url\(assets\/fonts\/gloock/, "the caption webfont is a page font");
  // the server holds every Gloock request until released: the timeline is built and seeked in the fallback font
  let release; const fontGate = new Promise((r) => { release = r; });
  const TYPES = { ".html": "text/html", ".woff2": "font/woff2", ".mp4": "video/mp4", ".js": "text/javascript" };
  const server = http.createServer(async (req, res) => {
    const f = path.join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    if (/gloock/i.test(f)) await fontGate;
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await puppeteer.launch({ executablePath: chrome, headless: "shell", args: ["--no-sandbox", "--force-device-scale-factor=1"], defaultViewport: { width: 1080, height: 1920, deviceScaleFactor: 1 } });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { window.__timelines = {}; });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
    try { await page.waitForFunction(() => window.__timelines && window.__timelines.main && window.tween, { timeout: 30000 }); }
    catch { return t.skip("the page timeline did not start"); }
    const starts = groupsOf(html).map((g) => +html.match(new RegExp(`id="cg${g.i}" [^>]*data-start="([\\d.]+)"`))[1]);
    // the first reads: seek into every pop-in while only the fallback font is available
    const early = await page.evaluate((ts) => {
      const tl = window.__timelines.main; tl.pause();
      for (const s of ts) tl.seek(s + 0.05);
      return document.fonts.check('58px "Gloock"');
    }, starts);
    assert.equal(early, false, "the race is forced: Gloock was not loaded at the first seek");
    release();
    const got = await page.evaluate(async (ts) => {
      await document.fonts.load('58px "Gloock"', "that i recommend"); await document.fonts.ready;
      const tl = window.__timelines.main;
      return ts.map((s, i) => {
        tl.seek(s + 0.3);   // after the 0.12 s pop-in
        const out = document.getElementById(`cg${i}`), inn = document.getElementById(`cg${i}in`);
        const ro = out.getBoundingClientRect(), ri = inn.getBoundingClientRect();
        return { i, parsedByGsap: !!window.__timelines.main._trackOf.get(out), inline: out.style.transform, outerX: (ro.left + ro.right) / 2, innerX: (ri.left + ri.right) / 2, innerW: ri.width, outerW: ro.width, font: document.fonts.check('58px "Gloock"') };
      });
    }, starts);
    for (const g of got) {
      assert.equal(g.font, true);
      assert.equal(g.parsedByGsap, false, `cg${g.i}: the tween runtime never read or wrote the outer group`);
      assert.equal(g.inline, "", `cg${g.i}: no inline transform on the outer group`);
      assert.ok(Math.abs(g.outerX - 540) <= 1, `cg${g.i}: outer centre ${g.outerX}`);
      assert.ok(Math.abs(g.innerX - 540) <= 1, `cg${g.i}: box centre ${g.innerX}`);
      assert.ok(g.innerW > g.outerW + 30, `cg${g.i}: the box (${g.innerW}) is the outer (${g.outerW}) plus its side padding`);
    }
  } finally { await browser.close(); server.close(); }
});

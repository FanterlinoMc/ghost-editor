#!/usr/bin/env node
// Caption boxes (mac-51): measure where every caption block is DRAWN, horizontally, and write it into the project's
// build/caption_layout.json as `x` and `width` per block. Spec: references/reel-json.md "caption_layout.json: x and
// width (caption-boxes.mjs)".
//
//   node scripts/caption-boxes.mjs <project> [--check] [--with-gsap]
//
// Why a browser and not a model: the placer only decides y. A block's width is the browser's line layout of the
// caption font, and 62 shipped styles caption in Arial (a system font the engine does not ship), while Geist, Inter,
// Montserrat and Oswald ship as VARIABLE fonts, so their bold advances are not the file's default ones. Only the page,
// in the Chrome that renders it, knows the width. So this loads the built index.html in that Chrome
// (lib/browser.mjs, the pinned shell first), JavaScript off and nothing fetched from outside the project (the
// captions are static HTML; --with-gsap runs the page's script and seeks into each block), and takes the union of the drawn rectangles of
// every caption element of the block (all caption styles put their blocks on track 5 with data-start), descendants
// included, so text that overflows its box is counted.
//
// Run it AFTER build.mjs. The build never writes x / width, so a reel built without this step is byte-identical to
// before, and a rebuild clears them: a block WITHOUT `x` is unmeasured, never stale. Each measured block gets
// `x` (left edge, px, may be negative) and `width` (px), both whole pixels; the file gets
// `measured: { by: "caption-boxes", chrome: <version>, platform: <os> }` (fonts can differ between hosts: Arial is the
// host's). A layout block with no drawn element at its start gets `x: null, width: null`.
// Each block also gets `drawnTop` / `drawnBottom` (px, whole): its drawn vertical extent, against the reserved `y` / `h`.
// --check: exit 1 when a block reaches outside [0, W] or outside the safe area [safeTop, safeBottom], one line per block.
// stdout: one JSON line { blocks, measured, unmatched, W, outside: [{ i, t0, x, width }], safeTop, safeBottom,
//   unsafe: [{ i, t0, mode, drawnTop, drawnBottom, over }], chrome }.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { findPuppeteer, findChrome } from "./lib/browser.mjs";
import { findChrome as findPinnedChrome } from "./lib/graphic-render.mjs";

const TYPES = { ".html": "text/html", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4",
  ".webm": "video/webm", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav" };
const MATCH_S = 0.006;   // the log's t0 is the start rounded to 0.01 s; the page's data-start is the start to 0.001 s

/** Join measured page blocks [{ start, x0, x1 }] to layout blocks [{ t0 }]: every page element whose start rounds to a
 *  block's t0 belongs to it (a cluster block is several elements). Pure, so the test can check it without Chrome. */
export function joinBoxes(layoutBlocks, pageBlocks) {
  return layoutBlocks.map((b) => {
    const mine = pageBlocks.filter((p) => Math.abs(p.start - b.t0) <= MATCH_S && p.x1 > p.x0);
    if (!mine.length) return { ...b, x: null, width: null, drawnTop: null, drawnBottom: null };
    const x0 = Math.min(...mine.map((p) => p.x0)), x1 = Math.max(...mine.map((p) => p.x1));
    const ys = mine.filter((p) => Number.isFinite(p.y0) && Number.isFinite(p.y1));
    const v = ys.length ? { drawnTop: Math.floor(Math.min(...ys.map((p) => p.y0))), drawnBottom: Math.ceil(Math.max(...ys.map((p) => p.y1))) } : {};
    return { ...b, x: Math.floor(x0), width: Math.ceil(x1) - Math.floor(x0), ...v };
  });
}

export async function measure(proj, { chrome, puppeteer, withGsap = false } = {}) {
  const layoutFile = path.join(proj, "build", "caption_layout.json");
  const html = path.join(proj, "index.html");
  if (!fs.existsSync(layoutFile) || !fs.existsSync(html)) throw new Error(`no built reel at ${proj} (run build.mjs first)`);
  const layout = JSON.parse(fs.readFileSync(layoutFile, "utf8"));
  const page0 = fs.readFileSync(html, "utf8");
  const W = +(/data-width="(\d+)"/.exec(page0) || [, 1080])[1], H = +(/data-height="(\d+)"/.exec(page0) || [, 1920])[1];
  chrome ??= (process.env.CHROME && fs.existsSync(process.env.CHROME) && process.env.CHROME) || findPinnedChrome() || findChrome();
  puppeteer ??= findPuppeteer();
  const root = path.resolve(proj);
  const server = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await puppeteer.launch({ executablePath: chrome, headless: "shell", args: ["--no-sandbox", "--force-device-scale-factor=1", "--autoplay-policy=no-user-gesture-required"],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 } });
  try {
    const version = (await browser.version()).replace(/^HeadlessChrome\//, "");
    const page = await browser.newPage();
    // Offline by default: the caption markup is static HTML from build.mjs, so the resting layout needs no script.
    // Every request that is not this project's own server is aborted (GSAP's CDN included), so measuring has no
    // network dependency. --with-gsap lets the page's script and its CDN GSAP run and seeks into each block instead.
    const base = `http://127.0.0.1:${server.address().port}/`;
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().startsWith(base) || /^(data|blob):/.test(r.url()) ? r.continue() : r.abort()));
    if (withGsap) await page.evaluateOnNewDocument(() => { window.__timelines = {}; });
    else await page.setJavaScriptEnabled(false);
    await page.goto(base + "index.html", { waitUntil: "load", timeout: 60000 });
    if (withGsap) await page.waitForFunction(() => window.__timelines && window.__timelines.main && window.gsap, { timeout: 30000 })
      .catch(() => { throw new Error("--with-gsap: the page's timeline did not start (GSAP comes from its CDN: offline?)"); });
    const pageBlocks = await page.evaluate(async (withGsap) => {
      await document.fonts.ready;
      const tl = withGsap ? window.__timelines.main : null;
      if (tl) tl.pause();
      const els = [...document.querySelectorAll('[data-track-index="5"][data-start]')];
      const out = [];
      for (const el of els) {
        const start = +el.dataset.start, dur = +el.dataset.duration || 0;
        if (tl) { tl.seek(start + Math.min(0.3, dur / 2)); await new Promise((r) => requestAnimationFrame(() => r())); }
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const n of [el, ...el.querySelectorAll("*")]) {
          const r = n.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { x0 = Math.min(x0, r.left); x1 = Math.max(x1, r.right); y0 = Math.min(y0, r.top); y1 = Math.max(y1, r.bottom); }
        }
        if (x1 > x0) out.push({ start, x0, x1, y0, y1 });
      }
      return out;
    }, withGsap);
    const blocks = joinBoxes(layout.blocks || [], pageBlocks);
    const next = { ...layout, measured: { by: "caption-boxes", chrome: version, platform: `${os.platform()}-${os.arch()}`, ...(withGsap ? { gsap: true } : {}) }, blocks };
    fs.writeFileSync(layoutFile, JSON.stringify(next, null, 1));
    const outside = blocks.map((b, i) => ({ i, t0: b.t0, x: b.x, width: b.width })).filter((b) => b.x !== null && (b.x < 0 || b.x + b.width > W));
    // vertical: the drawn box against the platform's safe area the placer used (caption_layout's safeTop / safeBottom)
    const sT = layout.safeTop ?? 0, sB = layout.safeBottom ?? H;
    const unsafe = blocks.map((b, i) => ({ i, t0: b.t0, mode: b.mode, drawnTop: b.drawnTop, drawnBottom: b.drawnBottom, over: Math.max(0, sT - b.drawnTop, b.drawnBottom - sB) }))
      .filter((b) => b.drawnTop != null && b.over > 0);
    return { blocks: blocks.length, measured: blocks.filter((b) => b.x !== null).length, unmatched: blocks.filter((b) => b.x === null).length, W, outside, safeTop: sT, safeBottom: sB, unsafe, chrome: version };
  } finally {
    await browser.close();
    server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const proj = args.find((a) => !a.startsWith("--"));
  if (!proj) { console.error("usage: node scripts/caption-boxes.mjs <project> [--check] [--with-gsap]"); process.exit(1); }
  try {
    const r = await measure(proj, { withGsap: args.includes("--with-gsap") });
    process.stdout.write(JSON.stringify(r) + "\n");
    if (args.includes("--check") && (r.outside.length || r.unsafe.length)) {
      for (const b of r.outside) console.error(`caption block ${b.i} at ${b.t0}s is drawn at x ${b.x}..${b.x + b.width}px, outside the ${r.W}px canvas`);
      for (const b of r.unsafe) console.error(`caption block ${b.i} at ${b.t0}s (${b.mode}) is drawn at y ${b.drawnTop}..${b.drawnBottom}px, outside the safe area ${r.safeTop}..${r.safeBottom}px`);
      process.exit(1);
    }
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); }
}

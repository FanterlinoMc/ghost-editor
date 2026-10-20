#!/usr/bin/env node
// The pixel check's DOM probe (references/pixel-check.md 2.3): where Chrome lays out the captions, the graphics and
// every visible text line of a built reel, at the pixel check's sample frames.
//
//   node scripts/pixel_probe.mjs <project> --frames <frames.json> [--out <project>/build/pixel_probe.json]
//
// <frames.json> is the sample list ({"frames": [n, ...]}) the checker computed from build/geometry.json
// (pixel_check.py --print-samples writes it); the probe never picks frames itself, so one list drives the probe and
// the decode. Opens <project>/index.html in the headless Chrome + puppeteer-core the renderer cached (lib/browser.mjs),
// offline (every non-file request is refused), and seeks the paused timeline the way the renderer does
// (motion-determinism.mjs --seek render: totalTime(t + .001, suppress), totalTime(t); a .clip shows only inside
// [data-start, data-start + data-duration)). Footage is irrelevant to layout and is paused and hidden.
// Output: rects in canvas px rounded to 0.01, sorted keys; deterministic for one index.html and one Chrome.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { findPuppeteer, findChrome } from "./lib/browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const proj = path.resolve(argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--"))) || ".");
const out = opt("out", path.join(proj, "build", "pixel_probe.json"));
const framesFile = opt("frames", null);
if (!framesFile) { console.error("pixel_probe: --frames <file> is required (pixel_check.py --print-samples writes it)"); process.exit(2); }
const geoBytes = fs.readFileSync(path.join(proj, "build", "geometry.json"));
const geo = JSON.parse(geoBytes);
const frames = JSON.parse(fs.readFileSync(framesFile, "utf8")).frames;
const html = path.join(proj, "index.html");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// canonical JSON: sorted keys, no spaces (the checker hashes it)
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);

// vendor folders, first match wins: $PIXEL_PROBE_VENDOR, then the engine's own vendor/ (when the fork carries one)
function loadVendor() {
  const m = new Map();
  for (const dir of [process.env.PIXEL_PROBE_VENDOR, path.join(path.dirname(new URL(import.meta.url).pathname), "..", "vendor")].filter(Boolean)) {
    let man; try { man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { continue; }
    for (const l of man.libraries || []) {
      if (m.has(l.url)) continue;
      try { const b = fs.readFileSync(path.join(dir, l.file)); if (sha(b) === l.sha256) m.set(l.url, b); } catch {}
    }
  }
  return m;
}

const puppeteer = findPuppeteer();
const t0 = Date.now();
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: "shell", args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars", "--mute-audio"],
  defaultViewport: { width: geo.W, height: geo.H, deviceScaleFactor: 1 } });
let result;
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  // offline: no network, ever. A runtime library the page loads from a CDN (GSAP) is answered from a vendor folder's
  // manifest.json ({ libraries: [{ url, file, sha256 }] }, the mac/bundle-gsap layout), only when the copy's sha256 matches.
  const vendor = loadVendor();
  const refused = [];
  page.on("request", (r) => {
    const u = r.url();
    if (/^(file|data|blob):/.test(u)) return r.continue();
    const v = vendor.get(u);
    if (v) return r.respond({ status: 200, contentType: "application/javascript", body: v });
    refused.push(u); return r.abort();
  });
  await page.evaluateOnNewDocument(() => { window.__timelines = {}; });
  await page.goto(pathToFileURL(html).href, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__timelines && window.__timelines.main && window.gsap, { timeout: 30000 })
    .catch((e) => { throw new Error(refused.length ? `the page needs ${refused.join(", ")} and the probe is offline: set PIXEL_PROBE_VENDOR to a vendor folder with a manifest.json that lists it` : e.message); });
  await page.evaluate(() => document.fonts.ready.then(() => 0));
  const chrome = await browser.version();
  result = await page.evaluate((frames, fps, W, H, graphics) => {
    const tl = window.__timelines.main; tl.pause();
    for (const m of document.querySelectorAll("video, audio")) { m.pause(); m.removeAttribute("autoplay"); }
    const clips = [...document.querySelectorAll(".clip[data-start]")];
    const seek = (t) => {
      tl.totalTime(t + 0.001, true); tl.totalTime(t, false);
      for (const c of clips) { const s = +c.dataset.start, d = +c.dataset.duration; c.style.visibility = t >= s - 1e-6 && t < s + d - 1e-6 ? "" : "hidden"; }
    };
    const q = (x) => Math.round(x * 100) / 100;
    const R = (r) => [q(r.left), q(r.top), q(r.width), q(r.height)];
    const root = document.getElementById("root") || document.body;
    // effective opacity: product of computed opacity up to the root; visibility:hidden or display:none = 0
    const effOp = (e) => {
      const cs0 = getComputedStyle(e);
      if (cs0.visibility === "hidden" || cs0.display === "none") return 0;
      let o = 1;
      for (let x = e; x && x !== document.documentElement; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.display === "none") return 0; o *= +cs.opacity; }
      return Math.round(o * 1000) / 1000;
    };
    const cssPath = (e) => { const p = []; for (let x = e; x && x !== root && p.length < 6; x = x.parentElement) p.unshift(x.id ? "#" + x.id : x.tagName.toLowerCase() + (x.classList.length ? "." + [...x.classList].join(".") : "")); return p.join(">"); };
    const owner = (e) => { for (let x = e; x && x !== root; x = x.parentElement) if (x.id) return "#" + x.id; return cssPath(e); };
    const clipRect = (e) => {
      let r = [-1e6, -1e6, 1e6, 1e6];
      for (let x = e.parentElement; x && x !== document.documentElement; x = x.parentElement) {
        const cs = getComputedStyle(x);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const b = x.getBoundingClientRect();
        r = [Math.max(r[0], b.left), Math.max(r[1], b.top), Math.min(r[2], b.right), Math.min(r[3], b.bottom)];
      }
      return r[0] < -1e5 ? null : [q(r[0]), q(r[1]), q(r[2] - r[0]), q(r[3] - r[1])];
    };
    const caps = document.getElementById("caps") || document.getElementById("ecaps");
    const graphicEls = graphics.map((g) => [g.id, document.querySelector(g.selector)]);
    const SKIP_COVER = new Set(["root", "pip", "base", "snap", "push", "room", "caps", "ecaps", "fx", "grain"]);
    const opaquePaint = (e, cs) => {
      if (["IMG", "CANVAS", "svg"].includes(e.tagName)) return true;
      if (e.tagName === "VIDEO") return !e.closest("#push, #pip");   // footage is the picture, not a cover over it
      if (cs.mixBlendMode !== "normal") return false;   // a look layer (soft-light tint) tints the picture, it does not hide it
      if (/url\(/.test(cs.backgroundImage || "")) return true;   // a picture; a gradient (vignette, scrim) is not a cover
      const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/); if (!m) return false;
      const p = m[1].split(",").map(Number); return (p.length < 4 ? 1 : p[3]) >= 0.99;
    };
    const out = {};
    for (const n of frames) {
      seek(n / fps);
      const s = { capsOp: caps ? effOp(caps) : 0, groups: [], graphics: {}, text: [], covers: [] };
      if (caps) for (const g of caps.querySelectorAll(".cap-group")) {
        const go = effOp(g); if (go <= 0) continue;
        const words = [];
        for (const w of g.querySelectorAll(".w")) {
          const r = w.getBoundingClientRect(), cs = getComputedStyle(w), oh = w.offsetHeight || r.height || 1;
          words.push({ id: w.id, rect: R(r), op: effOp(w), color: cs.color, fs: q(parseFloat(cs.fontSize) * (r.height / oh)) });
        }
        s.groups.push({ id: g.id, rect: R(g.getBoundingClientRect()), op: go, words });
      }
      for (const [id, e] of graphicEls) if (e) s.graphics[id] = { rect: R(e.getBoundingClientRect()), op: effOp(e) };
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (t) => t.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
      for (let t; (t = tw.nextNode());) {
        const e = t.parentElement; if (!e || e.closest("script,style")) continue;
        const op = effOp(e); if (op < 0.5) continue;
        const rg = document.createRange(); rg.selectNodeContents(t);
        const lines = [...rg.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5).map(R);
        if (!lines.length) continue;
        s.text.push({ el: owner(e), text: t.nodeValue.trim().slice(0, 60), cap: !!(caps && caps.contains(e)), lines, clip: clipRect(e), op });
      }
      for (const e of root.querySelectorAll("*")) {
        if (SKIP_COVER.has(e.id)) continue;
        const r = e.getBoundingClientRect();
        const ix = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)), iy = Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
        if (ix * iy < 0.9 * W * H) continue;
        const cs = getComputedStyle(e);
        if (!opaquePaint(e, cs)) continue;
        const op = effOp(e); if (op < 0.99) continue;
        s.covers.push(owner(e));
      }
      out[n] = s;
    }
    return out;
  }, frames, geo.fps, geo.W, geo.H, geo.graphics.map((g) => ({ id: g.id, selector: g.selector })));
  result = { v: 1, chrome, geometry_sha256: sha(geoBytes), html_sha256: sha(fs.readFileSync(html)), frames, samples: result };
} finally {
  await browser.close();
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, canon(result));
console.log(`pixel_probe: ${frames.length} frames in ${Date.now() - t0} ms -> ${out}`);

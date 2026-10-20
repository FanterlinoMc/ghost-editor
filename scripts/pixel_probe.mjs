#!/usr/bin/env node
// The pixel check's DOM probe (references/pixel-check.md 2.3): where Chrome lays out the captions, the graphics and
// every visible text line of a built reel, at the pixel check's sample frames.
//
//   node scripts/pixel_probe.mjs <project> --frames <frames.json> [--out <project>/build/pixel_probe.json]
//
// <frames.json> is the sample list ({"frames": [n, ...]}) the checker computed from build/geometry.json
// (pixel_check.py --print-samples writes it); the probe never picks frames itself, so one list drives the probe and
// the decode. Opens <project>/index.html in the headless Chrome + puppeteer-core the renderer cached (lib/browser.mjs)
// and seeks the paused timeline the way the renderer does (motion-determinism.mjs --seek render: totalTime(t + .001,
// suppress), totalTime(t); a .clip shows only inside [data-start, data-start + data-duration)). Footage is irrelevant
// to layout: media requests are refused and the elements paused.
//
// Network: the page is served from 127.0.0.1 by this process (the project folder only). Every other request is
// aborted, except the runtime libraries the page loads from a CDN that lib/runtime-libs.mjs lists (GSAP, the URL
// build.mjs writes): Node gets those bytes BEFORE Chrome starts, from $PIXEL_PROBE_VENDOR (a folder with a
// manifest.json, optional), else a cache in $PIXEL_PROBE_CACHE / os.tmpdir() keyed by sha256, else the CDN (8 s
// timeout), checks the pinned sha256 and answers Chrome's request with them. Nothing is shipped or vendored.
//
// Exit 0 = written. 3 = the library's bytes are not the pinned ones (integrity: the checker's PX0). 4 = unavailable
// (a library not reachable, or the page needs a URL it may not load: the checker runs its pixel-only rules). 2 = other.
// The last stderr line says why. A missing dependency fails before Chrome starts or right after the page's load event.
//
// Chrome: as the renderer launches it (--no-sandbox only on Linux, where hyperframes passes it too). Running as root
// (the server): through the graphic render's uid drop (lib/graphic-render.mjs: GRAPHIC_CHROME_UID / GID, setpriv, the
// per-uid host lock, the lingering-process sweep, a fresh uid-owned home, the network-lock flags, every process of the
// uid killed after), never Chrome as root.
// Output: rects in canvas px rounded to 0.01, sorted keys; deterministic for one index.html and one Chrome.

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { findPuppeteer, findChrome } from "./lib/browser.mjs";
import { RUNTIME_LIBS } from "./lib/runtime-libs.mjs";
import { chromeUser, chromeHome, chromeShim, releaseChromeHome, hostLock, sweepUid } from "./lib/graphic-render.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const proj = path.resolve(argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--"))) || ".");
const out = opt("out", path.join(proj, "build", "pixel_probe.json"));
const framesFile = opt("frames", null);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
class Stop extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const stop = (code, msg) => { throw new Stop(code, msg); };

// canonical JSON: sorted keys, no spaces (the checker hashes it)
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);

// ---- the runtime libraries, verified before Chrome starts ----
const cacheDir = () => process.env.PIXEL_PROBE_CACHE || os.tmpdir();
async function fetchBytes(url) {
  // tests only (node --test): PIXEL_PROBE_TEST_FETCH = a file whose bytes the "CDN" returns, or "fail"
  if (process.env.PIXEL_PROBE_TEST_FETCH && process.env.NODE_TEST_CONTEXT) {
    if (process.env.PIXEL_PROBE_TEST_FETCH === "fail") throw new Error("getaddrinfo ENOTFOUND (test)");
    return fs.readFileSync(process.env.PIXEL_PROBE_TEST_FETCH);
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
export async function libraryBytes(url, want) {
  const vdir = process.env.PIXEL_PROBE_VENDOR;
  if (vdir) {   // an optional local copy: it must be the same bytes
    let man; try { man = JSON.parse(fs.readFileSync(path.join(vdir, "manifest.json"), "utf8")); } catch { man = null; }
    const l = man && (man.libraries || []).find((x) => x.url === url);
    if (l) {
      const b = fs.readFileSync(path.join(vdir, l.file));
      if (sha(b) !== want) stop(3, `${url}: the copy in PIXEL_PROBE_VENDOR has sha256 ${sha(b)}, pinned ${want}`);
      return { bytes: b, from: "vendor" };
    }
  }
  const cached = path.join(cacheDir(), `pixel-probe-${want}.js`);
  try { const b = fs.readFileSync(cached); if (sha(b) === want) return { bytes: b, from: "cache" }; } catch {}
  let b;
  try { b = await fetchBytes(url); } catch (e) { stop(4, `probe unavailable: ${url} not reachable (${String(e.cause?.code || e.message).slice(0, 120)})`); }
  if (sha(b) !== want) stop(3, `${url}: fetched bytes have sha256 ${sha(b)}, pinned ${want} (not served)`);
  try { const tmp = `${cached}.${process.pid}.tmp`; fs.writeFileSync(tmp, b); fs.renameSync(tmp, cached); } catch {}
  return { bytes: b, from: "cdn" };
}

// ---- the project, served on 127.0.0.1 (the dropped Chrome cannot read the project dir; one path for both modes) ----
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
const MEDIA = /\.(mp4|webm|mov|m4v|m4a|mp3|wav|aac|ogg)$/i;
function serve(root) {
  const srv = http.createServer((q, r) => {
    let rel; try { rel = decodeURIComponent(new URL(q.url, "http://x").pathname); } catch { r.writeHead(400).end(); return; }
    const file = path.resolve(root, "." + rel);
    if (!(file === root || file.startsWith(root + path.sep)) || MEDIA.test(file)) { r.writeHead(404).end(); return; }
    fs.readFile(file, (err, b) => { if (err) r.writeHead(404).end(); else r.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" }).end(b); });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

async function main() {
  if (!framesFile) stop(2, "--frames <file> is required (pixel_check.py --print-samples writes it)");
  const geoBytes = fs.readFileSync(path.join(proj, "build", "geometry.json"));
  const geo = JSON.parse(geoBytes);
  if (geo.error) stop(2, `build/geometry.json has no geometry: ${geo.error}`);
  const frames = JSON.parse(fs.readFileSync(framesFile, "utf8")).frames;
  const html = path.join(proj, "index.html");
  const htmlText = fs.readFileSync(html, "utf8");
  // the page's remote scripts: each must be a listed runtime library, verified now (no Chrome yet: a failure is fast)
  const libs = new Map();
  for (const m of htmlText.matchAll(/<script[^>]*\ssrc="(https?:\/\/[^"]+)"/g)) {
    const url = m[1];
    if (!RUNTIME_LIBS[url]) stop(4, `probe unavailable: the page loads ${url}, which the probe may not fetch (lib/runtime-libs.mjs lists what it may)`);
    if (!libs.has(url)) libs.set(url, (await libraryBytes(url, RUNTIME_LIBS[url])).bytes);
  }
  const t0 = Date.now();
  const user = chromeUser();
  if (user.error) stop(2, user.error);
  let lock = null, home = null, scratch = null, server = null, browser = null;
  try {
    let exe = findChrome(), args = ["--force-device-scale-factor=1", "--hide-scrollbars", "--mute-audio"];
    if (user.root) {   // never Chrome as root: the graphic render's drop, with its lock, sweep, home and network flags
      lock = await hostLock(user);
      const sw = sweepUid(user); if (!sw.ok) stop(2, sw.error);
      home = chromeHome(user);
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-probe-"));
      exe = chromeShim(path.join(scratch, "chrome"), exe, { home, setpriv: user.setpriv });
    } else if (process.platform === "linux") args.unshift("--no-sandbox");   // as hyperframes launches it on Linux
    server = await serve(fs.realpathSync(proj));
    const origin = `127.0.0.1:${server.address().port}`;
    const puppeteer = findPuppeteer();
    browser = await puppeteer.launch({ executablePath: exe, headless: "shell", args, defaultViewport: { width: geo.W, height: geo.H, deviceScaleFactor: 1 },
      env: { ...process.env, GRAPHIC_RENDER_ORIGINS: origin } });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    const refused = new Set();
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith(`http://${origin}/`) && !MEDIA.test(new URL(u).pathname)) return r.continue();
      if (/^(data|blob):/.test(u)) return r.continue();
      const b = libs.get(u);
      if (b) return r.respond({ status: 200, contentType: "application/javascript", body: b });
      if (!MEDIA.test(u.split("?")[0])) refused.add(u);
      return r.abort();
    });
    await page.evaluateOnNewDocument(() => { window.__timelines = {}; });
    await page.goto(`http://${origin}/index.html`, { waitUntil: "load", timeout: 60000 });
    // a missing dependency shows at the load event: fail now, not after a wait
    const ready = () => page.evaluate(() => !!(window.__timelines && window.__timelines.main && window.gsap));
    if (!(await ready())) {
      await page.waitForFunction(() => window.__timelines && window.__timelines.main && window.gsap, { timeout: refused.size ? 500 : 5000 })
        .catch(() => stop(4, `probe unavailable: the page has no timeline / GSAP after load${refused.size ? ` (refused: ${[...refused].sort().join(", ")})` : ""}`));
    }
  await page.evaluate(() => document.fonts.ready.then(() => 0));
    const chrome = await browser.version();
    const result = await page.evaluate((frames, fps, W, H, graphics) => {
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
    const doc = { v: 1, chrome, geometry_sha256: sha(geoBytes), html_sha256: sha(Buffer.from(htmlText)), frames, refused: [...refused].sort(), samples: result };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, canon(doc));
    console.log(`pixel_probe: ${frames.length} frames in ${Date.now() - t0} ms -> ${out}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    try { if (home) { const rel = releaseChromeHome(home, user); if (!rel.ok) console.error(`pixel_probe: ${rel.error}`); } } finally { if (lock) lock.release(); }
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`pixel_probe: ${e.message}`); process.exit(e instanceof Stop ? e.code : 2); });
}

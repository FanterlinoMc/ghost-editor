#!/usr/bin/env node
// node --test scripts/build-nametag-captions.test.mjs
// mac-75 (CP3): captions step around a nametag - checked against the tag AS CHROME DRAWS IT, not against the build's own
// height arithmetic (a test that recomputes the formula is wrong exactly when the formula is). Both variants: the
// default tag and the Broadsheet byline. The tag sits ON the caption band (y 1180), so without the fix they overlap.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const SEC = 8;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nametag-captions-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const REQUIRED = process.env.CI === "1" || process.env.REQUIRE_CHROME === "1";
const skipOrFail = (t, why) => { if (REQUIRED) throw new Error(`real Chrome required (CI / REQUIRE_CHROME): ${why}`); return t.skip(why); };

function project(name, extra) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true }); fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=30:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "assets", "talk.mp4")]);
  const words = "my name is james and i study english at the university of sheffield every single day".split(" ");
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: SEC, words: words.map((w, i) => ({ word: w, start: +(0.3 + i * 0.42).toFixed(2), end: +(0.62 + i * 0.42).toFixed(2) })) }] }));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 9 }, (_, i) => [i, 300, 760, 340, 740, 450, 640]) }));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: name, source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: 30, outro: 0, music: null,
    takes: [{ a: 0, b: SEC }], zoom: {}, beats: [{ type: "nametag", at: 1, to: 6, name: "James", title: "Student, University of Sheffield", subtitle: "English", y: 1180 }], ...extra }));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary() } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return dir;
}

test("real Chrome: no caption block in the tag's window overlaps the tag as drawn (default tag and byline)", { timeout: 180000 }, async (t) => {
  let puppeteer, chrome;
  try { chrome = (process.env.CHROME && fs.existsSync(process.env.CHROME) && process.env.CHROME) || findPinnedChrome() || findChrome(); } catch (e) { return skipOrFail(t, e.message); }
  try { puppeteer = findPuppeteer({ npxTimeout: REQUIRED ? 20000 : undefined }); } catch (e) { return skipOrFail(t, e.message); }
  const TYPES = { ".html": "text/html", ".woff2": "font/woff2", ".mp4": "video/mp4", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg" };
  const browser = await puppeteer.launch({ executablePath: chrome, headless: "shell", args: ["--no-sandbox", "--force-device-scale-factor=1"], defaultViewport: { width: 1080, height: 1920, deviceScaleFactor: 1 } });
  try {
    for (const [name, extra] of [["default", {}], ["byline", { nametagStyle: "byline" }]]) {
      const dir = project(name, extra);
      const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
      const tagId = html.match(/<div id="(b\d+)-in" class="ov" style="left:\d+px;top:1180px;position:absolute">/)[1];
      const server = http.createServer((req, res) => {
        const f = path.join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
        if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => { window.__timelines = {}; });
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => !!(window.__timelines && window.__timelines.main), { timeout: 30000 });
        await page.evaluate(async () => { await document.fonts.ready; for (const f of document.fonts) await f.load().catch(() => {}); });
        const tag = await page.evaluate((id) => { const tl = window.__timelines.main; tl.pause(); tl.totalTime(3.0, false);
          const r = document.getElementById(`${id}-in`).getBoundingClientRect(); return { y0: r.top, y1: r.bottom }; }, tagId);
        await page.close();
        const blocks = JSON.parse(fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8")).blocks;
        const during = blocks.filter((k) => k.t0 < 6 && k.t1 > 1);
        assert.ok(tag.y1 - tag.y0 > 60, `${name}: the tag drew (${JSON.stringify(tag)})`);
        assert.ok(during.length > 0, `${name}: captions in the tag's window`);
        for (const k of during) assert.ok(k.y >= tag.y1 || k.y + k.h <= tag.y0, `${name}: caption block ${k.t0}s y ${k.y}..${k.y + k.h} overlaps the drawn tag ${Math.round(tag.y0)}..${Math.round(tag.y1)}`);
      } finally { server.close(); }
    }
  } finally { await browser.close(); }
});

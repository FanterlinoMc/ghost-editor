#!/usr/bin/env node
// mac-56: measure THIS host's widest emoji advance in Chrome, for CAPTION_EMOJI_EM (lib/emoji-em.mjs).
//
//   node scripts/emoji-advance.mjs [--font <emoji .ttf>] [--write <stamp.json>]
//
// --font: lay emoji out with that font file (to measure a font that is not this machine's, or when fontconfig cannot
// say which file draws emoji). Default: the file `fc-match emoji` names (Linux), drawn by the host's own fallback.
// Every Emoji_Presentation code point in U+2600-27BF and U+1F000-1FAFF is set 10 times at 100 px; the advance is the
// widest one, rounded UP to 0.001 em. stdout: one JSON line { advance, samples, widest, font, sha256, chrome }.
// --write also saves it as the stamp CAPTION_EMOJI_STAMP points at. Re-run it after any base-image or font change: the
// build refuses a stamp whose font file's sha256 no longer matches.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { findPuppeteer, findChrome } from "./lib/browser.mjs";
import { findChrome as findPinnedChrome } from "./lib/graphic-render.mjs";

const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(`ERROR: ${m}`); process.exit(1); };
let font = opt("--font");
const forced = !!font;
if (!font) {
  const r = spawnSync("fc-match", ["-f", "%{file}", "emoji"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) fail("no --font, and fontconfig (fc-match) cannot say which file draws emoji here");
  font = r.stdout.trim();
}
if (!fs.existsSync(font)) fail(`no font file ${font}`);
font = path.resolve(font);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(font)).digest("hex");
const page = `<!doctype html><meta charset="utf-8"><style>${forced ? '@font-face { font-family: "EmojiMeasure"; src: url(/font) format("truetype"); }' : ""}
  body { margin: 0; } span { font: 100px ${forced ? '"EmojiMeasure", ' : ""}sans-serif; white-space: nowrap; letter-spacing: 0; }</style><body></body>`;
const server = http.createServer((q, r) => {
  if (q.url === "/font") { r.writeHead(200, { "content-type": "font/ttf" }); return fs.createReadStream(font).pipe(r); }
  r.writeHead(200, { "content-type": "text/html" }); r.end(page);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const chrome = (process.env.CHROME && fs.existsSync(process.env.CHROME) && process.env.CHROME) || findPinnedChrome() || findChrome();
const browser = await findPuppeteer().launch({ executablePath: chrome, headless: "shell", args: ["--no-sandbox", "--force-device-scale-factor=1"] });
try {
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  const res = await p.evaluate(async (forced) => {
    if (forced) await document.fonts.load('100px "EmojiMeasure"', "\u{1F602}");
    await document.fonts.ready;
    const cps = [];
    for (const [a, b] of [[0x2600, 0x27bf], [0x1f000, 0x1faff]]) for (let c = a; c <= b; c++) if (/\p{Emoji_Presentation}/u.test(String.fromCodePoint(c))) cps.push(c);
    let max = 0, widest = null;
    for (const c of cps) {
      const s = document.createElement("span"); s.textContent = String.fromCodePoint(c).repeat(10); document.body.appendChild(s);
      const w = s.getBoundingClientRect().width / 10 / 100; s.remove();
      if (w > max) { max = w; widest = String.fromCodePoint(c); }
    }
    return { max, widest, samples: cps.length };
  }, forced);
  const out = { advance: Math.ceil(res.max * 1000) / 1000, samples: res.samples, widest: res.widest, font, sha256, chrome: (await browser.version()).replace(/^HeadlessChrome\//, "") };
  if (opt("--write")) fs.writeFileSync(opt("--write"), JSON.stringify(out, null, 2) + "\n");
  process.stdout.write(JSON.stringify(out) + "\n");
} finally { await browser.close(); server.close(); }

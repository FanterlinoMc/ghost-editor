#!/usr/bin/env node
// The Prompt Motion determinism check, standalone (PM2): static rules, network probe, wrapper, two independent
// `hyperframes@0.8.81 render`s (the second with --workers 1), every R rule, framemd5 of both outputs.
//   node scripts/graphic-determinism.mjs <graphic.html> [--mode overlay|insert] [--fps 30] [--size WxH] [--out DIR] [--keep]
// --size is the reel canvas (default 1080x1920). Prints `GRAPHIC DETERMINISM: PASS` or `GRAPHIC DETERMINISM: FAIL`
// (with the reasons; R6 names the first differing frame and its t) and exits 0 / 1. Needs node, npx, ffmpeg only
// (macOS and Linux). The rendered file is deleted unless --keep (then it stays in --out, default a temp dir).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderGraphic } from "./lib/graphic-render.mjs";
import { SRC_RE } from "./lib/graphic.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const file = args.find((a, i) => !a.startsWith("--") && !["--mode", "--fps", "--size", "--out"].includes(args[i - 1]));
const usage = () => { console.error("usage: node scripts/graphic-determinism.mjs <graphic.html> [--mode overlay|insert] [--fps 30] [--size WxH] [--out DIR] [--keep]"); process.exit(2); };
if (!file || !fs.existsSync(file)) usage();
const mode = opt("--mode", "overlay");
const fps = Number(opt("--fps", "30"));
const sm = /^(\d+)x(\d+)$/.exec(opt("--size", "1080x1920"));
if (!sm || !["overlay", "insert"].includes(mode) || !(fps > 0)) usage();
const [W, H] = [Number(sm[1]), Number(sm[2])];

// a file at <project>/assets/graphics/<name>.html is checked as that project's (G1, G16 media); any other file alone
const abs = path.resolve(file);
const rel = abs.split(path.sep).slice(-3).join("/");
const inProject = SRC_RE.test(rel);
const projectDir = inProject ? path.resolve(abs, "..", "..", "..") : null;
const htmlPath = inProject ? rel : `assets/graphics/${path.basename(abs).toLowerCase().replace(/[^a-z0-9-.]/g, "-")}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-determinism-"));
const outDir = opt("--out", path.join(work, "out"));
const t0 = Date.now();
const r = await renderGraphic({
  content: fs.readFileSync(abs), html: htmlPath, projectDir, mediaRoot: projectDir ? null : path.dirname(abs), mode, W, H, fps,
  outDir, buildDir: path.join(work, "build"), log: (l) => console.log(l),
});
console.log(`key ${r.key || "-"}  frames ${r.L ?? "-"}  renders ${(r.renders || []).map((x) => `${x.secs}s`).join(", ") || "-"}  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (r.ok) {
  console.log(`file ${args.includes("--keep") ? r.file : "(deleted; --keep keeps it)"}`);
  if (!args.includes("--keep")) fs.rmSync(work, { recursive: true, force: true });
  console.log("GRAPHIC DETERMINISM: PASS");
  process.exit(0);
}
for (const [i, x] of r.reasons.entries()) console.log(`${r.codes[i]}: ${x}`);
if (r.wrapper) console.log(`logs: ${path.dirname(r.wrapper)}/render-*.log`);
console.log("GRAPHIC DETERMINISM: FAIL");
process.exit(1);

#!/usr/bin/env node
// Frame preview for the planner's look-and-revise step: a Prompt Motion graphic at a few exact times, as PNGs,
// through renderGraphic's sandbox (scripts/lib/graphic-frames.mjs says how). Spec: references/reel-json.md
// "Frame preview CLI".
//   node scripts/graphic-frames.mjs <graphic.html> --w W --h H --at 0.4,1.5,2.6 --out DIR [--mode overlay|insert] [--lock PATH]
// --w / --h: the reel canvas (default 1080 x 1920; an overlay renders at its window.size, an insert at W x H).
// Writes DIR/f-<t>.png (overlay: RGBA, transparent background; insert: opaque) and prints ONE JSON line on stdout:
//   {"frames":[{"t":0.4,"file":"DIR/f-0.4.png"},...],"refused":null}        exit 0
//   {"frames":[],"refused":"R1: graphic tried to load ..."}                   exit 2 (a refusal: the texts are renderGraphic's)
//   {"frames":[],"refused":null,"error":"..."}                                exit 1 (usage or internal error)
// Progress goes to stderr. Needs node, npx (hyperframes@0.8.81 cached) and the pinned chrome-headless-shell
// (GRAPHIC_CHROME_PATH); root: GRAPHIC_CHROME_UID / GRAPHIC_CHROME_GID and setpriv, exactly as renderGraphic.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderFrames } from "./lib/graphic-frames.mjs";
import { SRC_RE } from "./lib/graphic.mjs";
import { holdRenderLock } from "./lib/graphic-lock.mjs";

const say = (o, code) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(code); };
const fail = (m) => say({ frames: [], refused: null, error: m }, 1);
try {
  holdRenderLock(); // --lock <path> / GRAPHIC_RENDER_LOCK: re-run under lockf / flock (the shared Mac)
  const args = process.argv.slice(2);
  const VAL = ["--w", "--h", "--at", "--out", "--mode", "--lock"];
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const file = args.find((a, i) => !a.startsWith("--") && !VAL.includes(args[i - 1]));
  const usage = "usage: node scripts/graphic-frames.mjs <graphic.html> --w W --h H --at t1,t2,... --out DIR [--mode overlay|insert] [--lock PATH]";
  if (!file || !fs.existsSync(file)) fail(`${usage} (no graphic file${file ? ` ${file}` : ""})`);
  const W = Number(opt("--w", "1080")), H = Number(opt("--h", "1920")), mode = opt("--mode", "overlay"), outDir = opt("--out");
  const at = String(opt("--at", "")).split(",").map((x) => x.trim()).filter(Boolean);
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 16 || H < 16 || !["overlay", "insert"].includes(mode) || !outDir || !at.length || !at.every((x) => /^[0-9]*\.?[0-9]+$/.test(x))) fail(usage);
  // a file at <project>/assets/graphics/<name>.html is checked as that project's (G1, G16 media); any other file alone
  const abs = path.resolve(file);
  const rel = abs.split(path.sep).slice(-3).join("/");
  const inProject = SRC_RE.test(rel);
  const projectDir = inProject ? path.resolve(abs, "..", "..", "..") : null;
  const htmlPath = inProject ? rel : `assets/graphics/${path.basename(abs).toLowerCase().replace(/[^a-z0-9-.]/g, "-")}`;
  // tests only: GRAPHIC_TEST_DEPS (a module exporting `deps`) under node --test, as build.mjs does
  const deps = process.env.GRAPHIC_TEST_DEPS && process.env.NODE_TEST_CONTEXT ? (await import(pathToFileURL(path.resolve(process.env.GRAPHIC_TEST_DEPS)).href)).deps : {};
  const r = await renderFrames({
    content: fs.readFileSync(abs), html: htmlPath, projectDir, mediaRoot: projectDir ? null : path.dirname(abs), mode, W, H,
    times: at.map(Number), outDir: path.resolve(outDir), log: (l) => console.error(l),
  }, deps);
  if (r.ok) say({ frames: r.frames, refused: null }, 0);
  say({ frames: [], refused: r.refused }, 2);
} catch (e) {
  console.error(e && e.stack ? e.stack : e);
  fail(String(e && e.message ? e.message : e));
}

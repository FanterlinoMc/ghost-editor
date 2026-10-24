#!/usr/bin/env node
// node scripts/render.mjs <hyperframes render args...>     (run in the project folder, e.g. `-o build/reel.mp4 --quiet`)
// `npx hyperframes@0.8.81 render` with GSAP (and every vendor/manifest.json library) served from vendor/, never a CDN.
// Exits 1 when the page uses a vendored URL the preload did not serve. The CLI of runRender() in scripts/lib/vendor.mjs,
// for callers in other languages (qa.py, empire_finish.py, phantasic).
import { runRender } from "./lib/vendor.mjs";

const r = runRender(process.argv.slice(2));
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
if (r.error) process.stderr.write(`render.mjs: ${r.error}\n`);
process.exit(r.status);

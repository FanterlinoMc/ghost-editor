// Finding a headless Chrome and puppeteer-core without a package.json (the fork has none): used by the
// scripts that drive the composition page directly (motion-determinism.mjs). The renderer itself is
// `npx hyperframes@<pinned>`; this reuses the puppeteer-core and Chrome it already cached.
//
//   PUPPETEER_CORE_DIR  a node_modules/puppeteer-core directory (override); else the npx caches (~/.npm/_npx, the
//                       npm_config_cache one, Windows' LOCALAPPDATA one), ~/node_modules, and last the puppeteer-core
//                       the PINNED renderer itself loads (graphic-render.mjs resolveHyperframes: npx -p hyperframes@pin)
//   CHROME              a chrome / chrome-headless-shell executable; else GRAPHIC_CHROME_PATH (the pinned shell the
//                       graphic renderer uses, e.g. on the Linux server), HYPERFRAMES_BROWSER_PATH,
//                       PRODUCER_HEADLESS_SHELL_PATH, then the hyperframes / puppeteer caches

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveHyperframes } from "./graphic-render.mjs";

function kids(dir) { try { return fs.readdirSync(dir).map((n) => path.join(dir, n)); } catch { return []; } }

export function findPuppeteer() {
  const cands = [];
  if (process.env.PUPPETEER_CORE_DIR) cands.push(process.env.PUPPETEER_CORE_DIR);
  const npxRoots = [path.join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx"), path.join(os.homedir(), ".npm", "_npx")];
  for (const r of npxRoots) for (const d of kids(r)) cands.push(path.join(d, "node_modules", "puppeteer-core"));
  if (process.env.npm_config_cache) for (const d of kids(path.join(process.env.npm_config_cache, "_npx"))) cands.push(path.join(d, "node_modules", "puppeteer-core"));
  cands.push(path.join(os.homedir(), "node_modules", "puppeteer-core"));
  for (const c of cands) if (fs.existsSync(path.join(c, "package.json"))) return createRequire(path.join(c, "package.json"))(c);
  // the engine's own resolution: the pinned hyperframes CLI (as the graphic renderer finds it), and the puppeteer-core
  // its package resolves (hoisted next to it in the npx tree)
  try {
    let dir = path.dirname(resolveHyperframes());
    while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
    return createRequire(path.join(dir, "package.json"))("puppeteer-core");
  } catch (e) {
    throw new Error(`puppeteer-core not found (npx caches, ~/node_modules, the pinned hyperframes: ${String(e.message).slice(0, 160)}): run \`npx -y hyperframes@<pin> --version\` once, or set PUPPETEER_CORE_DIR`);
  }
}

export function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const k of ["GRAPHIC_CHROME_PATH", "HYPERFRAMES_BROWSER_PATH", "PRODUCER_HEADLESS_SHELL_PATH"]) if (process.env[k] && fs.existsSync(process.env[k])) return process.env[k];
  const exe = process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  const roots = [path.join(os.homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell"), path.join(os.homedir(), ".cache", "puppeteer", "chrome-headless-shell")];
  for (const r of roots) for (const v of kids(r).sort().reverse()) for (const s of [v, ...kids(v)]) { const p = path.join(s, exe); if (fs.existsSync(p)) return p; }
  throw new Error("no chrome-headless-shell in ~/.cache/hyperframes or ~/.cache/puppeteer: set CHROME or GRAPHIC_CHROME_PATH");
}

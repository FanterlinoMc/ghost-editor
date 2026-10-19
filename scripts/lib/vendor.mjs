// Vendored runtime libraries (vendor/manifest.json): build.mjs copies the ones its page references into the project,
// and a render runs with scripts/vendor-offline.cjs preloaded, which serves those URLs from the local copies.
// The page keeps the CDN URL (it is part of every golden reel's hashed index.html); the bytes never come from it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VENDOR = path.join(SKILL, "vendor");
// forward slashes: NODE_OPTIONS reads a backslash inside quotes as an escape (Windows takes either)
export const PRELOAD = path.join(SKILL, "scripts", "vendor-offline.cjs").split(path.sep).join("/");
export const LIBRARIES = JSON.parse(fs.readFileSync(path.join(VENDOR, "manifest.json"), "utf8")).libraries;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// Copy every vendored library whose URL the page uses into the project (skipped when an identical copy is there).
// Dies through `die` when the fork's own copy is missing or does not match its sha256: a render would fall back to the CDN.
export function copyVendored(proj, html, die = (m) => { throw new Error(m); }) {
  const copied = [];
  for (const e of LIBRARIES) {
    if (!html.includes(e.url)) continue;
    const dst = path.join(proj, e.project);
    if (fs.existsSync(dst) && sha(fs.readFileSync(dst)) === e.sha256) { copied.push(e.project); continue; }
    const src = path.join(VENDOR, e.file);
    const b = fs.existsSync(src) ? fs.readFileSync(src) : null;
    if (!b || sha(b) !== e.sha256) die(`vendored ${e.name} ${e.version} missing or altered: ${path.relative(SKILL, src)} (sha256 must be ${e.sha256})`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, b);
    copied.push(e.project);
  }
  return copied;
}

// env for a `hyperframes render` child: the vendor preload added to NODE_OPTIONS
export const renderEnv = (env = process.env) => ({ ...env, NODE_OPTIONS: `${env.NODE_OPTIONS || ""} --require "${PRELOAD}"`.trim() });

// The Lottie element of the motion vocabulary (`shape: "lottie"`): resolving and checking the animation FILE.
// Spec: references/reel-json.md, "Lottie element". compileMotion (motion-graphics.mjs) handles the element's fields
// and the frame driver; this file only answers "which file, is it one we can render deterministically, and what
// are its numbers". Pure Node, no browser. The planner's validator mirrors every reason string below word for word.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// the page loads this exact URL; vendor/manifest.json maps it to vendor/lottie-web/5.12.2/lottie_light.min.js
export const LOTTIE_URL = "https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie_light.min.js";
export const LOTTIE_MAX_BYTES = 2097152;
export const LOTTIE_PER_GRAPHIC = 3;
export const LOTTIE_LAYER_TYPES = [0, 1, 3, 4];   // precomp, solid, null, shape
const ASSET_RE = /^assets\/[^\0]+\.json$/;
const LIB_ID_RE = /^[a-z0-9-]{1,48}$/;

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// the first layer type outside LOTTIE_LAYER_TYPES, top level and inside every precomp asset; null if all are fine
function badLayerType(d) {
  const lists = [d.layers, ...(Array.isArray(d.assets) ? d.assets.map((a) => a && a.layers).filter(Array.isArray) : [])];
  for (const list of lists) for (const l of list) if (!l || typeof l !== "object" || !LOTTIE_LAYER_TYPES.includes(l.ty)) return l && typeof l === "object" ? l.ty : "?";
  return null;
}
// an After Effects expression: a property object (has `k`) carrying a string `x`
function hasExpression(v) {
  if (Array.isArray(v)) return v.some(hasExpression);
  if (v === null || typeof v !== "object") return false;
  if ("k" in v && typeof v.x === "string") return true;
  for (const k in v) if (hasExpression(v[k])) return true;
  return false;
}

/**
 * Check a Lottie file's bytes. `label` is how the reason names it (the src as written).
 * @returns {{ ok: true, meta: {fr, ip, op, w, h}, json: string } | { ok: false, reason: string }}
 *   json: the file minified (JSON.stringify of the parse), what the page inlines
 */
export function inspectLottie(buf, label) {
  if (buf.length > LOTTIE_MAX_BYTES) return { ok: false, reason: `lottie file ${label} is ${buf.length} bytes (max ${LOTTIE_MAX_BYTES})` };
  let d;
  try { d = JSON.parse(buf.toString("utf8")); } catch { return { ok: false, reason: `lottie file ${label} is not valid JSON` }; }
  if (d === null || typeof d !== "object" || Array.isArray(d) || !["fr", "ip", "op", "w", "h"].every((k) => fin(d[k])) || !Array.isArray(d.layers))
    return { ok: false, reason: `lottie file ${label} is not a Lottie animation (needs numbers fr, ip, op, w, h and a layers array)` };
  if (!(d.fr >= 1 && d.fr <= 120 && d.op > d.ip && d.op - d.ip <= 10000 && d.w >= 1 && d.w <= 8192 && d.h >= 1 && d.h <= 8192))
    return { ok: false, reason: `lottie file ${label} is out of range (fr 1..120, op > ip, op - ip <= 10000, w and h 1..8192)` };
  const ty = badLayerType(d);
  if (ty !== null) return { ok: false, reason: `lottie file ${label} has a layer of type ${ty} (only 0 precomp, 1 solid, 3 null and 4 shape are supported)` };
  if (hasExpression(d)) return { ok: false, reason: `lottie file ${label} uses expressions (not supported)` };
  return { ok: true, meta: { fr: d.fr, ip: d.ip, op: d.op, w: d.w, h: d.h }, json: JSON.stringify(d) };
}

/**
 * A resolver for compileMotion's ctx.resolveLottie. proj: the project dir; lib: the library root (library/).
 * Each distinct file is read and checked once per build.
 * @returns (src) => { ok: true, key, meta, json } | { ok: false, reason }
 *   key: "lottie-" + the first 12 hex of the minified JSON's sha256 (the inlined <script>'s id; two srcs with the
 *   same content share one copy)
 */
export function makeLottieResolver(proj, lib) {
  const cache = new Map();
  const assets = path.join(proj, "assets");
  let manifest;   // read on first library use
  const libManifest = () => {
    if (manifest === undefined) {
      const p = path.join(lib, "lottie", "manifest.json");
      try { manifest = JSON.parse(fs.readFileSync(p, "utf8")); } catch { manifest = {}; }
    }
    return manifest;
  };
  const resolve = (src) => {
    if (typeof src !== "string") return { ok: false, reason: `lottie src '${String(src).slice(0, 60)}' is not an assets/ .json path inside the project or a library/lottie id` };
    let buf;
    if (ASSET_RE.test(src) && !src.split("/").includes("..")) {
      const full = path.resolve(proj, src);
      if (!full.startsWith(assets + path.sep)) return { ok: false, reason: `lottie src '${src.slice(0, 60)}' is not an assets/ .json path inside the project or a library/lottie id` };
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { ok: false, reason: `lottie file ${src} does not exist` };
      buf = fs.readFileSync(full);
    } else if (LIB_ID_RE.test(src)) {
      const m = libManifest(), e = Object.hasOwn(m, src) ? m[src] : null;
      if (!e || typeof e !== "object") return { ok: false, reason: `lottie id '${src}' is not in library/lottie/manifest.json` };
      const full = path.join(lib, "lottie", `${src}.json`);
      if (!fs.existsSync(full)) return { ok: false, reason: `lottie library file ${src}.json is missing (restore the library)` };
      buf = fs.readFileSync(full);
      if (sha256(buf) !== e.sha256) return { ok: false, reason: `lottie library file ${src}.json does not match its manifest sha256` };
    } else return { ok: false, reason: `lottie src '${src.slice(0, 60)}' is not an assets/ .json path inside the project or a library/lottie id` };
    const r = inspectLottie(buf, src);
    if (!r.ok) return r;
    return { ok: true, key: `lottie-${sha256(r.json).slice(0, 12)}`, meta: r.meta, json: r.json };
  };
  return (src) => {
    const k = typeof src === "string" ? src : `\0${String(src)}`;
    if (!cache.has(k)) cache.set(k, resolve(src));
    return cache.get(k);
  };
}

// The <head> tags for the Lottie files a page uses: the player (vendored; see vendor/manifest.json) and one inlined
// JSON block per distinct file. `<` is written as \u003c so no file content can close the <script>. Empty when unused.
// The player is moved off `window.lottie` to `window.__geLottie` right after it loads: HyperFrames 0.8.81 has a built-in
// Lottie adapter that finds `window.lottie.getRegisteredAnimations()` and, on every frame it renders, seeks each one to
// the COMPOSITION time (ignoring start, speed and frames, and after our timeline has run). Measured: with the global
// left in place both fixture players showed frame 59 at t = 4.1 s instead of 59 and 3. The GSAP timeline must be the
// only clock, so the adapter must not see them.
export function lottieHead(files) {
  if (!files.size) return "";
  const data = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, json]) => `<script type="application/json" id="${key}">${json.replace(/</g, "\\u003c")}</script>`);
  return `<script src="${LOTTIE_URL}"></script>\n<script>window.__geLottie = window.lottie; delete window.lottie;</script>\n${data.join("\n")}\n`;
}

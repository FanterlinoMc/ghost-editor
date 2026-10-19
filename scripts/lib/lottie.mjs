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
export const LOTTIE_MAX_DEPTH = 256;   // the player walks shape groups and precomps recursively; real files stay under ~40
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
// What lottie_light would LOAD from outside the file (and so race the first frame, or hit the network): its
// ImagePreloader loads every assets[] entry that has no `layers` array (an image, or `t: 3` footage), whether a layer
// uses it or not; its FontManager adds a <link>/@font-face for fonts.list entries, and `chars` are the glyphs of
// those fonts. A precomp (an asset WITH layers) is vector data. Returns the L13 reason's <what>, or null.
function loadsExternal(d) {
  if (Array.isArray(d.assets) && d.assets.some((a) => !a || typeof a !== "object" || !Array.isArray(a.layers))) return "an asset without layers (an image or footage)";
  if (d.fonts && typeof d.fonts === "object" && Array.isArray(d.fonts.list) && d.fonts.list.length) return "fonts";
  if (Array.isArray(d.chars) && d.chars.length) return "glyphs (chars)";
  return null;
}
// One iterative walk (a deeply nested file must not overflow OUR stack): the nesting depth, and whether any property
// object (has `k`) carries a string `x`, an After Effects expression.
function walk(root) {
  const stack = [[root, 1]];
  let depth = 0, expression = false;
  while (stack.length) {
    const [v, dpt] = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (dpt > depth) depth = dpt;
    if (depth > LOTTIE_MAX_DEPTH) break;
    if (Array.isArray(v)) { for (const x of v) stack.push([x, dpt + 1]); continue; }
    if ("k" in v && typeof v.x === "string") expression = true;
    for (const k in v) stack.push([v[k], dpt + 1]);
  }
  return { depth, expression };
}
// ip/op made whole (references/reel-json.md): within 1e-3 of a whole number -> that number (Bodymovin writes op as
// 60.0000024); otherwise ip up and op down, so every frame index the driver shows lies inside [ip, op)
const near = (v) => Math.abs(v - Math.round(v)) <= 1e-3;
export const wholeIp = (v) => (near(v) ? Math.round(v) : Math.ceil(v));
export const wholeOp = (v) => (near(v) ? Math.round(v) : Math.floor(v));

/**
 * Check a Lottie file's bytes. `label` is how the reason names it (the src as written).
 * @returns {{ ok: true, meta: {fr, ip, op, w, h}, json: string } | { ok: false, reason: string }}
 *   meta.ip / meta.op are whole numbers (wholeIp / wholeOp); json: the file minified, what the page inlines
 */
export function inspectLottie(buf, label) {
  if (buf.length > LOTTIE_MAX_BYTES) return { ok: false, reason: `lottie file ${label} is ${buf.length} bytes (max ${LOTTIE_MAX_BYTES})` };
  const notJson = { ok: false, reason: `lottie file ${label} is not valid JSON` };
  // a file nested too deeply to read or write back (a RangeError in parse or stringify) is reported as not valid JSON
  try {
    let d;
    try { d = JSON.parse(buf.toString("utf8")); } catch { return notJson; }
    if (d === null || typeof d !== "object" || Array.isArray(d) || !["fr", "ip", "op", "w", "h"].every((k) => fin(d[k])) || !Array.isArray(d.layers))
      return { ok: false, reason: `lottie file ${label} is not a Lottie animation (needs numbers fr, ip, op, w, h and a layers array)` };
    const ip = wholeIp(d.ip), op = wholeOp(d.op);
    if (!(d.fr >= 1 && d.fr <= 120 && op > ip && op - ip <= 10000 && d.w >= 1 && d.w <= 8192 && d.h >= 1 && d.h <= 8192))
      return { ok: false, reason: `lottie file ${label} is out of range (fr 1..120, op > ip, op - ip <= 10000, w and h 1..8192)` };
    const ty = badLayerType(d);
    if (ty !== null) return { ok: false, reason: `lottie file ${label} has a layer of type ${ty} (only 0 precomp, 1 solid, 3 null and 4 shape are supported)` };
    const ext = loadsExternal(d);
    if (ext) return { ok: false, reason: `lottie file ${label} has ${ext}: only vector shapes are supported, nothing may be loaded` };
    const wk = walk(d);
    if (wk.depth > LOTTIE_MAX_DEPTH) return { ok: false, reason: `lottie file ${label} is nested more than ${LOTTIE_MAX_DEPTH} levels deep` };
    if (wk.expression) return { ok: false, reason: `lottie file ${label} uses expressions (not supported)` };
    // the inlined copy carries the whole ip/op too: the player's own first frame and frame count then agree with the
    // driver (goToAndStop(f - ip) renders frame f - ip + the file's ip)
    d.ip = ip; d.op = op;
    return { ok: true, meta: { fr: d.fr, ip, op, w: d.w, h: d.h }, json: JSON.stringify(d) };
  } catch { return notJson; }
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
      // a symlinked file or folder must not lead out of assets/: compare the real paths
      let real, realAssets;
      try { real = fs.realpathSync(full); realAssets = fs.realpathSync(assets); } catch { real = null; }
      if (!real || !real.startsWith(realAssets + path.sep)) return { ok: false, reason: `lottie src '${src.slice(0, 60)}' is not an assets/ .json path inside the project or a library/lottie id` };
      const size = fs.statSync(real).size;
      if (size > LOTTIE_MAX_BYTES) return { ok: false, reason: `lottie file ${src} is ${size} bytes (max ${LOTTIE_MAX_BYTES})` };
      buf = fs.readFileSync(real);
    } else if (LIB_ID_RE.test(src)) {
      const m = libManifest(), e = Object.hasOwn(m, src) ? m[src] : null;
      if (!e || typeof e !== "object") return { ok: false, reason: `lottie id '${src}' is not in library/lottie/manifest.json` };
      const full = path.join(lib, "lottie", `${src}.json`);
      if (!fs.existsSync(full)) return { ok: false, reason: `lottie library file ${src}.json is missing (restore the library)` };
      const size = fs.statSync(full).size;
      if (size > LOTTIE_MAX_BYTES) return { ok: false, reason: `lottie file ${src} is ${size} bytes (max ${LOTTIE_MAX_BYTES})` };
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
// The player is moved off `window.lottie` (and `window.bodymovin`, the same object via the UMD tail) to `window.__geLottie`
// right after it loads: HyperFrames 0.8.81 has a built-in
// Lottie adapter that finds `window.lottie.getRegisteredAnimations()` and, on every frame it renders, seeks each one to
// the COMPOSITION time (ignoring start, speed and frames, and after our timeline has run). Measured: with the global
// left in place both fixture players showed frame 59 at t = 4.1 s instead of 59 and 3. The GSAP timeline must be the
// only clock, so the adapter must not see them.
export function lottieHead(files) {
  if (!files.size) return "";
  const data = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, json]) => `<script type="application/json" id="${key}">${json.replace(/</g, "\\u003c")}</script>`);
  return `<script src="${LOTTIE_URL}"></script>\n<script>window.__geLottie = window.lottie; delete window.lottie; delete window.bodymovin;</script>\n${data.join("\n")}\n`;
}

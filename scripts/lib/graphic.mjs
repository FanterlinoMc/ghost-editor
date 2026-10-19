// Prompt Motion graphic (references/reel-json.md "Prompt Motion graphic", spec v3): the static sandbox rules (G1-G28,
// P1-P3), the wrapper page HyperFrames renders, and the cache key. The render itself is graphic-render.mjs (PM2).
// Nothing here is read by build.mjs yet (PM3 places graphics in reels): opt-in, existing reels are unchanged.
//
// The spec lives in two places only: REASONS here (every problem text, word for word) and
// scripts/graphic-rules/rules.json (every regex: the spec's single source of truth, read at load).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { scopes } from "../graphic-rules/rules.mjs";

export const RENDERER = "hyperframes@0.8.81";
export const KEY_VERSION = 3; // bumped when the wrapper / bridge / CSP / lock changes (it is in the cache key)
export const QUALITY = "looks";
export const LIMITS = {
  htmlBytes: 2097152, mediaBytes: 4194304, mediaFiles: 8, fileBytes: 52428800,
  minDuration: 0.5, maxDuration: 30, minWindow: 0.1, maxWindow: 60, minSize: 16, boxInside: 0.2,
};
export const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";

// ---------- THE reason table (spec v2: "Problems, word for word") ----------
export const REASONS = {
  G1: ({ html }) => `graphic html '${html}' is not assets/graphics/<name>.html inside the project`,
  G2: ({ html }) => `graphic file ${html} does not exist`,
  G3: ({ html, bytes }) => `graphic file ${html} is ${bytes} bytes (max 2097152)`,
  G4: ({ html }) => `graphic file ${html} is not a UTF-8 HTML document with one <head> and one <body>`,
  G5: ({ html }) => `graphic file ${html} loads a script file or has a typed script (<script src / href / xlink:href / type>): only plain inline scripts are allowed`,
  G6: ({ html }) => `graphic file ${html} has a <link> tag: put styles inline in <style>`,
  G7: ({ html }) => `graphic file ${html} uses @import, url(...) or image-set(...) with something other than a data: URI or a #fragment`,
  G8: ({ html, match }) => `graphic file ${html} uses ${match} (no network: fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon, import(), import.meta, workers, RTCPeerConnection)`,
  G9: ({ html, match }) => `graphic file ${html} uses ${match} (no eval, new Function or constructor tricks)`,
  G10: ({ html, match }) => `graphic file ${html} uses ${match} (no timers: seek(t) is the only clock)`,
  G11: ({ html, match }) => `graphic file ${html} reads the clock (${match}): use the t passed to seek(t)`,
  G12: ({ html }) => `graphic file ${html} calls Math.random: use window.rng(seed)`,
  G13: ({ html, match }) => `graphic file ${html} uses ${match} (no CSS animations, transitions, Web Animations or SVG animation: compute every style in seek(t))`,
  G14: ({ html, match }) => `graphic file ${html} has a ${match} element (no video, audio, iframe, object, embed, base, form or meta refresh)`,
  G15: ({ html, value }) => `graphic file ${html} refers to '${value}' (images must be data: URIs or assets/graphics/media/ files)`,
  G16: ({ path: p }) => `graphic media ${p} does not exist`,
  G16o: ({ path: p }) => `graphic media ${p} resolves outside assets/graphics/media/`,
  G17: ({ path: p, bytes }) => `graphic media ${p} is ${bytes} bytes (max 4194304)`,
  G17n: ({ html, n }) => `graphic file ${html} uses ${n} media files (max 8)`,
  G18: ({ html, name }) => `graphic file ${html} uses font family '${name}' (only the engine's fonts, a data: @font-face, var(--...), or a generic family)`,
  G19: ({ html, match }) => `graphic file ${html} uses a library (${match}): no GSAP or any other animation, 3D, chart or UI library; write plain seek(t) code`,
  G20: ({ html }) => `graphic file ${html} asks for a WebGL/WebGPU context (only canvas 2d)`,
  G21: ({ html }) => `graphic file ${html} does not define window.seek(t)`,
  G22: ({ html }) => `graphic file ${html} does not set window.duration to a number literal from 0.5 to 30`,
  G23: ({ W, H }) => `graphic size must be window.size = { w: <even int>, h: <even int> } within 16..${W} x 16..${H}`,
  G24: ({ W, H, w, h }) => `an insert graphic must be ${W}x${H} (window.size is ${w}x${h})`,
  G25: ({ html, match }) => `graphic file ${html} uses ${match} (no storage, navigation, window access or environment reads)`,
  G26: ({ html }) => `graphic file ${html} redefines window.rng (copy the engine snippet as is)`,
  G27: ({ html, match }) => `graphic file ${html} has a link that leaves the page (${match}): <a>/<area> href must be a #fragment; no ping, no formaction`,
  G28: ({ html, match }) => `graphic file ${html} builds a name from pieces (${match}): write property names out in full`,
  G29: ({ html, match }) => `graphic file ${html} has an event-handler attribute (${match}): no on...= attributes; everything runs from seek(t)`,
  G30: ({ html }) => `graphic file ${html} has an HTML comment (<!--): use /* */ inside <style> and <script> instead`,
  G31: ({ html, match }) => `graphic file ${html} has a backslash escape in CSS (${match}): write CSS without escapes`,
  G32: ({ html, match }) => `graphic file ${html} has an end tag written as ${match}: write </script>, </style> and </title> exactly`,
  G33: ({ html, match }) => `graphic file ${html} uses a script URL (${match})`,
  G34: ({ html, match }) => `graphic file ${html} has ${match} (no math, noscript, xmp, noembed, noframes, plaintext, textarea or template elements, and no <script> or <style> inside <svg>)`,
  G35: ({ html, match }) => `graphic file ${html} starts a ${match} inside another tag (a < inside an attribute value)`,
  P1: ({ v }) => `graphic mode '${v}' is not overlay or insert`,
  P2: ({ s }) => `graphic window ${s}s is outside 0.1..60s`,
  P3: ({ W, H }) => `graphic box shows less than 20% inside the ${W}x${H} canvas`,
  R1: ({ url }) => `graphic tried to load ${url} (no network): render refused`,
  R2: ({ message }) => `graphic page error: ${message}`,
  R3: () => `window.seek is not a function after the page loaded`,
  R4: ({ t, message }) => `seek(${t}) threw: ${message}`,
  R4p: ({ t }) => `seek(${t}) returned a Promise (it must be synchronous)`,
  R5: ({ a, b }) => `window.duration / window.size changed at load (static ${a}, at load ${b})`,
  R6: ({ i, t }) => `frame ${i} (t=${t}s) differs between two renders (not deterministic)`,
  R6n: ({ a, b }) => `the two renders have ${a} and ${b} frames`,
  R6L: ({ a, L }) => `the two renders have ${a} and ${L} frames`,
  R6o: ({ k, t }) => `frame ${k} (t=${t}s) depends on the seeks before it (not deterministic)`,
  R7: ({ s, L, b }) => `render took ${s}s for ${L} frames (budget ${b}s)`,
  R8: ({ bytes }) => `rendered file is ${bytes} bytes (max 52428800)`,
  R9: () => `every frame is fully transparent`,
  R10: ({ code, line }) => `hyperframes render failed (exit ${code}): ${line}`,
  R11: () => `graphic navigated away from its page: render refused`,
  R12: ({ url }) => `network lock is not in place (${url} was reachable from the render browser): graphic renders refused`,
  R12n: ({ message }) => `network lock probe could not run: ${message}`,
  R13: ({ v, k }) => `the render used Chrome ${v}, the cache key says ${k}: nothing cached`,
  GW1: ({ v, duration }) => `graphic in ${v}s is outside 0..${duration}s, clamped`,
  GW2: ({ a, b }) => `graphic after cut: shortened from ${a}s to ${b}s (the graphic's length)`,
  GW3: ({ v }) => `graphic after '${v}' is not hold, loop or cut, using hold`,
  GW4: () => `graphic box is ignored for an insert (full frame)`,
  GW5: () => `graphic audio is ignored (graphics are silent)`,
  GW6: () => `graphic fps is ignored (the reel's fps is used)`,
  GW7: ({ platform }) => `graphic box crosses the ${platform} UI zone`, // platform: the DISPLAY name (safezone PLATFORMS[p].name)
  GW8: () => `graphic src is ignored on a layer (a layer is in output seconds; the graphic file is html)`,
};
export const reason = (code, args = {}) => REASONS[code](args);
// how a problem is worded in a reel (spec): a layer dies, a beat is dropped with a warning
export const layerProblem = (layerId, html, r) => `layer ${layerId}: graphic ${html}: ${r}`;
export const beatProblem = (beatIdOrAt, html, r) => `graphic ${beatIdOrAt}: ${html}: ${r}, dropped`;

// ---------- THE regex source: scripts/graphic-rules/rules.json (spec v3: the single source of truth) ----------
// Every regex (G5-G28 listing, scopes, unicode spaces, G18 font sources, G21-G23/G26 literal assignments) is read from
// it at load; nothing is retyped here. graphic.test.mjs runs staticFirst() on its cases.json (parity with rules.mjs/.py).
export const RULES_JSON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "graphic-rules", "rules.json");
const J = JSON.parse(fs.readFileSync(RULES_JSON, "utf8"));
export const RULES = J.rules; // [id, [scopes], flags, source]
const rx = ([src, fl], g = false) => new RegExp(src, fl + (g ? "g" : ""));
export const SRC_RE = /^assets\/graphics\/[a-z0-9-]{1,48}\.html$/;
export const MEDIA_RE = /^assets\/graphics\/media\/[a-z0-9-]{1,48}\.(png|jpe?g|webp)$/;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/i;
// the scopes (WHOLE, SCRIPT, STYLE, MARKUP, insideTag for G35): the spec's own single-pass tokenizer, reused from
// scripts/graphic-rules/rules.mjs (not reimplemented), after its newline and unicode-space normalisation
export { scopes };

// every [tag, attr, value] in MARKUP whose value G15 checks
export function imageRefs(markup) {
  const out = [];
  const tagRe = /<([A-Za-z][A-Za-z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const attrRe = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const m of markup.matchAll(tagRe)) {
    const tag = m[1].toLowerCase();
    for (const a of m[2].matchAll(attrRe)) {
      const name = a[1].toLowerCase();
      const value = a[3] ?? a[4] ?? a[5] ?? "";
      if (["src", "srcset", "poster"].includes(name) || ((tag === "image" || tag === "use") && (name === "href" || name === "xlink:href"))) out.push({ tag, attr: name, value });
    }
  }
  return out;
}

// ---------- G18, the font rule ----------
export const familyList = (v) => v.replace(/!important/i, "").split(",").map((x) => x.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim()).filter(Boolean);
const afterSize = (v) => { const m = v.match(rx(J.fonts.size)); return m ? m[1] : v; };
// -> { bad: the first family not allowed (or null), engine: the engine families used (canonical names, sorted) }
export function checkFonts(S) {
  const F = J.fonts;
  const declared = new Set([...S.STYLE.matchAll(rx(F.face, true))].flatMap((m) => familyList(m[1])).map((x) => x.toLowerCase()));
  const engineLc = new Map(F.engine.map((f) => [f.toLowerCase(), f]));
  const generic = new Set(F.generic.map((x) => x.toLowerCase()));
  const lists = [
    ...[...S.STYLE.matchAll(rx(F.css, true))].map((m) => m[1]),
    ...[...S.STYLE.matchAll(rx(F.short, true))].map((m) => afterSize(m[1])),
    ...[...S.MARKUP.matchAll(rx(F.svg, true))].map((m) => m[1] ?? m[2]),
    ...[...S.SCRIPT.matchAll(rx(F.jsFam, true))].map((m) => m[2]),
    ...[...S.SCRIPT.matchAll(rx(F.jsFont, true))].map((m) => afterSize(m[2])),
  ];
  const engine = new Set();
  for (const l of lists) for (const f of familyList(l)) {
    const lc = f.toLowerCase();
    if (declared.has(lc) || generic.has(lc) || /^var\(/i.test(f)) continue;
    if (engineLc.has(lc)) { engine.add(engineLc.get(lc)); continue; }
    return { bad: f, engine: [] };
  }
  return { bad: null, engine: [...engine].sort() };
}

// ---------- the static checks that need only the text (G5-G14, G18-G23, G25-G28) ----------
// The first failure in table order as { code, scope?, match?, name?, size? }, or null. `stage` splits the run around
// the checks that need the file system / placement (G15-G17 after G14, G24 after G23), which inspectGraphic inserts.
export function staticChecks(S, { W = 1080, H = 1920 } = {}, stage = "all") {
  const M = J.meta, s = S.SCRIPT;
  const regexHit = (from, to) => {
    for (const [id, sc, fl, src] of J.rules) {
      const n = +id.slice(1);
      if (n < from || n > to) continue;
      for (const k of sc) { const m = S[k].match(new RegExp(src, fl)); if (m) return { code: id, scope: k, match: m[0] }; }
    }
    return null;
  };
  const count = (r) => (s.match(rx(r, true)) || []).length;
  const out = {};
  const A = [() => regexHit(5, 14)];
  const B = [
    () => { const f = checkFonts(S); out.fonts = f.engine; return f.bad === null ? null : { code: "G18", name: f.bad }; },
    () => regexHit(19, 20),
    () => (rx(M.G21).test(s) ? null : { code: "G21" }),
    () => { const lit = [...s.matchAll(rx(M.G22lit, true))]; if (count(M.G22all) === 1 && lit.length === 1 && +lit[0][1] >= 0.5 && +lit[0][1] <= 30) { out.duration = +lit[0][1]; return null; } return { code: "G22" }; },
    () => { const all = count(M.G23all), lit = [...s.matchAll(rx(M.G23lit, true))];
      const ok = all <= 1 && all === lit.length && lit.every((m) => !(+m[1] % 2) && !(+m[2] % 2) && +m[1] >= 16 && +m[1] <= W && +m[2] >= 16 && +m[2] <= H);
      if (ok) out.size = lit.length ? { w: +lit[0][1], h: +lit[0][2] } : { w: W, h: H };
      return ok ? null : { code: "G23" }; },
  ];
  const C = [() => regexHit(25, 25), () => (rx(M.G26).test(s) ? { code: "G26" } : null), () => regexHit(27, 34),
    () => (S.insideTag ? { code: "G35", match: S.insideTag } : null)];
  const list = stage === "A" ? A : stage === "B" ? B : stage === "C" ? C : [...A, ...B, ...C];
  for (const c of list) { const r = c(); if (r) return { ...r, out }; }
  return { code: null, out };
}
// rules.mjs's format ("Gn:<SCOPE>:<match>" / "G18:<family>" / "Gn"), for the cases.json parity check
export function staticFirst(html, opts) {
  const r = staticChecks(scopes(html), opts);
  if (!r.code) return null;
  if (r.code === "G18") return `G18:${JSON.stringify(r.name)}`;
  if (r.code === "G35") return `G35:${JSON.stringify(r.match)}`;
  return r.scope ? `${r.code}:${r.scope}:${JSON.stringify(r.match)}` : r.code;
}

// ---------- inspectGraphic ----------
// content: the file's text or bytes (null: read <projectDir>/<html>). opts: { html (the reel.json field: the path
// assets/graphics/<name>.html), projectDir, W, H, mode, mediaRoot }.
// Returns { ok, reasons: [the FIRST failing check's text] or [], codes, meta: { duration, size, fonts, media } }.
// meta.size is the DESIGN size ({w,h}, the reel canvas when the file sets none); meta.fonts the engine families it
// uses (sorted; the wrapper inlines them and the key carries them); meta.media [{ path, abs, bytes }] in order of first
// appearance. Without a project (and no mediaRoot) G16 and the media sizes are skipped, never the count (v3.1).
export function inspectGraphic(content, opts = {}) {
  const { html = "assets/graphics/graphic.html", projectDir = null, W = 1080, H = 1920, mode = "overlay" } = opts;
  const meta = { duration: null, size: null, fonts: [], media: [] };
  const fail = (code, args = {}) => ({ ok: false, reasons: [reason(code, { html, W, H, ...args })], codes: [code], meta });
  const failS = (r) => fail(r.code, r.code === "G18" ? { name: r.name } : { match: r.match });
  let root = null;
  if (projectDir) {
    root = path.resolve(projectDir);
    const abs = path.resolve(root, String(html));
    if (typeof html !== "string" || !SRC_RE.test(html) || path.dirname(abs) !== path.join(root, "assets", "graphics")) return fail("G1");
    if (content == null) { if (!fs.existsSync(abs)) return fail("G2"); content = fs.readFileSync(abs); }
  } else if (content == null) throw new Error("inspectGraphic: content or projectDir is required");
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (bytes.length > LIMITS.htmlBytes) return fail("G3", { bytes: bytes.length });
  let text = null;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
  if (text === null || (text.match(/<head\b/gi) || []).length !== 1 || (text.match(/<body\b/gi) || []).length !== 1) return fail("G4");
  const S = scopes(text);
  let r = staticChecks(S, { W, H }, "A");
  if (r.code) return failS(r);
  // G15 - G17 (v3.1): values as written; srcset whole; distinct media paths in order of first appearance
  const media = [];
  for (const { tag, value } of imageRefs(S.MARKUP)) {
    if (DATA_IMAGE_RE.test(value) || (tag === "use" && value.startsWith("#"))) continue;
    if (MEDIA_RE.test(value)) { if (!media.includes(value)) media.push(value); continue; }
    return fail("G15", { value });
  }
  const base = root || (opts.mediaRoot ? path.resolve(opts.mediaRoot) : null);
  const files = media.map((p) => ({ path: p, abs: null, bytes: null }));
  if (base) {
    const mdir = path.join(base, "assets", "graphics", "media");
    for (const f of files) {
      const abs = path.resolve(base, f.path);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return fail("G16", { path: f.path });
      const real = fs.realpathSync(abs);
      if (!real.startsWith(fs.realpathSync(mdir) + path.sep)) return fail("G16o", { path: f.path });
      f.abs = real; f.bytes = fs.statSync(real).size;
    }
    for (const f of files) if (f.bytes > LIMITS.mediaBytes) return fail("G17", { path: f.path, bytes: f.bytes });
  }
  if (files.length > LIMITS.mediaFiles) return fail("G17n", { n: files.length });
  meta.media = files;
  r = staticChecks(S, { W, H }, "B");
  if (r.code) return failS(r);
  Object.assign(meta, { duration: r.out.duration, size: r.out.size, fonts: r.out.fonts });
  if (mode === "insert" && (meta.size.w !== W || meta.size.h !== H)) return fail("G24", { w: meta.size.w, h: meta.size.h });
  r = staticChecks(S, { W, H }, "C");
  if (r.code) return failS(r);
  return { ok: true, reasons: [], codes: [], meta };
}

// ---------- placement problems (P1-P3, static on the reel.json entry; first failing one) ----------
// { mode, window (seconds: dur, or to - at), box {x,y,w,h} } on a W x H canvas -> reasons[] (0 or 1)
export function checkPlacement({ mode = "overlay", window: win, box } = {}, { W = 1080, H = 1920 } = {}) {
  if (mode !== "overlay" && mode !== "insert") return [reason("P1", { v: mode })];
  if (win !== undefined && !(Number.isFinite(win) && win >= LIMITS.minWindow && win <= LIMITS.maxWindow)) return [reason("P2", { s: win })];
  if (mode === "overlay" && box && [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0) {
    const iw = Math.max(0, Math.min(box.x + box.w, W) - Math.max(box.x, 0));
    const ih = Math.max(0, Math.min(box.y + box.h, H) - Math.max(box.y, 0));
    if ((iw * ih) / (box.w * box.h) < LIMITS.boxInside) return [reason("P3", { W, H })];
  }
  return [];
}

// ---------- frames ----------
// duration (s), fps, inS (s), after, frames (L wanted; default the whole graphic from in) -> { L, inF, D, after, warnings }
export function graphicFrames({ duration, fps = 30, inS = 0, after = "hold", frames } = {}) {
  const warnings = [];
  const D = Math.round(duration * fps);
  if (!["hold", "loop", "cut"].includes(after)) { warnings.push(reason("GW3", { v: after })); after = "hold"; }
  if (!(inS >= 0 && inS < duration)) { warnings.push(reason("GW1", { v: inS, duration })); inS = Math.min(Math.max(Number(inS) || 0, 0), duration - 1 / fps); }
  const inF = Math.min(Math.round(inS * fps), D - 1);
  let L = frames ?? D - inF;
  if (after === "cut" && L > D - inF) { warnings.push(reason("GW2", { a: +(L / fps).toFixed(3), b: +((D - inF) / fps).toFixed(3) })); L = D - inF; }
  return { L, inF, D, after, warnings };
}
// which graphic frame wrapper frame j shows (the bridge does the same in the page)
export const mapFrame = (j, { inF, D, after }) => { const k = inF + j; return after === "loop" ? k % D : Math.min(k, D - 1); };

// ---------- cache key (v2) ----------
// canonical JSON = Python json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
const asciiJson = (s) => JSON.stringify(s).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
export const canonicalJson = (v) => Array.isArray(v) ? `[${v.map(canonicalJson).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${asciiJson(k)}:${canonicalJson(v[k])}`).join(",")}}` : typeof v === "string" ? asciiJson(v) : JSON.stringify(v);
export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
export const platformTag = (p = process.platform, a = process.arch) => `${p}-${a}`;
// html: bytes or text; media: [[path, sha256 hex]]; fonts: engine families; w, h: the RENDERED size; chrome, ffmpeg: versions
export function graphicKey({ html, media = [], fonts = [], chrome, ffmpeg, quality = QUALITY, platform = platformTag(), fps, w, h, mode, frames, inF = 0, after = "hold" }) {
  for (const [k, v] of Object.entries({ fps, w, h, frames, inF })) if (!Number.isInteger(v)) throw new Error(`graphicKey: ${k} must be an integer (got ${v})`);
  if (!chrome || !ffmpeg) throw new Error("graphicKey: chrome and ffmpeg versions are required");
  const obj = {
    v: KEY_VERSION, html: sha256(Buffer.isBuffer(html) ? html : Buffer.from(String(html), "utf8")),
    media: [...media].map(([p, s]) => [p, s]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    fonts: [...fonts].sort(), renderer: RENDERER, chrome, ffmpeg, quality, platform, fps, w, h, mode, frames, in: inF, after,
  };
  const json = canonicalJson(obj);
  return { key: sha256(Buffer.from(json, "utf8")), json };
}
export const renderedSize = (meta, mode, W, H) => (mode === "insert" ? { w: W, h: H } : { ...meta.size });
export const graphicName = (html) => path.basename(html).replace(/\.html$/i, "");
export const outputName = (name, key, mode) => `${name}-${key.slice(0, 16)}.${mode === "insert" ? "mp4" : "webm"}`;


// ---------- the wrapper page ----------
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "fonts");
// the same naming and unicode ranges as build.mjs's @font-face loop (kept in step by graphic.test.mjs)
export const FONT_NAMES = { "instrument-serif": "Instrument Serif", "caveat-brush": "Caveat Brush", "yellowtail": "Yellowtail", "eb-garamond": "EB Garamond", "playfair-display": "Playfair Display", "jetbrains-mono": "JetBrains Mono", "geist-mono": "GeistMono" };
export const RANGES = {
  latin: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  cyrillic: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
  "latin-ext": "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
};
export function fontFaceCss(families, fontDir = FONT_DIR) {
  const want = new Set(families);
  const files = fs.readdirSync(fontDir).filter((f) => /-(latin-ext|latin|cyrillic)(-italic)?\.woff2$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const m = /^(.*)-(latin-ext|latin|cyrillic)(-italic)?\.woff2$/.exec(f);
    const fam = FONT_NAMES[m[1]] || m[1].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    if (!want.has(fam)) continue;
    const b64 = fs.readFileSync(path.join(fontDir, f)).toString("base64");
    out.push(`@font-face { font-family: "${fam}"; src: url(data:font/woff2;base64,${b64}) format("woff2"); font-weight: 100 900;${m[3] ? " font-style: italic;" : ""} unicode-range: ${RANGES[m[2]]}; }`);
  }
  return out.join("\n");
}
// the engine's seeded random, defined before the graphic's scripts (spec: the same mulberry32 the templates carry)
export const RNG_SNIPPET = `window.rng = function (seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0; var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};`;
export const REFUSED = "GRAPHIC-REFUSED: ";
const fmtT = (t) => String(+t.toFixed(3));
// The bridge, in two parts around the graphic. preScript runs BEFORE any graphic script (it is placed ahead of the
// graphic's <head>): it keeps the page's own console.error, addEventListener and Math functions in a closure, installs
// the navigate trap and the hf-seek listener first (so a graphic can neither silence the refusals by stubbing
// console.error, nor register a navigate listener ahead of the trap, nor navigate before it exists), and exposes the
// refusal function as a non-writable, non-configurable window.__graphicRefuse for postScript. HyperFrames dispatches
// window "hf-seek" with detail.time = j / fps; the listener maps j to the graphic's frame k and calls window.seek(k / fps).
// Problems go to the saved console.error (HyperFrames prints them as [Browser:ERROR] ...), once per page.
export const ORDER_SAMPLES = 8;
export function preScript({ fps, L, inF, D, after }) {
  return `(function () {
  var err = console.error.bind(console), add = EventTarget.prototype.addEventListener, round = Math.round, min = Math.min;
  var toFixed = Number.prototype.toFixed, split = String.prototype.split, Str = String;
  var getById = Document.prototype.getElementById, qsa = Document.prototype.querySelectorAll, getAttr = Element.prototype.getAttribute;
  var innerGet = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML").get, toURL = HTMLCanvasElement.prototype.toDataURL;
  var checked = false, SAMPLES = ${ORDER_SAMPLES};
  var FPS = ${fps}, L = ${L}, IN = ${inF}, D = ${D}, AFTER = ${JSON.stringify(after)}, said = false, R = ${JSON.stringify(REFUSED)};
  function refuse(m) { if (!said) { said = true; err(R + m); } }
  function fmt(t) { try { return Str(+toFixed.call(t, 3)); } catch (x) { return "?"; } }
  function msg(x) { try { return split.call(Str(x && x.message !== undefined ? x.message : x), "\\n")[0]; } catch (y) { return "(unreadable error)"; } }
  Object.defineProperty(window, "__graphicRefuse", { value: refuse, writable: false, configurable: false, enumerable: false });
  // R11 navigation trap. Not pagehide/beforeunload: measured, pagehide also fires when HyperFrames closes the page at
  // the end of a NORMAL render. The Navigation API's navigate event fires only for navigations the page starts
  // (location =, link clicks, form submits, refreshes) and is cancelled here.
  if (window.navigation) add.call(window.navigation, "navigate", function (e) { err(R + "navigated"); if (e.cancelable) e.preventDefault(); });
  else refuse("navigation trap unavailable (no window.navigation)");
  // R6 at any length: the seek-order check. On the first hf-seek (HyperFrames has waited for fonts and media by
  // then), seek a sample of frames forward, backward and shuffled, snapshot the page after each (the root's markup with
  // every inline style, the html/body style attributes, every canvas's pixels) and refuse if a frame's snapshot depends
  // on the order: state carried between seeks. Two renders alone miss it when HyperFrames uses one worker for both.
  // Every native it uses was saved above, before any graphic script ran.
  function snap() {
    var out = innerGet.call(getById.call(document, "graphic-root")) + "\u0000" + (getAttr.call(document.documentElement, "style") || "") + "\u0000" + (getAttr.call(document.body, "style") || "");
    var cs = qsa.call(document, "canvas");
    for (var i = 0; i < cs.length; i++) { try { out += "\u0000" + toURL.call(cs[i]); } catch (x) { out += "\u0000(unreadable canvas)"; } }
    return out;
  }
  function orderCheck() {
    var n = min(D, SAMPLES), ks = [], i, o, k;
    for (i = 0; i < n; i++) ks[i] = n === 1 ? 0 : round(i * (D - 1) / (n - 1));
    var fwd = [], back = [], mix = [];
    for (i = 0; i < n; i++) { fwd[i] = ks[i]; back[i] = ks[n - 1 - i]; mix[i] = ks[i]; }
    var a = 2463534242;
    for (i = n - 1; i > 0; i--) { a = (a * 1103515245 + 12345) % 2147483648; var j = a % (i + 1), tmp = mix[i]; mix[i] = mix[j]; mix[j] = tmp; }
    var orders = [fwd, back, mix], snaps = [{}, {}, {}];
    for (o = 0; o < 3; o++) for (i = 0; i < n; i++) {
      k = orders[o][i];
      try { window.seek(k / FPS); } catch (x) { refuse("seek(" + fmt(k / FPS) + ") threw: " + msg(x)); return; }
      snaps[o][k] = snap();
    }
    for (i = 0; i < n; i++) { k = ks[i]; if (snaps[0][k] !== snaps[1][k] || snaps[0][k] !== snaps[2][k]) { refuse("seek order: frame " + k + " (t=" + fmt(k / FPS) + "s) depends on the seeks before it"); return; } }
  }
  add.call(window, "hf-seek", function (e) {
    if (!checked) { checked = true; if (typeof window.seek === "function") orderCheck(); }
    var j = round(e.detail.time * FPS); if (j < 0) j = 0; if (j > L - 1) j = L - 1;
    var k = IN + j; k = AFTER === "loop" ? k % D : min(k, D - 1);
    var t = k / FPS;
    if (typeof window.seek !== "function") { refuse("window.seek is not a function"); return; }
    try {
      var r = window.seek(t);
      if (r && typeof r.then === "function") refuse("seek(" + fmt(t) + ") returned a Promise");
    } catch (x) { refuse("seek(" + fmt(t) + ") threw: " + msg(x)); }
  });
})();`;
}
// postScript runs after the graphic's body: the load-time checks (R5 duration/size, R3 seek), through __graphicRefuse
export function postScript({ duration, size }) {
  return `(function () {
  var refuse = window.__graphicRefuse;
  var sz = window.size && typeof window.size === "object" ? window.size.w + "x" + window.size.h : "${size.w}x${size.h}";
  var a = "${duration}s ${size.w}x${size.h}", b = window.duration + "s " + sz;
  if (a !== b) refuse("window.duration / window.size changed at load (static " + a + ", at load " + b + ")");
  if (typeof window.seek !== "function") refuse("window.seek is not a function");
})();`;
}
const headOf = (html) => (/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html) || [, ""])[1];
const bodyOf = (html) => { const m = /<body\b[^>]*>([\s\S]*?)(<\/body\s*>|$)/i.exec(html); return m ? m[1].replace(/<\/html\s*>\s*$/i, "") : ""; };
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
// inline each assets/graphics/media/ file named in a markup attribute as a data: URI
export function inlineMedia(text, media) {
  let out = text;
  for (const { path: p, abs } of media) {
    if (!abs) throw new Error(`inlineMedia: ${p} has no file`);
    const uri = `data:${MIME[p.split(".").pop().toLowerCase()]};base64,${fs.readFileSync(abs).toString("base64")}`;
    out = out.replace(new RegExp(`(=\\s*["']?)${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=["'\\s>])`, "g"), `$1${uri}`);
  }
  return out;
}
// The wrapper HTML for one render: { html (graphic text), meta (inspectGraphic), mode, fps, L, inF, D, after, W, H }
export function wrapperHtml({ html, meta, mode = "overlay", fps = 30, L, inF = 0, D, after = "hold", W = 1080, H = 1920, fontDir }) {
  const text = Buffer.isBuffer(html) ? html.toString("utf8") : String(html);
  const { w, h } = renderedSize(meta, mode, W, H);
  const src = inlineMedia(text, meta.media);
  const bg = mode === "insert" ? "#000" : "transparent";
  const dur = +(L / fps).toFixed(6);
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
${fontFaceCss(meta.fonts, fontDir)}
html, body { margin: 0; padding: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: ${bg}; }
#graphic-root { position: relative; width: ${w}px; height: ${h}px; overflow: hidden; background: ${bg}; }
</style>
<script>
${preScript({ fps, L, inF, D, after })}
${RNG_SNIPPET}
</script>
${headOf(src)}
</head>
<body>
<div id="graphic-root" data-composition-id="graphic" data-width="${w}" data-height="${h}" data-start="0" data-duration="${dur}" data-no-timeline>
${bodyOf(src)}
</div>
<script>
${postScript({ duration: meta.duration, size: meta.size })}
</script>
</body></html>
`;
}
// writes <buildDir>/graphics/<id>-<key16>/index.html; returns { dir, file }
export function wrapGraphic({ buildDir, id, key, ...rest }) {
  const dir = path.join(buildDir, "graphics", `${id}-${key.slice(0, 16)}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, wrapperHtml(rest));
  return { dir, file };
}
export { fmtT };


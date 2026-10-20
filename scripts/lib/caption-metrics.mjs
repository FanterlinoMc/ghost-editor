// The drawn extent of a caption block, for the placer (safezone.mjs place(t0, t1, h)): how far the box reaches above
// and below its CSS `top`, computed from the font file and the CSS the build writes - no browser at build time.
//
// Why (mac-45): the placer used to reserve `size x 1.3` for every caption block. Broadsheet's "clipping" block is a
// box (padding 6px top + 12px bottom) around Gloock at line-height 1.08, tilted by `rotate` on an outer group that is
// also translateX(-50%)'d: drawn, a one-line block is 80.64 px of box plus up to (width + 20) x sin(tilt) more below
// its top, ~91 px for B1's cg7 (a 3-word line) against the 75 px reserved, so a lower-face block ran 15 px into the platform's
// bottom UI band (pixel check PX11 on a real close-up reel). Measured in Chrome, the model below matches to < 1 px.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fontTable } from "./font-coverage.mjs";

const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "fonts");

// cmap (format 4 / 12, Unicode subtables) -> glyph id of one code point, 0 when unmapped. Engine fonts only (trusted).
function glyphOf(cmap, cp) {
  const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const pid = cmap.readUInt16BE(4 + 8 * i), eid = cmap.readUInt16BE(6 + 8 * i), off = cmap.readUInt32BE(8 + 8 * i);
    if (!(pid === 0 || (pid === 3 && (eid === 1 || eid === 10)))) continue;
    const f = cmap.readUInt16BE(off);
    if (f === 4 && cp <= 0xffff) {
      const segX2 = cmap.readUInt16BE(off + 6), ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ros = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        if (cp > cmap.readUInt16BE(ends + 2 * s)) continue;
        const start = cmap.readUInt16BE(starts + 2 * s);
        if (cp < start) break;
        const delta = cmap.readInt16BE(deltas + 2 * s), ro = cmap.readUInt16BE(ros + 2 * s);
        if (!ro) return (cp + delta) & 0xffff;
        const g = cmap.readUInt16BE(ros + 2 * s + ro + 2 * (cp - start));
        return g ? (g + delta) & 0xffff : 0;
      }
    } else if (f === 12) {
      const groups = cmap.readUInt32BE(off + 12);
      for (let g = 0; g < groups; g++) {
        const p = off + 16 + 12 * g, a = cmap.readUInt32BE(p), b = cmap.readUInt32BE(p + 4);
        if (cp >= a && cp <= b) return cmap.readUInt32BE(p + 8) + (cp - a);
      }
    }
  }
  return 0;
}

// one face file -> advance(cp) in em, or null when the face has no glyph for cp
function face(file) {
  const buf = fs.readFileSync(path.join(FONTS, file));
  const cmap = fontTable(buf, "cmap"), head = fontTable(buf, "head"), hhea = fontTable(buf, "hhea"), hmtx = fontTable(buf, "hmtx");
  const upm = head.readUInt16BE(18), nh = hhea.readUInt16BE(34);
  return (cp) => {
    const g = glyphOf(cmap, cp);
    if (!g) return null;
    return hmtx.readUInt16BE(4 * Math.min(g, nh - 1)) / upm;
  };
}

const cache = new Map();
// an emoji no caption face covers falls back to the colour emoji font, drawn ~1.2 em wide (Chrome, Apple Color Emoji:
// "😂😂😂 lol 🔥🔥" at 58 px). 1.25 em keeps the model at or over it; other uncovered text keeps `fallbackEm` (0.6 em
// measured on the safe side for Arabic, which falls back to Noto Sans Arabic)
const PICTO = /\p{Extended_Pictographic}/u, EMOJI_EM = 1.25;
// a family's faces in @font-face order (latin, then latin-ext: the unicode-ranges do not overlap); the em advance of a
// code point no face covers (the browser falls back to Noto Sans Arabic / Georgia) is `fallbackEm`, an emoji's EMOJI_EM
function family(files, fallbackEm) {
  const k = files.join("|");
  if (!cache.has(k)) {
    const faces = files.map(face), memo = new Map();
    cache.set(k, (cp) => {
      if (!memo.has(cp)) { let a = null; for (const f of faces) { a = f(cp); if (a != null) break; } memo.set(cp, a ?? (PICTO.test(String.fromCodePoint(cp)) ? EMOJI_EM : fallbackEm)); }
      return memo.get(cp);
    });
  }
  return cache.get(k);
}

// Width in px of `text` set in a family at `size` px with `letterSpacing` em after every character (Chrome adds it after
// each one, the last included). Advances only: no kerning (GPOS), which Gloock applies as small negative pairs, so the
// estimate runs at or over the drawn width (measured on a real reel's 12 blocks: +3..+23 px, 1-3%) - the safe side for
// the tilt term, and a wrap only ever comes a little early, never late.
export function textWidth(text, size, { files, fallbackEm = 0.6, letterSpacing = 0 }) {
  const adv = family(files, fallbackEm);
  let em = 0;
  for (const ch of text) em += adv(ch.codePointAt(0)) + letterSpacing;
  return em * size;
}

// Greedy line breaking at the break opportunities the markup and UAX #14 allow: between word spans (<wbr>, no space
// characters) and on either side of an emoji inside a word (emoji are line-break class ID: Chrome wraps a long emoji
// run mid-span). Each word is `wordPad` em wider for its side margins (half each side); -> line widths in px. Mirrors
// CSS for a width: max-content box clamped by max-width: a line breaks before a piece that would push it past
// maxWidth; a single over-long piece stays.
export function wrapLines(words, size, maxWidth, opts) {
  const pad = (opts.wordPad ?? 0) * size / 2, pieces = [];
  for (const w of words) {
    const parts = w.split(/(\p{Extended_Pictographic}️?)/u).filter(Boolean);
    if (!parts.length) { pieces.push(2 * pad); continue; }
    parts.forEach((t, i) => pieces.push(textWidth(t, size, opts) + (i === 0 ? pad : 0) + (i === parts.length - 1 ? pad : 0)));
  }
  const lines = [];
  let cur = 0;
  for (const pw of pieces) {
    if (cur > 0 && cur + pw > maxWidth) { lines.push(cur); cur = pw; } else cur += pw;
  }
  if (cur > 0 || !lines.length) lines.push(cur);
  return lines;
}

// How far a box drawn by an element of `w` x `h` (outer group, origin at its centre unless `scale` < 1, which sets
// transform-origin 50% 0) reaches above (`up`) and below (`down`) the element's CSS top, after
// `transform: translateX(-50%) [scale(s)]` and the `rotate: <deg>` property (CSS applies rotate after transform,
// about the same origin). `padX`: the drawn box is wider than the element by padX each side (Broadsheet's inner
// .cap-in: margin 0 -20px). Corners only: the box is a rectangle, so its axis-aligned extent is at a corner.
export function drawnExtent({ w, h, deg = 0, scale = 1, padX = 0 }) {
  const th = (deg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const ox = w / 2, oy = scale < 1 ? 0 : h / 2;
  let lo = Infinity, hi = -Infinity;
  for (const x of [-padX, w + padX]) for (const y of [0, h]) {
    // transform (translateX(-50%) then scale, about the origin), then rotate, about the origin
    const tx = (x - ox) * scale - w / 2, ty = (y - oy) * scale;
    const ry = oy + tx * s + ty * c;
    lo = Math.min(lo, ry); hi = Math.max(hi, ry);
  }
  return { up: Math.max(0, -lo), down: hi };
}

// Broadsheet's "clipping" block (build.mjs: .cap-group Gloock / line-height 1.08 / letter-spacing -0.01em, words with
// margin 0 0.12em; inner .cap-in padding 6px 20px 12px, margin 0 -20px; tilt as `rotate` on the outer group).
// -> { up, down, h: up + down, lines, w }: the band [top - up, top + down] the drawn box covers.
export const CLIPPING = { files: ["gloock-latin.woff2", "gloock-latin-ext.woff2"], fallbackEm: 0.6, letterSpacing: -0.01, wordPad: 0.24, lineHeight: 1.08, padTop: 6, padBottom: 12, padX: 20 };
export function clippingExtent(words, { size, maxWidth, deg = 0, scale = 1 }) {
  const m = CLIPPING;
  const lines = wrapLines(words, size, maxWidth, m);
  const w = Math.min(maxWidth, Math.max(...lines));
  const h = lines.length * size * m.lineHeight + m.padTop + m.padBottom;
  const { up, down } = drawnExtent({ w, h, deg, scale, padX: m.padX });
  return { up, down, h: up + down, lines: lines.length, w };
}

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
// An emoji no caption face covers is drawn by whatever the OS has, so its advance differs by platform. EMOJI_EM is an
// upper bound over all of them (measured or published, 1 em = the caption's font-size; mac-45 follow-up):
//   Apple Color Emoji (macOS, Chrome 152, measured)                1.000 em
//   Noto Color Emoji (Linux/Android; published, 2550/2048 = 1.245)  ~1.275 em
//   Segoe UI Emoji (Windows; from the PC's real-Chrome test, +108.2 px over 5 emoji at 58 px vs the Mac) ~1.373 em
//   no emoji font (the Linux server): Chrome draws the .notdef box of the primary font - Gloock 0.565 em,
//   Noto Sans Arabic 0.600 em (hmtx glyph 0); Apple's LastResort, the macOS last resort, measured 1.000 em
// 1.5 em clears the widest (Segoe) by 0.127 em (7 px a glyph at 58 px). Regional indicators (a flag is two) and
// skin-tone modifiers count as emoji too: Segoe draws a regional indicator as its own boxed letter, and a tofu
// server draws each as a box. A constant, never this machine's font, so a build is the same on every OS; the
// real-Chrome test checks it bounds the drawn width on whichever OS runs it. Other uncovered text keeps
// `fallbackEm` (0.6 em, measured on the safe side for Arabic, which falls back to Noto Sans Arabic).
export const EMOJI_EM = 1.5;
const PICTO = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/u;
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

// One emoji as Chrome shapes it: a ZWJ sequence (👨‍👩‍👧), a flag (two regional indicators), a skin-tone or VS16 variant -
// one unit, never broken inside. Its width is still the sum of its code points' (an over-estimate, the safe side).
const EMOJI_UNIT = /(\p{Regional_Indicator}{1,2}|\p{Extended_Pictographic}[️⃣\p{Emoji_Modifier}]*(?:‍\p{Extended_Pictographic}[️⃣\p{Emoji_Modifier}]*)*|\p{Emoji_Modifier})/u;
// a word's unbreakable pieces: the text between emoji, and each emoji unit
export const wordPieces = (w) => w.split(EMOJI_UNIT).filter(Boolean);

// Line breaking -> line widths in px, for a width: max-content box clamped by max-width. Break opportunities: between
// word spans (<wbr>, no space characters) and around an emoji inside a word (line-break class ID). Each word is
// `wordPad` em wider for its side margins (half each side); a single over-long piece stays on its own line.
// The count is an UPPER bound over how Chromes break a word that holds an emoji run (mac-45 CP5: Windows Chrome put
// "to be 😂 x 22" on 4 lines where greedy packing gives 3), so two policies run and the one with more lines wins:
//   packed: greedy over every piece (the run starts on the line before it, as macOS Chrome does)
//   whole:  a word that does not fit the rest of the line starts a new one; if it is wider than a line it is then
//           split greedily at its own pieces (the run moves down first, then wraps, as Windows Chrome did)
// A word without emoji is one piece, so both policies agree on every plain-text caption.
export function wrapLines(words, size, maxWidth, opts) {
  const pad = (opts.wordPad ?? 0) * size / 2;
  const ws = words.map((w) => {
    const parts = wordPieces(w);
    if (!parts.length) return [2 * pad];
    return parts.map((t, i) => textWidth(t, size, opts) + (i === 0 ? pad : 0) + (i === parts.length - 1 ? pad : 0));
  });
  const run = (whole) => {
    const lines = [];
    let cur = 0;
    const put = (pw) => { if (cur > 0 && cur + pw > maxWidth) { lines.push(cur); cur = pw; } else cur += pw; };
    for (const ps of ws) {
      const ww = ps.reduce((x, y) => x + y, 0);
      if (!whole || ps.length === 1 || cur + ww <= maxWidth) { ps.forEach(put); continue; }
      if (cur > 0) { lines.push(cur); cur = 0; }
      ps.forEach(put);
    }
    if (cur > 0 || !lines.length) lines.push(cur);
    return lines;
  };
  const packed = run(false), whole = run(true);
  return whole.length > packed.length ? whole : packed;
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
  // the group is width: max-content clamped by max-width, so a block that wraps is max-width wide (Chrome: 820 px on a
  // 2- and a 3-line block whose longest line is ~640), not its longest line: the tilt term uses that width
  const w = lines.length > 1 ? maxWidth : Math.min(maxWidth, lines[0]);
  const h = lines.length * size * m.lineHeight + m.padTop + m.padBottom;
  const { up, down } = drawnExtent({ w, h, deg, scale, padX: m.padX });
  return { up, down, h: up + down, lines: lines.length, w };
}

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
function family(files, fallbackEm, emojiEm = EMOJI_EM) {
  const k = files.join("|") + `|${fallbackEm}|${emojiEm}`;
  if (!cache.has(k)) {
    const faces = files.map(face), memo = new Map();
    cache.set(k, (cp) => {
      if (!memo.has(cp)) { let a = null; for (const f of faces) { a = f(cp); if (a != null) break; } memo.set(cp, a ?? (PICTO.test(String.fromCodePoint(cp)) ? emojiEm : fallbackEm)); }
      return memo.get(cp);
    });
  }
  return cache.get(k);
}

// Width in px of `text` set in a family at `size` px with `letterSpacing` em after every character (Chrome adds it after
// each one, the last included). Advances only: no kerning (GPOS), which Gloock applies as small negative pairs, so the
// estimate runs at or over the drawn width (measured on a real reel's 12 blocks: +3..+23 px, 1-3%) - the safe side for
// the tilt term, and a wrap only ever comes a little early, never late.
// `emojiEm` overrides EMOJI_EM (tests only: modelling one platform's real emoji advance; builds never pass it).
export function textWidth(text, size, { files, fallbackEm = 0.6, letterSpacing = 0, emojiEm = EMOJI_EM }) {
  const adv = family(files, fallbackEm, emojiEm);
  let em = 0;
  for (const ch of text) em += adv(ch.codePointAt(0)) + letterSpacing;
  return em * size;
}

// One emoji as Chrome shapes it: a ZWJ sequence (👨‍👩‍👧), a flag (two regional indicators), a skin-tone or VS16 variant -
// one unit, never broken inside. Its width is still the sum of its code points' (an over-estimate, the safe side).
const EMOJI_UNIT = /(\p{Regional_Indicator}{1,2}|\p{Extended_Pictographic}[️⃣\p{Emoji_Modifier}]*(?:‍\p{Extended_Pictographic}[️⃣\p{Emoji_Modifier}]*)*|\p{Emoji_Modifier})/u;
// a word's unbreakable pieces: the text between emoji, and each emoji unit - with the punctuation UAX #14 forbids a
// break beside glued on: opening punctuation / quotes (OP, QU: "(", "[", "{", "“", "‘", "«", "¿", "¡", '"', "'") to the
// emoji after them, closing ones (CL, CP, EX, IS, QU: ")", "]", "}", "”", "’", "»", "!", "?", ",", ".", ":", ";", "…",
// '"', "'") to the emoji before them. "(😂)" is one piece: Chrome never breaks between "(" and the emoji.
const OPEN = /[(\[{“‘«¿¡"']+$/u, CLOSE = /^[)\]}”’»!?,.:;…"']+/u;
export const wordPieces = (w) => {
  const parts = w.split(EMOJI_UNIT).filter(Boolean);
  const emoji = (t) => EMOJI_UNIT.test(t) && t.replace(EMOJI_UNIT, "") === "";
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    let t = parts[i];
    if (!emoji(t)) { out.push(t); continue; }
    const prev = out.length && !emoji(out[out.length - 1]) ? out[out.length - 1].match(OPEN) : null;
    if (prev) { out[out.length - 1] = out[out.length - 1].slice(0, -prev[0].length); if (!out[out.length - 1]) out.pop(); t = prev[0] + t; }
    const next = i + 1 < parts.length && !emoji(parts[i + 1]) ? parts[i + 1].match(CLOSE) : null;
    if (next) { t += next[0]; parts[i + 1] = parts[i + 1].slice(next[0].length); }
    out.push(t);
  }
  return out.filter(Boolean);
};

// Line breaking -> line widths in px, for a width: max-content box clamped by max-width. Each word is `wordPad` em
// wider for its side margins (half each side). Between words (<wbr>) Chrome can always break. INSIDE a word that holds
// emoji, where it can break is not something the model can know: it depends on Chrome's ICU line-break data, not on
// UAX #14 alone (Chrome 152 breaks between 😂😂 but never between ✨✨, 💯💯, ⭐⭐, ✅✅, ❌❌ or ⚡⚡, and between 😂 and ✨
// it does), and on Windows "to be 😂 x 22" took 4 lines where greedy packing gives 3 (mac-45 CP5). So the count is the
// WORST over every set of break opportunities inside such words: the adversary may glue any run of consecutive
// pieces into one unbreakable chunk, and Chrome then fills each line greedily (it breaks at the last opportunity that
// fits; a chunk wider than a line overflows on its own line). Exact by dynamic programming over (piece, line start).
// The pieces (wordPieces) are only ever split where Chrome may break or finer, which keeps it an upper bound; glued
// punctuation just trims choices Chrome never has. A word without emoji is one piece: no choice, plain greedy, so
// every plain-text caption counts exactly as before.
export const EXACT_PIECES = 64;
export function wrapLines(words, size, maxWidth, opts) {
  const pad = (opts.wordPad ?? 0) * size / 2;
  // mac-48: every caption word is its own `display: inline-block` span (build.mjs `.w`). Chrome never breaks a word that
  // fits on a line: it is atomic, and the line between words fills greedily. A word WIDER than a line wraps inside its
  // own box, and that box is as wide as the line, so the word sits alone on its lines and the next word starts a new
  // line. (The old model let the next word share the wrapped word's last line: 2 of 420 random groups drawn a line
  // taller than modelled with Noto Color Emoji, the server's font; 1 of 420 with Segoe.)
  const ws = words.map((w) => {
    const parts = wordPieces(w);
    if (!parts.length) return [2 * pad];
    return parts.map((t, i) => textWidth(t, size, opts) + (i === 0 ? pad : 0) + (i === parts.length - 1 ? pad : 0));
  });
  // lines a too-wide word takes inside its box (content width maxWidth - 2 x pad, its margins outside): the WORST over
  // every set of break opportunities inside it (where Chrome can break inside a word that holds emoji is ICU data, see
  // above), each line filled greedily. Exact by dynamic programming over (piece, line start); above EXACT_PIECES pieces a
  // bound that holds for ANY chunking: two consecutive lines always hold more than the width together, so
  // k <= 2 x ceil(total / width) - 1.
  const innerLines = (ps) => {
    const inner = ps.map((x, i) => x - (i === 0 ? pad : 0) - (i === ps.length - 1 ? pad : 0)), wid = maxWidth - 2 * pad;
    const n = inner.length, tot = inner.reduce((x, y) => x + y, 0);
    if (n > (opts.exactPieces ?? EXACT_PIECES)) return Math.max(1, 2 * Math.ceil(tot / wid) - 1);
    const pre = [0]; inner.forEach((x) => pre.push(pre[pre.length - 1] + x));
    const memo = new Map();
    const best = (i, s) => {   // most breaks still to come: next chunk starts at piece i, the line holds pieces s..i-1
      if (i >= n) return 0;
      const k = i * (n + 1) + s;
      if (memo.has(k)) return memo.get(k);
      let r = 0;
      for (let j = i + 1; j <= n; j++) {
        const c = pre[j] - pre[i], cur = pre[i] - pre[s];
        r = Math.max(r, cur > 0 && cur + c > wid ? 1 + best(j, i) : best(j, s));
      }
      memo.set(k, r);
      return r;
    };
    return 1 + best(0, 0);
  };
  let lines = 0, cur = 0, total = 0;   // lines finished so far; the width used on the open line (0: none open)
  for (const ps of ws) {
    const w = ps.reduce((x, y) => x + y, 0);
    total += w;
    if (w <= maxWidth) {
      if (cur > 0 && cur + w > maxWidth) { lines++; cur = 0; }
      cur += w;
      continue;
    }
    if (cur > 0) { lines++; cur = 0; }   // the line-wide box cannot share a line
    lines += innerLines(ps);
  }
  if (cur > 0) lines++;
  lines = Math.max(1, lines);
  return lines === 1 ? [total] : Array(lines).fill(maxWidth);
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
export function clippingExtent(words, { size, maxWidth, deg = 0, scale = 1, emojiEm, exactPieces }) {
  const m = emojiEm || exactPieces != null ? { ...CLIPPING, emojiEm: emojiEm ?? EMOJI_EM, exactPieces } : CLIPPING;
  const lines = wrapLines(words, size, maxWidth, m);
  // the group is width: max-content clamped by max-width, so a block that wraps is max-width wide (Chrome: 820 px on a
  // 2- and a 3-line block whose longest line is ~640), not its longest line: the tilt term uses that width
  const w = lines.length > 1 ? maxWidth : Math.min(maxWidth, lines[0]);
  const h = lines.length * size * m.lineHeight + m.padTop + m.padBottom;
  const { up, down } = drawnExtent({ w, h, deg, scale, padX: m.padX });
  return { up, down, h: up + down, lines: lines.length, w };
}

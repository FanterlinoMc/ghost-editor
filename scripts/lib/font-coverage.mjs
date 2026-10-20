// Glyph coverage of a font file (R14, references/reel-json.md "Prompt Motion graphic"): the code points its cmap maps
// to a glyph, as sorted, merged inclusive ranges [[a, b], ...]. Reads raw sfnt (TrueType / OpenType), WOFF (zlib per
// table) and WOFF2 (one brotli stream; cmap is never transformed) with Node's own zlib: no dependency.
// Used for the engine's fonts (templates/fonts/*.woff2, each face clipped to its @font-face unicode-range, as the
// browser does) and for a graphic's own data: @font-face fonts.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const tag = (b, o) => b.toString("latin1", o, o + 4);
// Limits (a graphic's data: font is untrusted input): over any of them the font is TOO LARGE and covers nothing
// (fontRanges throws FontLimit; declaredCoverage turns that into []). Nothing here allocates per code point, so the
// work is bounded by the input and these caps, never by the ranges a cmap claims.
export const LIMITS = { inputBytes: 16 << 20, decompressedBytes: 16 << 20, tables: 512, subtables: 64, ranges: 1 << 17, steps: 1 << 21 };
export class FontLimit extends Error {}
const over = (what) => { throw new FontLimit(`font over the ${what} limit`); };
// WOFF2's known-table index (spec 5.2); only cmap (0), glyf (10) and loca (11) matter here
const W2TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];

// -> the cmap table's bytes, or throws
export const cmapTable = (buf) => fontTable(buf, "cmap");
// -> the bytes of table `want` ("cmap", "hmtx", "head", ...), or throws. WOFF2's transformed tables (glyf/loca, and a
// transformed hmtx) are refused: reading them needs the reconstruction this parser does not do.
export function fontTable(buf, want) {
  if (buf.length > LIMITS.inputBytes) over("input size");
  const sig = tag(buf, 0);
  if (sig === "wOF2") {
    const numTables = buf.readUInt16BE(12), compLen = buf.readUInt32BE(20);
    if (numTables > LIMITS.tables) over("table count");
    let o = 48;
    const b128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const x = buf[o++]; v = v * 128 + (x & 0x7f); if (!(x & 0x80)) return v; } throw new Error("bad UIntBase128"); };
    const dir = [];
    for (let i = 0; i < numTables; i++) {
      const flags = buf[o++];
      const t = (flags & 0x3f) === 63 ? (o += 4, tag(buf, o - 4)) : W2TAGS[flags & 0x3f];
      const ver = flags >> 6, orig = b128();
      const transformed = t === "glyf" || t === "loca" ? ver !== 3 : ver !== 0;
      const len = transformed ? b128() : orig;
      dir.push({ t, len, transformed });
    }
    let data;
    try { data = zlib.brotliDecompressSync(buf.subarray(o, o + compLen), { maxOutputLength: LIMITS.decompressedBytes }); } catch (e) { if (e && e.code === "ERR_BUFFER_TOO_LARGE") over("decompressed size"); throw e; }
    let off = 0;
    for (const d of dir) {
      if (d.t === want) { if (d.transformed) throw new Error(`${want} is transformed`); return data.subarray(off, off + d.len); }
      off += d.len;
    }
    throw new Error(`no ${want}`);
  }
  if (sig === "wOFF") {
    const n = buf.readUInt16BE(12);
    if (n > LIMITS.tables) over("table count");
    for (let i = 0; i < n; i++) {
      const e = 44 + 20 * i;
      if (tag(buf, e) !== want) continue;
      const off = buf.readUInt32BE(e + 4), comp = buf.readUInt32BE(e + 8), orig = buf.readUInt32BE(e + 12);
      const raw = buf.subarray(off, off + comp);
      if (comp >= orig) return raw;
      try { return zlib.inflateSync(raw, { maxOutputLength: LIMITS.decompressedBytes }); } catch (e) { if (e && e.code === "ERR_BUFFER_TOO_LARGE") over("decompressed size"); throw e; }
    }
    throw new Error(`no ${want}`);
  }
  if (buf.readUInt32BE(0) === 0x00010000 || sig === "OTTO" || sig === "true") {
    const n = buf.readUInt16BE(4);
    if (n > LIMITS.tables) over("table count");
    for (let i = 0; i < n; i++) {
      const e = 12 + 16 * i;
      if (tag(buf, e) === want) { const off = buf.readUInt32BE(e + 8); return buf.subarray(off, off + buf.readUInt32BE(e + 12)); }
    }
    throw new Error(`no ${want}`);
  }
  throw new Error(`not a font (signature ${JSON.stringify(sig)})`);
}

export function mergeRanges(rs) {
  const s = rs.filter((r) => r[0] <= r[1]).map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of s) { const l = out[out.length - 1]; if (l && r[0] <= l[1] + 1) l[1] = Math.max(l[1], r[1]); else out.push(r); }
  return out;
}
export function intersectRanges(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (lo <= hi) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}
export const covers = (ranges, cp) => { let lo = 0, hi = ranges.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (cp < ranges[m][0]) hi = m - 1; else if (cp > ranges[m][1]) lo = m + 1; else return true; } return false; };

// the Unicode subtables (platform 0, or 3 with encoding 1 / 10), formats 4, 12, 13, 6, 0; glyph 0 (.notdef) is no glyph.
// Ranges are pushed per segment / group (format 4 with idRangeOffset 0 splits only around the ONE code point whose
// glyph wraps to 0); per-code-point work (format 4 glyph arrays, format 6) counts against LIMITS.steps.
export function cmapRanges(cmap) {
  const n = cmap.readUInt16BE(2), out = [];
  if (n > LIMITS.subtables) over("subtable count");
  let steps = 0;
  const push = (a, b) => { if (out.length >= LIMITS.ranges) over("range count"); out.push([a, b]); };
  const step = (k) => { steps += k; if (steps > LIMITS.steps) over("work"); };
  for (let i = 0; i < n; i++) {
    const pid = cmap.readUInt16BE(4 + 8 * i), eid = cmap.readUInt16BE(6 + 8 * i), off = cmap.readUInt32BE(8 + 8 * i);
    if (!(pid === 0 || (pid === 3 && (eid === 1 || eid === 10)))) continue;
    const f = cmap.readUInt16BE(off);
    if (f === 4) {
      const segX2 = cmap.readUInt16BE(off + 6), ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ros = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        step(1);
        const end = cmap.readUInt16BE(ends + 2 * s), start = cmap.readUInt16BE(starts + 2 * s);
        const delta = cmap.readInt16BE(deltas + 2 * s), ro = cmap.readUInt16BE(ros + 2 * s);
        if (start === 0xffff || start > end) continue;
        if (ro === 0) {
          const zero = (0x10000 - (delta & 0xffff)) & 0xffff; // the one c with (c + delta) & 0xffff === 0
          if (zero >= start && zero <= end) { if (zero > start) push(start, zero - 1); if (zero < end) push(zero + 1, end); }
          else push(start, end);
        } else {
          step(end - start + 1);
          let runA = -1;
          for (let c = start; c <= end; c++) {
            const at = ros + 2 * s + ro + 2 * (c - start);
            const g = at + 2 <= cmap.length ? cmap.readUInt16BE(at) : 0;
            const has = g !== 0 && ((g + delta) & 0xffff) !== 0;
            if (has && runA < 0) runA = c;
            if (!has && runA >= 0) { push(runA, c - 1); runA = -1; }
          }
          if (runA >= 0) push(runA, end);
        }
      }
    } else if (f === 12 || f === 13) {
      const groups = cmap.readUInt32BE(off + 12);
      if (off + 16 + 12 * groups > cmap.length) throw new Error("cmap groups past the table");
      for (let g = 0; g < groups; g++) {
        const p = off + 16 + 12 * g, a = cmap.readUInt32BE(p), b = Math.min(cmap.readUInt32BE(p + 4), 0x10ffff), gid = cmap.readUInt32BE(p + 8);
        if (f === 13 && gid === 0) continue;
        if (a > b) continue;
        push(f === 12 && gid === 0 ? a + 1 : a, b);
      }
    } else if (f === 6) {
      const first = cmap.readUInt16BE(off + 6), cnt = cmap.readUInt16BE(off + 8);
      step(cnt);
      for (let k = 0; k < cnt; k++) if (cmap.readUInt16BE(off + 10 + 2 * k)) push(first + k, first + k);
    } else if (f === 0) {
      for (let k = 0; k < 256; k++) if (cmap[off + 6 + k]) push(k, k);
    }
  }
  return mergeRanges(out);
}
export const fontRanges = (buf) => cmapRanges(cmapTable(buf));

// "U+0000-00FF, U+0131, U+4??" -> ranges
export function parseUnicodeRange(s) {
  const out = [];
  for (const part of String(s).split(",")) {
    const m = /^\s*U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!m) continue;
    if (m[1].includes("?")) out.push([parseInt(m[1].replace(/\?/g, "0"), 16), parseInt(m[1].replace(/\?/g, "f"), 16)]);
    else out.push([parseInt(m[1], 16), parseInt(m[2] || m[1], 16)]);
  }
  return mergeRanges(out);
}

// ---------- the engine's fonts ----------
// family -> ranges: the union over the family's faces (normal and italic) of (cmap ∩ the face's unicode-range).
// facesOf(fontDir) yields { family, file, range } exactly as graphic.mjs's fontFaceCss writes its @font-face rules.
const cache = new Map();
export function familyCoverage(faces) {
  const by = new Map();
  for (const { family, file, range } of faces) {
    const k = `${file}\0${range}`;
    if (!cache.has(k)) cache.set(k, intersectRanges(fontRanges(fs.readFileSync(file)), parseUnicodeRange(range)));
    by.set(family, mergeRanges([...(by.get(family) || []), ...cache.get(k)]));
  }
  return by;
}

// a graphic's own data: @font-face rules (in its STYLE text) -> family (lower case) -> ranges. A face whose data
// cannot be read as a font covers nothing (its text then needs the engine's repertoire).
export function declaredCoverage(style) {
  const out = new Map();
  for (const m of String(style).matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = m[1];
    const fam = /(?<![\w-])font-family\s*:\s*([^;}]*)/i.exec(body);
    if (!fam) continue;
    const name = fam[1].trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim().toLowerCase();
    let ranges = [];
    for (const u of body.matchAll(/url\(\s*['"]?data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)['"]?\s*\)/gi)) {
      try { ranges = mergeRanges([...ranges, ...fontRanges(Buffer.from(u[1].replace(/\s+/g, ""), "base64"))]); } catch {}
    }
    const ur = /(?<![\w-])unicode-range\s*:\s*([^;}]*)/i.exec(body);
    if (ur) ranges = intersectRanges(ranges, parseUnicodeRange(ur[1]));
    out.set(name, mergeRanges([...(out.get(name) || []), ...ranges]));
  }
  return out;
}
// ranges -> the flat [a0, b0, a1, b1, ...] the bridge binary-searches
export const flat = (ranges) => ranges.flat();
export const fontFile = (dir, f) => path.join(dir, f);

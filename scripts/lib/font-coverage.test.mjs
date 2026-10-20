// node --test scripts/lib/font-coverage.test.mjs
// R14's coverage source: the cmap of the engine's woff2 fonts (brotli), of WOFF 1.0 (zlib) and raw sfnt files (a
// graphic's own data: @font-face), clipped to unicode-range; the engine repertoire; G36's ranges outside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as C from "./font-coverage.mjs";
import * as G from "./graphic.mjs";
import { tinyFont } from "./graphic-fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FONTS = path.join(here, "..", "..", "templates", "fonts");
const cps = (s) => [...s].map((c) => c.codePointAt(0));

test("woff2: the engine's fonts parse; Inter latin has é, —, “ ” and €, no emoji, no arrow →", () => {
  const r = C.fontRanges(fs.readFileSync(path.join(FONTS, "inter-latin.woff2")));
  for (const c of cps("Aaé—“”€™½")) assert.ok(C.covers(r, c), `U+${c.toString(16)}`);
  for (const c of cps("👋🚀✅→▶")) assert.ok(!C.covers(r, c), `U+${c.toString(16)} must not be covered`);
  // every bundled face parses and has the basic Latin letters (cyrillic / latin-ext faces: their own letters)
  for (const f of fs.readdirSync(FONTS).filter((x) => x.endsWith(".woff2"))) {
    const fr = C.fontRanges(fs.readFileSync(path.join(FONTS, f)));
    assert.ok(fr.length > 0, f);
    if (/-latin(-italic)?\.woff2$/.test(f)) assert.ok(C.covers(fr, 0x41) && C.covers(fr, 0x7a), f);
    if (/-cyrillic/.test(f)) assert.ok(C.covers(fr, 0x41f), f);
  }
});

test("ttf / woff 1.0 / cmap formats 4 and 12; not a font throws", () => {
  const want = [[0x41, 0x5a], [0xe9, 0xe9], [0x1f44b, 0x1f44b]];
  assert.deepEqual(C.fontRanges(tinyFont(want)), want);
  assert.deepEqual(C.fontRanges(tinyFont(want, { woff: true })), want);
  assert.deepEqual(C.fontRanges(tinyFont([[0x41, 0x5a], [0xe9, 0xe9]], { format: 4 })), [[0x41, 0x5a], [0xe9, 0xe9]]);
  assert.throws(() => C.fontRanges(Buffer.from("hello world, not a font")), /not a font/);
});

test("ranges: merge, intersect, unicode-range (with ?), covers", () => {
  assert.deepEqual(C.mergeRanges([[5, 9], [1, 3], [4, 4], [20, 30], [25, 26]]), [[1, 9], [20, 30]]);
  assert.deepEqual(C.intersectRanges([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]]);
  assert.deepEqual(C.parseUnicodeRange("U+0000-00FF, U+0131, U+4??"), [[0, 0xff], [0x131, 0x131], [0x400, 0x4ff]]);
  assert.ok(C.covers([[1, 3], [10, 12]], 11) && !C.covers([[1, 3], [10, 12]], 5) && !C.covers([], 1));
});

test("a face is clipped to its unicode-range (as the browser does); the engine repertoire", () => {
  const faces = G.engineFaces(FONTS);
  const cov = C.familyCoverage(faces.filter((f) => f.family === "Inter"));
  const inter = cov.get("Inter");
  assert.ok(C.covers(inter, 0xe9) && C.covers(inter, 0x41f) && C.covers(inter, 0x141), "latin, cyrillic, latin-ext faces");
  const rep = G.engineRepertoire(FONTS);
  for (const c of cps("é—–“”€™½ПŁ↑·")) assert.ok(C.covers(rep, c), `U+${c.toString(16)} in the repertoire`);
  for (const c of cps("👋🚀✅❤→▶⭐⌚")) assert.ok(!C.covers(rep, c), `U+${c.toString(16)} not in the repertoire`);
});

test("G36 ∩ coverage = ∅ (every engine face and the Arabic face, from the cmaps); rules.json is what gen-glyphs gives", async () => {
  const J = JSON.parse(fs.readFileSync(G.RULES_JSON, "utf8"));
  const cov = C.mergeRanges([...G.engineRepertoire(FONTS), ...G.arabicCoverage(FONTS)]);
  assert.deepEqual(C.intersectRanges(cov, C.mergeRanges(J.glyphs.G36)), []);
  const { g36Ranges } = await import("../graphic-rules/gen-glyphs.mjs");
  assert.deepEqual(J.glyphs.G36, g36Ranges(), "rules.json glyphs.G36 is stale: run node scripts/graphic-rules/gen-glyphs.mjs");
  // the arrow / math blocks: uncovered ones in, covered ones out
  const inG36 = (c) => C.covers(J.glyphs.G36, c);
  for (const c of cps("→←↗⇒≤≥≠≈∞√")) assert.ok(inG36(c), `U+${c.toString(16)} in G36`);
  for (const c of cps("↑↓−∕")) assert.ok(!inG36(c), `U+${c.toString(16)} allowed`);
  for (const c of cps("🫶🪄🫡")) assert.ok(inG36(c));
  assert.equal(J.glyphs.G36.at(-1)[1], 0x1fbff);
});

test("Arabic: the bundled Noto Sans Arabic (OFL) covers Arabic letters; not part of the engine repertoire", () => {
  assert.match(fs.readFileSync(path.join(FONTS, "LICENSE-NotoSansArabic.txt"), "utf8"), /SIL Open Font License, Version 1\.1/);
  const ar = G.arabicCoverage(FONTS);
  for (const c of cps("مرحبا بالعالم ١٢٣")) if (c !== 32) assert.ok(C.covers(ar, c), `U+${c.toString(16)}`);
  assert.ok(!C.covers(G.engineRepertoire(FONTS), 0x645));
});

// a font whose cmap is given as raw bytes (for the hostile cases)
const sfntWith = (cmap) => { const h = Buffer.alloc(28); h.writeUInt32BE(0x00010000, 0); h.writeUInt16BE(1, 4); h.write("cmap", 12, "latin1"); h.writeUInt32BE(28, 20); h.writeUInt32BE(cmap.length, 24); return Buffer.concat([h, cmap]); };
// format 4: n segments [start, end] with idRangeOffset ro (0: idDelta 1), plus the final 0xFFFF one; ro > 0 points
// into a glyph array of `glyphs` ids
function fmt4(segs, { ro = 0, glyphs = 0, delta = 1 } = {}) {
  const all = [...segs, [0xffff, 0xffff]], n = all.length;
  const sub = Buffer.alloc(16 + 8 * n + 2 * glyphs, 0);
  sub.writeUInt16BE(4, 0); sub.writeUInt16BE(Math.min(sub.length, 0xffff), 2); sub.writeUInt16BE(2 * n, 6);
  all.forEach(([a, b], i) => {
    sub.writeUInt16BE(b, 14 + 2 * i); sub.writeUInt16BE(a, 16 + 2 * n + 2 * i);
    sub.writeInt16BE(i < n - 1 ? delta : 1, 16 + 4 * n + 2 * i);
    if (ro && i < n - 1) sub.writeUInt16BE(2 * (n - i), 16 + 6 * n + 2 * i); // -> the glyph array right after the table
  });
  for (let g = 0; g < glyphs; g++) sub.writeUInt16BE(7, 16 + 8 * n + 2 * g);
  return sfntWith(Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12]), sub]));
}
const bounded = (fn) => {
  global.gc?.();
  const h0 = process.memoryUsage().heapUsed, t0 = Date.now();
  const r = fn();
  return { r, ms: Date.now() - t0, mb: (process.memoryUsage().heapUsed - h0) / 1048576 };
};

test("hostile fonts: huge format-4 segments, glyph arrays, bombs, too many ranges: fast, bounded, never a crash", () => {
  // 600 segments over the whole BMP (the 4.8 KB font that OOM-crashed a 2 GB heap before): one range per segment
  const huge = fmt4(Array.from({ length: 600 }, () => [0, 0xfffe]));
  assert.ok(huge.length < 6000);
  const a = bounded(() => C.fontRanges(huge));
  assert.deepEqual(a.r, [[0, 0xfffe]]);
  assert.ok(a.ms < 1000 && a.mb < 64, `${a.ms} ms, ${a.mb.toFixed(1)} MB`);
  // the one code point whose glyph wraps to 0 ((c + idDelta) & 0xffff = 0) is split out
  assert.deepEqual(C.fontRanges(fmt4([[0x10, 0x20]], { delta: -0x15 })), [[0x10, 0x14], [0x16, 0x20]]);
  // glyph-array segments (idRangeOffset != 0): per-code-point work is capped, the font covers nothing
  const arr = fmt4(Array.from({ length: 200 }, () => [0, 0xfffe]), { ro: 1, glyphs: 4 });
  assert.throws(() => C.fontRanges(arr), C.FontLimit);
  // a small glyph-array segment still works
  assert.deepEqual(C.fontRanges(fmt4([[0x41, 0x44]], { ro: 1, glyphs: 4 })), [[0x41, 0x44]]);
  // decompression bombs: WOFF (zlib) and WOFF2 (brotli) that inflate to 64 MB
  const zeros = Buffer.alloc(64 << 20);
  const z = zlib.deflateSync(zeros), wh = Buffer.alloc(64);
  wh.write("wOFF", 0, "latin1"); wh.writeUInt16BE(1, 12); wh.write("cmap", 44, "latin1"); wh.writeUInt32BE(64, 48); wh.writeUInt32BE(z.length, 52); wh.writeUInt32BE(zeros.length, 56);
  const woffBomb = Buffer.concat([wh, z]);
  const br = zlib.brotliCompressSync(zeros), w2 = Buffer.alloc(48 + 1 + 5);
  w2.write("wOF2", 0, "latin1"); w2.writeUInt16BE(1, 12); w2.writeUInt32BE(br.length, 20);
  w2[48] = 0; // cmap, null transform; origLength as UIntBase128 (64 MB)
  let v = zeros.length, bytes = []; do { bytes.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v); bytes = bytes.map((x, i) => (i < bytes.length - 1 ? x | 0x80 : x));
  const woff2Bomb = Buffer.concat([w2.subarray(0, 49), Buffer.from(bytes), br]);
  zeros.fill(0, 0, 1);
  for (const bomb of [woffBomb, woff2Bomb]) {
    const b = bounded(() => assert.throws(() => C.fontRanges(bomb), C.FontLimit));
    assert.ok(b.ms < 2000, `${b.ms} ms`);
  }
  // too many ranges (format 12 groups) and too large an input
  const many = tinyFont(Array.from({ length: C.LIMITS.ranges + 1 }, (_, i) => [0x10000 + 2 * i, 0x10000 + 2 * i]));
  assert.throws(() => C.fontRanges(many), C.FontLimit);
  assert.throws(() => C.fontRanges(Buffer.alloc(C.LIMITS.inputBytes + 1)), C.FontLimit);
  // as a graphic's data: font: covers nothing, no throw
  const css = [huge, arr, woffBomb, woff2Bomb].map((f, i) => `@font-face { font-family: "Bad${i}"; src: url(data:font/ttf;base64,${f.toString("base64")}); }`).join("\n");
  const d = bounded(() => C.declaredCoverage(css));
  assert.deepEqual([...d.r.keys()], ["bad0", "bad1", "bad2", "bad3"]);
  assert.deepEqual(d.r.get("bad1"), []); assert.deepEqual(d.r.get("bad2"), []); assert.deepEqual(d.r.get("bad3"), []);
  assert.ok(d.ms < 3000, `${d.ms} ms`);
});

test("declaredCoverage: a graphic's own data: @font-face (woff / ttf), clipped by its unicode-range; junk covers nothing", () => {
  const b64 = (b) => b.toString("base64");
  const css = `@font-face { font-family: 'Emo'; src: url(data:font/woff;base64,${b64(tinyFont([[0x1f44b, 0x1f44b], [0x41, 0x5a]], { woff: true }))}) format("woff"); }
    @font-face { font-family: "Half"; src: url("data:font/ttf;base64,${b64(tinyFont([[0x41, 0x5a]]))}"); unicode-range: U+41-43; }
    @font-face { font-family: Junk; src: url(data:font/ttf;base64,aGVsbG8=); }`;
  const d = C.declaredCoverage(css);
  assert.deepEqual(d.get("emo"), [[0x41, 0x5a], [0x1f44b, 0x1f44b]]);
  assert.deepEqual(d.get("half"), [[0x41, 0x43]]);
  assert.deepEqual(d.get("junk"), []);
});

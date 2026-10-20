// node --test scripts/lib/font-coverage.test.mjs
// R14's coverage source: the cmap of the engine's woff2 fonts (brotli), of WOFF 1.0 (zlib) and raw sfnt files (a
// graphic's own data: @font-face), clipped to unicode-range; the engine repertoire; G36's ranges outside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

test("G36's ranges hold nothing any engine font has a glyph for (measured from the cmaps)", () => {
  const J = JSON.parse(fs.readFileSync(G.RULES_JSON, "utf8"));
  const rep = G.engineRepertoire(FONTS);
  assert.deepEqual(C.intersectRanges(rep, C.mergeRanges(J.glyphs.G36)), []);
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

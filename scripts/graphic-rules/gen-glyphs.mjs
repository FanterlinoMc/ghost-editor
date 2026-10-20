#!/usr/bin/env node
// Generates rules.json glyphs.G36 (v3.3) from the bundled fonts' coverage:
//   * the emoji / pictograph BLOCKS (BLOCKS below), which must hold no covered code point (else this fails), and
//   * in the arrow and math blocks (PARTIAL), exactly the code points NO engine font and not the Arabic face covers,
//     so covered ones (↑ ↓ − ∕ ...) stay allowed.
//   node scripts/graphic-rules/gen-glyphs.mjs           rewrite glyphs.G36 in rules.json (review the diff)
//   node scripts/graphic-rules/gen-glyphs.mjs --check   exit 1 if rules.json differs from what the fonts give
import fs from "node:fs";
import { RULES_JSON, engineRepertoire, arabicCoverage } from "../lib/graphic.mjs";
import { mergeRanges, intersectRanges } from "../lib/font-coverage.mjs";

export const BLOCKS = [[0x2300, 0x23ff], [0x25a0, 0x27bf], [0x2b00, 0x2bff], [0xfe0f, 0xfe0f], [0x1f000, 0x1fbff]];
export const PARTIAL = [[0x2190, 0x21ff], [0x2200, 0x22ff]];
export const coverage = () => mergeRanges([...engineRepertoire(), ...arabicCoverage()]);
// ranges minus the covered set
const minus = (rs, cov) => {
  const out = [];
  for (const [a, b] of rs) {
    let c = a;
    for (const [x, y] of cov) { if (y < c || x > b) continue; if (x > c) out.push([c, x - 1]); c = y + 1; if (c > b) break; }
    if (c <= b) out.push([c, b]);
  }
  return out;
};
export function g36Ranges() {
  const cov = coverage();
  const hit = intersectRanges(cov, mergeRanges(BLOCKS));
  if (hit.length) throw new Error(`a G36 block holds covered code points: ${JSON.stringify(hit)}`);
  return mergeRanges([...BLOCKS, ...minus(PARTIAL, cov)]);
}
if (process.argv[1] && process.argv[1].endsWith("gen-glyphs.mjs")) {
  const text = fs.readFileSync(RULES_JSON, "utf8");
  const J = JSON.parse(text);
  const want = g36Ranges();
  if (process.argv.includes("--check")) {
    const same = JSON.stringify(J.glyphs.G36) === JSON.stringify(want);
    console.log(same ? "G36 GLYPHS: UP TO DATE" : "G36 GLYPHS: STALE (run gen-glyphs.mjs)");
    process.exit(same ? 0 : 1);
  }
  J.glyphs.G36 = want;
  fs.writeFileSync(RULES_JSON, JSON.stringify(J, null, 2) + "\n");
  console.log(`G36: ${want.length} ranges written`);
}

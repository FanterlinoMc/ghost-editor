#!/usr/bin/env node
// Parity + expectation check for the Prompt Motion graphic static rules (spec v3, references/reel-json.md).
//   node scripts/graphic-rules/parity.mjs            compare node, Python (re.ASCII) and cases.json's expect
//   node scripts/graphic-rules/parity.mjs --record   write the node results into cases.json as expect (review the diff!)
// Python: $PYTHON, else py (Windows) / python3. Prints "PARITY: PASS" or "PARITY: FAIL" last; exit 1 on FAIL.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firstFail } from "./rules.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CASES = path.join(DIR, "cases.json");
const doc = JSON.parse(fs.readFileSync(CASES, "utf8"));
const js = Object.fromEntries(Object.entries(doc.cases).map(([k, c]) => [k, firstFail(c.html)]));
if (process.argv.includes("--record")) {
  for (const [k, c] of Object.entries(doc.cases)) c.expect = js[k];
  fs.writeFileSync(CASES, JSON.stringify(doc, null, 1) + "\n");
  console.log(`recorded ${Object.keys(js).length} expectations`);
  process.exit(0);
}
const py = process.env.PYTHON || (process.platform === "win32" ? "py" : "python3");
const r = spawnSync(py, [path.join(DIR, "rules.py"), CASES], { encoding: "utf8", maxBuffer: 1 << 26 });
if (r.status !== 0) { console.log(r.stderr || r.error); console.log("PARITY: FAIL"); process.exit(1); }
const pyOut = JSON.parse(r.stdout);
let bad = 0;
for (const [k, c] of Object.entries(doc.cases)) {
  const e = c.expect ?? null, a = js[k], b = pyOut[k] ?? null;
  if (a !== e || b !== e) { bad++; console.log(`DIFF ${k}: expect ${e} | node ${a} | python ${b}`); }
}
const n = Object.keys(doc.cases).length;
console.log(`${n} cases, ${n - bad} agree (node == python == expect), ${bad} differ`);
console.log(bad ? "PARITY: FAIL" : "PARITY: PASS");
process.exit(bad ? 1 : 0);

#!/usr/bin/env node
// Does every sound id resolve to a file? FAILS (exit 1, one line per id) when any id would play nothing.
//
//   node scripts/sfx_check.mjs [--json] [--pack <dir>]
//
// build.mjs plays a sound id from library/sfx/<manifest[id].file> and, when that file is absent, warns and skips it:
// a decorative miss must not kill a render. That is also how every reel shipped silent from 2 Oct without anyone
// noticing. This check is the loud side: run it where reels are made (after the pack is restored) and it is red
// until every id in library/sfx/manifest.json is playable. For each id that is not, it says why:
//   no pack category      the licensed pack has no sound of this kind (library/sfx/pack-map.json category null)
//   not mapped            a pack category is proposed but no pack file is named yet (packFile null)
//   not measured          the entry has duration null (an id record with no source: build.mjs never plays it)
//   file absent           mapped and measured, but library/sfx/<file> is not on this machine
//   pack file absent      (--pack <dir>, or PHANTASIC_PACK_DIR) the mapped raw wav is not in the pack copy at <dir>
// PHANTASIC_LIB points at another library root, as in build.mjs. Node built-ins only; reads only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// -> { ids, ok: [id], bad: [{ id, why }] }
export function check({ lib = path.join(ROOT, "library"), pack = null } = {}) {
  const man = readJson(path.join(lib, "sfx", "manifest.json"));
  const mapFile = path.join(lib, "sfx", "pack-map.json");
  const map = fs.existsSync(mapFile) ? readJson(mapFile).ids || {} : {};
  const ok = [], bad = [];
  for (const [id, m] of Object.entries(man)) {
    const p = map[id];
    const onDisk = !!m.file && fs.existsSync(path.join(lib, "sfx", m.file));
    let why = null;
    if (!p) why = "not in library/sfx/pack-map.json";
    else if (!p.packFile) why = p.category ? `not mapped: pack category "${p.category}" proposed (${p.proposal}), no pack file named yet` : "no pack category: the licensed pack has no sound of this kind (still needed)";
    else if (pack && !fs.existsSync(path.join(pack, p.packFile))) why = `pack file absent: ${p.packFile} is not in ${pack}`;
    else if (m.duration == null) why = `not measured: duration null (process ${p.packFile} into sfx/${m.file} and measure it, scripts/sfx_index.py)`;
    else if (!onDisk) why = `file absent: library/sfx/${m.file} (from ${p.packFile}) is not on this machine`;
    if (why) bad.push({ id, why }); else ok.push(id);
  }
  for (const id of Object.keys(map)) if (!man[id]) bad.push({ id, why: "in pack-map.json but not in library/sfx/manifest.json" });
  return { ids: Object.keys(man).length, ok, bad };
}

function main() {
  const argv = process.argv.slice(2);
  const lib = process.env.PHANTASIC_LIB ? path.resolve(process.env.PHANTASIC_LIB) : path.join(ROOT, "library");
  const pi = argv.indexOf("--pack");
  const pack = pi >= 0 ? path.resolve(argv[pi + 1] || ".") : process.env.PHANTASIC_PACK_DIR ? path.resolve(process.env.PHANTASIC_PACK_DIR) : null;
  const r = check({ lib, pack });
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(r) + "\n");
  else {
    for (const b of r.bad) console.error(`SFX UNRESOLVED ${b.id}: ${b.why}`);
    console.log(`sfx: ${r.ok.length} of ${r.ids} ids play a file; ${r.bad.length} unresolved${r.bad.length ? " (every reel that asks for them is silent there)" : ""}`);
  }
  process.exit(r.bad.length ? 1 : 0);
}

const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) main();

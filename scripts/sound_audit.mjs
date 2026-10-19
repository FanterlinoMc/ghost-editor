#!/usr/bin/env node
// What sound the styles ask for, and what this library can actually play. Reads only; never downloads anything.
//
//   node scripts/sound_audit.mjs --audit      sound ids that styles/ or brands/ name but neither manifest has,
//                                             each with the styles that use it and whether that style still builds
//   node scripts/sound_audit.mjs --coverage   every library/sfx and library/music manifest id, and whether its file is
//                                             on disk (the "sounds still missing" list for a machine or a container)
//
// The library's audio is never in git: see library/SOURCES.md for where sounds may come from (and why the Mixkit
// entries in the manifests are records only). PHANTASIC_LIB points at another library root, as in build.mjs.
// Node built-ins only; no npm packages.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStyleChain } from "./lib/style-path.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ---------- --audit: sound ids named by styles/brands that no manifest has ----------
const FAMILIES = new Set(["pop", "whoosh", "impact"]);   // build.mjs VARIANTS: a family name picks pop-1..3 etc.
const SKIP = new Set(["none", "auto", ""]);
// -> [{ kind: "sfx" | "music" | "pack", id, where }] for one parsed JSON
export function soundRefs(json) {
  const out = [];
  const add = (kind, id, where) => { if (typeof id === "string" && !SKIP.has(id)) out.push({ kind: id.startsWith("pack:") ? "pack" : kind, id, where }); };
  const walk = (v, trail) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...trail, i])); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      const t = [...trail, k], where = t.join(".");
      if (k === "music" && x && typeof x === "object") { add("music", x.id, `${where}.id`); add("music", x.fallback, `${where}.fallback`); }
      if (/sfx/i.test(k) && !/(db|every|profile)$/i.test(k)) {
        if (k === "sfxFallback" && x && typeof x === "object") for (const [a, b] of Object.entries(x)) { add("sfx", a, `${where} key`); add("sfx", b, `${where}.${a}`); }
        else for (const s of [].concat(x)) if (typeof s === "string") add("sfx", s, where);
      }
      if (trail.at(-1) === "drop" && ["riser", "boom", "tail"].includes(k)) add("sfx", x, where);
      if (x && typeof x === "object") walk(x, t);
    }
  };
  walk(json, []);
  return out;
}

// build.mjs's deepMerge: objects merge key by key, anything else replaces
const deepMerge = (a, b) => {
  if (b === undefined) return a;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const o = { ...a };
    for (const k of Object.keys(b)) o[k] = deepMerge(a[k], b[k]);
    return o;
  }
  return b;
};
// the style as build.mjs sees it (its `extends` chain merged); a brand kit or an unloadable file as written
const resolved = (root, rel, raw) => {
  const m = rel.match(/^styles\/((?:library\/)?[a-z0-9][a-z0-9-]*)\.json$/);
  if (!m) return raw;
  try { return loadStyleChain(m[1], { stylesDir: path.join(root, "styles"), deepMerge }).style; } catch { return raw; }
};

export function audit({ root = ROOT, lib = path.join(ROOT, "library") } = {}) {
  const sfx = readJson(path.join(lib, "sfx", "manifest.json")), music = readJson(path.join(lib, "music", "manifest.json"));
  const files = [];
  const walkDir = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkDir(p); else if (e.name.endsWith(".json")) files.push(p); } };
  for (const d of ["styles", "brands"]) if (fs.existsSync(path.join(root, d))) walkDir(path.join(root, d));
  const missing = new Map();   // "kind id" -> {kind, id, uses: [{style, where, verdict}]}
  for (const f of files.sort()) {
    let j; try { j = readJson(f); } catch { continue; }
    const style = path.relative(root, f).split(path.sep).join("/");
    const full = resolved(root, style, j);
    for (const r of soundRefs(full)) {   // the merged style: a child inherits its parent's sounds
      const known = r.kind === "music" ? !!music[r.id] : r.kind === "sfx" ? !!sfx[r.id] || FAMILIES.has(r.id) : false;
      if (known) continue;
      let verdict;
      if (r.kind === "sfx") {
        const fb = full.sfxFallback?.[r.id];
        verdict = fb && fb !== "none" && sfx[fb] ? `builds; plays sfxFallback "${fb}"` : "builds; the sound is skipped with a warning";
      } else if (r.kind === "pack") verdict = "builds; skipped with a warning unless PHANTASIC_SFX_PACK has the wav";
      else if (r.where.endsWith(".fallback")) verdict = "builds; a fallback that is not in the manifest is never used";
      else {
        // judged on the merged style: a parent's music.optional or fallback still applies
        const m = r.where.split(".").slice(0, -1).reduce((o, k) => o?.[k], full) || {};
        verdict = m.optional === true ? "builds without music (music.optional)"
          : m.fallback && music[m.fallback] ? `builds with fallback "${m.fallback}" once that bed is on disk`
          : "DOES NOT BUILD: buildMusic throws (no optional, no usable fallback)";
      }
      const key = `${r.kind} ${r.id}`;
      if (!missing.has(key)) missing.set(key, { kind: r.kind, id: r.id, uses: [] });
      missing.get(key).uses.push({ style, where: r.where, verdict });
    }
  }
  const packs = new Map();   // video/overlay packs a style switches on (library/packs/<name>/)
  for (const f of files) { let j; try { j = readJson(f); } catch { continue; } for (const [k, on] of Object.entries(j.packs || {})) if (on) { if (!packs.has(k)) packs.set(k, []); packs.get(k).push(path.relative(root, f).split(path.sep).join("/")); } }
  return { missing: [...missing.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)), packs };
}

// ---------- --coverage: which manifest ids have their file on disk ----------
export function coverage({ lib = path.join(ROOT, "library") } = {}) {
  const out = [];
  for (const kind of ["sfx", "music"]) {
    const man = readJson(path.join(lib, kind, "manifest.json"));
    for (const [id, m] of Object.entries(man)) out.push({ kind, id, file: m.file, onDisk: !!m.file && fs.existsSync(path.join(lib, kind, m.file)) });
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const lib = process.env.PHANTASIC_LIB ? path.resolve(process.env.PHANTASIC_LIB) : path.join(ROOT, "library");
  if (argv.includes("--audit")) {
    const { missing, packs } = audit({ lib });
    console.log(`${missing.length} sound id(s) named by styles/ or brands/ that neither manifest has:
`);
    for (const m of missing) {
      console.log(`${m.kind.padEnd(5)} ${m.id}`);
      for (const u of m.uses) console.log(`        ${u.style}  (${u.where})  -> ${u.verdict}`);
    }
    console.log(`
asset packs switched on by styles (library/packs/<name>/, not audio manifests):`);
    for (const [k, v] of packs) console.log(`  ${k}: ${v.length} style(s): ${v.join(", ")}`);
  } else if (argv.includes("--coverage")) {
    const rows = coverage({ lib });
    for (const kind of ["sfx", "music"]) {
      const all = rows.filter((r) => r.kind === kind), have = all.filter((r) => r.onDisk);
      console.log(`${kind}: ${have.length} of ${all.length} manifest ids have their file on disk`);
      const miss = all.filter((r) => !r.onDisk).map((r) => r.id);
      if (miss.length) console.log(`  missing: ${miss.join(", ")}`);
    }
  } else {
    console.error("usage: node scripts/sound_audit.mjs --audit | --coverage");
    process.exit(2);
  }
}

// run directly: compare real paths, so a checkout under a symlinked folder (macOS /tmp) still runs main()
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) main();

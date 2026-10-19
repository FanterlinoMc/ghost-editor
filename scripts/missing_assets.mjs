#!/usr/bin/env node
// usage: node scripts/missing_assets.mjs > references/missing-assets.json   (reads only; PHANTASIC_LIB = another library root)
//
// Every library/ file the engine would look for (named by a style, brand kit, example reel, a library manifest or the
// engine's own code) that is not on disk, one entry per path, plus the sound/music ids that resolve to no path at all.
// The resolution rules mirror build.mjs and scripts/lib/*.mjs; the "resolution" block of the output describes them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { soundRefs } from "./sound_audit.mjs";
import { loadStyleChain } from "./lib/style-path.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = process.env.PHANTASIC_LIB ? path.resolve(process.env.PHANTASIC_LIB) : path.join(ROOT, "library");
const rd = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const has = (p) => fs.existsSync(path.join(LIB, p));
const SFX = rd(path.join(LIB, "sfx", "manifest.json")), MUSIC = rd(path.join(LIB, "music", "manifest.json"));
const FAMILIES = { pop: ["pop-1", "pop-2", "pop-3"], whoosh: ["whoosh-1", "whoosh-2", "whoosh-3"], impact: ["impact-1", "impact-2"] };   // build.mjs VARIANTS
const PACK_KINDS = ["leaks", "burns", "8mm-gate", "8mm-dust"];   // the packClip() kinds build.mjs asks for

// refs: "kind id" -> { kind, id, styles:Set, engine:Set }
const refs = new Map();
const ref = (kind, id, { style, site } = {}) => {
  for (const x of kind === "sfx" && FAMILIES[id] ? FAMILIES[id] : [id]) {
    const k = `${kind} ${x}`;
    if (!refs.has(k)) refs.set(k, { kind, id: x, styles: new Set(), engine: new Set() });
    if (style) refs.get(k).styles.add(style);
    if (site) refs.get(k).engine.add(site);
  }
};

// ---------- 1. styles/, brands/, examples/: the style as build.mjs merges it (its `extends` chain) ----------
const deepMerge = (a, b) => {
  if (b === undefined) return a;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) { const o = { ...a }; for (const k of Object.keys(b)) o[k] = deepMerge(a[k], b[k]); return o; }
  return b;
};
const jsonFiles = (d) => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? jsonFiles(path.join(d, e.name)) : e.name.endsWith(".json") ? [path.join(d, e.name)] : []);
for (const f of [...jsonFiles(path.join(ROOT, "styles")), ...jsonFiles(path.join(ROOT, "brands")), ...jsonFiles(path.join(ROOT, "examples"))].sort()) {
  let s; try { s = rd(f); } catch { continue; }
  const name = rel(f).replace(/\.json$/, "").replace(/^styles\//, "");
  const m = rel(f).match(/^styles\/((?:library\/)?[a-z0-9][a-z0-9-]*)\.json$/);
  if (m) try { s = loadStyleChain(m[1], { stylesDir: path.join(ROOT, "styles"), deepMerge }).style; } catch { /* as written */ }
  for (const r of soundRefs(s)) if (r.kind !== "pack") ref(r.kind, r.id, { style: name });   // "pack:<x>" sounds live outside library/ (PHANTASIC_SFX_PACK)
  if (s.music?.id === "auto") ref("music", Object.keys(MUSIC).find((k) => (MUSIC[k].styles || []).includes(m?.[1])) || "deep-techno-ambience", { style: name });   // build.mjs music "auto"
  const pack = s.packs ? Object.keys(s.packs).find((k) => s.packs[k]) : null;
  if (pack) {
    const gate8 = Object.values(s.scenes || {}).some((sc) => sc?.gate === "8mm");
    if (s.leaks) ref("pack", `packs/${pack}/leaks/`, { style: name });
    if (s.burns || s.openFlash) ref("pack", `packs/${pack}/burns/`, { style: name });
    if (gate8) { ref("pack", `packs/${pack}/8mm-gate/`, { style: name }); ref("pack", `packs/${pack}/8mm-dust/`, { style: name }); }
    if (typeof s.openFlash?.clip === "string") ref("pack", `packs/${pack}/burns/${s.openFlash.clip}`, { style: name });
  }
  // objectPops: the engine's CONCEPTS objects (build.mjs), each an engravings/png/<obj>.png
  if (s.objectPops) for (const o of objectPopNames()) ref("engraving", o, { style: name });
}

// ---------- 2. the engine's own code: sound ids it names, objects it draws ----------
function objectPopNames() {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "build.mjs"), "utf8");
  const block = src.slice(src.indexOf("const CONCEPTS = ["), src.indexOf("if (spec.objectPops)"));
  return [...block.matchAll(/\/, "([a-z0-9-]+)"\]/g)].map((x) => x[1]);
}
// A literal that IS a manifest id or a family counts wherever it appears in code; a literal that is not one counts only
// on a line that plays sound (an *Sfx( call, an sfx key, a sound map), minus the labels/names listed here.
const guarded = new Map();   // sfx id -> code sites that check the manifest before using it
const NOT_SOUNDS = new Set(["sfx-pack", "push-in", "gm-kinetic", "gm-flow", "gm-nodes"]);
const SOUND_LINE = /Sfx\(|sfx|Sfx|riser:|boom:|tail:|PAPER_IN|penN|sfxManifest\[|: \["[a-z0-9-]+", (true|false)\]|^\s+(riser|hit|tail|soft|tick|swish|whip|ramp): \[/;
const codeFiles = ["scripts/build.mjs", ...fs.readdirSync(path.join(ROOT, "scripts", "lib")).filter((f) => f.endsWith(".mjs") && !/test|fixture/.test(f)).sort().map((f) => `scripts/lib/${f}`)];
for (const f of codeFiles) fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
  if (/^\s*\/\//.test(line) || line.includes("const VARIANTS =")) return;   // the family table itself is not a use
  const site = `${f.replace(/^scripts\//, "")}:${i + 1}`;
  for (const [, id] of line.replace(/(role: |volFor\()"[a-z]+"/g, "").matchAll(/"([a-z][a-z0-9]*(?:-[a-z0-9]+)*)"/g)) {   // a mix role is not a sound
    if (SFX[id] || (FAMILIES[id] && SOUND_LINE.test(line))) ref("sfx", id, { site });
    else if (SOUND_LINE.test(line) && id.includes("-") && !NOT_SOUNDS.has(id) && !MUSIC[id]) {
      ref("sfx", id, { site });
      if (line.includes(`sfxManifest["${id}"]`)) guarded.set(id, (guarded.get(id) ?? new Set()).add(site));   // the code checks the manifest before it uses the id
    }
  }
});
ref("music", "deep-techno-ambience", { site: "build.mjs music \"auto\" default" });
for (const o of objectPopNames()) ref("engraving", o, { site: "build.mjs objectPops CONCEPTS" });
ref("engraving", "bulge", { site: "lib/motion.mjs collage bulge filter" });
const gz = fs.readFileSync(path.join(ROOT, "scripts", "lib", "gadzhi.mjs"), "utf8").match(/library names \(([^)]+)\)/)[1];
for (const o of gz.split(/,\s*/)) ref("object", o, { site: "lib/gadzhi.mjs gm-object / gm-nodes scenes" });
for (const k of PACK_KINDS) ref("pack", `packs/editorsinventory/${k}/`, { site: "build.mjs packClip" });

// ---------- 3. the library manifests: every catalogued file is something a reel may name ----------
for (const id of Object.keys(SFX)) ref("sfx", id);
for (const id of Object.keys(MUSIC)) ref("music", id);
const ART = rd(path.join(LIB, "art", "manifest.json"));
for (const [k, v] of Object.entries(ART)) if (!v.skip) ref("art", k);   // skip:true = curated out, never fetched
const ENG = rd(path.join(LIB, "engravings", "manifest.json"));
for (const c of new Set(Object.values(ENG).map((v) => v.concept))) ref("engraving", c);
const MEMES = fs.existsSync(path.join(LIB, "memes")) ? fs.readdirSync(path.join(LIB, "memes"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
for (const id of MEMES) ref("meme", id);

// ---------- resolve each ref to its library path, and check the disk ----------
const PROPOSED_FROM_PACK = new Set(["whoosh-1", "whoosh-2", "whoosh-3", "whoosh-cine", "burn-whoosh-fast", "burn-whoosh-tunnel", "tech-digital-whoosh", "pop-whoosh-light",
  "riser-1", "cinematic-rumble-riser", "tech-camera-flash", "click-1", "tick-1", "pop-1", "pop-2", "pop-3", "typing-1", "zoom-sweep-small", "zoom-sweep-short"]);
const sourceOf = (kind, id) => ({
  sfx: () => PROPOSED_FROM_PACK.has(id) ? "licensed pack candidate: one of its 12 sounds may be processed into this id (category match, not yet heard); Mixkit entry is a record only"
    : "needs a licensed source (no pack category matches); Mixkit entry is a record only, licence unresolved",
  music: () => "needs a licensed bed (Mixkit music not OK for this use); a reel can pass music.src instead",
  art: () => `public domain (${/^[a-z]+-\d+$/.test(id) ? "The Met Open Access, CC0: scripts/art_fetch.py" : "Wikimedia Commons, pre-1900: scripts/art_famous.py"}); gitignored, fetched per machine`,
  engraving: () => "public domain (Wikimedia Commons sources in engravings/manifest.json) or generated (engravings/gen/urls.txt -> scripts/engravings_process.py); no processed png",
  object: () => "CC0 (3dicons v1, see gm-objects/SOURCES.md)",
  meme: () => "user-supplied (scripts/meme_add.py)",
  pack: () => "licensed pack, not shipped",
}[kind]());
const pathOf = (kind, id) => ({
  sfx: () => SFX[id] ? `sfx/${SFX[id].file}` : null,
  music: () => MUSIC[id] ? `music/${MUSIC[id].file}` : null,
  art: () => `art/${id}.jpg`,
  engraving: () => id === "bulge" ? "engravings/bulge.png" : `engravings/png/${id}.png`,
  object: () => `gm-objects/${id === "brain" ? "puzzle" : id}.png`,
  meme: () => `memes/${id}/meta.json`,
  pack: () => id,
}[kind]());
const present = (p) => p.endsWith("/") ? has(p) && fs.readdirSync(path.join(LIB, p)).some((f) => f.endsWith(".mp4")) : has(p);
// styles: "library/podcast-punch--19" ... collapse to "library/podcast-punch--* (N)"
const styleList = (set) => {
  const groups = new Map();
  for (const s of [...set].sort()) { const g = s.replace(/--\d+$/, "--*"); groups.set(g, (groups.get(g) ?? 0) + 1); }
  return [...groups].map(([g, n]) => (g.endsWith("--*") ? `${g} (${n})` : g));
};

const missing = [], dangling = [], counts = {};
for (const r of [...refs.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))) {
  const p = pathOf(r.kind, r.id);
  const named = r.styles.size + r.engine.size > 0;
  const c = (counts[r.kind] ??= { referenced: 0, catalogued_only: 0, missing: 0, dangling: 0 });
  if (named) c.referenced++; else c.catalogued_only++;
  // engine code sites without line numbers ("build.mjs x3"): a line number moves with every edit above it, which made
  // the staleness test fail on unrelated engine changes; a site count changes only when a reference is added or removed
  const byFile = new Map();
  for (const s of r.engine) { const f = s.replace(/:\d+$/, ""); byFile.set(f, (byFile.get(f) ?? 0) + 1); }
  const forWhat = { styles: styleList(r.styles), engine: [...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([f, n]) => (n > 1 ? `${f} x${n}` : f)) };
  const uses = r.styles.size + r.engine.size;
  if (p === null) {
    c.dangling++;
    dangling.push({ kind: r.kind, id: r.id, uses, for: forWhat,
      effect: r.kind === "music" ? "no manifest entry: buildMusic throws unless music.optional or a usable music.fallback is set"
        : guarded.get(r.id)?.size === r.engine.size && r.styles.size === 0 ? "no manifest entry, but every code site checks the manifest first and uses another sound instead (meme beats: cinematic-deep-boom, else the impact family); nothing is skipped and no warning is printed"
        : "no manifest entry: addSfx skips it with a warning (or plays the style's sfxFallback); a file alone will not fix it" });
    continue;
  }
  if (present(p)) continue;
  c.missing++;
  missing.push({ path: p, kind: r.kind, uses, for: named ? forWhat : "catalogued in its manifest; nothing in the fork names it", source: sourceOf(r.kind, r.id) });
}

const out = {
  _about: "Files under library/ that the engine would resolve and a clean checkout lacks. Generated, do not hand-edit: node scripts/missing_assets.mjs > references/missing-assets.json. "
    + "uses = styles, brand kits and example reels that name the asset (after `extends`) + engine code sites that name it (listed per file with a count, no line numbers, so the list only changes when a reference is added or removed). Styles named only through a family (whoosh/pop/impact) count for every variant. "
    + "counts per kind: referenced = named by a style/reel/code (dangling ids included), catalogued_only = in a library manifest and named by nothing; dangling = named but no manifest entry, so no path. The engine-code sound scan is a heuristic (a line regex plus an exclusion list), so the code-site lists and the dangling sfx list are a strong hint, not exact.",
  resolution: {
    root: "build.mjs LIB = $PHANTASIC_LIB or library/",
    sfx: "build.mjs reads sfx/manifest.json; addSfx: id (a family pop/whoosh/impact picks its variants round-robin, VARIANTS) -> sfx/<manifest[id].file>; no entry or no file = skipped with a warning",
    music: "build.mjs music (auto, fallback) and lib/motion.mjs buildMusic: id -> music/<manifest[id].file>; missing = fatal unless music.optional",
    art: "build.mjs artAsset: key -> art/<key>.jpg (fatal when missing); resolveLayerImage for layer images (skipped when missing)",
    engraving: "build.mjs objectPops (CONCEPTS) and lib/motion.mjs page scenes (paper / pageToCollage, collage, concept, stack icon, cutout): key -> engravings/png/<key>.png; lib/motion.mjs collage: engravings/bulge.png",
    object: "lib/gadzhi.mjs gm-object / gm-nodes: name -> gm-objects/<name>.png (brain -> puzzle)",
    meme: "build.mjs memeLib: id -> memes/<id>/meta.json (fatal when missing)",
    pack: "build.mjs packClip: style `packs` on -> packs/<pack>/<kind>/*.mp4 (leaks, burns, 8mm-gate, 8mm-dust); pickBurn: openFlash.clip -> packs/<pack>/burns/<clip>. Absent = asset-free fallback",
  },
  counts,
  missing,
  dangling,
};
process.stdout.write(JSON.stringify(out, null, 1) + "\n");

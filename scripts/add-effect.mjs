#!/usr/bin/env node
// Add a ready-made effect to a reel.
//
//   node scripts/add-effect.mjs <project> <effect> --at 12.4 --to 14.8 [--text "WORD"] [--set a.b=c ...]
//   node scripts/add-effect.mjs --list
//
// Every effect in library/effects/manifest.json is an EXISTING engine primitive written out in the
// engine's own grammar, so this writes reel.json and nothing else: no new beat type, no runtime, and a
// reel that uses one renders on any engine that already has that kind. The point is not capability, it
// is that the shapes are remembered - `title` takes `lines` and not `text`, a hand-written collage item
// needs its own x/y, a `behind` beat needs reel.matte. Each of those cost a build to find.
//
// A beat goes in reel.beats[], a layer in reel.layers[] with a unique id. --at/--to are SOURCE seconds
// for a beat (they move with the words when a take is cut) and FINISHED-video seconds for a layer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(HERE, "..", "library", "effects", "manifest.json");
const die = (m) => { console.error(m); process.exit(1); };
const lib = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

const argv = process.argv.slice(2);
if (argv.includes("--list") || !argv.length) {
  console.log("ready-to-add effects (library/effects/manifest.json):\n");
  const order = (e) => (String(e.frame ?? "").startsWith("overlay") ? 0 : 1);
  const sorted = Object.entries(lib.effects).sort((a, b) => order(a[1]) - order(b[1]) || a[0].localeCompare(b[0]));
  let head = null;
  for (const [name, e] of sorted) {
    const band = order(e) === 0 ? "OVER the footage - the speaker stays on screen" : "FULL frame - it replaces the speaker for its window";
    if (band !== head) { console.log(`--- ${band}\n`); head = band; }
    console.log(`  ${name.padEnd(18)} ${e.what}`);
    console.log(`  ${" ".repeat(18)} params: ${e.params.join(", ")}${e.needs ? `   needs: ${e.needs}` : ""}`);
    if (e.note) console.log(`  ${" ".repeat(18)} note: ${e.note}`);
    console.log("");
  }
  if (Array.isArray(lib.limitations) && lib.limitations.length) {
    console.log("what these cannot do (you would have to build it):");
    for (const l of lib.limitations) console.log(`  - ${l}`);
    console.log("");
  }
  process.exit(0);
}
const [project, name, ...rest] = argv;
if (!project || !name) die("usage: add-effect.mjs <project> <effect> --at <s> [--to <s>] [--text ...] [--set path=value]\n       add-effect.mjs --list");
const eff = lib.effects[name];
if (!eff) die(`unknown effect ${JSON.stringify(name)}; have: ${Object.keys(lib.effects).join(", ")}`);

// --flags
const opt = {}; const sets = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--set") { sets.push(rest[++i]); continue; }
  if (rest[i].startsWith("--")) opt[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[++i] : true;
}
const num = (v) => (v === undefined ? undefined : Number(v));
const node = structuredClone(eff.beat ?? eff.layer);
const isLayer = !!eff.layer;

// time: a beat takes at/to, a layer takes at/dur
if (opt.at === undefined) die(`${name} needs --at`);
node.at = num(opt.at);
if (isLayer) { if (opt.dur === undefined && opt.to === undefined) die(`${name} is a layer: it needs --dur (or --to)`); node.dur = opt.dur !== undefined ? num(opt.dur) : +(num(opt.to) - num(opt.at)).toFixed(3); }
else { if (opt.to === undefined) die(`${name} needs --to`); node.to = num(opt.to); }

// the one-word effects take --text; nested times default to the start so nothing lands before the beat
if (opt.text && typeof opt.text === "string") {
  if ("text" in node) node.text = opt.text;
  else if (Array.isArray(node.lines)) node.lines[0].text = opt.text;
}
// A nested `at: 0` means "the start", and for a beat's own items (a stats badge, a collage item, a
// highlight line) that start is an ABSOLUTE time, so it has to be stamped. A motion tween's `at` is
// NOT: it is seconds from the layer's own start, so stamping it pushes every tween past the end and
// the compiler drops them. Found by building a reel from the library - the first plate worked because
// it happened to start at 0.15 s, and the next two were silently stripped of all movement.
const stampTimes = (o) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object") stampTimes(v); else if ((k === "at" || k === "labelAt") && v === 0) o[k] = node.at; } };
for (const [k, v] of Object.entries(node)) if (v && typeof v === "object" && k !== "tweens") stampTimes(v);

// --y <px>: put the TOP of the whole effect at px, moving every y and y2 together. Without it, moving
// a composited card means setting six coordinates by hand and a missed `y2` leaves the rule drawing
// diagonally across the frame - which it did, on the first reel built from this library.
if (opt.y !== undefined) {
  const ys = [];
  const collect = (o) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object") collect(v); else if ((k === "y" || k === "y2") && Number.isFinite(v)) ys.push(v); } };
  // tweens carry y as a MOVEMENT (`from: {y: 48}`, `to: {y: 0}`), not a position, so they are skipped
  // here exactly as in the time stamping above - counting a tween's y: 0 as the top made --y an offset
  // instead of a placement, which is how this was caught.
  for (const [k, v] of Object.entries(node)) if (v && typeof v === "object" && k !== "tweens") collect(v);
  if (!ys.length) die(`${name} has no y to move`);
  const dy = num(opt.y) - Math.min(...ys);
  const shift = (o) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object") shift(v); else if ((k === "y" || k === "y2") && Number.isFinite(v)) o[k] = Math.round(v + dy); } };
  for (const [k, v] of Object.entries(node)) if (v && typeof v === "object" && k !== "tweens") shift(v);
}

// --set a.b=c, so anything in the template can be overridden without editing the file
for (const s of sets) {
  const i = s.indexOf("=");
  if (i < 0) die(`--set wants path=value, got ${JSON.stringify(s)}`);
  const keys = s.slice(0, i).split("."), raw = s.slice(i + 1);
  let v; try { v = JSON.parse(raw); } catch { v = raw; }
  let t = node;
  for (const k of keys.slice(0, -1)) { if (t[k] === undefined) t[k] = /^\d+$/.test(keys[keys.indexOf(k) + 1] ?? "") ? [] : {}; t = t[k]; }
  t[keys.at(-1)] = v;
}

const rp = path.join(project, "reel.json");
if (!fs.existsSync(rp)) die(`no reel.json in ${project}`);
const reel = JSON.parse(fs.readFileSync(rp, "utf8"));
const warn = [];
if (isLayer) {
  reel.layers ??= [];
  const base = node.id ?? name;
  let id = base, n = 2;
  while (reel.layers.some((l) => l.id === id)) id = `${base}-${n++}`;
  node.id = id;
  reel.layers.push(node);
} else {
  reel.beats ??= [];
  reel.beats.push(node);
  reel.beats.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}
if (eff.needs && /matte/.test(eff.needs) && reel.matte !== true) {
  reel.matte = true; reel.matteWindows = true; reel.matteClip = true;
  warn.push('set reel.matte/matteWindows/matteClip: this effect needs the speaker cut out, and the windowed cut keeps it to seconds rather than the whole clip');
}
fs.writeFileSync(rp, JSON.stringify(reel, null, 2) + "\n");
console.log(`added ${name} -> ${isLayer ? `layers[] as "${node.id}"` : "beats[]"} at ${node.at}${isLayer ? ` for ${node.dur}s` : `-${node.to}`}`);
if (eff.frame) console.log(`  frame: ${eff.frame === "overlay" ? "OVER the footage, speaker stays on screen" : eff.frame === "full-dimmed" ? "FULL frame, speaker dimmed behind it" : "FULL frame, it replaces the speaker for this window"}`);
for (const w of warn) console.log(`  ${w}`);
if (eff.needs) console.log(`  needs: ${eff.needs}`);
if (eff.cannot) console.log(`  cannot: ${eff.cannot}`);
if (eff.note) console.log(`  note: ${eff.note}`);

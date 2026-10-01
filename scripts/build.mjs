#!/usr/bin/env node
// Generate a HyperFrames composition (index.html) for a vertical talking-head
// reel from one edit spec, reel.json, and the whisper word json.
//
//   node build.mjs <project-dir>            (reads <project>/reel.json)
//
// Every time in reel.json is an ORIGINAL-recording second. E(t) maps it to
// edit time through the chosen takes and throws when t was cut, so a beat
// can never point at material that is not in the video.
//
// What the build owns so the plan does not have to:
//   - takes as muted <video> ranges + matching <audio> with 2/3-frame fades
//   - snap zooms and push-ins on two nested wrappers (they multiply)
//   - word-timed captions (house or pill style)
//   - overlays: big, chips, strike, quote, list, emoji, logo, meme, endcard
//   - SFX: default sound per beat type, round-robin variants, level by role
//     from the normalized kit, density and repetition rules
//   - copies every asset into <project>/assets so the render is self-contained
// It writes index.html, build/sfx_events.json (for qa.py) and prints the edit
// timeline, the caption text and an SFX density report.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MOTION_CSS, buildScene, buildEditorialCaptions, buildMusic, uiCard } from "./lib/motion.mjs";
import { makePlacer, PLATFORMS, FORMATS } from "./lib/safezone.mjs";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(SKILL, "library");
const proj = path.resolve(process.argv[2] || ".");
const rawSpec = JSON.parse(fs.readFileSync(path.join(proj, "reel.json"), "utf8"));
// a style preset (styles/<name>.json) supplies defaults; reel.json overrides
const deepMerge = (a, b) => {
  if (b === undefined) return a;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const o = { ...a };
    for (const k of Object.keys(b)) o[k] = deepMerge(a[k], b[k]);
    return o;
  }
  return b;
};
const STYLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "styles");
// a style can extend another ("extends": "editorial-collage"): the base loads first, the style overrides it
// (R1b port: brand-kit layering, ported from main's engine/core/scripts/build.mjs)
const loadStyle = (name, seen = []) => {
  const sp = path.join(STYLE_DIR, `${name}.json`);
  if (!fs.existsSync(sp)) { console.error(`ERROR: unknown style '${name}'; have: ${fs.readdirSync(STYLE_DIR).map((f) => f.replace(".json", "")).join(", ")}`); process.exit(1); }
  if (seen.includes(name)) { console.error(`ERROR: style '${name}' extends itself`); process.exit(1); }
  const own = JSON.parse(fs.readFileSync(sp, "utf8"));
  delete own._about;
  const base = own.extends ? loadStyle(own.extends, [...seen, name]) : {};
  delete own.extends;
  return deepMerge(base, own);
};
// a brand kit (brands/<id>.json) turns one customer's identity into template settings: colours, watermark, name tag,
// and a flash/burn tint derived from the accent colour (so every brand gets its own burn, not ours)
const hexToHsl = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return [(h + 360) % 360, s * 100, l * 100];
};
const hslToRgb = (h, s, l) => {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `${f(0)},${f(8)},${f(4)}`;
};
const brandLayer = (id) => {
  const bp = path.join(STYLE_DIR, "..", "brands", `${id}.json`);
  if (!fs.existsSync(bp)) { console.error(`ERROR: unknown brand kit '${id}' (brands/)`); process.exit(1); }
  const kit = JSON.parse(fs.readFileSync(bp, "utf8"));
  const [h, s] = hexToHsl(kit.accent);
  const layer = {
    brand: { accent: kit.accent, accentDark: kit.accentDark ?? kit.accent },
    openFlash: {
      color: kit.flash?.color ?? [hslToRgb(h, Math.min(90, s + 20), 53), hslToRgb(h, 80, 75)],
      textureFilter: kit.flash?.textureFilter ?? `hue-rotate(${Math.round((h - 25 + 360) % 360)}deg) saturate(1.6) brightness(.95)`,
    },
  };
  if (kit.watermark) layer.watermark = { text: kit.watermark };
  if (kit.person) layer.nametag = { name: kit.person.name, title: kit.person.title, subtitle: kit.person.subtitle, until: "hook" };
  if (kit.music) layer.music = kit.music;
  return layer;
};
let preset = rawSpec.style ? loadStyle(rawSpec.style) : {};
const kitId = rawSpec.brandKit ?? preset.brandKit;
if (kitId) {
  const layer = brandLayer(kitId);
  if (preset.openFlash === false) delete layer.openFlash;       // a template with no opening burn stays without one
  preset = deepMerge(preset, layer);
}
const spec = deepMerge(preset, rawSpec);

const FPS = spec.fps ?? 30;
// brand kit: one accent (60/30/10), ink for text on light scenes, caption size
const brand = { accent: "#D13F34", accentDark: "#B93026", ink: "#262626", capSize: 58, font: null, ...(spec.brand || {}) };
const warn = [];
const die = (m) => { console.error("ERROR: " + m); process.exit(1); };
// I-19: output format. Canonical WxH comes from safezone.mjs's FORMATS map (one
// source of truth prep.sh and build.mjs both read, rather than build.mjs holding
// its own second copy of these four numbers). Unknown spec.format dies loudly
// instead of silently falling back - a typo'd format and a missing one should
// not look the same.
const FORMAT = spec.format ?? "9:16";
if (!FORMATS[FORMAT]) die(`unknown spec.format '${FORMAT}'; have: ${Object.keys(FORMATS).join(", ")}`);
const { W, H } = FORMATS[FORMAT];

// ---------- takes and time mapping ----------
const takes = spec.takes.map((t, i) => {
  if (!(t.b > t.a)) die(`take ${i} has b <= a`);
  return { ...t, frames: Math.round((t.b - t.a) * FPS) };
});
// hold: seconds of frozen last frame AFTER a take (no voice). It makes air
// for a meme on a tightly cut recording; the meme's `at` is the take's b.
let acc = 0;
for (const t of takes) {
  t.start = acc / FPS; acc += t.frames; t.dur = t.frames / FPS;
  t.holdFrames = Math.round((t.hold ?? 0) * FPS); t.holdStart = acc / FPS; acc += t.holdFrames;
}
const SPEECH = acc / FPS;
const OUTRO = spec.outro ?? 3;
const TOTAL = +(SPEECH + OUTRO).toFixed(3);

// takes in recording order, for the gap-snap below. Array order is PLAYBACK order and may differ.
const bySource = [...takes].sort((x, y) => x.a - y.a);
const E = (t, what = "") => {
  if (t === "end") return TOTAL;
  if (typeof t === "string" && t.startsWith("outro+")) return SPEECH + parseFloat(t.slice(6));
  for (const k of takes) if (t >= k.a - 1e-6 && t <= k.b + 1e-6) return +(k.start + (t - k.a)).toFixed(3);
  // whisper word times are loose around pauses: a time inside a short removed
  // gap (< 1.2 s) snaps to the start of the next kept take.
  // Walk takes in SOURCE order, not array order: a reordered edit (the hook moved to the front)
  // leaves array-adjacent takes non-adjacent in the recording, and this test then compares a gap
  // that does not exist. Measured: with takes [10.06-20.12, 0.4-4.88, 7.82-9.5, 20.24-22.36],
  // E(9.8) threw "not inside any take" where source order resolved it to 6.133. Sorting a copy is
  // a no-op when takes are already in source order, so plans that never reorder are untouched.
  if (typeof t === "number") for (let i = 0; i + 1 < bySource.length; i++) if (t > bySource[i].b && t < bySource[i + 1].a && bySource[i + 1].a - bySource[i].b < 1.2) return +bySource[i + 1].start.toFixed(3);
  // "hold:<i>+s" = s seconds into the hold after take i
  if (typeof t === "string" && t.startsWith("hold:")) { const [i, off] = t.slice(5).split("+"); return +(takes[+i].holdStart + (parseFloat(off) || 0)).toFixed(3); }
  throw new Error(`E(${t})${what ? " for " + what : ""}: not inside any take`);
};
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------- words -> edit-time captions ----------
const core = (w) => w.replace(/[.,!?;:]+$/, "");
const punct = (w) => w.slice(core(w).length);
const whisper = JSON.parse(fs.readFileSync(path.resolve(proj, spec.words), "utf8"));
const allWords = whisper.segments.flatMap((s) => (s.words || []).map((w) => ({ word: w.word.trim(), start: w.start, end: w.end })));
const fixes = Object.entries(spec.captions?.fixes || {});
const words = [];
console.log("\n edit-start   orig a  ->  orig b   dur   text");
// each word belongs to ONE take: the one it overlaps most (whisper stretches
// words over pauses, so a boundary word can touch two neighbouring takes)
const ov = (w, k) => Math.min(w.end, k.b) - Math.max(w.start, k.a);
const owner = allWords.map((w) => {
  let best = -1, bo = 0;
  takes.forEach((k, i) => { const o = ov(w, k); if (o > bo) { bo = o; best = i; } });
  return bo >= Math.min(0.1, 0.5 * (w.end - w.start)) ? best : -1;
});
for (const [ti, k] of takes.entries()) {
  const ws = allWords.filter((w, wi) => owner[wi] === ti);
  if (!ws.length) { warn.push(`take ${k.a}-${k.b} owns no words (a breath or a tail); fine for autocut takes`); continue; }
  ws.forEach((w, i) => {
    let text = w.word;
    for (const [o, n] of fixes) if (core(text).toLowerCase() === o.toLowerCase()) text = n + punct(text);
    if (i === 0 && /^[a-z]/.test(text) && (!words.length || /[.?!]$/.test(words.at(-1).word))) text = text[0].toUpperCase() + text.slice(1);
    const prev = words.at(-1);
    // whisper splits "co-founder" and "50,000"; glue the pieces back
    if (prev && (text.startsWith("-") || (/^[,.]\d/.test(text) && /\d$/.test(prev.word)))) { prev.word += text; prev.end = r3(k.start + Math.min(w.end, k.b) - k.a); return; }
    words.push({ word: text, start: r3(k.start + Math.max(w.start, k.a) - k.a), end: r3(k.start + Math.min(w.end, k.b) - k.a) });
  });
  const line = ws.map((w) => w.word).join(" ");
  console.log(`${k.start.toFixed(2).padStart(9)}   ${k.a.toFixed(2).padStart(7)} -> ${k.b.toFixed(2).padStart(7)}  ${k.dur.toFixed(2).padStart(5)}   ${line.slice(0, 90)}${line.length > 90 ? "..." : ""}`);
}

// phrase fixes: whisper mangles product names across several words
// ("a call for reach" -> "Coffer Reach"); the first word takes the new text
// and the span of the whole phrase, the rest are dropped
for (const [from, to] of Object.entries(spec.captions?.phrases || {})) {
  const pat = from.toLowerCase().split(/\s+/);
  for (let i = 0; i + pat.length <= words.length; i++) {
    if (pat.every((p, k) => core(words[i + k].word).toLowerCase() === p)) {
      const tail = punct(words[i + pat.length - 1].word);
      words[i] = { word: to + tail, start: words[i].start, end: words[i + pat.length - 1].end };
      words.splice(i + 1, pat.length - 1);
    }
  }
}
// A phrase mapped to "" removes it: grunts and noise whisper heard as words.
for (let i = words.length - 1; i >= 0; i--) if (core(words[i].word) === "") words.splice(i, 1);

// rtl (I-18): mirrors the cyr check further down (build.mjs, near capCss) but for scripts that
// read right-to-left (Arabic, Hebrew, ...). Computed here, before motionCtx, because
// buildEditorialCaptions (motion.mjs) needs it for the per-word "script" write-on animation and
// the highlight underline, both of which mirror their sweep direction under rtl.
const rtl = /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(JSON.stringify(spec.beats || []) + words.map((w) => w.word).join(" "));

// ---------- assets ----------
const A = path.join(proj, "assets");
for (const d of ["sfx", "memes", "icons", "fonts"]) fs.mkdirSync(path.join(A, d), { recursive: true });
// A16: assets/fonts must mirror templates/fonts exactly, or a project built before a
// font rename keeps the old file around under its old name and the fontFaces loop
// below (which just reads whatever is in assets/fonts) emits a @font-face for a
// phantom family forever - the exact bug 49ba994 fixed, resurrected from stale
// copies. assets/fonts has no other writer than this loop, so delete-then-copy is
// safe: anything here that isn't in templates/fonts right now is a leftover from an
// older build, never something a project added itself.
const templateFonts = fs.readdirSync(path.join(SKILL, "templates", "fonts"));
const wantedFonts = new Set(templateFonts);
for (const f of fs.readdirSync(path.join(A, "fonts"))) if (!wantedFonts.has(f)) fs.unlinkSync(path.join(A, "fonts", f));
for (const f of templateFonts) fs.copyFileSync(path.join(SKILL, "templates", "fonts", f), path.join(A, "fonts", f));

const sfxManifest = JSON.parse(fs.readFileSync(path.join(LIB, "sfx", "manifest.json"), "utf8"));
const memeLib = (id) => {
  const dir = path.join(LIB, "memes", id);
  const mp = path.join(dir, "meta.json");
  if (!fs.existsSync(mp)) die(`meme '${id}' not in library (library/memes/${id}/meta.json); add it with meme_add.py or run meme_find.py`);
  return { dir, meta: JSON.parse(fs.readFileSync(mp, "utf8")) };
};
// a public-domain painting from library/art (art_fetch.py fills it; the files are gitignored)
// ported from origin/main bd7ae09
const artAsset = (key) => {
  const src = path.join(LIB, "art", `${key}.jpg`);
  if (!fs.existsSync(src)) die(`art '${key}' not in library/art (see library/art/manifest.json)`);
  fs.mkdirSync(path.join(A, "art"), { recursive: true });
  const dst = path.join(A, "art", `${key}.jpg`);
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  return `assets/art/${key}.jpg`;
};
const icon = (slug) => {
  // simple-icons (CC0), fetched at build time, never at render time
  const dst = path.join(A, "icons", `${slug}.svg`);
  if (!fs.existsSync(dst)) {
    try { execFileSync("curl", ["-sfL", "-o", dst, `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`]); }
    catch { die(`no simple-icons slug '${slug}' (see https://simpleicons.org); pass "src" with your own image instead`); }
  }
  return `assets/icons/${slug}.svg`;
};
const userAsset = (p) => {
  const src = path.resolve(proj, p);
  if (!fs.existsSync(src)) die(`asset not found: ${p}`);
  if (src.startsWith(A + path.sep)) return path.relative(proj, src);
  const dst = path.join(A, path.basename(src));
  fs.copyFileSync(src, dst);
  return `assets/${path.basename(src)}`;
};

// ---------- SFX: levels by role, defaults per beat, rules ----------
// Levels are set RELATIVE TO THIS RECORDING'S VOICE: the p95 of 50 ms peak
// windows over the kept words (the voice is -16 LUFS after prep.sh, but a
// compressed voice peaks higher than a dynamic one). Kit files are
// peak-normalized to -1 dBFS and the HyperFrames mixer is linear (verified:
// volume 0.5 = -6 dB, no normalization by track count), so
// volume = 10^((voiceP95 + roleDb - (-1)) / 20).
// ui ticks sit well under the voice, meme hits come close to it because they
// land in pauses.
const ROLE_DB = { ui: -14, whoosh: -12, impact: -8, meme: -3, ...(spec.mix?.roleDb || {}) };
const voiceP95 = (() => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path.resolve(proj, spec.source), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const win = 800, pk = [];
  for (const k of takes) for (const w of allWords) {
    if (w.start < k.a || w.end > k.b) continue;
    for (let i = Math.floor(w.start * 16000); i + win <= w.end * 16000; i += win) {
      let m = 0;
      for (let j = i; j < i + win; j++) m = Math.max(m, Math.abs(x[j]));
      pk.push(m);
    }
  }
  pk.sort((a, b) => a - b);
  return 20 * Math.log10(Math.max(pk[Math.floor(pk.length * 0.95)] || 0.3, 1e-6));
})();
const volFor = (role, extraDb = 0) => r3(Math.min(1, Math.pow(10, (voiceP95 + ROLE_DB[role] + extraDb + 1) / 20)));
const VARIANTS = { pop: ["pop-1", "pop-2", "pop-3"], whoosh: ["whoosh-1", "whoosh-2", "whoosh-3"], impact: ["impact-1", "impact-2"] };
const rr = {};
const pick = (id) => {
  if (!VARIANTS[id]) return id;
  rr[id] = ((rr[id] ?? -1) + 1) % VARIANTS[id].length;
  return VARIANTS[id][rr[id]];
};
const sfxEvents = []; // {t, id, role, vol, src, why}
// sfxProfile: restrained keeps only structural hits (scene changes, hero words,
// clicks, impacts); rich adds a whoosh to every snap. Standard = everything.
const SFX_PROFILE = spec.sfxProfile || "standard";
const RESTRAINED_DROP = /type tick|fly3d word|chip|list line|card pill|badge in|push-in|device line|ui line|kinetic keyword|emoji|logo/;
// A missing sound effect WARNS and is skipped; it does not kill the build.
//
// Two things forced this. First, library/sfx/ ships manifests and no audio at all, so until the
// licensed pack is restored every reel that wants a sound dies - and the engine has ~40 raw
// addSfx() call sites, most of them inside scene builders where no per-beat `sfx: false` can
// reach. Working around that per reel meant deleting the beats and icons that wanted sound.
// Second, a sound effect is decorative: losing a whoosh should cost you a whoosh, not a render.
// Music keeps its named, fatal error (A10) because a missing music bed IS structural.
// Every miss is collected and reported once at the end rather than per occurrence.
const missingSfx = new Map();
const addSfx = (t, id, why, { db = 0, lead = 0 } = {}) => {
  if (!id || id === "none") return;
  if (SFX_PROFILE === "restrained" && RESTRAINED_DROP.test(why)) return;
  const real = pick(id);
  const m = sfxManifest[real];
  if (!m) { missingSfx.set(real, (missingSfx.get(real) ?? 0) + 1); return; }
  const srcFile = path.join(LIB, "sfx", m.file);
  if (!fs.existsSync(srcFile)) { missingSfx.set(`${real} (${m.file})`, (missingSfx.get(`${real} (${m.file})`) ?? 0) + 1); return; }
  fs.copyFileSync(srcFile, path.join(A, "sfx", m.file));
  sfxEvents.push({ t: r3(Math.max(0, t - lead)), id: real, role: m.role, vol: volFor(m.role, db), dur: m.duration, src: `assets/sfx/${m.file}`, why });
};
const beatSfx = (b, t, def, why, opts) => {
  const s = b.sfx === undefined ? def : b.sfx;
  if (s === false || s === "none") return;
  for (const id of [].concat(s)) addSfx(t, id, why, opts);
};

// ---------- zoom ----------
const zoom = spec.zoom || {};
const tl = []; // GSAP lines
const snaps = (zoom.snaps || []).map(([t, z]) => [E(t, "snap"), z]).sort((a, b) => a[0] - b[0]);
// cadence: automatic punch-in rhythm (The Closer: the frame changes every 1-1.5 s).
// Snaps land on a word start, at every jump cut between takes, and on emphasis words;
// they alternate between the framings in `scales`. Every `sfxEvery`-th snap gets a sound.
const cadence = spec.cadence;
const cadenceSnaps = new Set();
if (cadence) {
  const every = cadence.every ?? 1.3, minGap = cadence.minGap ?? 0.6;
  const scales = cadence.scales ?? [1, 1.12];
  const emphasis = new Set([].concat(spec.captions?.highlight || []).filter((h) => typeof h === "string").map((h) => h.toLowerCase()));
  const joins = takes.slice(1).map((k) => r3(k.start));
  let last = -Infinity, n = 0;
  const add = (t, why) => {
    if (t - last < minGap || t >= SPEECH - 0.3) return;
    if (snaps.some(([u]) => Math.abs(u - t) < minGap)) { last = t; return; }
    const z = why === "emphasis" ? (cadence.emphasisScale ?? Math.max(...scales) + 0.06) : scales[n % scales.length];
    snaps.push([r3(t), z]); cadenceSnaps.add(r3(t)); last = t; n++;
  };
  let joinIndex = 0;
  for (const w of words) {
    const t = r3(Math.max(0, w.start - 0.02));
    const before = last;
    while (joinIndex < joins.length && joins[joinIndex] <= w.start + 0.05) add(joins[joinIndex++], "jump cut");
    if (last !== before) continue;
    if (emphasis.has(core(w.word).toLowerCase()) || /!$/.test(w.word)) add(t, "emphasis");
    else if (t - last >= every) add(t, "cadence");
  }
  snaps.sort((a, b) => a[0] - b[0]);
  console.log(`cadence: ${cadenceSnaps.size} punch-ins added (~${(cadenceSnaps.size / Math.max(SPEECH, 1) * 60).toFixed(0)}/min)`);
}
tl.push(`tl.set("#snap", { scale: 1 }, 0);`);
let cadenceIndex = 0;
for (const [t, z] of snaps) {
  tl.push(`tl.set("#snap", { scale: ${z} }, ${t});`);
  if (cadenceSnaps.has(t)) {
    const every = cadence.sfxEvery ?? 4;
    if (cadence.sfx && cadenceIndex % every === 0) addSfx(t, cadence.sfx, "cadence snap", { db: cadence.sfxDb ?? -6, lead: 0.04 });
    cadenceIndex++;
  } else if (zoom.snapSfx || SFX_PROFILE === "rich") addSfx(t, !zoom.snapSfx || zoom.snapSfx === true ? "whoosh" : zoom.snapSfx, "snap", { db: -6, lead: 0.05 });
}
let lastPushEnd = -1;
const pushesEdit = [];
// openPush: a slow push-in on the speaker over the opening seconds (the hook breathes in)
if (spec.openPush && !(zoom.pushes || []).some((p) => E(p.at, "push") < (spec.openPush.dur ?? 2.5))) {
  const d = spec.openPush.dur ?? 2.5;
  tl.push(`ft("#push", { scale: 1 }, { scale: ${spec.openPush.z ?? 1.08}, duration: ${d}, ease: "sine.inOut" }, 0);`);
  tl.push(`tl.to("#push", { scale: 1, duration: 0.01 }, ${r3(d + 0.05)});`);
  pushesEdit.push({ a: 0, b: d, z: spec.openPush.z ?? 1.08, up: d, down: 0 });
  lastPushEnd = d;
}
for (const p of zoom.pushes || []) {
  const a = E(p.at, "push"), up = p.up ?? 0.4, down = p.down ?? 0;
  const b = p.until === "end" ? TOTAL : E(p.until, "push until");
  pushesEdit.push({ a, b, z: p.z, up, down: p.until === "end" ? 0 : down });
  if (a < lastPushEnd) die(`push at ${p.at} overlaps the previous push`);
  tl.push(`ft("#push", { scale: 1 }, { scale: ${p.z}, duration: ${up}, ease: "power3.out" }, ${a});`);
  if (p.sfx) addSfx(a, p.sfx, "push-in", { db: -4, lead: 0.05 });
  if (p.until !== "end") tl.push(down > 0 ? `tl.to("#push", { scale: 1, duration: ${down}, ease: "power2.inOut" }, ${b});` : `tl.set("#push", { scale: 1 }, ${b});`);
  lastPushEnd = b + down;
}

// ---------- the speaker ----------
const SRC = spec.source;
if (!fs.existsSync(path.resolve(proj, SRC))) die(`source ${SRC} missing; run prep.sh first`);
const srcDur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.resolve(proj, SRC)]).toString());
const stillAt = (t) => String(Math.max(0, Math.min(t, srcDur - 0.12)));
const fadeLane = (d) => JSON.stringify({ version: 1, lanes: [{ target: "volume", points: [{ t: 0, v: 0 }, { t: r3(2 / FPS), v: 1 }, { t: r3(d - 3 / FPS), v: 1 }, { t: r3(d), v: 0 }] }] });
const takeHtml = takes.map((k, i) => {
  let h = `
      <video id="take-${i}" src="${SRC}" data-start="${r3(k.start)}" data-duration="${r3(k.dur)}" data-media-start="${k.a}" data-track-index="0" muted playsinline></video>`;
  if (k.holdFrames) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", stillAt(k.a + k.dur - 1 / FPS), "-i", path.resolve(proj, SRC), "-frames:v", "1", "-q:v", "2", "-update", "1", path.join(A, `hold-${i}.jpg`)]);
    h += `
      <img id="hold-${i}" class="fill" src="assets/hold-${i}.jpg" data-start="${r3(k.holdStart)}" data-duration="${r3(k.holdFrames / FPS)}" data-track-index="0" />`;
  }
  return h;
}).join("");
// take-join transitions (I-17): a join can now blur or whip between the two recordings instead
// of a hard cut. No SFX here, by design: expand/wipe's whoosh (motion.mjs transIn) ties a
// transition to the SFX library, which ships 0 files while E1 is open (the A10 defect class) -
// blur and whip are built fresh here, video-to-video on the same layer, not a lift of
// motion.mjs's transIn/transOut (those dissolve a full-screen scene OVER the speaker plate).
// Validated once into takeJoins, then applied to #take- below and to #matte- (when spec.matte)
// further down, so the cut-out layer whips/blurs in step with the plate instead of hard-cutting
// underneath an animated join.
const JOIN_TRANSITIONS = new Set(["blur", "whip"]);
if (takes[0]?.transition) warn.push(`take 0: 'transition' is ignored (no earlier take to join from)`);
const takeJoins = [];
for (let i = 1; i < takes.length; i++) {
  const kind = takes[i].transition;
  if (!kind) continue;
  if (!JOIN_TRANSITIONS.has(kind)) die(`take ${i}: unknown transition '${kind}'; have: ${[...JOIN_TRANSITIONS].join(", ")}`);
  if (takes[i - 1].holdFrames) die(`take ${i}: transition '${kind}' follows a hold on take ${i - 1} (a frozen still, nothing to dissolve from)`);
  if (Math.min(takes[i - 1].dur, takes[i].dur) < 0.3) warn.push(`take ${i}: '${kind}' transition on a take under 0.3s may clip`);
  takeJoins.push({
    i, kind, T: r3(takes[i].start),
    outDur: Math.min(kind === "whip" ? 0.12 : 0.18, takes[i - 1].dur / 2),
    inDur: Math.min(kind === "whip" ? 0.16 : 0.22, takes[i].dur / 2),
  });
}
const pushJoinTransition = (outSel, inSel, kind, T, outDur, inDur) => {
  if (kind === "blur") {
    tl.push(`tl.to("${outSel}", { autoAlpha: 0, filter: "blur(28px)", duration: ${outDur}, ease: "power2.in" }, ${r3(T - outDur)});`);
    tl.push(`ft("${inSel}", { autoAlpha: 0, filter: "blur(28px)" }, { autoAlpha: 1, filter: "blur(0px)", duration: ${inDur}, ease: "power2.out" }, ${T});`);
  } else if (kind === "whip") {
    tl.push(`tl.to("${outSel}", { autoAlpha: 0, xPercent: -8, filter: "blur(40px)", duration: ${outDur}, ease: "power1.in" }, ${r3(T - outDur)});`);
    tl.push(`ft("${inSel}", { autoAlpha: 0, xPercent: 8, filter: "blur(40px)" }, { autoAlpha: 1, xPercent: 0, filter: "blur(0px)", duration: ${inDur}, ease: "power1.out" }, ${T});`);
  }
};
for (const { i, kind, T, outDur, inDur } of takeJoins) pushJoinTransition(`#take-${i - 1}`, `#take-${i}`, kind, T, outDur, inDur);
const takeAudio = takes.map((k, i) => `
  <audio id="take-${i}-audio" src="${SRC}" data-start="${r3(k.start)}" data-duration="${r3(k.dur)}" data-media-start="${k.a}" data-track-index="${10 + (i % 2)}" data-automation='${fadeLane(k.dur)}'></audio>`).join("");
let matteHtml = "";
if (spec.matte) {
  const mp = path.join(A, "talk-matte.webm");
  if (!fs.existsSync(mp)) {
    console.log("cutting the speaker out (hyperframes remove-background, ~4 fps; cached in assets/talk-matte.webm)...");
    // npx is a .cmd shim on Windows and CreateProcess cannot launch it directly, so this
    // threw ENOENT and took every `behind` beat with it (they die() without a matte).
    const npx = process.platform === "win32" ? ["cmd", ["/c", "npx"]] : ["npx", []];
    execFileSync(npx[0], [...npx[1], "hyperframes", "remove-background", path.resolve(proj, SRC), "-o", mp], { stdio: ["ignore", "ignore", "pipe"], cwd: proj, maxBuffer: 1 << 28 }); console.log("  matte done");
  }
  matteHtml = takes.map((k, i) => `
      <video id="matte-${i}" class="matte" src="assets/talk-matte.webm" data-start="${r3(k.start)}" data-duration="${r3(k.dur)}" data-media-start="${k.a}" data-track-index="2" muted playsinline></video>`).join("");
  // the cut-out layer mirrors the plate's join transition so a `behind` beat never shows the
  // matte hard-cutting on top of a plate that is whipping or blurring underneath it.
  for (const { i, kind, T, outDur, inDur } of takeJoins) pushJoinTransition(`#matte-${i - 1}`, `#matte-${i}`, kind, T, outDur, inDur);
}
// the outro is a real still of the last frame, frozen under the end card
const last = takes.at(-1);
if (OUTRO > 0) execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", stillAt(last.a + last.dur - 1 / FPS), "-i", path.resolve(proj, SRC), "-frames:v", "1", "-q:v", "2", "-update", "1", path.join(A, "outro.jpg")]);
const outroHtml = OUTRO > 0 ? `
      <img id="outro-still" class="fill" src="assets/outro.jpg" data-start="${r3(SPEECH)}" data-duration="${r3(OUTRO)}" data-track-index="0" />` : "";

// ---------- caption placement: face-aware, inside the platform's safe area ----------
// I-19: 4:5/1:1/16:9 have no stories-style swipe chrome, so "instagram" is the
// wrong default guide set for them - default on format, still overridable by
// an explicit spec.platform. (Verified: 1:1 with "instagram" dead-centres a
// 440px safe window in a 1080-tall frame - the safezone.mjs console.warn does
// not catch that, since 440 > its 324px threshold - so this default is what
// actually prevents it, not the warning.)
const platform = spec.platform || (FORMAT === "16:9" ? "widescreen" : FORMAT === "9:16" ? "instagram" : "feed");
const facePath = path.join(proj, spec.face || "build/face.json");
const face = fs.existsSync(facePath) ? JSON.parse(fs.readFileSync(facePath, "utf8")) : null;
if (!face) warn.push(`no ${path.relative(proj, facePath)}: captions sit at a fixed height and may cover the face; run scripts/face_track.py first`);
// A face.json is pixel coordinates in whatever W/H face_track.py measured. If that
// doesn't match this build's canvas (project built in one format, face.json tracked
// against another), every caption placement is silently wrong - same failure class
// as a stale format assumption, just one level up, so this dies loudly rather than
// placing captions against the wrong pixel space. Older face.json files predating
// this field have no w/h to check, so they fall back to a warning, not a die.
if (face && face.w != null && face.h != null) {
  if (face.w !== W || face.h !== H) die(`${path.relative(proj, facePath)} is ${face.w}x${face.h} but this build is ${W}x${H} (spec.format '${FORMAT}') - re-run face_track.py against the matching source`);
} else if (face) {
  warn.push(`${path.relative(proj, facePath)} has no w/h; cannot verify it matches this build's ${W}x${H} canvas - re-run face_track.py to add it`);
}
const placer = makePlacer({ face, takes, zoom: { ...zoom, snapsEdit: snaps, pushesEdit }, TOTAL, platform, ideal: spec.captions?.y ?? Math.round(H * 1180 / 1920), H, W });

// ---------- overlays ----------
const CARD = { x: 60, y: spec.layout?.cardY ?? 990, w: 870 };
const SLOT = { x: 720, y: spec.layout?.slotY ?? 240 }; // reaction slot next to the head
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
if (JSON.stringify(spec.beats || []).includes("—")) warn.push("em dash in on-screen text");
const overlays = [];
let n = 0;
const enter = (sel, t, kind = "pop") => kind === "slide"
  ? `ft("${sel}", { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: "power3.out" }, ${t});`
  : `ft("${sel}", { autoAlpha: 0, scale: 0.55 }, { autoAlpha: 1, scale: 1, duration: 0.38, ease: "back.out(2.2)" }, ${t});`;
const exit = (sel, end) => `tl.to("${sel}", { autoAlpha: 0, scale: 0.9, duration: 0.18, ease: "power2.in" }, ${r3(end - 0.22)});`;
const slotUsed = [];
const hiddenCaps = [];
const behindHtml = [];
const shownCaps = []; // scenes that keep captions (captions.onlyInScenes shows ONLY these)
const faceFile = path.join(proj, spec.face || "build/face.json");
const faceY = (() => {
  if (!fs.existsSync(faceFile)) return 700;
  const ys = JSON.parse(fs.readFileSync(faceFile, "utf8")).samples.filter((x) => x[1] != null).map((x) => (x[1] + x[2]) / 2).sort((a, b) => a - b);
  return ys.length ? Math.round(ys[Math.floor(ys.length / 2)]) : 700;
})();
const motionCtx = { tl, E, r3, esc, addSfx, brand, userAsset, artAsset, icon: (slug) => icon(slug), zoomBase: (spec.zoom || {}).base ?? 1, words, proj, LIB, faceY, sound: spec.sound || {}, pageScreen: spec.pageScreen, pageMap: spec.pageMap, pagePaper: spec.pagePaper, sceneIn: spec.sceneIn, sceneOut: spec.sceneOut, source: SRC, rtl, get SPEECH() { return SPEECH; }, get TOTAL() { return TOTAL; } };

// a scene that hands over to an expand/wipe scene stays underneath until the
// incoming panel has covered it
const deferredLeaks = [];   // leak beats need the pack helpers, which are defined after the beat loop (ported from main bd7ae09)
const beatsList = spec.beats || [];
// a template can carry the name tag: on screen from the first frame until the hook page cuts in (or 2.4 s)
// (R1b port)
if (spec.nametag && !beatsList.some((b) => b.type === "nametag")) {
  // first page as the VIEWER meets it, so pick by edit time - but keep its source `at`, because
  // `until` below is a source time that gets mapped through E() with every other beat. When takes
  // are in source order E() is monotonic, so this sorts identically to sorting by `at` and no
  // existing plan changes; it only differs once a take has been moved.
  const pagesByEdit = beatsList.filter((b) => b.type === "scene").sort((x, y) => E(x.at) - E(y.at));
  const firstPage = pagesByEdit.length ? pagesByEdit[0].at : undefined;
  const until = spec.nametag.until === "hook" && firstPage != null && firstPage < 4.5 ? firstPage - 0.05 : (spec.nametag.to ?? 2.4);
  beatsList.unshift({ type: "nametag", name: spec.nametag.name, title: spec.nametag.title, subtitle: spec.nametag.subtitle, at: spec.nametag.at ?? 0.15, to: Math.max(1.2, until), sfx: false });
}
const HANDOVER = 0.45;
for (const b of beatsList) {
  const id = `b${n++}`;
  const t0 = E(b.at, `${b.type} at`);
  let t1 = b.to === undefined ? (b.type === "endcard" ? TOTAL : t0 + (b.type === "meme" ? 1.8 : 2.5)) : E(b.to, `${b.type} to`);
  if (b.type === "scene" && beatsList.some((o) => o !== b && o.type === "scene" && ["expand", "wipe"].includes(o.in) && Math.abs(E(o.at) - t1) < 0.06)) t1 = r3(Math.min(TOTAL, t1 + HANDOVER));
  const dur = r3(t1 - t0);
  const inSlot = ["emoji", "logo", "meme", "icon"].includes(b.type);
  if (inSlot) {
    for (const [s, e] of slotUsed) if (t0 < e && t1 > s) warn.push(`reaction slot double-booked at ${b.at} (${b.type})`);
    slotUsed.push([t0, t1]);
  }
  let inner = "", css = "";
  // cards and the reaction slot avoid the face too (unless the spec pins them)
  const CARD_H = { big: b.sub ? 230 : 180, chips: 200, strike: 190, quote: 90 + (b.lines || []).length * 70, list: 60 + (b.lines || []).length * 64 };
  let cy = CARD.y;
  if (CARD_H[b.type] && spec.layout?.cardY === undefined && face) {
    const pc = placer.card(t0, t1, CARD_H[b.type] * (spec.layout?.compact ? 0.8 : 1));
    if (pc) cy = pc.y;
    else if (b.type === "big") {
      // close-up: no room for a card without covering the face, so the number
      // becomes a short full-screen accent scene instead (voice continues)
      warn.push(`big at ${b.at}: no room beside the face, promoted to a full-screen scene`);
      const subText = typeof b.sub === "string" ? b.sub : null;
      Object.assign(b, { type: "scene", kind: "sentence", bg: "accent", in: b.in ?? "expand", out: b.out ?? "blur", lines: subText ? [subText] : [], hero: { text: b.text, at: b.at, size: b.text.length > 6 ? 170 : 230 }, sfx: b.sfx });
      delete b.sub;
    } else warn.push(`${b.type} at ${b.at}: no room beside the face for a card (close-up); make it a full-screen scene`);
  }
  let slotPos = null;
  if (["emoji", "logo", "meme", "icon"].includes(b.type) && b.x === undefined && b.y === undefined && face) {
    slotPos = placer.slot(t0, t1, b.type === "emoji" ? 360 : b.type === "logo" || b.type === "icon" ? 280 : (b.w ?? 320), b.type === "emoji" ? 360 : 300);
    if (!slotPos) { warn.push(`${b.type} at ${b.at}: the face fills the frame, no room beside it: skipped`); continue; }
  }
  const box = (html, x = CARD.x, y = cy, w = CARD.w) => `<div id="${id}-in" class="ov card" style="left:${x}px;top:${y}px;width:${w}px">${html}</div>`;

  switch (b.type) {
    case "big": {
      inner = box(`<div class="big-text" id="${id}-n">${esc(b.text)}</div>${b.sub ? `<div class="big-sub">${esc(b.sub)}</div>` : ""}`);
      tl.push(enter(`#${id}-in`, t0));
      const num = /^([^\d]*)([\d,.]+)(.*)$/.exec(b.text);
      if (b.count && num) {
        const target = parseFloat(num[2].replace(/,/g, ""));
        tl.push(`(() => { const o = { v: 0 }, el = document.getElementById("${id}-n"); tl.to(o, { v: ${target}, duration: 0.6, ease: "power2.out", onUpdate: () => { el.textContent = ${JSON.stringify(num[1])} + Math.round(o.v).toLocaleString("en-US") + ${JSON.stringify(num[3])}; } }, ${t0}); })();`);
      }
      beatSfx(b, t0, ["whoosh-cine", "impact"], "big", { lead: 0.08 });
      break;
    }
    case "chips": {
      const items = b.items.map((it, i) => {
        const img = it.icon ? icon(it.icon) : it.src ? userAsset(it.src) : null;
        const face = img ? `<img src="${img}" style="${it.invert ? "filter:invert(1);" : ""}"/>` : `<span>${esc(it.text ?? "")}</span>`;
        const at = it.at !== undefined ? E(it.at, "chip") : t0 + i * 0.35;
        tl.push(`ft("#${id}-c${i}", { autoAlpha: 0, scale: 0.4, y: 30 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.35, ease: "back.out(2.4)" }, ${r3(at)});`);
        beatSfx(it, at, "pop", "chip");
        return `<div id="${id}-c${i}" class="chip"><div class="chip-face" style="background:${it.bg || "#fff"};color:${it.fg || "#111"}">${face}</div>${it.label ? `<div class="chip-label">${esc(it.label)}</div>` : ""}</div>`;
      });
      inner = `<div id="${id}-in" class="ov chips" style="left:${CARD.x}px;top:${cy}px;width:${CARD.w}px">${items.join("")}</div>`;
      break;
    }
    case "strike": {
      const st = E(b.strikeAt ?? b.at + 0.6, "strikeAt");
      inner = box(`<div class="strike-wrap"><div class="big-text">${esc(b.text)}</div><div id="${id}-line" class="strike-line"></div></div><div id="${id}-x" class="strike-x">✗</div>`);
      tl.push(enter(`#${id}-in`, t0));
      tl.push(`ft("#${id}-line", { scaleX: 0 }, { scaleX: 1, duration: 0.22, ease: "power2.out" }, ${st});`);
      tl.push(`ft("#${id}-x", { autoAlpha: 0, scale: 2.2 }, { autoAlpha: 1, scale: 1, duration: 0.25, ease: "back.out(2)" }, ${r3(st + 0.15)});`);
      beatSfx(b, st, "whoosh", "strike");
      break;
    }
    case "quote": {
      const lines = b.lines.map((l, i) => {
        const at = E(l.at, "quote line");
        tl.push(`ft("#${id}-l${i}", { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: "power3.out" }, ${at});`);
        if (l.big) beatSfx(l, at, "impact", "quote big line");
        return `<div id="${id}-l${i}" class="${l.big ? "q-big" : "q-line"}">${esc(l.text)}</div>`;
      });
      inner = box(`${b.header ? `<div class="q-head">${esc(b.header)}</div>` : ""}${lines.join("")}`);
      tl.push(enter(`#${id}-in`, t0, "slide"));
      break;
    }
    case "list": {
      const sa = b.stampAt !== undefined ? E(b.stampAt, "stampAt") : null;
      const lines = b.lines.map((l, i) => {
        const at = E(l.at, "list line");
        tl.push(`ft("#${id}-l${i}", { autoAlpha: 0, x: -24 }, { autoAlpha: 1, x: 0, duration: 0.28, ease: "power3.out" }, ${at});`);
        beatSfx(l, at, "pop", "list line");
        if (sa !== null) tl.push(`ft("#${id}-s${i}", { scaleX: 0 }, { scaleX: 1, duration: 0.2 }, ${r3(sa + 0.12 + i * 0.08)});`);
        return `<div id="${id}-l${i}" class="l-line"><span class="l-num">${i + 1}</span><span class="l-text">${esc(l.text)}<i id="${id}-s${i}" class="l-strike"></i></span></div>`;
      });
      const stamp = sa !== null ? `<div id="${id}-stamp" class="stamp">${esc(b.stamp || "nope")}</div>` : "";
      inner = box(`${lines.join("")}${stamp}`);
      tl.push(enter(`#${id}-in`, t0, "slide"));
      if (sa !== null) {
        tl.push(`ft("#${id}-stamp", { autoAlpha: 0, scale: 2.6, rotation: -30 }, { autoAlpha: 1, scale: 1, rotation: -12, duration: 0.22, ease: "power4.in" }, ${sa});`);
        beatSfx({ sfx: b.stampSfx }, sa, ["impact", "buzzer-1"], "stamp");
      }
      break;
    }
    case "emoji": {
      inner = `<div id="${id}-in" class="ov emoji" style="left:${slotPos ? slotPos.x : b.x ?? 690}px;top:${slotPos ? slotPos.y : b.y ?? SLOT.y}px;width:360px;height:360px;font-size:290px;line-height:360px">${b.emoji}</div>`;
      tl.push(enter(`#${id}-in`, t0));
      tl.push(`ft("#${id}-in", { rotation: -14 }, { rotation: 0, duration: 0.6, ease: "elastic.out(1.2,0.35)" }, ${t0});`);
      beatSfx(b, t0, "pop", "emoji");
      break;
    }
    case "slam": {
      // Alif's type-only pattern break: the footage dims and blurs, one huge serif word (plus a small line) lands on it
      // (R1b port)
      const big = esc(String(b.text || "").toUpperCase());
      const fit = Math.min(b.size ?? 300, Math.floor(1000 / Math.max(1, String(b.text || "").length * 0.47)));
      inner = `<div id="${id}-in" class="ov" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
        <div id="${id}-dim" style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 55%, rgba(8,10,14,.45) 0%, rgba(8,10,14,.72) 100%);backdrop-filter:blur(6px)"></div>
        ${b.pre ? `<div style="position:relative;font-family:'Instrument Serif',Georgia,serif;font-size:${Math.round(fit * 0.36)}px;color:#f4efe6;letter-spacing:-0.03em;margin-bottom:-${Math.round(fit * 0.08)}px;text-shadow:0 0 14px rgba(255,255,255,.35)">${esc(b.pre)}</div>` : ""}
        <div id="${id}-big" style="position:relative;font-family:'Instrument Serif',Georgia,serif;font-size:${fit}px;line-height:.9;letter-spacing:-0.035em;color:#fff;text-shadow:0 0 22px rgba(255,255,255,.45), 0 0 2px #fff, 3px 0 0 rgba(230,40,60,.25), -3px 0 0 rgba(20,170,230,.25)">${big}</div>
        ${b.post ? `<div style="position:relative;font-family:'Instrument Serif',Georgia,serif;font-size:${Math.round(fit * 0.36)}px;color:#f4efe6;letter-spacing:-0.03em;margin-top:${Math.round(fit * 0.02)}px;text-shadow:0 0 14px rgba(255,255,255,.35)">${esc(b.post)}</div>` : ""}</div>`;
      tl.push(`ft("#${id}-dim", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.18, ease: "power1.out" }, ${t0});`);
      tl.push(`ft("#${id}-big", { autoAlpha: 0, scale: 1.18, filter: "blur(14px)" }, { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: 0.28, ease: "power3.out" }, ${t0});`);
      tl.push(`ft("#${id}-big", { scale: 1 }, { scale: 1.05, duration: ${r3(Math.max(0.3, t1 - t0 - 0.3))}, ease: "none" }, ${r3(t0 + 0.28)});`);
      tl.push(`tl.to("#${id}-in", { autoAlpha: 0, duration: 0.18, ease: "power2.in" }, ${r3(t1 - 0.18)});`);
      hiddenCaps.push([t0, t1]);
      beatSfx(b, t0, "burn-whoosh-fast", "type slam", { db: 0 });
      break;
    }
    case "nametag": {
      if (spec.nametagStyle === "byline") {
        // Broadsheet: a newspaper byline. "BY NAME" in spaced caps, the outlet and beat in italic serif, a brand rule
        // (R1b port)
        const x = b.x ?? 70, y = b.y ?? 1330;
        inner = `<div id="${id}-scrim" class="ov" style="position:absolute;left:0;right:0;top:${y - 120}px;height:520px;background:linear-gradient(180deg, rgba(10,8,6,0) 0%, rgba(10,8,6,.55) 45%, rgba(10,8,6,.55) 100%)"></div>
        <div id="${id}-in" class="ov" style="left:${x}px;top:${y}px;position:absolute">
          <div id="${id}-rule" style="width:480px;height:7px;background:${b.color ?? brand.accent};margin-bottom:14px;transform-origin:0 50%"></div>
          <div style="font-family:Inter,system-ui,sans-serif;font-weight:800;font-size:50px;letter-spacing:.14em;color:#fff;text-transform:uppercase;text-shadow:0 2px 12px rgba(0,0,0,.55)">By ${esc(b.name || "")}</div>
          <div style="font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:66px;letter-spacing:-0.02em;color:#fbf8f1;line-height:1.02;margin-top:6px;text-shadow:0 2px 14px rgba(0,0,0,.6)">${esc(b.title || "")}${b.subtitle ? `<br>${esc(b.subtitle)}` : ""}</div></div>`;
        tl.push(`ft("#${id}-in", { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: "power3.out" }, ${t0});`);
        tl.push(`ft("#${id}-scrim", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 }, ${t0});`);
        tl.push(`ft("#${id}-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.4, ease: "power2.out" }, ${r3(t0 + 0.05)});`);
        if (spec.sound?.nametag !== false) beatSfx(b, t0, "whoosh", "nametag (byline)", { db: -10 });
        break;
      }
      // Measured against Alif's tags at the same scale: an extra-bold grotesque name with the letters touching,
      // a condensed serif title (every line the same size, packed tight) in a snug box that sweeps in from the
      // left, and a thin hand-drawn hook from the end of the name down into the box.
      const x = b.x ?? 64, y = b.y ?? 1310;
      const nameSize = b.nameSize ?? 66, titleSize = b.titleSize ?? 72;
      const nameW = (b.name || "").length * nameSize * 0.5;          // rough width of the tight bold name
      const arrow = `<svg width="64" height="84" viewBox="0 0 64 84" fill="none" style="position:absolute;left:${Math.round(nameW - 8)}px;top:-18px;overflow:visible"><path d="M6 14 C 22 -2, 54 2, 52 30 C 51 46, 44 58, 36 70" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M27 60 L35 72 L46 63" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      const lines = [b.title, b.subtitle].filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join("");
      inner = `<div id="${id}-in" class="ov" style="left:${x}px;top:${y}px;position:absolute">
        <div style="position:relative;display:inline-block;font-family:'Inter',system-ui,sans-serif;font-size:${nameSize}px;font-weight:800;letter-spacing:-0.075em;line-height:1;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.45);white-space:nowrap">${esc(b.name || "")}${arrow}</div>
        <div style="position:relative;isolation:isolate;display:inline-block;margin:2px 0 0 6px;padding:6px 26px 14px 10px;font-family:'Instrument Serif',Georgia,serif;font-size:${titleSize}px;letter-spacing:-0.06em;line-height:.88;color:#f4efe6;white-space:nowrap;transform:scaleX(.94);transform-origin:0 0"><span id="${id}-bg" style="position:absolute;inset:0;z-index:-1;background:${b.color ?? brand.accent};transform-origin:0 50%"></span>${lines}</div></div>`;
      tl.push(`ft("#${id}-in", { autoAlpha: 0, x: -30 }, { autoAlpha: 1, x: 0, duration: 0.35, ease: "power3.out" }, ${t0});`);
      // the box fills from the left once the words are up, like ink being laid down (Alif)
      if (b.wipe !== false) tl.push(`ft("#${id}-bg", { scaleX: 0 }, { scaleX: 1, duration: ${b.wipeDur ?? 0.42}, ease: "power2.out" }, ${r3(t0 + 0.08)});`);
      if (spec.sound?.nametag !== false) beatSfx(b, t0, "whoosh", "nametag", { db: -10 });
      break;
    }
    case "icon": {
      // a gold glass tile with a line icon (Lucide, ISC licence) for a named concept: "working towards" -> signpost
      const svgPath = path.join(A, "icons", `lucide-${b.name}.svg`);
      if (!fs.existsSync(svgPath)) {
        try { execFileSync("curl", ["-sfL", "-o", svgPath, `https://cdn.jsdelivr.net/npm/lucide-static@latest/icons/${b.name}.svg`]); }
        catch { die(`no Lucide icon '${b.name}' (see https://lucide.dev/icons)`); }
      }
      const svg = fs.readFileSync(svgPath, "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/width="24"/, 'width="120"').replace(/height="24"/, 'height="120"')
        .replace(/stroke="currentColor"/, `stroke="${b.ink ?? "#fff8e6"}"`).replace(/stroke-width="2"/, 'stroke-width="1.6"');
      const x = b.x ?? (slotPos ? slotPos.x : SLOT.x), y = b.y ?? (slotPos ? slotPos.y : SLOT.y);
      inner = `<div id="${id}-in" class="ov icon-tile" style="left:${x}px;top:${y}px">${svg}</div>`;
      tl.push(enter(`#${id}-in`, t0));
      tl.push(`tl.to("#${id}-in", { y: -12, duration: ${r3(Math.max(0.4, t1 - t0 - 0.3))}, ease: "sine.inOut" }, ${r3(t0 + 0.3)});`);
      beatSfx(b, t0, "ding-1", "icon tile", { db: -6 });
      break;
    }
    case "logo": {
      const img = b.icon ? icon(b.icon) : userAsset(b.src);
      inner = `<div id="${id}-in" class="ov logo" style="left:${slotPos ? slotPos.x : SLOT.x}px;top:${slotPos ? slotPos.y : SLOT.y}px;background:${b.bg || "#fff"}"><img src="${img}" style="${b.invert ? "filter:invert(1);" : ""}"/></div>`;
      tl.push(enter(`#${id}-in`, t0));
      beatSfx(b, t0, "pop", "logo");
      break;
    }
    case "meme": {
      const { dir, meta } = memeLib(b.id);
      const file = meta.clip || meta.image;
      const dst = `assets/memes/${b.id}-${path.basename(file)}`;
      fs.copyFileSync(path.join(dir, file), path.join(proj, dst));
      const w = b.w ?? meta.w ?? 320;
      const x = b.x ?? (slotPos ? slotPos.x : Math.min(W - w - 40, SLOT.x)), y = b.y ?? (slotPos ? slotPos.y : SLOT.y);
      const tilt = b.tilt ?? (n % 2 ? 4 : -4);
      if (meta.clip) {
        // alpha webm: timed video inside an UNtimed wrapper; the wrapper animates
        const clipIn = b.in ?? meta.in ?? 0; // beat-level "in": start later in the clip
        const md = Math.min(dur, (meta.duration ?? dur) - clipIn);
        inner = `<div id="${id}-in" class="ov meme-clip${meta.has_alpha ? "" : " meme-framed"}" style="left:${x}px;top:${y}px;width:${w}px">
        <video id="${id}-v" src="${dst}" data-start="${t0}" data-duration="${r3(md)}" data-media-start="${clipIn}" muted playsinline style="width:100%;display:block"></video></div>`;
        if (meta.has_audio && b.audio !== false) {
          overlays.push({ audio: `<audio id="${id}-a" src="${dst}" data-start="${t0}" data-duration="${r3(md)}" data-media-start="${clipIn}" data-track-index="12" data-volume="${volFor("meme", b.db ?? 0)}"></audio>` });
          sfxEvents.push({ t: t0, id: `meme:${b.id}`, role: "meme", vol: volFor("meme", b.db ?? 0), dur: md, src: dst, why: "meme clip audio" });
        }
        tl.push(`ft("#${id}-in", { autoAlpha: 0, scale: 0.5, rotation: ${tilt + 14} }, { autoAlpha: 1, scale: 1, rotation: ${tilt}, duration: 0.3, ease: "back.out(2)" }, ${t0});`);
        tl.push(`tl.to("#${id}-in", { autoAlpha: 0, scale: 0.85, duration: 0.15 }, ${r3(t0 + md - 0.17)});`);
        if (b.sfx) beatSfx(b, t0, null, "meme extra");
      } else {
        inner = `<div id="${id}-in" class="ov meme-img" style="left:${x}px;top:${y}px;width:${w}px"><img src="${dst}"/></div>`;
        tl.push(`ft("#${id}-in", { autoAlpha: 0, scale: 0.5, rotation: ${tilt + 14} }, { autoAlpha: 1, scale: 1, rotation: ${tilt}, duration: 0.32, ease: "back.out(2)" }, ${t0});`);
        // default punch: vine boom when the (private) rip kit has it, else a licensed impact
        const memeDefault = meta.sfx && sfxManifest[meta.sfx] ? meta.sfx : sfxManifest["vine-boom"] ? "vine-boom" : "cinematic-deep-boom" in sfxManifest ? "cinematic-deep-boom" : "impact";
        beatSfx(b, t0, memeDefault, "meme image");
      }
      break;
    }
    case "endcard": {
      inner = `<div id="${id}-dim" class="ov dim"></div><div id="${id}-in" class="ov endcard">${b.title ? `<div class="ec-title">${esc(b.title)}</div>` : ""}${b.line ? `<div class="ec-line">${esc(b.line)}</div>` : ""}${b.url ? `<div class="ec-url">${esc(b.url)}</div>` : ""}</div>`;
      tl.push(`ft("#${id}-dim", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 }, ${t0});`);
      tl.push(enter(`#${id}-in`, r3(t0 + 0.1), "slide"));
      beatSfx(b, t0, "whoosh", "endcard");
      break;
    }
    case "behind": {
      // lives INSIDE the camera wrappers, between the plate and the matte, so it
      // zooms with the speaker and the person stays in front of the letters
      if (!spec.matte) die("a 'behind' beat needs \"matte\": true (a person cut-out of talk.mp4)");
      // fit the frame width (display type runs ~0.8 em per char), and sit where the
      // head is so the matte actually covers part of the letters
      const size = Math.min(b.size ?? 300, Math.floor(1180 / Math.max(1, b.text.length * 0.8)));
      let y = b.y;
      if (y === undefined) { const sp = face ? placer.span(t0, t1) : null; y = sp && sp.seen ? Math.round(Math.max(placer.safeTop, sp.top + (sp.eyes - sp.top) * 0.35 - size * 0.55)) : 380; }
      behindHtml.push(`<div id="${id}" class="clip behind" data-start="${t0}" data-duration="${dur}" data-track-index="1"><div id="${id}-in" class="behind-in" style="top:${y}px;font-size:${size}px;color:${b.color ?? brand.accent}">${esc(b.text)}</div></div>`);
      tl.push(`ft("#${id}-in", { autoAlpha: 0, y: 80, scaleY: 1.6 }, { autoAlpha: 1, y: 0, scaleY: 1, duration: 0.45, ease: "expo.out" }, ${t0});`);
      tl.push(`tl.to("#${id}-in", { autoAlpha: 0, y: -40, duration: 0.2, ease: "power2.in" }, ${r3(t1 - 0.22)});`);
      beatSfx(b, t0, "impact", "behind word");
      break;
    }
    case "scene": {
      const sd = spec.scenes || {};
      const bb = { ...(sd[b.kind] || {}), ...b };
      if (b.in === undefined && sd.default_in) bb.in = sd.default_in;
      inner = buildScene(bb, id, t0, t1, motionCtx);
      if (b.captions !== true) hiddenCaps.push([t0, t1]); else shownCaps.push([t0, t1]);
      break;
    }
    // --- ported from origin/main (Ahmedmkarrar/phantasic) bd7ae09, 1 Oct: the beat types the
    // mono / pitch / monologue templates need. Additive by decision - no existing case changed.
    case "titlebox": {
      // the hook title types on letter by letter in an accent box that slides in tilted from the top left
      // and settles centred near the top; the box grows with the letters
      const chars = [...b.text];
      const step = Math.min(0.045, (b.typeFor ?? 0.8) / chars.length);
      inner = `<div id="${id}-in" class="ov tbox" style="top:${b.y ?? 250}px"><div class="tbox-in" style="background:${b.color ?? brand.accent};font-size:${b.size ?? 66}px">${chars.map((c, k) => `<span id="${id}-c${k}" style="display:none">${c === " " ? "&nbsp;" : esc(c)}</span>`).join("")}</div></div>`;
      chars.forEach((c, k) => tl.push(`tl.set("#${id}-c${k}", { display: "inline" }, ${r3(t0 + (k ? k * step : -0.02))});`));
      tl.push(`ft("#${id}-in", { xPercent: -50, x: -240, y: -30, rotation: -7, scale: 0.88, autoAlpha: 0 }, { xPercent: -50, x: 0, y: 0, rotation: 0, scale: 1, autoAlpha: 1, duration: 1.0, ease: "power3.out" }, ${t0});`);
      beatSfx(b, t0, "typing-1", "title type-on", { db: -8 });
      break;
    }
    case "popcard": {
      // a framed picture flips in over the speaker with the spoken word on an accent label; the camera behind
      // softly defocuses and dims so the card is the one sharp thing in frame
      const img = b.ui ? null : b.art ? artAsset(b.art) : userAsset(b.src);
      const w = b.w ?? spec.popcard?.w ?? 620, h = b.h ?? spec.popcard?.h ?? 560, y = b.y ?? spec.popcard?.y ?? 300;
      const face = b.ui ? uiCard(b.ui, `${id}u`, t0, t1, motionCtx).html : `<img id="${id}-img" class="popcard-img" src="${img}" style="max-width:${w}px;max-height:${h}px" />`;
      inner = `<div id="${id}-in" class="ov popcard" style="top:${y}px">${face}${b.label ? `<div id="${id}-lab" class="popcard-lab" style="background:${brand.accent};font-size:${b.labelSize ?? 64}px">${esc(b.label)}</div>` : ""}</div>`;
      tl.push(`ft("#${id}-in", { xPercent: -50, autoAlpha: 0, rotationY: ${b.tilt ?? 70}, rotationX: -12, scale: 0.72, filter: "blur(14px)" }, { xPercent: -50, autoAlpha: 1, rotationY: 0, rotationX: 0, scale: 1, filter: "blur(0px)", duration: 0.45, ease: "expo.out" }, ${t0});`);
      tl.push(`tl.to("#${id}-in", { y: -14, duration: ${r3(Math.max(0.3, t1 - t0 - 0.3))}, ease: "sine.inOut" }, ${r3(t0 + 0.3)});`);
      if (b.label) tl.push(`ft("#${id}-lab", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.24, ease: "power3.out" }, ${r3(t0 + 0.18)});`);
      if (b.defocus !== false) {
        tl.push(`tl.to("#fx", { filter: "blur(${b.blur ?? 9}px) brightness(0.72)", duration: 0.25, ease: "power2.out" }, ${t0});`);
        tl.push(`tl.to("#fx", { filter: "blur(0px) brightness(1)", duration: 0.26, ease: "power2.out" }, ${r3(t1 - 0.3)});`);
      }
      hiddenCaps.push([t0, t1]);
      beatSfx(b, t0, "pop-whoosh-light", "pop card", { db: -4 });
      break;
    }
    case "leak": {
      // a warm light-leak flash (a real burn/leak clip, screen-blended) with a bloom on the camera: the "$80" transition
      deferredLeaks.push({ b, t0, t1 });
      tl.push(`tl.to("#fx", { filter: "blur(0px) brightness(${b.bloom ?? 1.5})", duration: 0.1, ease: "power2.out" }, ${t0});`);
      tl.push(`tl.to("#fx", { filter: "blur(0px) brightness(1)", duration: 0.25, ease: "power2.in" }, ${r3(Math.max(t0 + 0.12, t1 - 0.25))});`);
      beatSfx(b, t0, "whoosh", "light leak", { db: -6 });
      break;
    }
    case "mood": {
      // a whole sentence drops to black and white (hard cut in and out, like a grade change between shots)
      const g = spec.look?.grade ?? "";
      tl.push(`tl.set("#base", { filter: "${g} grayscale(1) contrast(1.12)".trim() }, ${t0});`);
      tl.push(`tl.set("#base", { filter: "${g || "none"}" }, ${r3(t1)});`);
      break;
    }
    case "scene": {
      const sd = spec.scenes || {};
      const bb = { ...(sd[b.kind] || {}), ...b };
      if (b.in === undefined && sd.default_in) bb.in = sd.default_in;
      inner = buildScene(bb, id, t0, t1, motionCtx);
      if (b.captions !== true) hiddenCaps.push([t0, t1]); else shownCaps.push([t0, t1]);
      break;
    }

    default:
      die(`unknown beat type '${b.type}'`);
  }
  if (b.type === "behind") continue;
  if (!["endcard", "scene"].includes(b.type) && !(b.type === "meme" && memeLib(b.id).meta.clip)) tl.push(exit(`#${id}-in`, t1));
  const clipMeme = b.type === "meme" && memeLib(b.id).meta.clip;
  overlays.push({ html: clipMeme
    ? `<div id="${id}" class="layer">${inner}</div>` // the <video> inside is the timed element; a timed wrapper would break it
    : `<div id="${id}" class="clip layer" data-start="${t0}" data-duration="${dur}" data-track-index="${b.type === "scene" ? 4 : inSlot ? 3 : 2}">${inner}</div>` });
}

for (const s of spec.sfx || []) addSfx(E(s.at, "sfx"), s.id, "manual", { db: s.db ?? 0, lead: s.lead ?? 0 });

// ---------- SFX rules ----------
sfxEvents.sort((a, b) => a.t - b.t);
const memeHits = sfxEvents.filter((e) => e.role === "meme");
const seenMeme = new Set();
for (const e of memeHits) {
  if (seenMeme.has(e.id)) warn.push(`meme sound '${e.id}' used twice; never repeat a meme sound in one reel`);
  seenMeme.add(e.id);
}
for (let i = 1; i < memeHits.length; i++) if (memeHits[i].t - memeHits[i - 1].t < 8) warn.push(`meme sounds ${memeHits[i - 1].id} and ${memeHits[i].id} only ${(memeHits[i].t - memeHits[i - 1].t).toFixed(1)}s apart (want >= 8 s)`);
const perMin = (xs) => (xs.length / Math.max(TOTAL, 1)) * 60;
// a layered hit (whoosh + impact on one frame) is one event to the ear
const accent = sfxEvents.filter((e) => e.role !== "ui").filter((e, i, xs) => !xs.slice(0, i).some((p) => Math.abs(p.t - e.t) < 0.2));
if (perMin(memeHits) > 3.5) warn.push(`${perMin(memeHits).toFixed(1)} meme sounds/min (want 1-3)`);
if (perMin(accent) > 14) warn.push(`${perMin(accent).toFixed(1)} whoosh/impact/meme hits per min (want <= 12)`);
// a meme hit should land in air, not on top of speech
for (const e of memeHits) {
  const talking = words.filter((w) => w.start < e.t + 0.5 && w.end > e.t + 0.05);
  if (talking.length) warn.push(`meme sound ${e.id} at ${e.t}s lands on speech ("${talking.map((w) => w.word).join(" ")}"); put it in a pause or on the last word's end`);
}
const sfxAudio = sfxEvents.filter((e) => !e.id.startsWith("meme:")).map((e, i) =>
  `<audio id="sfx-${i}" src="${e.src}" data-start="${e.t}" data-duration="${r3(Math.min(e.dur, TOTAL - e.t))}" data-track-index="${14 + (i % 4)}" data-volume="${e.vol}"></audio>`);

motionCtx.placeCaption = (t0, t1, h) => placer.place(t0, t1, h);
motionCtx.sidePad = placer.sidePad;

// ---------- captions ----------
const cap = { style: "house", group: 3, highlight: null, ...(spec.captions || {}) };
if (cap.style === "clean" && !cap.highlight) cap.highlight = brand.accent;
// box: the Closer (whole phrase on a solid accent box); condensed: the Headline (tall 1-2 word caps);
// serif: the Monk (small lowercase serif, no motion)
const CAP_SIZES = { pill: 66, box: cap.size ?? 60, condensed: cap.size ?? 104, serif: cap.size ?? 52, sessions: cap.size ?? 64 };
if (cap.style === "sessions") { cap.pop ??= false; cap.reveal ??= "word"; }
if (cap.style === "clipping") { cap.pop ??= false; cap.reveal ??= "none"; }  // R1b port (Broadsheet)
if (cap.style === "serif") { cap.pop ??= false; cap.lowercase ??= true; }
if (["box", "condensed"].includes(cap.style)) cap.upper ??= true;
const caseOf = (word) => cap.upper ? word.toUpperCase() : cap.lowercase === true ? word.toLowerCase() : word;
const WEAK_END = /^(a|an|the|to|of|and|or|but|in|on|at|for|with|my|your|his|her|their|our|is|are|was|he's|she's|it's|i'm|you're|we're|they're|i|you|he|she|we|they|gonna|wanna|have|has|had|be|so|if|that|this|just)$/i;
// captions.smartBreaks is OPT-IN (decision 6): the three rules below (weak trailing word,
// one-word orphans, minimum read time) run only when a style or reel asks for them with
// `true`. Defaulting them on silently re-captioned every pre-existing style, which would
// invalidate the measured caption rates in CATALOG.md that The Closer, The Monk and The
// Headline were tuned against.
const SMART = cap.smartBreaks === true;
const groups = [];
let cur = [];
for (const w of words) {
  if (cur.length && (w.start - cur.at(-1).end > 0.6)) { groups.push(cur); cur = []; }
  cur.push(w);
  // don't strand a phrase on a weak word ("GONNA HAVE TO" / "OKAY OKAY HE'S"): allow one extra word
  const bare = w.word.replace(/[^a-z']/gi, "");
  const weak = SMART && (WEAK_END.test(bare) || /[a-z]'s$/i.test(bare)) && cur.length <= cap.group;
  const size = cur.reduce((n, x) => n + x.word.trim().split(/\s+/).length, 0);
  if ((size >= cap.group && !weak) || size > cap.group + 1 || /[.?!,]$/.test(w.word)) { groups.push(cur); cur = []; }
}
if (cur.length) groups.push(cur);
// no one-word orphans ("it." / "okay," / "ChatGPT?"): fold into the phrase they belong to
const wc = (g) => g.reduce((n, x) => n + x.word.trim().split(/\s+/).length, 0);
for (let i = 0; i < groups.length; i++) {
  if (!SMART || wc(groups[i]) !== 1 || groups.length < 2) continue;
  const g = groups[i], prev = groups[i - 1], next = groups[i + 1];
  const joinsPrev = prev && !/[.?!]$/.test(prev.at(-1).word) && g[0].start - prev.at(-1).end < 0.6 && wc(prev) <= cap.group + 1;
  const joinsNext = next && !/[.?!]$/.test(g[0].word) && next[0].start - g[0].end < 0.6 && wc(next) <= cap.group;
  if (joinsPrev) { prev.push(...g); groups.splice(i--, 1); }
  else if (joinsNext) { next.unshift(...g); groups.splice(i--, 1); }
}
// fast talk: a phrase on screen for under ~0.5 s can't be read; give it the next phrase's words too
const MIN_READ = cap.minRead ?? 0.5;
for (let i = 0; i < groups.length - 1; i++) {
  const g = groups[i], next = groups[i + 1];
  if (!SMART || next[0].start - g[0].start >= MIN_READ || /[.?!]$/.test(g.at(-1).word)) continue;
  if (wc(g) + wc(next) > cap.group + 4) continue;
  g.push(...next); groups.splice(i + 1, 1); i--;
}
// captions.onlyInScenes: the recording already has burned-in captions, so ours
// appear only over scenes that cover them (e.g. an image scene)
const complement = (wins) => { const out = []; let c = 0; for (const [a, b] of [...wins].sort((x, y) => x[0] - y[0])) { if (a > c) out.push([c, a]); c = Math.max(c, b); } if (c < TOTAL) out.push([c, TOTAL + 1]); return out; };
// every caption style hides under full-screen scenes (editorial handles its own)
if (cap.style !== "editorial" && cap.style !== "none") {
  const wins = cap.onlyInScenes ? complement(shownCaps) : hiddenCaps;
  const merged = [];
  for (const [a, b] of [...wins].sort((x, y) => x[0] - y[0])) { if (merged.length && a <= merged.at(-1)[1] + 0.05) merged.at(-1)[1] = Math.max(merged.at(-1)[1], b); else merged.push([a, b]); }
  tl.push(`tl.set("#caps", { autoAlpha: 1 }, 0);`);
  for (const [a, b] of merged) { tl.push(`tl.to("#caps", { autoAlpha: 0, duration: 0.06 }, ${r3(Math.max(0, a - 0.06))});`); tl.push(`tl.to("#caps", { autoAlpha: 1, duration: 0.12 }, ${r3(b - 0.05)});`); }
}
const edit = cap.style === "editorial" ? buildEditorialCaptions(words, cap, motionCtx, cap.onlyInScenes ? complement(shownCaps) : hiddenCaps) : null;
const capHtml = cap.style === "none" || edit ? "" : groups.map((g, gi) => {
  const s = Math.max(0, g[0].start - 0.05);
  const nextS = gi + 1 < groups.length ? groups[gi + 1][0].start - 0.05 : SPEECH;
  const e = Math.min(g.at(-1).end + 0.3, nextS, SPEECH, g.at(-1).end + (cap.maxHold ?? 99));
  g.forEach((w, wi) => {
    if (cap.pop !== false) tl.push(`ft("#cg${gi}w${wi}", { scale: 1 }, { scale: 1.08, duration: 0.08, yoyo: true, repeat: 1, ease: "power1.out" }, ${r3(w.start)});`);
    // reveal: word -> each word appears when it's spoken; the box is already sized for the whole phrase
    if (cap.style === "clipping" && wi === 0) tl.push(`ft("#cg${gi}", { scale: 0.9 }, { scale: 1, duration: 0.12, ease: "back.out(2.5)" }, ${r3(s)});`);  // R1b port (Broadsheet)
    if (cap.reveal === "word" && wi > 0) tl.push(`ft("#cg${gi}w${wi}", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.05 }, ${r3(Math.max(s, w.start - 0.02))});`);
    if (cap.highlight) tl.push(`tl.set("#cg${gi}w${wi}", { color: "${cap.highlight}" }, ${r3(w.start)}); tl.set("#cg${gi}w${wi}", { color: "#fff" }, ${r3(Math.min(w.end + 0.02, e - 0.01))});`);
  });
  const capSize = CAP_SIZES[cap.style] ?? (cap.style === "clean" ? (cap.size ?? brand.capSize) : (cap.size ?? 56));
  const pl = placer.place(s, e, capSize * (["pill", "box"].includes(cap.style) ? 1.6 : 1.3));
  const backed = pl.mode === "lower-face" && !["pill", "box", "sessions"].includes(cap.style);
  const tilt = cap.tilt ? `;rotate:${gi % 2 ? -cap.tilt : cap.tilt * 0.7}deg` : "";  // R1b port (Broadsheet clippings)
  return `<div id="cg${gi}" class="cap-group clip${backed ? " cap-backed" : ""}" style="top:${pl.y}px${tilt}${pl.scale && pl.scale < 1 ? `;transform:translateX(-50%) scale(${pl.scale});transform-origin:50% 0` : ""}" data-start="${r3(s)}" data-duration="${r3(Math.max(0.1, e - s))}" data-track-index="5">${g.map((w, wi) => `<span id="cg${gi}w${wi}" class="w">${esc(caseOf(w.word))}</span>`).join("<wbr>")}</div>`;
}).join("\n      ");

const cyr = /[\u0400-\u04FF]/.test(JSON.stringify(spec.beats || []) + words.map((w) => w.word).join(" "));
const UI_FONT = brand.font || (cyr ? "Inter" : "Geist");
const capCss = cap.style === "clean"
  ? `.cap-group { font-family: ${UI_FONT}, "Noto Sans Arabic", system-ui, sans-serif; font-size: ${cap.size ?? brand.capSize}px; font-weight: 800; color: #fff; letter-spacing: -1px; text-shadow: 0 4px 18px rgba(0,0,0,.55), 0 1px 3px rgba(0,0,0,.6); }`
  : cap.style === "pill"
  ? `.cap-group { font-family: ${UI_FONT}, "Noto Sans Arabic", system-ui, sans-serif; font-size: 66px; font-weight: 800; color: #fff; background: rgba(12,12,14,.88); border-radius: 22px; padding: 16px 32px; max-width: 900px; }`
  : cap.style === "box"
  ? `.cap-group { font-family: ${brand.font || "Montserrat"}, "Noto Sans Arabic", system-ui, sans-serif; font-size: ${CAP_SIZES.box}px; font-weight: 900; line-height: 1.08; color: ${cap.ink ?? brand.ink ?? "#111"}; background: ${cap.boxColor ?? brand.accent}; border-radius: 12px; padding: 10px 24px 14px; max-width: 860px; text-align: center; box-shadow: 0 10px 28px rgba(0,0,0,.28); }
  .cap-group .w { margin: 0 0.14em; }`
  : cap.style === "condensed"
  ? `.cap-group { font-family: ${cap.font ?? "Oswald"}, "Noto Sans Arabic", sans-serif; font-size: ${CAP_SIZES.condensed}px; font-weight: 700; line-height: .95; letter-spacing: 1px; color: #fff; max-width: 920px; text-align: center; text-shadow: 0 6px 22px rgba(0,0,0,.6), 0 2px 4px rgba(0,0,0,.7); }`
  : cap.style === "clipping"
  ? `.cap-group { font-family: Gloock, "Noto Sans Arabic", Georgia, serif; font-size: ${cap.size ?? 58}px; line-height: 1.08; letter-spacing: -0.01em; color: #fbf8f1; background: #141210; padding: 6px 20px 12px; max-width: 900px; text-align: center; box-shadow: 0 10px 22px rgba(0,0,0,.35); }
  .cap-group .w { margin: 0 0.12em; }`
  : cap.style === "sessions"
  // R1b port: restyled to match editorial-collage's locked look (shares this style key with alif.json,
  // which had no CATALOG.md-tracked caption rate and no fixture dependency - see R1b's report for the tradeoff)
  ? `.cap-group { font-family: "${cap.font ?? "Instrument Serif"}", "Noto Sans Arabic", Georgia, serif; font-size: ${CAP_SIZES.sessions}px; font-weight: 400; line-height: 1.12; letter-spacing: -0.05em; color: #fff; max-width: 860px; text-align: center; -webkit-text-stroke: 0.2px #fff; text-shadow: 0 0 8px rgba(255,255,255,.4), 0 0 1px rgba(255,255,255,.85); }
  .cap-group { background: rgba(98,98,104,.6); padding: 5px 14px 10px; border-radius: 1px; }
  .cap-group .w { margin: 0 0.055em; }`
  : cap.style === "serif"
  ? `.cap-group { font-family: ${cap.font ?? "EB Garamond"}, "Noto Sans Arabic", Georgia, serif; font-size: ${CAP_SIZES.serif}px; font-weight: 500; line-height: 1.15; color: ${cap.color ?? "#E7C66B"}; max-width: 900px; text-align: center; text-shadow: 0 2px 12px rgba(0,0,0,.55); }
  .cap-group .w { margin: 0 0.12em; }`
  : `.cap-group { font-family: Arial, "Noto Sans Arabic", Helvetica, sans-serif; font-size: ${cap.size ?? 56}px; font-weight: 700; color: #fff; max-width: 900px;
      -webkit-text-stroke: 8px #000; paint-order: stroke fill; text-shadow: 0 4px 10px rgba(0,0,0,.35); }`;

// ---------- asset packs (library/packs/<pack>/<kind>/*.mp4), gated by spec.packs ----------
// A pack is used only when the style or reel turns it on (e.g. "packs": { "editorsinventory": true }) and its
// row in engine/assets/LEDGER.md says it may ship. Clips are picked round-robin so repeats are spread out.
// This fork does not yet have library/packs/ (out of scope for this port - a separate asset-restore task),
// so packClip always returns null here and every caller below degrades to its asset-free fallback.
const packRR = {};
const packClip = (pack, kind) => {
  if (!spec.packs?.[pack]) return null;
  const dir = path.join(LIB, "packs", pack, kind);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mp4")).sort();
  if (!files.length) return null;
  const key = `${pack}/${kind}`;
  packRR[key] = ((packRR[key] ?? -1) + 1) % files.length;
  const f = files[packRR[key]];
  fs.mkdirSync(path.join(A, "pack"), { recursive: true });
  const dst = path.join(A, "pack", `${pack}-${kind}-${f}`);
  if (!fs.existsSync(dst)) fs.copyFileSync(path.join(dir, f), dst);
  return `assets/pack/${pack}-${kind}-${f}`;
};
const packOf = spec.packs ? Object.keys(spec.packs).find((k) => spec.packs[k]) : null;
const topOverlays = [];
let packN = 0;
const packOverlay = (src, t0, dur, { blend = "screen", z = 7, opacity = 1, media = 0, fadeIn = 0.15, fadeOut = 0.3, filter = "" } = {}) => {
  const id = `pk${packN++}`;
  topOverlays.push(`<video id="${id}" class="clip" src="${src}" data-start="${r3(Math.max(0, t0))}" data-duration="${r3(dur)}" data-media-start="${media}" data-track-index="${30 + (packN % 8)}" muted playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:${z};mix-blend-mode:${blend};opacity:0;pointer-events:none${filter ? `;filter:${filter}` : ""}"></video>`);
  tl.push(`ft("#${id}", { opacity: 0 }, { opacity: ${opacity}, duration: ${fadeIn}, ease: "power1.in" }, ${r3(Math.max(0, t0))});`);
  tl.push(`tl.to("#${id}", { opacity: 0, duration: ${fadeOut}, ease: "power1.out" }, ${r3(Math.max(0, t0) + dur - fadeOut)});`);
};

// a `leak` beat, resolved here because packClip/packOverlay are defined above (ported from main bd7ae09)
for (const { b, t0, t1 } of deferredLeaks) {
  const clip = packClip(packOf, b.kind ?? "leaks") || packClip(packOf, "burns");
  if (clip) packOverlay(clip, t0, Math.max(0.3, t1 - t0), { blend: "screen", z: 7, opacity: b.opacity ?? 1, media: b.media ?? 0.2, fadeIn: 0.06, fadeOut: 0.2 });
  else warn.push(`leak at ${b.at}: no leak/burn clip (turn a pack on in the style's "packs")`);
}

// ---------- watermark (spec.watermark = { text, opacity?, font? }) and colour tint (spec.look.tint) ----------
let brandHtml = "";
if (spec.watermark?.text) brandHtml += `<div style="position:absolute;top:${spec.watermark.y ?? 120}px;right:${spec.watermark.x ?? 60}px;z-index:9;font-family:'${spec.watermark.font ?? "Instrument Serif"}',Georgia,serif;font-size:${spec.watermark.size ?? 54}px;letter-spacing:-0.5px;color:#fff;opacity:${spec.watermark.opacity ?? 0.38};pointer-events:none">${esc(spec.watermark.text)}</div>`;
if (spec.look?.tint) brandHtml += `<div style="position:absolute;inset:0;z-index:3;pointer-events:none;background:${spec.look.tint.color ?? "#1d6b75"};mix-blend-mode:${spec.look.tint.blend ?? "soft-light"};opacity:${spec.look.tint.opacity ?? 0.22}"></div>`;
if (spec.look?.grade) tl.push(`tl.set("#base", { filter: "${spec.look.grade}" }, 0);`);

// ---------- light leaks (spec.leaks = { every, color?, at? }) ----------
// A warm burn-through flash that hides a cut between sections. Auto: on take joins, spaced by `every` seconds.
let leakHtml = "";
if (spec.leaks) {
  const every = spec.leaks.every ?? 8, color = spec.leaks.color ?? "255,176,64";
  const times = spec.leaks.at ? spec.leaks.at.map((t) => E(t, "leak")) : [];
  if (!spec.leaks.at) {
    let last = -Infinity;
    for (const k of takes.slice(1)) if (k.start - last >= every && k.start > 2 && k.start < SPEECH - 2) { times.push(r3(k.start)); last = k.start; }
  }
  times.forEach((t, i) => {
    const clip = packOf && packClip(packOf, "leaks");
    // Alif: a flash is never silent; the whoosh rides it
    if (spec.sound?.leaks) addSfx(t - 0.3, spec.sound.leakSfx ?? "whoosh-cine", "light leak", { db: spec.sound.leakDb ?? -12 });
    if (clip) { packOverlay(clip, t - 0.35, 1.3, { blend: "screen", z: 7, opacity: 1, media: spec.leaks.media ?? 1.2, fadeIn: 0.25, fadeOut: 0.5, filter: spec.leaks.boost ?? "brightness(1.9) saturate(1.25)" }); return; }
    leakHtml += `<div id="leak${i}" class="clip" data-start="${r3(Math.max(0, t - 0.25))}" data-duration="0.9" data-track-index="10" style="position:absolute;inset:0;z-index:7;pointer-events:none;mix-blend-mode:screen;opacity:0;background:radial-gradient(ellipse 120% 90% at 30% 40%, rgba(${color},0.95) 0%, rgba(${color},0.55) 35%, rgba(255,90,20,0.18) 70%, rgba(0,0,0,0) 100%)"></div>`;
    tl.push(`ft("#leak${i}", { opacity: 0 }, { opacity: 1, duration: 0.22, ease: "power2.in" }, ${r3(Math.max(0, t - 0.22))});`);
    tl.push(`tl.to("#leak${i}", { opacity: 0, duration: 0.55, ease: "power2.out" }, ${r3(t + 0.05)});`);
  });
  if (times.length) console.log(`light leaks: ${times.length} at ${times.join(", ")}`);
}

// ---------- 8mm film gate over B-roll scenes (scene option gate: "8mm", or spec.scenes.<kind>.gate) ----------
if (packOf) for (const b of beatsList) {
  const sd = (spec.scenes || {})[b.kind] || {};
  if (b.type !== "scene" || (b.gate ?? sd.gate) !== "8mm") continue;
  const t0 = E(b.at), t1 = E(b.to);
  const matte = packClip(packOf, "8mm-gate"), dust = packClip(packOf, "8mm-dust");
  if (matte) packOverlay(matte, t0, t1 - t0, { blend: "multiply", z: 6, opacity: 1, fadeIn: 0.05, fadeOut: 0.1 });
  if (dust) packOverlay(dust, t0, t1 - t0, { blend: "screen", z: 6, opacity: 0.7, fadeIn: 0.05, fadeOut: 0.1 });
}

// ---------- film burns (spec.burns = { at?, onScenes? }) ----------
if (spec.burns && packOf) {
  const times = (spec.burns.at || []).map((t) => E(t, "burn"));
  if (spec.burns.onScenes) for (const b of beatsList) if (b.type === "scene" && ["image", "window", "tv"].includes(b.kind)) times.push(E(b.at));
  for (const t of [...new Set(times.map(r3))].sort((a, b) => a - b)) {
    const clip = packClip(packOf, "burns");
    if (clip) packOverlay(clip, t - 0.2, 0.9, { blend: "screen", z: 9, opacity: 1, fadeIn: 0.08, fadeOut: 0.35 });
  }
}

// ---------- opening flash (spec.openFlash = { at?, dur?, color?, clip?, sfx?, db? }) ----------
// The hook: a split-second warm film burn that sweeps in from the left edge on the first frame (Alif reels),
// with a soft film-flash sound under the voice. A glow, not a whiteout: the face stays readable.
let flashN = 0;
const brandFlash = (f, t, why, { side = "left" } = {}) => {
  const dur = f.dur ?? 0.4, fid = `oflash${flashN++}`;
  const [c1, c2] = f.color ?? ["255,92,40", "255,150,120"];
  const x = side === "left" ? [4, 0, 90] : [96, 100, 270];
  leakHtml += `<div id="${fid}" class="clip" data-start="${r3(t)}" data-duration="${r3(dur)}" data-track-index="11" style="position:absolute;inset:0;z-index:12;pointer-events:none;mix-blend-mode:screen;opacity:0;background:radial-gradient(ellipse 70% 55% at ${x[0]}% 74%, rgba(${c1},1) 0%, rgba(${c1},.85) 40%, rgba(${c1},0) 100%), radial-gradient(ellipse 45% 70% at ${x[1]}% 30%, rgba(${c2},.85) 0%, rgba(${c2},0) 100%), linear-gradient(${x[2]}deg, rgba(${c1},.55) 0%, rgba(${c1},0) 45%)"></div>`;
  const dir = side === "left" ? -1 : 1;
  tl.push(`ft("#${fid}", { opacity: 0.6, xPercent: ${dir * 25} }, { opacity: 1, xPercent: 0, duration: ${r3(dur * 0.25)}, ease: "power2.out" }, ${r3(t)});`);
  tl.push(`tl.to("#${fid}", { opacity: 0, xPercent: ${dir * 20}, duration: ${r3(dur * 0.55)}, ease: "power2.in" }, ${r3(t + dur * 0.4)});`);
  addSfx(t, f.sfx ?? "cinematic-film-flash", why, { db: f.db ?? -8 });
};
// Alif: a burn carries the picture INTO a cutaway and back OUT to the speaker, and the whoosh rides it
if (spec.sceneFlash && spec.openFlash) {
  const sf = spec.sceneFlash, kinds = sf.kinds ?? ["collage", "paper"];
  const scenes = beatsList.filter((b) => b.type === "scene" && kinds.includes(b.kind));
  const chosen = sf.which === "all" ? scenes : sf.which === "last" ? scenes.slice(-1) : scenes.slice(0, sf.count ?? 1);
  for (const b of chosen) {
    brandFlash({ ...spec.openFlash, dur: sf.dur ?? 0.35, db: sf.db ?? -10, sfx: sf.sfxIn ?? spec.openFlash.sfx }, r3(Math.max(0, E(b.at) - 0.12)), "burn into cutaway");
    if (sf.out !== false) brandFlash({ ...spec.openFlash, dur: sf.dur ?? 0.35, db: (sf.db ?? -10) - 3, sfx: sf.sfxOut ?? spec.openFlash.sfx }, r3(E(b.to) - 0.2), "burn out to speaker", { side: "right" });
  }
}
if (spec.openFlash) {
  const f = spec.openFlash, t = E(f.at ?? 0, "open flash"), dur = f.dur ?? 0.4;
  const [c1, c2] = f.color ?? ["255,92,40", "255,150,120"];
  leakHtml += `<div id="oflash" class="clip" data-start="${r3(t)}" data-duration="${r3(dur)}" data-track-index="11" style="position:absolute;inset:0;z-index:8;pointer-events:none;mix-blend-mode:screen;opacity:0;background:radial-gradient(ellipse 70% 55% at 4% 74%, rgba(${c1},1) 0%, rgba(${c1},.85) 40%, rgba(${c1},0) 100%), radial-gradient(ellipse 45% 70% at 0% 30%, rgba(${c2},.85) 0%, rgba(${c2},0) 100%), linear-gradient(90deg, rgba(${c1},.55) 0%, rgba(${c1},0) 45%)"></div>`;
  tl.push(`ft("#oflash", { opacity: 0.6, xPercent: -25 }, { opacity: 1, xPercent: 0, duration: ${r3(dur * 0.25)}, ease: "power2.out" }, ${r3(t)});`);
  tl.push(`tl.to("#oflash", { opacity: 0, xPercent: -20, duration: ${r3(dur * 0.55)}, ease: "power2.in" }, ${r3(t + dur * 0.4)});`);
  const pickBurn = (name) => {
    const src = path.join(LIB, "packs", packOf, "burns", name);
    if (!fs.existsSync(src)) die(`openFlash.clip '${name}' is not in packs/${packOf}/burns`);
    fs.mkdirSync(path.join(A, "pack"), { recursive: true });
    fs.copyFileSync(src, path.join(A, "pack", `${packOf}-burns-${name}`));
    return `assets/pack/${packOf}-burns-${name}`;
  };
  const clip = f.clip !== false && packOf && spec.packs?.[packOf] && (f.clip ? pickBurn(f.clip) : packClip(packOf, "burns"));
  if (clip) packOverlay(clip, t, dur, { blend: "screen", z: 8, opacity: f.texture ?? 0.8, media: f.media ?? 0.1, fadeIn: 0.05, fadeOut: dur * 0.5,
    filter: f.textureFilter ?? "saturate(1.4) hue-rotate(-18deg) brightness(.9)" });
  if (clip) topOverlays[topOverlays.length - 1] = topOverlays.at(-1).replace("pointer-events:none", "pointer-events:none;-webkit-mask-image:linear-gradient(90deg,#000 0%,#000 18%,transparent 55%);mask-image:linear-gradient(90deg,#000 0%,#000 18%,transparent 55%)");
  addSfx(t, f.sfx ?? "cinematic-film-flash", "open flash", { db: f.db ?? -8 });
  console.log(`open flash at ${t}s (${dur}s)`);
}

// ---------- list marks (spec.listMarks) ----------
// When the speaker enumerates ("number one", "secondly", "step two"), a numbered card lands beside them: a small
// handwritten label, a brand box that wipes in left -> right, a big serif numeral. Paper + pen sounds carry it.
if (spec.listMarks) {
  const L = spec.listMarks === true ? {} : spec.listMarks;
  const NUM = { one: 1, first: 1, firstly: 1, two: 2, second: 2, secondly: 2, three: 3, third: 3, thirdly: 3, four: 4, fourth: 4, five: 5, fifth: 5, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };
  const bare = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  const marks = [];
  for (let i = 0; i < words.length; i++) {
    const a = bare(words[i].word), b = bare(words[i + 1]?.word || ""), prev = bare(words[i - 1]?.word || "");
    let n = null, label = null;
    if (/^(number|step|tip|rule)$/.test(a) && NUM[b]) { n = NUM[b]; label = a; }
    else if (/^(firstly|secondly|thirdly|second|third)$/.test(a) && !/^(at|the|a|every|one)$/.test(prev) && /[,.]$/.test(words[i].word.trim())) { n = NUM[a]; label = "step"; }
    else if (a === "first" && /[,]$/.test(words[i].word.trim()) && !/^(at|the|a)$/.test(prev)) { n = 1; label = "step"; }
    if (!n) continue;
    if (marks.some((m) => m.n === n)) continue;                      // a restated "number one" is not a new point
    if (marks.length && label === "step") label = marks[0].label;    // "number one ... secondly" stays "number 02"
    marks.push({ n, label, t: r3(Math.max(0, words[i].start - 0.05)) });
  }
  const scenes = beatsList.filter((b) => b.type === "scene").map((b) => [E(b.at), E(b.to)]);
  marks.forEach((m, k) => {
    if (scenes.some(([a, b]) => m.t >= a - 0.3 && m.t <= b)) return;  // a full-screen page is up: it already carries the point
    const id = `lm${k}`, hold = L.hold ?? 1.8, x = L.x ?? 70, y = L.y ?? 300;
    leakHtml += `<div id="${id}" class="clip" data-start="${m.t}" data-duration="${r3(hold + 0.35)}" data-track-index="13" style="position:absolute;left:${x}px;top:${y}px;z-index:9;pointer-events:none">
      <div id="${id}-lab" style="font-family:'Caveat Brush',cursive;font-size:${L.labelSize ?? 70}px;color:#fff;line-height:.9;transform:rotate(-6deg);transform-origin:0 100%;margin:0 0 6px 8px;text-shadow:0 3px 12px rgba(0,0,0,.45)">${esc(m.label)}</div>
      <div style="display:inline-block;position:relative;isolation:isolate;padding:0 26px 14px 20px;font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:${L.size ?? 190}px;letter-spacing:-6px;line-height:1;color:#fff"><span id="${id}-bg" style="position:absolute;inset:0;z-index:-1;background:${L.color ?? brand.accent};transform-origin:0 50%;box-shadow:0 14px 34px rgba(0,0,0,.28)"></span><span id="${id}-num" style="display:inline-block">${String(m.n).padStart(2, "0")}</span></div></div>`;
    tl.push(`ft("#${id}-bg", { scaleX: 0 }, { scaleX: 1, duration: 0.32, ease: "power3.out" }, ${m.t});`);
    tl.push(`ft("#${id}-num", { autoAlpha: 0, y: 26, rotation: -4 }, { autoAlpha: 1, y: 0, rotation: 0, duration: 0.3, ease: "back.out(2)" }, ${r3(m.t + 0.08)});`);
    tl.push(`ft("#${id}-lab", { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: 0.32, ease: "none" }, ${r3(m.t + 0.14)});`);
    tl.push(`tl.to("#${id}", { autoAlpha: 0, x: -40, duration: 0.25, ease: "power2.in" }, ${r3(m.t + hold)});`);
    addSfx(m.t, "paper-quick", `list mark ${m.n}`, { db: spec.sound?.paperDb ?? -2 });
    addSfx(m.t + 0.14, "pen-scribble", `list mark ${m.n} label`, { db: spec.sound?.penDb ?? -4 });
  });
  if (marks.length) console.log(`list marks: ${marks.map((m) => `${m.label} ${m.n} @${m.t}`).join(", ")}`);
}

// ---------- tool logos (spec.toolLogos) ----------
// When a product is named ("ChatGPT", "Claude", "n8n"...), its logo lands as an app-icon tile (Alif: the ChatGPT
// tile on the "AI hype cycle" page). Logos: Simple Icons (CC0 SVGs), drawn white on the brand colour.
// (R1b port)
const BRANDS = [
  [/^(chatgpt|openai|gpt)$/, "openai", "#10A37F"], [/^claude(ai)?$/, "claude", "#D97757"], [/^n8n$/, "n8n", "#EA4B71"],
  [/^deepseek$/, "deepseek", "#4D6BFE"], [/^gemini$/, "googlegemini", "#8E75B2"], [/^zapier$/, "zapier", "#FF4F00"],
  [/^(notion)$/, "notion", "#111111"], [/^(hubspot)$/, "hubspot", "#FF7A59"], [/^(slack)$/, "slack", "#4A154B"],
];
if (spec.toolLogos) {
  const T = spec.toolLogos === true ? {} : spec.toolLogos;
  const size = T.size ?? 230, hold = T.hold ?? 1.5;
  const scenes = beatsList.filter((b) => b.type === "scene").map((b) => [E(b.at), E(b.to)]);
  const shown = [];
  fs.mkdirSync(path.join(A, "logos"), { recursive: true });
  words.forEach((w) => {
    const key = w.word.toLowerCase().replace(/[^a-z0-9]/g, "");
    const brand2 = BRANDS.find(([re]) => re.test(key));
    if (!brand2) return;
    const [, slug, color] = brand2, t = r3(Math.max(0, w.start - 0.05));
    if (shown.some((m) => m.slug === slug && t - m.t < 8)) return;       // named twice in a row: one tile
    const svg = path.join(A, "logos", `${slug}.svg`);
    if (!fs.existsSync(svg)) {
      try { execFileSync("curl", ["-sfL", "-o", svg, `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`]); }
      catch { warn.push(`no logo for ${slug}`); return; }
    }
    const onPage = scenes.some(([a, b]) => t >= a - 0.1 && t <= b);
    // slots: on a page, bottom-right (clear of the text column); over footage, upper right (clear of the face)
    const busy = shown.filter((m) => m.onPage === onPage && t < m.t + hold + 0.3).length;
    const x = (onPage ? (T.pageX ?? 780) : (T.x ?? 800)) - busy * (size + 30), y = onPage ? (T.pageY ?? 1360) : (T.y ?? 300);
    const id = `logo${shown.length}`;
    shown.push({ slug, t, onPage });
    leakHtml += `<div id="${id}" class="clip" data-start="${t}" data-duration="${r3(hold + 0.3)}" data-track-index="14" style="position:absolute;left:${x}px;top:${y}px;width:${size}px;height:${size}px;z-index:10;pointer-events:none;border-radius:${Math.round(size * 0.23)}px;background:${color};box-shadow:0 18px 40px rgba(0,0,0,.28), inset 0 2px 0 rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center"><img src="assets/logos/${slug}.svg" style="width:58%;height:58%;filter:brightness(0) invert(1)"/></div>`;
    tl.push(`ft("#${id}", { autoAlpha: 0, scale: 0.35, rotation: -10 }, { autoAlpha: 1, scale: 1, rotation: ${onPage ? -4 : 3}, duration: 0.28, ease: "back.out(2.2)" }, ${t});`);
    tl.push(`tl.to("#${id}", { autoAlpha: 0, scale: 0.8, duration: 0.2, ease: "power2.in" }, ${r3(t + hold)});`);
    addSfx(t, T.sfx ?? "pop-whoosh-light", `logo: ${slug}`, { db: T.db ?? 2 });
  });
  if (shown.length) console.log(`tool logos: ${shown.map((m) => `${m.slug}@${m.t}${m.onPage ? " (page)" : ""}`).join(", ")}`);
}

const OBJECT_SFX_BUILD = { calendar: ["pen-short", false], watch: ["tick-1", false], coins: ["kaching-1", true], mail: ["tech-notification-2", false],
  team: ["pop-whoosh-light", false], chart: ["riser-1", false], handshake: ["whoosh-1", false], target: ["impact-2", false],
  rocket: ["riser-1", false], trophy: ["ding-1", false], checklist: ["tick-1", false], phone: ["tech-notification-2", false],
  laptop: ["click-1", false], lightbulb: ["ding-1", false], brain: ["ding-1", false], magnifier: ["whoosh-2", false], gears: ["click-1", false] };
// ---------- object pop-ups (spec.objectPops) ----------
// Between pages, when the speaker names something concrete ("day-to-day" -> calendar, "money" -> cash, "emails"
// -> envelope), its engraving pops up beside them on a small paper card, with the object's own sound. Alif fills
// the talking stretches between pages this way (calendar, clock, cash stickers).
// (R1b port)
const CONCEPTS = [
  [/^(daytoday|daily|everyday|weekly|monthly|week|month|calendar|schedule|deadline|2026|2025)$/, "calendar"],
  [/^(time|hours|hour|minutes|timeline|fast|faster|quickly)$/, "watch"],
  [/^(money|revenue|cash|profit|dollars|income|cost|costs)$/, "coins"],
  [/^(email|emails|inbox|outreach|messages|dms)$/, "mail"],
  [/^(employees|employee|team|staff|people|hire|hiring)$/, "team"],
  [/^(grow|growth|scale|scaling|results|increase)$/, "chart"],
  [/^(clients|client|customers|customer|deal|deals|partner)$/, "handshake"],
  [/^(goal|goals|target|targets)$/, "target"],
  [/^(launch|launching|rocket)$/, "rocket"],
  [/^(win|winning|best|success)$/, "trophy"],
  [/^(tasks|task|todo|checklist|list)$/, "checklist"],
  [/^(phone|calls|call)$/, "phone"],
  [/^(computer|laptop|software|app|apps|website)$/, "laptop"],
  [/^(idea|ideas|creative)$/, "lightbulb"],
  [/^(think|thinking|mindset|knowledge|expertise)$/, "brain"],
  [/^(audit|analyze|analyse|bottleneck|bottlenecks|problem|problems)$/, "magnifier"],
  [/^(workflow|workflows|process|processes|systems|system|automation|automations|automate)$/, "gears"],
];
if (spec.objectPops) {
  const P = spec.objectPops === true ? {} : spec.objectPops;
  const hold = P.hold ?? 1.5, gap = P.gap ?? 4.5, w = P.w ?? 300;
  const have = (k) => fs.existsSync(path.join(LIB, "engravings", "png", `${k}.png`));
  // stay clear of pages, list marks, logos and the first/last beats
  const busy = beatsList.filter((b) => b.type === "scene" || b.type === "nametag" || b.type === "slam").map((b) => [E(b.at) - 0.6, E(b.to) + 0.8]);
  // number cards sit top-left and pop-ups top-right, so they can share the screen; logos share the pop-up slot
  busy.push(...[...leakHtml.matchAll(/id="(logo\d+)" class="clip" data-start="([\d.]+)" data-duration="([\d.]+)"/g)].map((m) => [parseFloat(m[2]) - 0.6, parseFloat(m[2]) + parseFloat(m[3]) + 0.6]));
  // never repeat a picture a page already showed
  const used = new Set(beatsList.flatMap((b) => [b.engraving, ...(b.items || []).filter((it) => it.type === "image").map((it) => it.src)]).filter(Boolean));
  let last = -Infinity, k = 0;
  for (let i = 0; i < words.length; i++) {
    const key = (words[i].word + (words[i + 1]?.word || "") + (words[i + 2]?.word || "")).toLowerCase().replace(/[^a-z0-9]/g, "");
    // a phrase fix can merge several words into one token ("have an audit"): test each word inside it
    const parts = words[i].word.toLowerCase().split(/\s+/).map((p) => p.replace(/[^a-z0-9]/g, ""));
    const one = parts.find((p) => CONCEPTS.some(([re]) => re.test(p))) || parts[0];
    const hit = CONCEPTS.find(([re]) => re.test(one) || re.test(key.slice(0, 10)));
    if (!hit) continue;
    const obj = hit[1], t = r3(Math.max(0, words[i].start - 0.05));
    if (!have(obj) || used.has(obj) || t < 1.5 || t > SPEECH - 2 || t - last < gap) continue;
    if (busy.some(([a, b]) => t + hold > a && t < b)) continue;
    const id = `op${k++}`, rot = k % 2 ? 4 : -5;
    // the label is what they said: "day-to-day", "time", "money" (a hyphenated phrase stays whole)
    const label = (words[i].word.toLowerCase().split(/\s+/).find((p) => p.replace(/[^a-z0-9]/g, "") === one) || one).replace(/[^a-z0-9'-]/g, "");
    const src = userAsset(path.join(LIB, "engravings", "png", `${obj}.png`));
    leakHtml += `<div id="${id}" class="clip" data-start="${t}" data-duration="${r3(hold + 0.3)}" data-track-index="15" style="position:absolute;left:${P.x ?? 720}px;top:${P.y ?? 300}px;width:${w}px;z-index:9;pointer-events:none;transform:rotate(${rot}deg)">
      <div style="background:#efece4;padding:${Math.round(w * 0.07)}px;border-radius:6px;box-shadow:0 16px 36px rgba(0,0,0,.32), 0 2px 0 rgba(255,255,255,.4) inset"><img src="${src}" style="display:block;width:100%"/></div>
      <div id="${id}-lab" style="display:inline-block;position:relative;margin:-26px 0 0 ${Math.round(w * 0.12)}px;padding:2px 16px 8px 12px;background:${brand.accent};color:#f4efe6;font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:${P.labelSize ?? 58}px;letter-spacing:-0.04em;line-height:1;white-space:nowrap;transform:rotate(${-rot * 0.6}deg);box-shadow:0 10px 22px rgba(0,0,0,.25)">${esc(label)}</div></div>`;
    tl.push(`ft("#${id}-lab", { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: 0.3, ease: "power2.out" }, ${r3(t + 0.18)});`);
    tl.push(`ft("#${id}", { autoAlpha: 0, scale: 0.55, y: 30 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.3, ease: "back.out(1.8)" }, ${t});`);
    tl.push(`tl.to("#${id}", { autoAlpha: 0, scale: 0.85, y: -10, duration: 0.22, ease: "power2.in" }, ${r3(t + hold)});`);
    addSfx(t, "paper-quick", `pop-up in: ${obj}`, { db: -6 });
    const [sfx, hero] = OBJECT_SFX_BUILD[obj] || [];
    if (sfx) addSfx(t + 0.08, sfx, `pop-up: ${obj}`, { db: hero ? 8 : 0 });
    used.add(obj); last = t; busy.push([t - 0.3, t + hold + 0.3]);
  }
  if (k) console.log(`object pop-ups: ${k}`);
}

// ---------- page sync check ----------
// A page shows what the speaker is saying WHILE it is up. A line whose words were said before the page appeared
// reads as lagging behind the voice (Ahmed caught "most CEOs / implement AI" landing after he'd said it).
// (R1b port)
{
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const spoken = words.map((w) => ({ t: w.start, w: norm(w.word) })).flatMap((x) => x.w.map((w) => ({ t: x.t, w })));
  for (const b of beatsList.filter((b) => b.type === "scene" && (b.lines || b.items))) {
    const a = E(b.at), z = E(b.to);
    const lines = (b.lines || (b.items || []).filter((it) => it.type === "text")).map((l) => l.text).filter(Boolean);
    for (const text of lines) {
      const first = norm(text).find((w) => w.length > 2);
      if (!first) continue;
      const hits = spoken.filter((s) => s.w === first || s.w.startsWith(first.slice(0, 5)));
      if (!hits.length) continue;                                   // paraphrased: nothing to compare
      if (!hits.some((h) => h.t >= a - 0.4 && h.t <= z + 0.3)) {
        warn.push(`page @${b.at}: "${text}" was said at ${hits.map((h) => h.t.toFixed(1)).join("/")}s, not while the page is up (${a.toFixed(1)}-${z.toFixed(1)}s): it will lag the voice`);
      }
    }
  }
}

// ---------- title banner (spec.banner) ----------
// A headline that stays on screen for the whole reel (or from..to), top of the frame, inside the safe area.
let titleHtml = "";
if (spec.banner?.text) {
  const from = spec.banner.from ?? 0, to = Math.min(spec.banner.to ?? TOTAL, TOTAL);
  titleHtml = `<div id="title-banner" class="clip" data-start="${r3(from)}" data-duration="${r3(Math.max(0.1, to - from))}" data-track-index="9" style="position:absolute;left:60px;right:60px;top:${spec.banner.y ?? 250}px;text-align:center;z-index:9;font-family:${brand.font || "Montserrat"},system-ui,sans-serif;font-size:${spec.banner.size ?? 64}px;font-weight:900;line-height:1.05;color:#fff;-webkit-text-stroke:10px #000;paint-order:stroke fill;text-transform:uppercase">${esc(spec.banner.text)}</div>`;
}

// ---------- music bed ----------
let musicHtml = "";
// Alif: a punch-in is barely audible, a tiny air swish ~20 dB under the voice (not during full-screen scenes)
if (spec.sound?.zoom && cadenceSnaps.size) {
  const sceneWins = beatsList.filter((b) => b.type === "scene").map((b) => [E(b.at) - 0.1, E(b.to) + 0.1]);
  let zn = 0;
  for (const t of [...cadenceSnaps].sort((a, b) => a - b)) {
    if (t < 0.6 || sceneWins.some(([a, b]) => t >= a && t <= b)) continue;   // the open flash owns the first beat
    addSfx(t - 0.03, zn++ % 2 ? "zoom-sweep-short" : "zoom-sweep-small", "zoom swish", { db: spec.sound.zoomDb ?? -8 });
  }
}

if (spec.music) {
  if (spec.music.id === "auto") {
    const man = JSON.parse(fs.readFileSync(path.join(LIB, "music", "manifest.json"), "utf8"));
    const pickId = Object.keys(man).find((k) => (man[k].styles || []).includes(spec.style)) || "deep-techno-ambience";
    spec.music = { ...spec.music, id: pickId };
  }
  const drops = spec.music.drops;
  if (drops) {
    const times = [];
    if (drops === "auto" || drops.auto) {
      const scenes = beatsList.filter((b) => b.type === "scene").map((b) => E(b.at));
      // the payoff: set explicitly (the page that carries the core promise) or else the last page
      // (R1b port)
      if (spec.music.payoffAt != null) times.push(E(spec.music.payoffAt, "payoff"));
      else if (scenes.length) times.push(scenes.at(-1));
      // the call to action: "comment ...", "follow ...", "subscribe", "link in bio", in the last quarter only
      const cta = words.find((w) => w.start > SPEECH * 0.75 && /^(comment|follow|subscribe|link)\b/i.test(w.word.trim().replace(/[^a-z ]/gi, "")));
      if (cta) times.push(r3(cta.start));
    }
    for (const t of Array.isArray(drops) ? drops : (typeof drops === "object" && Array.isArray(drops.at) ? drops.at : [])) times.push(E(t, "music drop"));
    spec.music = { ...spec.music, dropTimes: [...new Set(times.map(r3))] };
    console.log(`music drops at ${spec.music.dropTimes.join(", ")}s`);
  }
  // the turn: where the hook ends and the promise begins ("but what it needs...", "here's exactly how",
  // "I'm going to be showing you") -> the muffled bed opens here
  // (R1b port)
  if (spec.music.reveal) {
    let at = typeof spec.music.reveal === "number" ? E(spec.music.reveal, "reveal") : null;
    if (at == null) {
      const bare = (w) => w.toLowerCase().replace(/[^a-z']/g, "");
      for (let i = 0; i < words.length && at == null; i++) {
        const w = words[i], b = bare(w.word), nx = bare(words[i + 1]?.word || "");
        if (w.start < 2.2 || w.start > 9) continue;
        const hit = b === "but" || b === "here's" || b === "heres" || (b === "showing" && bare(words[i - 1]?.word || "") === "be") ||
          (b === "number" && nx === "one") || (b === "what" && nx === "you" && bare(words[i + 2]?.word || "") === "need");
        if (!hit) continue;
        let j = i;   // back up over the clause lead-in: "and I'm going to be | showing", "and | here's"
        while (j > 0 && /^(and|so|i'm|im|going|to|be|today|now)$/.test(bare(words[j - 1].word)) && i - j < 5 && words[j].start - words[j - 1].end < 0.4) j--;
        at = r3(Math.max(0, words[j].start - 0.04));
      }
    }
    if (at != null) { spec.music = { ...spec.music, revealAt: at }; console.log(`music reveal (muffled -> open) at ${at}s`); }
  }
  // the payoff: a riser into the last page, the drop's silence, a soft hit as the page lands
  // (R1b port)
  const lastScene = spec.music.payoffAt != null ? E(spec.music.payoffAt, "payoff") : beatsList.filter((b) => b.type === "scene").map((b) => E(b.at)).sort((a, b) => a - b).at(-1);
  if (lastScene && spec.music.payoff !== false && spec.music.drops) {
    const len = spec.music.dropLen ?? 0.5;
    addSfx(r3(lastScene - len - 1.25), spec.music.riserSfx ?? "riser-1", "riser into the payoff", { db: spec.music.riserDb ?? -2 });
    addSfx(r3(lastScene), spec.music.hitSfx ?? "cinematic-cine-hit", "payoff hit", { db: spec.music.hitDb ?? -6 });
  }
  const m = buildMusic(spec.music, motionCtx, execFileSync, path, fs);
  musicHtml = m.html;
  console.log(`music: ${spec.music.id || spec.music.src} at ${m.I} LUFS -> volume ${m.vol} (${spec.music.db ?? -20} dB under the voice)`);
}

// ---------- write ----------
const FONT_NAMES = { "instrument-serif": "Instrument Serif", "caveat-brush": "Caveat Brush", "yellowtail": "Yellowtail", "eb-garamond": "EB Garamond", "playfair-display": "Playfair Display", "jetbrains-mono": "JetBrains Mono", "geist-mono": "GeistMono" };
// latin-ext (I-18, N4): Google's own CSS2 API value, so Romanian/Slovak/Czech captions don't
// drop to a system font mid-word. arabic: Google's own CSS2 API value for Noto Sans Arabic.
const RANGES = {
  latin: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  cyrillic: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
  "latin-ext": "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
  arabic: "U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC, U+102E0-102FB, U+10E60-10E7E, U+10EC2-10EC4, U+10EFC-10EFF, U+1EE00-1EE03, U+1EE05-1EE1F, U+1EE21-1EE22, U+1EE24, U+1EE27, U+1EE29-1EE32, U+1EE34-1EE37, U+1EE39, U+1EE3B, U+1EE42, U+1EE47, U+1EE49, U+1EE4B, U+1EE4D-1EE4F, U+1EE51-1EE52, U+1EE54, U+1EE57, U+1EE59, U+1EE5B, U+1EE5D, U+1EE5F, U+1EE61-1EE62, U+1EE64, U+1EE67-1EE6A, U+1EE6C-1EE72, U+1EE74-1EE77, U+1EE79-1EE7C, U+1EE7E, U+1EE80-1EE89, U+1EE8B-1EE9B, U+1EEA1-1EEA3, U+1EEA5-1EEA9, U+1EEAB-1EEBB, U+1EEF0-1EEF1",
};
// order matters: latin-ext must be tried before latin, or the alternation matches "latin" inside
// "latin-ext" first and leaves "-ext" unconsumed against the "\.woff2$" anchor, failing the match.
const fontFaces = fs.readdirSync(path.join(A, "fonts")).filter((f) => /-(latin-ext|latin|cyrillic|arabic)(-italic)?\.woff2$/.test(f)).map((f) => {
  const m = /^(.*)-(latin-ext|latin|cyrillic|arabic)(-italic)?\.woff2$/.exec(f);
  const fam = FONT_NAMES[m[1]] || m[1].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  // Geist/Inter/Montserrat's latin+cyrillic faces are hand-declared below (legacy, predates this
  // loop); their latin-ext faces are declared there too now, so still skip them here to avoid a
  // duplicate (harmless but redundant) @font-face for the same family+range.
  if (["Geist", "Inter", "Montserrat"].includes(fam)) return "";
  return `@font-face { font-family: "${fam}"; src: url(assets/fonts/${f}) format("woff2"); font-weight: 100 900;${m[3] ? " font-style: italic;" : ""} unicode-range: ${RANGES[m[2]]}; }`;
}).join("\n  ");
const look = spec.look || {};
if (look.exposure && look.exposure !== 1) tl.push(`tl.set("#pip", { filter: "brightness(${look.exposure}) contrast(${look.contrast ?? 1.04})" }, 0);`);
const grainHtml = look.grain ? `<div id="grain" class="look-grain" style="opacity:${look.grain}"></div>` : "";
const vignetteHtml = look.vignette ? `<div class="look-vignette" style="background:radial-gradient(ellipse at 50% 42%, rgba(0,0,0,0) 45%, rgba(0,0,0,${look.vignette}) 100%)"></div>` : "";
if (look.grain) for (let t = 0, k = 0; t < TOTAL; t += 1 / 12, k++) tl.push(`tl.set("#grain", { backgroundPosition: "${(k * 137) % 400}px ${(k * 251) % 400}px" }, ${r3(t)});`);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<title>${esc(spec.title || "reel")}</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  @font-face { font-family: Geist; src: url(assets/fonts/geist-latin.woff2) format("woff2"); font-weight: 100 900; }
  @font-face { font-family: Geist; src: url(assets/fonts/geist-latin-ext.woff2) format("woff2"); font-weight: 100 900; unicode-range: ${RANGES["latin-ext"]}; }
  @font-face { font-family: GeistMono; src: url(assets/fonts/geist-mono-latin.woff2) format("woff2"); }
  @font-face { font-family: Inter; src: url(assets/fonts/inter-cyrillic.woff2) format("woff2"); font-weight: 100 900; unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
  @font-face { font-family: Inter; src: url(assets/fonts/inter-latin.woff2) format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
  @font-face { font-family: Inter; src: url(assets/fonts/inter-latin-ext.woff2) format("woff2"); font-weight: 100 900; unicode-range: ${RANGES["latin-ext"]}; }
  @font-face { font-family: Montserrat; src: url(assets/fonts/montserrat-cyrillic.woff2) format("woff2"); font-weight: 100 900; unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
  @font-face { font-family: Montserrat; src: url(assets/fonts/montserrat-latin.woff2) format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
  @font-face { font-family: Montserrat; src: url(assets/fonts/montserrat-latin-ext.woff2) format("woff2"); font-weight: 100 900; unicode-range: ${RANGES["latin-ext"]}; }
  ${fontFaces}
  body { margin: 0; background: #000; }
  #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; font-family: ${UI_FONT}, system-ui, sans-serif; }
  #base, #snap, #push { position: absolute; inset: 0; transform-origin: ${zoom.origin || "50% 29%"}; }
  #base { transform: scale(${zoom.base ?? 1});${look.grade ? ` filter: ${look.grade};` : ""} }
  #pip { position: absolute; inset: 0; z-index: 1; transform-origin: ${W / 2}px ${faceY}px; }
  .behind { position: absolute; inset: 0; pointer-events: none; }
  .behind-in { position: absolute; left: -40px; right: -40px; text-align: center; font-weight: 900; line-height: .86; letter-spacing: -6px; text-transform: uppercase; white-space: nowrap; font-family: ${brand.displayFont ? `"${brand.displayFont}", ` : ""}${UI_FONT}, sans-serif; }
  .matte { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .look-grain { position: absolute; inset: 0; z-index: 6; pointer-events: none; mix-blend-mode: overlay; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='400' height='400' filter='url(%23n)' opacity='0.9'/></svg>"); }
  .look-vignette { position: absolute; inset: 0; z-index: 6; pointer-events: none; }
  .layer { z-index: 3; }
  #caps, #ecaps { z-index: 8; }
  #push video, .fill { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .layer { position: absolute; inset: 0; pointer-events: none; }
  .ov { position: absolute; box-sizing: border-box; }
  .card { background: rgba(14,14,16,.92); color: #fff; border-radius: 28px; padding: 28px 36px; box-shadow: 0 18px 50px rgba(0,0,0,.35); }
  .big-text { font-size: 96px; font-weight: 800; letter-spacing: -2px; line-height: 1.02; }
  .big-sub { font-size: 38px; font-weight: 600; color: #FFD166; margin-top: 8px; }
  .chips { display: flex; gap: 26px; }
  .chip { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .chip-face { width: 130px; height: 130px; border-radius: 30px; display: flex; align-items: center; justify-content: center; font-size: 70px; font-weight: 800; box-shadow: 0 12px 30px rgba(0,0,0,.3); }
  .chip-face img { width: 62%; height: 62%; object-fit: contain; }
  .chip-label { font-size: 30px; font-weight: 700; color: #111; background: rgba(255,255,255,.94); padding: 6px 18px; border-radius: 14px; white-space: nowrap; }
  .strike-wrap { position: relative; display: inline-block; }
  .strike-line { position: absolute; left: -8px; right: -8px; top: 52%; height: 12px; background: #FF453A; border-radius: 6px; transform-origin: 0 50%; }
  .strike-x { position: absolute; right: 36px; top: 18px; font-size: 110px; color: #FF453A; font-weight: 900; }
  .q-head { font-size: 28px; text-transform: uppercase; letter-spacing: 3px; color: #aaa; margin-bottom: 12px; }
  .q-line { font-size: 46px; font-weight: 600; line-height: 1.2; margin: 6px 0; }
  .q-big { font-size: 60px; font-weight: 800; line-height: 1.1; color: #FFD166; margin-top: 12px; }
  .l-line { display: flex; gap: 20px; align-items: baseline; font-size: 46px; font-weight: 700; margin: 8px 0; }
  .l-num { color: #FFD166; font-family: GeistMono, monospace; }
  .l-text { position: relative; }
  .l-strike { position: absolute; left: -4px; right: -4px; top: 55%; height: 6px; background: #FF453A; transform-origin: 0 50%; display: block; }
  .stamp { position: absolute; right: 30px; top: 40%; border: 8px solid #FF453A; color: #FF453A; font-size: 78px; font-weight: 900; padding: 4px 26px; border-radius: 16px; text-transform: uppercase; background: rgba(0,0,0,.25); }
  .emoji { width: 400px; height: 400px; font-size: 320px; line-height: 400px; text-align: center; filter: drop-shadow(0 20px 30px rgba(0,0,0,.35)); }
  .icon-tile { width: 220px; height: 220px; border-radius: 44px; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(145deg, rgba(255,214,120,.92) 0%, rgba(226,166,44,.88) 55%, rgba(170,112,20,.9) 100%);
    border: 2px solid rgba(255,238,196,.75); box-shadow: 0 18px 50px rgba(0,0,0,.35), 0 0 60px rgba(242,193,78,.45), inset 0 2px 0 rgba(255,255,255,.55); }
  .icon-tile svg { filter: drop-shadow(0 3px 6px rgba(120,70,0,.45)); }
  .logo { width: 280px; height: 280px; border-radius: 62px; display: flex; align-items: center; justify-content: center; box-shadow: 0 18px 50px rgba(0,0,0,.35); }
  .logo img { width: 60%; height: 60%; object-fit: contain; }
  .meme-img { background: #fff; padding: 8px; border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.4); }
  .meme-img img { width: 100%; display: block; border-radius: 8px; }
  .meme-clip video { filter: drop-shadow(0 16px 30px rgba(0,0,0,.45)); }
  .meme-framed { background: #fff; padding: 8px; border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.4); }
  .meme-framed video { filter: none; border-radius: 8px; }
  .dim { inset: 0; background: rgba(0,0,0,.55); }
  .endcard { left: 90px; top: 640px; width: 900px; background: #fff; color: #111; border-radius: 34px; padding: 44px 48px; text-align: center; box-shadow: 0 24px 70px rgba(0,0,0,.45); }
  .ec-title { font-size: 72px; font-weight: 800; letter-spacing: -1px; }
  .ec-line { font-size: 38px; font-weight: 500; margin-top: 12px; color: #333; }
  .ec-url { font-family: GeistMono, monospace; font-size: 30px; margin-top: 22px; color: #555; white-space: nowrap; }
  #caps { position: absolute; left: 0; right: 0; top: 0; height: 0; }
  .cap-group { position: absolute; left: 50%; transform: translateX(-50%); width: max-content; max-width: ${W - 2 * placer.sidePad}px !important; text-align: center; line-height: 1.18; }
  .cap-backed { background: rgba(8,8,10,.55); border-radius: 20px; padding: 6px 22px; -webkit-text-stroke: 0 !important; }
  ${capCss}
  ${rtl ? `#caps, .cap-group { direction: rtl; unicode-bidi: plaintext; }` : ""}
  /* layout.compact: a smaller card grammar for a narrow band (e.g. under burned-in captions) */
  .compact .card { padding: 18px 28px; border-radius: 22px; }
  .compact .big-text { font-size: 70px; letter-spacing: -1px; }
  .compact .big-sub { font-size: 30px; margin-top: 4px; }
  .compact .chip-face { width: 104px; height: 104px; border-radius: 24px; font-size: 56px; }
  .compact .chip-label { font-size: 24px; padding: 4px 14px; }
  .compact .chips { gap: 22px; }
  .compact .q-head { font-size: 22px; margin-bottom: 6px; }
  .compact .q-line { font-size: 36px; margin: 2px 0; }
  .compact .q-big { font-size: 46px; margin-top: 6px; }
  .compact .l-line { font-size: 36px; margin: 2px 0; }
  .compact .strike-x { font-size: 80px; top: 8px; }
  .w { display: inline-block; margin: 0 0.2em; transform-origin: 50% 80%; }
  ${MOTION_CSS(brand, rtl)}
</style>
</head>
<body>
<div id="root" class="${spec.layout?.compact ? "compact" : ""}" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${TOTAL}" data-fps="${FPS}">
  <div id="pip"><div id="base"><div id="snap"><div id="push">${takeHtml}${outroHtml}${behindHtml.join("")}${matteHtml}
  </div></div></div></div>
  ${overlays.filter((o) => o.html).map((o) => o.html).join("\n  ")}
  ${grainHtml}${vignetteHtml}
  <div id="caps">
      ${capHtml}
  </div>
  ${titleHtml}
  ${brandHtml}
  ${leakHtml}
  ${topOverlays.join("\n  ")}
  ${edit ? edit.html : ""}
  ${takeAudio}
  ${overlays.filter((o) => o.audio).map((o) => o.audio).join("\n  ")}
  ${sfxAudio.join("\n  ")}
  ${musicHtml}
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  // fromTo with a baseline at 0: seeks before a tween never inherit another tween's from-values
  // fromTo with a baseline at 0, set ONCE per element: a second baseline for an
  // element animated twice would be rendered after the first tween on a direct
  // seek and wipe it out (pip, repeated push-ins)
  const based = new Set();
  const ft = (sel, from, to, at) => { if (!based.has(sel)) { based.add(sel); tl.set(sel, from, 0); } tl.fromTo(sel, from, { ...to, immediateRender: false }, Math.max(0, at)); };
  ${tl.join("\n  ")}
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(proj, "index.html"), html);
fs.mkdirSync(path.join(proj, "build"), { recursive: true });
fs.writeFileSync(path.join(proj, "build", "sfx_events.json"), JSON.stringify({ total: TOTAL, speech: SPEECH, voiceP95: r3(voiceP95), roleDb: ROLE_DB, events: sfxEvents }, null, 2));
fs.writeFileSync(path.join(proj, "build", "words.edit.json"), JSON.stringify(words));
fs.writeFileSync(path.join(proj, "build", "caption_layout.json"), JSON.stringify({ platform: placer.platform, safeTop: placer.safeTop, safeBottom: placer.safeBottom, blocks: placer.log }, null, 1));
// Resolved edit-time motion events, for the style-study accuracy harness (A1). Beat times in
// reel.json are SOURCE seconds; these are what the render actually contains, after E() maps them
// through the takes. Ground truth must come from here, never from the input spec.
fs.writeFileSync(path.join(proj, "build", "edit_truth.json"), JSON.stringify({
  total: TOTAL, speech: SPEECH, fps: FPS,
  // I-17: a take's `transition` names the look its join FROM the previous take carries (blur or
  // whip) instead of a hard cut; omitted entirely when unset, so a reel with no take transitions
  // still writes byte-identical edit_truth.json to before this field existed.
  takes: takes.map((t) => ({ start: r3(t.start), dur: r3(t.dur), holdStart: r3(t.holdStart), holdFrames: t.holdFrames, ...(t.transition ? { transition: t.transition } : {}) })),
  snaps: snaps.map(([t, z]) => ({ t: r3(t), scale: z })),
  pushes: pushesEdit.map((p) => ({ start: r3(p.a), end: r3(p.b), z: p.z, up: p.up, down: p.down })),
  // `to` matters as much as `at`: a scene animates in at `at` and out near `to`, so both are
  // events a frame-level analyzer should see.
  beats: (spec.beats || []).map((b) => ({
    type: b.type, kind: b.kind ?? null,
    at: r3(E(b.at, `${b.type} at`)),
    to: b.to === undefined ? null : r3(E(b.to, `${b.type} to`)),
    in: b.in ?? null, out: b.out ?? null,
  })),
}, null, 2));
{
  const modes = {};
  for (const b of placer.log) modes[b.mode] = (modes[b.mode] || 0) + 1;
  console.log(`caption placement (${placer.platform.name}, safe y ${placer.safeTop}-${placer.safeBottom}): ${JSON.stringify(modes)}`);
  if (modes["lower-face"]) warn.push(`${modes["lower-face"]} caption block(s) in close-up fallback (under the mouth, on a backing); see build/caption_layout.json`);
}

console.log(`\n${takes.length} takes, ${SPEECH.toFixed(2)}s speech + ${OUTRO}s outro = ${TOTAL}s`);
console.log(`captions: ${edit ? edit.count + " blocks" : groups.length + " groups"}, style ${cap.style}\n  ${words.map((w) => w.word).join(" ")}`);
const byRole = {};
for (const e of sfxEvents) byRole[e.role] = (byRole[e.role] || 0) + 1;
console.log(`voice p95 peak ${voiceP95.toFixed(1)} dBFS; sfx role levels vs voice ${JSON.stringify(ROLE_DB)}`);
console.log(`sfx: ${sfxEvents.length} hits ${JSON.stringify(byRole)}, ${perMin(sfxEvents).toFixed(1)}/min`);
if (missingSfx.size) {
  const total = [...missingSfx.values()].reduce((a, b) => a + b, 0);
  warn.push(`${total} sound(s) skipped, ${missingSfx.size} id(s) unavailable: `
    + [...missingSfx.entries()].map(([k, n]) => `${k} x${n}`).join(", ")
    + ` - restore library/sfx (see engine/assets/LEDGER.md) to hear them`);
}
for (const e of sfxEvents) console.log(`  ${e.t.toFixed(2).padStart(6)}s  ${e.id.padEnd(22)} ${e.role.padEnd(6)} vol ${e.vol}  (${e.why})`);
if (warn.length) console.log("\nWARNINGS:\n  " + [...new Set(warn)].join("\n  "));
console.log(`\n-> ${path.join(proj, "index.html")}`);

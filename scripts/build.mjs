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
import { MOTION_CSS, buildScene, buildEditorialCaptions, buildMusic } from "./lib/motion.mjs";
import { makePlacer, PLATFORMS } from "./lib/safezone.mjs";

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
let preset = {};
if (rawSpec.style) {
  const sp = path.join(STYLE_DIR, `${rawSpec.style}.json`);
  if (!fs.existsSync(sp)) { console.error(`ERROR: unknown style '${rawSpec.style}'; have: ${fs.readdirSync(STYLE_DIR).map((f) => f.replace(".json", "")).join(", ")}`); process.exit(1); }
  preset = JSON.parse(fs.readFileSync(sp, "utf8"));
  delete preset._about;
}
const spec = deepMerge(preset, rawSpec);

const FPS = spec.fps ?? 30;
// brand kit: one accent (60/30/10), ink for text on light scenes, caption size
const brand = { accent: "#D13F34", accentDark: "#B93026", ink: "#262626", capSize: 58, font: null, ...(spec.brand || {}) };
const W = 1080, H = 1920;
const warn = [];
const die = (m) => { console.error("ERROR: " + m); process.exit(1); };

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

const E = (t, what = "") => {
  if (t === "end") return TOTAL;
  if (typeof t === "string" && t.startsWith("outro+")) return SPEECH + parseFloat(t.slice(6));
  for (const k of takes) if (t >= k.a - 1e-6 && t <= k.b + 1e-6) return +(k.start + (t - k.a)).toFixed(3);
  // whisper word times are loose around pauses: a time inside a short removed
  // gap (< 1.2 s) snaps to the start of the next kept take
  if (typeof t === "number") for (let i = 0; i + 1 < takes.length; i++) if (t > takes[i].b && t < takes[i + 1].a && takes[i + 1].a - takes[i].b < 1.2) return +takes[i + 1].start.toFixed(3);
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

// ---------- assets ----------
const A = path.join(proj, "assets");
for (const d of ["sfx", "memes", "icons", "fonts"]) fs.mkdirSync(path.join(A, d), { recursive: true });
for (const f of fs.readdirSync(path.join(SKILL, "templates", "fonts"))) fs.copyFileSync(path.join(SKILL, "templates", "fonts", f), path.join(A, "fonts", f));

const sfxManifest = JSON.parse(fs.readFileSync(path.join(LIB, "sfx", "manifest.json"), "utf8"));
const memeLib = (id) => {
  const dir = path.join(LIB, "memes", id);
  const mp = path.join(dir, "meta.json");
  if (!fs.existsSync(mp)) die(`meme '${id}' not in library (library/memes/${id}/meta.json); add it with meme_add.py or run meme_find.py`);
  return { dir, meta: JSON.parse(fs.readFileSync(mp, "utf8")) };
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
const addSfx = (t, id, why, { db = 0, lead = 0 } = {}) => {
  if (!id || id === "none") return;
  if (SFX_PROFILE === "restrained" && RESTRAINED_DROP.test(why)) return;
  const real = pick(id);
  const m = sfxManifest[real];
  if (!m) die(`sfx '${real}' not in library/sfx/manifest.json (${why})`);
  fs.copyFileSync(path.join(LIB, "sfx", m.file), path.join(A, "sfx", m.file));
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
}
// the outro is a real still of the last frame, frozen under the end card
const last = takes.at(-1);
if (OUTRO > 0) execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", stillAt(last.a + last.dur - 1 / FPS), "-i", path.resolve(proj, SRC), "-frames:v", "1", "-q:v", "2", "-update", "1", path.join(A, "outro.jpg")]);
const outroHtml = OUTRO > 0 ? `
      <img id="outro-still" class="fill" src="assets/outro.jpg" data-start="${r3(SPEECH)}" data-duration="${r3(OUTRO)}" data-track-index="0" />` : "";

// ---------- caption placement: face-aware, inside the platform's safe area ----------
const platform = spec.platform || "instagram";
const facePath = path.join(proj, spec.face || "build/face.json");
const face = fs.existsSync(facePath) ? JSON.parse(fs.readFileSync(facePath, "utf8")) : null;
if (!face) warn.push(`no ${path.relative(proj, facePath)}: captions sit at a fixed height and may cover the face; run scripts/face_track.py first`);
const placer = makePlacer({ face, takes, zoom: { ...zoom, snapsEdit: snaps, pushesEdit }, TOTAL, platform, ideal: spec.captions?.y ?? 1180 });

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
const motionCtx = { tl, E, r3, esc, addSfx, brand, userAsset, words, proj, LIB, faceY, sound: spec.sound || {}, source: SRC, get SPEECH() { return SPEECH; }, get TOTAL() { return TOTAL; } };

// a scene that hands over to an expand/wipe scene stays underneath until the
// incoming panel has covered it
const beatsList = spec.beats || [];
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
    case "nametag": {
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
if (cap.style === "serif") { cap.pop ??= false; cap.lowercase ??= true; }
if (["box", "condensed"].includes(cap.style)) cap.upper ??= true;
const caseOf = (word) => cap.upper ? word.toUpperCase() : cap.lowercase === true ? word.toLowerCase() : word;
const WEAK_END = /^(a|an|the|to|of|and|or|but|in|on|at|for|with|my|your|his|her|their|our|is|are|was|he's|she's|it's|i'm|you're|we're|they're|i|you|he|she|we|they|gonna|wanna|have|has|had|be|so|if|that|this|just)$/i;
const groups = [];
let cur = [];
for (const w of words) {
  if (cur.length && (w.start - cur.at(-1).end > 0.6)) { groups.push(cur); cur = []; }
  cur.push(w);
  // don't strand a phrase on a weak word ("GONNA HAVE TO" / "OKAY OKAY HE'S"): allow one extra word
  const bare = w.word.replace(/[^a-z']/gi, "");
  const weak = cap.smartBreaks !== false && (WEAK_END.test(bare) || /[a-z]'s$/i.test(bare)) && cur.length <= cap.group;
  const size = cur.reduce((n, x) => n + x.word.trim().split(/\s+/).length, 0);
  if ((size >= cap.group && !weak) || size > cap.group + 1 || /[.?!,]$/.test(w.word)) { groups.push(cur); cur = []; }
}
if (cur.length) groups.push(cur);
// no one-word orphans ("it." / "okay," / "ChatGPT?"): fold into the phrase they belong to
const wc = (g) => g.reduce((n, x) => n + x.word.trim().split(/\s+/).length, 0);
for (let i = 0; i < groups.length; i++) {
  if (cap.smartBreaks === false || wc(groups[i]) !== 1 || groups.length < 2) continue;
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
  if (cap.smartBreaks === false || next[0].start - g[0].start >= MIN_READ || /[.?!]$/.test(g.at(-1).word)) continue;
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
    if (cap.reveal === "word" && wi > 0) tl.push(`ft("#cg${gi}w${wi}", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.05 }, ${r3(Math.max(s, w.start - 0.02))});`);
    if (cap.highlight) tl.push(`tl.set("#cg${gi}w${wi}", { color: "${cap.highlight}" }, ${r3(w.start)}); tl.set("#cg${gi}w${wi}", { color: "#fff" }, ${r3(Math.min(w.end + 0.02, e - 0.01))});`);
  });
  const capSize = CAP_SIZES[cap.style] ?? (cap.style === "clean" ? (cap.size ?? brand.capSize) : (cap.size ?? 56));
  const pl = placer.place(s, e, capSize * (["pill", "box"].includes(cap.style) ? 1.6 : 1.3));
  const backed = pl.mode === "lower-face" && !["pill", "box", "sessions"].includes(cap.style);
  return `<div id="cg${gi}" class="cap-group clip${backed ? " cap-backed" : ""}" style="top:${pl.y}px${pl.scale && pl.scale < 1 ? `;transform:translateX(-50%) scale(${pl.scale});transform-origin:50% 0` : ""}" data-start="${r3(s)}" data-duration="${r3(Math.max(0.1, e - s))}" data-track-index="5">${g.map((w, wi) => `<span id="cg${gi}w${wi}" class="w">${esc(caseOf(w.word))}</span>`).join("<wbr>")}</div>`;
}).join("\n      ");

const cyr = /[\u0400-\u04FF]/.test(JSON.stringify(spec.beats || []) + words.map((w) => w.word).join(" "));
const UI_FONT = brand.font || (cyr ? "Inter" : "Geist");
const capCss = cap.style === "clean"
  ? `.cap-group { font-family: ${UI_FONT}, system-ui, sans-serif; font-size: ${cap.size ?? brand.capSize}px; font-weight: 800; color: #fff; letter-spacing: -1px; text-shadow: 0 4px 18px rgba(0,0,0,.55), 0 1px 3px rgba(0,0,0,.6); }`
  : cap.style === "pill"
  ? `.cap-group { font-family: ${UI_FONT}, system-ui, sans-serif; font-size: 66px; font-weight: 800; color: #fff; background: rgba(12,12,14,.88); border-radius: 22px; padding: 16px 32px; max-width: 900px; }`
  : cap.style === "box"
  ? `.cap-group { font-family: ${brand.font || "Montserrat"}, system-ui, sans-serif; font-size: ${CAP_SIZES.box}px; font-weight: 900; line-height: 1.08; color: ${cap.ink ?? brand.ink ?? "#111"}; background: ${cap.boxColor ?? brand.accent}; border-radius: 12px; padding: 10px 24px 14px; max-width: 860px; text-align: center; box-shadow: 0 10px 28px rgba(0,0,0,.28); }
  .cap-group .w { margin: 0 0.14em; }`
  : cap.style === "condensed"
  ? `.cap-group { font-family: ${cap.font ?? "Oswald"}, sans-serif; font-size: ${CAP_SIZES.condensed}px; font-weight: 700; line-height: .95; letter-spacing: 1px; color: #fff; max-width: 920px; text-align: center; text-shadow: 0 6px 22px rgba(0,0,0,.6), 0 2px 4px rgba(0,0,0,.7); }`
  : cap.style === "sessions"
  ? `.cap-group { font-family: "${cap.font ?? "Instrument Serif"}", Georgia, serif; font-size: ${CAP_SIZES.sessions}px; font-weight: 400; line-height: 1.12; letter-spacing: -0.045em; color: #f4f1ea; max-width: 860px; text-align: center; text-shadow: 0 0 14px rgba(255,255,255,.22); }
  .cap-group .w { margin: 0; background: rgba(78,78,84,.6); padding: 2px 0.065em 8px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .cap-group .w:first-child { padding-left: 16px; } .cap-group .w:last-child { padding-right: 16px; }`
  : cap.style === "serif"
  ? `.cap-group { font-family: ${cap.font ?? "EB Garamond"}, Georgia, serif; font-size: ${CAP_SIZES.serif}px; font-weight: 500; line-height: 1.15; color: ${cap.color ?? "#E7C66B"}; max-width: 900px; text-align: center; text-shadow: 0 2px 12px rgba(0,0,0,.55); }
  .cap-group .w { margin: 0 0.12em; }`
  : `.cap-group { font-family: Arial, Helvetica, sans-serif; font-size: ${cap.size ?? 56}px; font-weight: 700; color: #fff; max-width: 900px;
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
      if (scenes.length) times.push(scenes.at(-1));
      // the call to action: "comment ...", "follow ...", "subscribe", "link in bio", in the last quarter only
      const cta = words.find((w) => w.start > SPEECH * 0.75 && /^(comment|follow|subscribe|link)\b/i.test(w.word.trim().replace(/[^a-z ]/gi, "")));
      if (cta) times.push(r3(cta.start));
    }
    for (const t of Array.isArray(drops) ? drops : (typeof drops === "object" && Array.isArray(drops.at) ? drops.at : [])) times.push(E(t, "music drop"));
    spec.music = { ...spec.music, dropTimes: [...new Set(times.map(r3))] };
    console.log(`music drops at ${spec.music.dropTimes.join(", ")}s`);
  }
  const m = buildMusic(spec.music, motionCtx, execFileSync, path, fs);
  musicHtml = m.html;
  console.log(`music: ${spec.music.id || spec.music.src} at ${m.I} LUFS -> volume ${m.vol} (${spec.music.db ?? -20} dB under the voice)`);
}

// ---------- write ----------
const FONT_NAMES = { "instrument-serif": "Instrument Serif", "caveat-brush": "Caveat Brush", "yellowtail": "Yellowtail", "eb-garamond": "EB Garamond", "playfair-display": "Playfair Display", "jetbrains-mono": "JetBrains Mono", "geist-mono": "GeistMono" };
const RANGES = { latin: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD", cyrillic: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" };
const fontFaces = fs.readdirSync(path.join(A, "fonts")).filter((f) => /-(latin|cyrillic)(-italic)?\.woff2$/.test(f)).map((f) => {
  const m = /^(.*)-(latin|cyrillic)(-italic)?\.woff2$/.exec(f);
  const fam = FONT_NAMES[m[1]] || m[1].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
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
  @font-face { font-family: GeistMono; src: url(assets/fonts/geist-mono-latin.woff2) format("woff2"); }
  @font-face { font-family: Inter; src: url(assets/fonts/inter-cyrillic.woff2) format("woff2"); font-weight: 100 900; unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
  @font-face { font-family: Inter; src: url(assets/fonts/inter-latin.woff2) format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
  @font-face { font-family: Montserrat; src: url(assets/fonts/montserrat-cyrillic.woff2) format("woff2"); font-weight: 100 900; unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
  @font-face { font-family: Montserrat; src: url(assets/fonts/montserrat-latin.woff2) format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
  ${fontFaces}
  body { margin: 0; background: #000; }
  #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; font-family: ${UI_FONT}, system-ui, sans-serif; }
  #base, #snap, #push { position: absolute; inset: 0; transform-origin: ${zoom.origin || "50% 29%"}; }
  #base { transform: scale(${zoom.base ?? 1});${look.grade ? ` filter: ${look.grade};` : ""} }
  #pip { position: absolute; inset: 0; z-index: 1; transform-origin: 540px ${faceY}px; }
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
  ${MOTION_CSS(brand)}
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
  takes: takes.map((t) => ({ start: r3(t.start), dur: r3(t.dur), holdStart: r3(t.holdStart), holdFrames: t.holdFrames })),
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
for (const e of sfxEvents) console.log(`  ${e.t.toFixed(2).padStart(6)}s  ${e.id.padEnd(22)} ${e.role.padEnd(6)} vol ${e.vol}  (${e.why})`);
if (warn.length) console.log("\nWARNINGS:\n  " + [...new Set(warn)].join("\n  "));
console.log(`\n-> ${path.join(proj, "index.html")}`);

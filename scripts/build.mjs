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
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MOTION_CSS, buildScene, buildEditorialCaptions, buildMusic, uiCard, isLightColor, fitWipe } from "./lib/motion.mjs";
import { makePlacer, PLATFORMS, FORMATS } from "./lib/safezone.mjs";
import { clippingExtent } from "./lib/caption-metrics.mjs";
import { wordOwners } from "./lib/words.mjs";
import { wordsPathFor, facePathFor, cropPathFor, locateTake, medianFaceY } from "./lib/sources.mjs";
import { compileMotion, resolveColor, LIMITS as MOTION_LIMITS } from "./lib/motion-graphics.mjs";
import { resolveEmojiEm } from "./lib/emoji-em.mjs";
import { ROOM_SCALE, ROOM_EXIT_S, ROOM_FILL, normalizeRoom, ROOM_EASE_NAME, roomFrames, roomWindows, roomOrigin, roomCardCss } from "./lib/room.mjs";
import { computeSections, buildSectionManifest, globalHash } from "./lib/sections.mjs";
import { loadStyleChain, checkBrandName } from "./lib/style-path.mjs";
import { takeEndAt } from "./lib/caption-span.mjs";
import * as PK from "./lib/premium.mjs";
import { GM_CSS } from "./lib/gadzhi.mjs";
import { HZ_CSS, hzBeat } from "./lib/hormozi.mjs";
import { createHash } from "node:crypto";
import { joinDurProblem, joinDurations } from "./lib/joins.mjs";
import { matteThreads, cutMatteThreaded, writeAtomically } from "./lib/matte.mjs";
import * as RL from "./lib/relight.mjs";
import { resolveLayers, layerTruth, duckWindows, takeVolumeLane, renderLayer, layersCss, MEDIA_EXT } from "./lib/layers.mjs";
import { inspectPlaced, resolveGraphicBeat, prepareGraphics, testDeps, graphicBeatHtml, graphicBeatTweens, crossesUi, graphicLabel as _gl } from "./lib/graphic-place.mjs";
import { layerProblem as graphicLayerProblem, beatProblem as graphicBeatProblem, reason as graphicReason, checkContract, checkContractCoded, NOT_AN_OVERLAY as GRAPHIC_NOT_AN_OVERLAY, CAMERA_BEATS as GRAPHIC_CAMERA_BEATS, LIMITS as GRAPHIC_LIMITS } from "./lib/graphic.mjs";
import { vendoredIcon } from "./lib/vendor.mjs";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = process.env.PHANTASIC_LIB ? path.resolve(process.env.PHANTASIC_LIB) : path.join(SKILL, "library");   // PHANTASIC_LIB: another library root (tests; a studio with its own sounds)
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
const styleWarnings = [];
const loadStyle = (name) => {
  try {
    const r = loadStyleChain(name, { stylesDir: STYLE_DIR, deepMerge });
    styleWarnings.push(...r.warnings);
    return r.style;
  } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
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
  try { checkBrandName(id); } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
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
// stage (premium, opt-in): the speaker is cut out (matte) and composited on a designed set; the plate is hidden
if (spec.stage) spec.matte = true;
// glow.hookGround (opt-in, Podcast Glow; references/reel-json.md): the hook (the earliest pos "top" headline) gets the speaker cut
// out over a dark grid page for its window, as in the approved sample. Only when there is such a headline, no ground already on
// it and no stage: then the matte is cut, and shown (and extracted) only while the page is up (matteWindows + matteClip, unless the reel sets them).
if (spec.glow?.hookGround && !spec.stage && Array.isArray(spec.beats)) {
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const hook = spec.beats.filter((b) => b && b.type === "headline" && b.pos === "top" && isNum(b.at) && isNum(b.to) && b.to > b.at).sort((p, q) => p.at - q.at)[0];
  if (hook && !spec.beats.some((b) => b && b.type === "ground" && !(isNum(b.at) && isNum(b.to) && (b.to <= hook.at || b.at >= hook.to)))) {
    // the cut-out cannot follow a speed curve (take.ramp dies with a matte), and an explicit "matte": false is the reel's call
    if ((spec.takes || []).some((k) => k && k.ramp)) styleWarnings.push(`glow.hookGround: the reel has a ramped take, so the hook at ${hook.at}s gets no grid ground (a cut-out cannot follow a speed curve)`);
    else if (spec.matte === false) styleWarnings.push(`glow.hookGround: the reel sets "matte": false, so the hook at ${hook.at}s gets no grid ground`);
    else {
      const hg = spec.glow.hookGround, over = hg && typeof hg === "object" && !Array.isArray(hg) ? hg : {};
      const ground = { gradient: ["#141414", "#050505"], paper: "grid", gridColor: "rgba(255,255,255,.09)", gridSize: 64, grain: false, ...over, at: hook.at, to: hook.to, type: "ground" };
      const k = spec.beats.indexOf(hook);
      spec.beats = [...spec.beats.slice(0, k), ground, ...spec.beats.slice(k)];
      // a reel that already cut its matte for its own reasons (behind words...) keeps showing it as before
      if (spec.matte !== true) {
        spec.matte = true;
        if (spec.matteWindows === undefined) spec.matteWindows = true;
        if (spec.matteClip === undefined) spec.matteClip = true;
      }
    }
  }
}

const FPS = spec.fps ?? 30;
// brand kit: one accent (60/30/10), ink for text on light scenes, caption size
const brand = { accent: "#D13F34", accentDark: "#B93026", ink: "#262626", capSize: 58, font: null, ...(spec.brand || {}) };
// "#RRGGBB" -> "rgba(r,g,b,a)", for glows that follow the accent (colour themes: hormozi, podcast-glow)
const rgbaOf = (hex, a) => { const h = String(hex).replace("#", ""); return /^[0-9a-f]{6}$/i.test(h) ? `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})` : hex; };
// a stage / set glow of "accent" takes the template's accent colour
const glowOf = (g) => (g === "accent" ? rgbaOf(brand.accent, 0.3) : g);
const warn = [...styleWarnings];
// mac-56: this host's emoji advance for the caption model (CAPTION_EMOJI_EM + its stamp; lib/emoji-em.mjs), else 1.5
const HOST_EMOJI = resolveEmojiEm();
if (HOST_EMOJI.warning) warn.push(HOST_EMOJI.warning);
// mac-54: every graphic the build leaves out, as data: build/graphics-dropped.json (written only when something was
// dropped, removed otherwise, so the file never outlives the build that wrote it). The warnings are unchanged; this is a
// second, machine-readable copy for the planner and the review pass. Spec: references/reel-json.md "graphics-dropped.json".
const dropped = [];
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const GRAPHIC_WHY = (code) => !code ? "it could not be placed"
  : /^G\d/.test(code) ? "its HTML file failed a safety check"
  : /^R\d/.test(code) ? "it could not be rendered safely"
  : ({ P1: "its mode is not overlay or insert", P2: "it is shorter or longer than a graphic window may be", P3: "most of its box is off the canvas",
       P4: "it covered the speaker's face", P5: "it crossed the captions", P6: "it overlapped something the director placed at the same time",
       time: "its time is not inside the edit", box: "its box is not a valid rectangle", fit: "its fit is not cover or contain" })[code] ?? "it could not be placed";
const recordDrop = ({ kind, id = null, type = null, at = null, to = null, t = null, rule, why, warning }) =>
  dropped.push({ kind, id: id ?? null, type, at: at ?? null, to: to ?? null, t: Number.isFinite(t) ? Math.round(t * 1000) / 1000 : null, rule, why, warning });
// the parts a kept motion graphic (beat or layer) leaves out: elements (not drawn) and tweens or tween keys (drawn, but
// not moving as planned). `owner`: { id, type, at, to } as written; `t`: its start in output seconds.
const recordMotionParts = (owner, mg, t) => {
  const what = owner.type === "motion layer" ? "motion layer" : "motion graphic";
  for (const d of mg.dropped || []) recordDrop({ kind: "motion element", id: `${owner.id ?? "?"}/${d.element ?? "?"}`, type: owner.type, at: owner.at, to: owner.to, t, rule: "element", why: `One part${d.element ? ` ("${d.element}")` : ""} of the ${what} at ${clock(t)} was left out because it could not be drawn.`, warning: d.why });
  for (const d of mg.droppedTweens || []) {
    const on = d.target ? ` on "${d.target}"` : "";
    const why = d.rule === "tween-limit" ? `An animation (tween ${d.tween}${on}) of the ${what} at ${clock(t)} was left out because a motion graphic may have at most ${MOTION_LIMITS.tweens} animations.`
      : d.rule === "tween-key" ? `Part of an animation (tween ${d.tween}${on}) of the ${what} at ${clock(t)} was left out, so it does not move exactly as planned.`
      : `An animation (tween ${d.tween}${on}) of the ${what} at ${clock(t)} was left out, so that part does not move as planned.`;
    recordDrop({ kind: "motion tween", id: `${owner.id ?? "?"}/tween ${d.tween}`, type: owner.type, at: owner.at, to: owner.to, t, rule: d.rule, why, warning: `motion ${owner.id ?? "?"}: ${d.why}` });
  }
};
const die = (m) => { console.error("ERROR: " + m); process.exit(1); };
// premium kit (opt-in, lib/premium.mjs): SVG defs collected here are written inside #root next to the watermark.
// look.preset names a grade in presets/grades.json (an SVG tone-curve filter on #base); unset = nothing changes.
const premiumDefs = [];
let brollGrade;
let gradePresetUsed = null;
if (spec.look?.preset) {
  const gp = PK.gradePreset(spec.look, path.join(SKILL, "presets", "grades.json"));
  if (gp.error) die(gp.error);
  spec.look = gp.look; premiumDefs.push(gp.svg); brollGrade = gp.brollGrade ?? undefined; gradePresetUsed = gp.resolved;
  console.log(`grade preset ${spec.look.preset}: ${spec.look.grade}`);
}
// Blank project (origin "blank", no takes): a black W x H page, 1 s long, with the same root and
// timeline contract as a real build, plus the build/*.json files other tools read - all empty.
function writeBlankPage() {
  const BLANK_S = 1;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<title>${String(spec.title || "reel").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  body { margin: 0; background: #000; }
  #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${BLANK_S}" data-fps="${FPS}"></div>
<script>
  const tl = gsap.timeline({ paused: true });
  // the timeline is as long as the reel, not as long as its last tween: a preview or player that reads
  // tl.duration() would otherwise stop at the last caption/graphic and freeze the footage after it
  tl.set({}, {}, ${BLANK_S});
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(proj, "index.html"), html);
  fs.mkdirSync(path.join(proj, "build"), { recursive: true });
  const j = (name, v) => fs.writeFileSync(path.join(proj, "build", name), JSON.stringify(v, null, 2));
  j("edit_truth.json", { total: BLANK_S, speech: 0, fps: FPS, takes: [], snaps: [], pushes: [], beats: [] });
  j("sfx_events.json", { total: BLANK_S, speech: 0, voiceP95: 0, roleDb: {}, events: [] });
  j("words.edit.json", []);
  j("caption_layout.json", { platform: null, safeTop: 0, safeBottom: H, blocks: [] });
  j("sections.json", { total: BLANK_S, fps: FPS, globalHash: null, sections: [] });
  fs.rmSync(path.join(proj, "build", "graphics-dropped.json"), { force: true });   // mac-54: a blank page drops nothing
  console.log(`blank project: no takes yet -> ${BLANK_S}s black ${W}x${H} page\n\n-> ${path.join(proj, "index.html")}`);
  process.exit(0);
}
// I-19: output format. Canonical WxH comes from safezone.mjs's FORMATS map (one
// source of truth prep.sh and build.mjs both read, rather than build.mjs holding
// its own second copy of these four numbers). Unknown spec.format dies loudly
// instead of silently falling back - a typo'd format and a missing one should
// not look the same.
const FORMAT = spec.format ?? "9:16";
if (!FORMATS[FORMAT]) die(`unknown spec.format '${FORMAT}'; have: ${Object.keys(FORMATS).join(", ")}`);
const { W, H } = FORMATS[FORMAT];

// I-25 second half, PROTOTYPE: render-per-section. Opt-in via three env vars, all unset by
// default - every existing caller (every fixture, every `node build.mjs <dir>` invocation in
// SKILL.md/doctor.sh/the A1 harness) leaves SECTION_MODE false and this file's behaviour is
// completely unchanged below this line. See the report accompanying this change for exactly
// what IS and is NOT exercised by this prototype (beats/scenes, multi-source, take-join
// transitions, opening effects and the endcard are NOT covered - only takes, snaps, pushes and
// word-timed captions are, which is what f01-cuts-pushes (the fixture this was proved against)
// contains). This writes ONE section's composition to GE_SECTION_OUT; it does not orchestrate
// the render or the final concat/mux - that is done by the calling script, same division as
// `hyperframes render` itself not knowing about sections.
const SECTION_START = process.env.GE_SECTION_START !== undefined ? parseFloat(process.env.GE_SECTION_START) : null;
const SECTION_END = process.env.GE_SECTION_END !== undefined ? parseFloat(process.env.GE_SECTION_END) : null;
const SECTION_OUT = process.env.GE_SECTION_OUT || null;
const SECTION_MODE = SECTION_START !== null && SECTION_END !== null;
if (SECTION_MODE && !SECTION_OUT) die("GE_SECTION_START/GE_SECTION_END set without GE_SECTION_OUT");
if (SECTION_MODE && !(SECTION_END > SECTION_START)) die(`GE_SECTION_END (${SECTION_END}) must be > GE_SECTION_START (${SECTION_START})`);

// ---------- takes and time mapping ----------
// I-16 / MULTIANGLE Gap 1: a take names the recording it comes from. `take.src` is OPTIONAL and
// defaults to spec.source, so every reel.json written before this - and every fixture - means
// exactly what it meant before, and a single-source build is byte-identical (verified against
// f01-f06's index.html and edit_truth.json hashes, both before and after this change). Only a reel
// that actually sets take.src on some take becomes multi-source.
//
// Scope, deliberately: this is Gaps 1 and 2 (schema + renderer). Gap 3 - prep.sh / transcribe.py /
// face_track.py writing per-source outputs - is NOT in this change; a multi-source project today
// needs its assets/*.mp4 placed by hand. Recorded in NEXT.md so it does not expand silently.
// BLANK TIMELINE (BLANK-TIMELINE-SPEC.md, Stage 1): a project that has no clips yet. An empty reel
// with `origin: "blank"` builds a valid black page of 1 s (so the editor's preview iframe has
// something to show) and stops here. Without the marker an empty reel is still an error - a plan
// that lost all its takes by accident must not look like a deliberate blank project.
if (!(spec.takes || []).length) {
  if (rawSpec.origin !== "blank") die(`reel.json has no takes (an empty reel is only valid with "origin": "blank")`);
  // layers are resolved against the take layout, and there is none: say so rather than drop them silently
  if (Array.isArray(rawSpec.layers) && rawSpec.layers.length) console.log(`WARNING: ${rawSpec.layers.length} layer(s) ignored - a reel with no takes builds the blank page only; add a clip first`);
  writeBlankPage();
}
const takes = spec.takes.map((t, i) => {
  if (!(t.b > t.a)) die(`take ${i} has b <= a`);
  if (t.src != null && typeof t.src !== "string") die(`take ${i}: src must be a string path, got ${typeof t.src}`);
  // take.ramp (premium kit): a NON-SPEECH action take plays on a speed curve; its length on the timeline is
  // (b - a) / mean speed, and E() maps source seconds inside it through the warp
  if (t.ramp) {
    let R;
    try { R = PK.resolveRamp(t.ramp); } catch (e) { die(`take ${i}: ${e.message}`); }
    const frames = Math.round(((t.b - t.a) / PK.meanSpeed(R.curve)) * FPS);
    return { ...t, src: t.src ?? spec.source, frames, warp: PK.warpFn(PK.rampKnots(R.curve, frames / FPS)) };
  }
  return { ...t, src: t.src ?? spec.source, frames: Math.round((t.b - t.a) * FPS) };
});
takes.forEach((k, i) => {
  if (!k.ramp) return;
  if (k.hold || i === takes.length - 1) die(`take ${i}: a ramped take can't be the last take or carry a hold`);
  if (spec.stage || spec.matte) die(`take ${i}: take.ramp is not supported with spec.stage / spec.matte (the cut-out layer cannot follow a speed curve)`);
});
// a position inside a take (source seconds -> edit seconds); a ramped take goes through its warp
const inTake = (k, x) => k.start + (k.warp ? k.warp(x - k.a) : x - k.a);
// Distinct sources in first-use order. SOURCES[0] stays spec.source for any reel that does not use
// take.src, which is what keeps the single-source render path unchanged.
const SOURCES = [...new Set(takes.map((t) => t.src))];
if (SOURCES.some((s) => s == null)) die("a take has no src and spec.source is unset");
const srcIndex = new Map(SOURCES.map((s, i) => [s, i]));
// hold: seconds of frozen last frame AFTER a take (no voice). It makes air
// for a meme on a tightly cut recording; the meme's `at` is the take's b.
let acc = 0;
for (const t of takes) {
  t.start = acc / FPS; acc += t.frames; t.dur = t.frames / FPS;
  t.holdFrames = Math.round((t.hold ?? 0) * FPS); t.holdStart = acc / FPS; acc += t.holdFrames;
}
const SPEECH = acc / FPS;
const OUTRO = spec.outro ?? 3;
// reel.layers[] (BLANK-TIMELINE-SPEC.md, Stage 3): picture-in-picture, B-roll over the voice, logos, stickers,
// text and graphics on a clip without speech. Their times are OUTPUT seconds, so they are resolved HERE,
// straight after the take layout and BEFORE the SECTION_MODE rebase below (anchors read the whole-reel
// t.start). Timing + validation is lib/layers.mjs (pure); this only adds what needs the filesystem: the
// file must exist, and a video layer's sound is only used if the file has any. No layers key = nothing in
// this block runs and the build is byte-identical to before it existed.
const LAYERS = [];
if (spec.layers !== undefined) {
  const lr = resolveLayers(spec.layers, { takes, total: +(SPEECH + OUTRO).toFixed(3), fps: FPS, W, H, graphic: (L) => inspectPlaced(L, { proj, W, H }) });
  if (lr.errors.length) die("layers: " + lr.errors.join("; "));
  if (lr.problems.length) die(lr.problems[0]);   // a graphic layer's G / P problem, word for word (references/reel-json.md)
  for (const m of lr.warnings) warn.push(m);
  for (const l of lr.layers) {
    if (MEDIA_EXT[l.kind]) {
      const full = path.resolve(proj, l.src);
      if (!full.startsWith(proj + path.sep) || !fs.existsSync(full)) die(`layer ${l.id}: ${l.kind} src ${l.src} is not a file inside the project`);
      if (l.kind === "video") {
        const probe = (...a) => execFileSync("ffprobe", ["-v", "error", ...a, full]).toString().trim();
        const dur = parseFloat(probe("-show_entries", "format=duration", "-of", "csv=p=0"));
        l.hasAudio = probe("-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0") !== "";
        if (Number.isFinite(dur) && l.in + l.dur > dur + 0.05) {
          const avail = +(Math.max(0, dur - l.in)).toFixed(3);
          if (avail < 0.1) die(`layer ${l.id}: in ${l.in}s is past the end of ${l.src} (${dur.toFixed(2)}s)`);
          warn.push(`layer ${l.id}: ${l.src} has only ${avail}s after in ${l.in}s, shortened from ${l.dur}s`);
          l.dur = avail; l.t1 = +(l.t0 + avail).toFixed(3);
        }
      }
    }
    LAYERS.push(l);
  }
}
const DUCK = duckWindows(LAYERS);
// I-25 prototype: every take's edit-time position shifts by -SECTION_START, UNCHANGED array,
// UNCHANGED indices - take-join-transition adjacency (takes[i-1]/takes[i], below) and E()'s own
// take lookup (which reads t.start) both still work exactly as in the full build, just in a
// time-origin that starts at this section instead of at the reel. `t.inSection` is decided on
// the PRE-rebase (i.e. real, whole-reel) start/end, before it moves: a take wholly outside
// [SECTION_START, SECTION_END) is kept in the array (so adjacency math stays intact) but never
// emitted (see takeHtml/takeAudio/the words-ownership loop below). E() itself needs no change -
// every snap, push and beat `at`/`to` in the system already resolves through `k.start` (this
// same rebased value), so rebasing takes here rebases everything downstream of E() for free.
if (SECTION_MODE) {
  for (const t of takes) {
    const tEnd = t.start + t.dur + t.holdFrames / FPS;
    t.inSection = t.start < SECTION_END - 1e-6 && tEnd > SECTION_START + 1e-6;
    // not run through r3() here - t.start/t.holdStart were never rounded at this point either
    // (see the unrounded `acc / FPS` assignment just above); rounding is applied, as before,
    // wherever these values are interpolated into output strings (r3(k.start) etc. below).
    t.start = t.start - SECTION_START;
    t.holdStart = t.holdStart - SECTION_START;
  }
}
const SECTION_TOTAL = SECTION_MODE ? +(SECTION_END - SECTION_START).toFixed(3) : null;
const TOTAL = +(SPEECH + OUTRO).toFixed(3);

// takes in recording order, for the gap-snap below. Array order is PLAYBACK order and may differ.
// I-16: partitioned PER SOURCE. A single global sort would interleave times from different
// recordings, and the "< 1.2 s removed gap" test below would then compare two takes that are
// adjacent in the merged ordering but come from different files - a gap that does not exist in
// either recording. That returns a plausible wrong edit time rather than throwing, which is the
// worse failure, so the partition is load-bearing and not a tidy-up. With one source this is the
// same single sorted array as before.
const bySourceOf = new Map(SOURCES.map((s) => [s, takes.filter((t) => t.src === s).sort((x, y) => x.a - y.a)]));
// Beat-level `src` (blank-timeline multi-source): a beat's times are seconds of ONE recording. `beat.src`
// names it, and every bare time that beat (and its inner lines, items, pills...) hands to E() is read
// as {src, t}. CUR_BEAT is the beat whose body is being compiled (set by the beat loop), so nested
// E(l.at) calls need no change; EB(b, "at") is for the sites that resolve a beat's own at/to outside it.
// Without `src` the old rule stands, except that an ambiguous bare time INSIDE A BEAT no longer throws (which dropped motion beats
// without a trace): it resolves to the primary source if that covers it, else the first covering take in output order, and warns.
// Snaps, pushes and the like still throw when ambiguous - they have no beat to carry a src.
let CUR_BEAT = null;
// A beat's `src` names a recording only where it cannot mean something else: popcard/logo/meme beats already use `src` for an
// image ASSET, so there it counts only when it is one of the reel's sources; a motion beat has no asset src, so any value counts
// (and an unknown one drops the beat with a warning).
const beatRec = (b) => (b && typeof b.src === "string" && (b.type === "motion" || SOURCES.includes(b.src)) ? b.src : null);
const ambiguousWarned = new Set();
const E = (t, what = "", src) => {
  if (t === "end") return TOTAL;
  if (typeof t === "string" && t.startsWith("outro+")) return SPEECH + parseFloat(t.slice(6));
  const beatSrc = src !== undefined ? src : beatRec(CUR_BEAT);
  if (typeof t === "number" && beatSrc != null && SOURCES.length > 1) {
    if (!SOURCES.includes(beatSrc)) throw new Error(`E(${t})${what ? " for " + what : ""}: src ${JSON.stringify(beatSrc)} is not a source of this reel (${SOURCES.join(", ")})`);
    t = { src: beatSrc, t };
  }
  // I-16: with more than one source a bare number is "t seconds into WHICH file?". Resolve it only
  // when exactly one source can claim it; if two different recordings both contain that time, the
  // reel has to say which, because guessing is how an edit silently cuts to the wrong camera.
  // `{src, t}` is the explicit form. Single-source reels never reach the ambiguity branch.
  if (typeof t === "object" && t !== null && t.src != null && typeof t.t === "number") {
    const k = takes.find((q) => q.src === t.src && t.t >= q.a - 1e-6 && t.t <= q.b + 1e-6);
    if (k) return +inTake(k, t.t).toFixed(3);
    // a removed gap (< 1.2 s) inside the named recording snaps to the next kept take, as for a bare time
    const bs = bySourceOf.get(t.src) || [];
    for (let i = 0; i + 1 < bs.length; i++) if (t.t > bs[i].b && t.t < bs[i + 1].a && bs[i + 1].a - bs[i].b < 1.2) return +bs[i + 1].start.toFixed(3);
    throw new Error(`E({src:${t.src}, t:${t.t}})${what ? " for " + what : ""}: not inside any take of that source`);
  }
  if (typeof t === "number" && SOURCES.length > 1) {
    const hits = takes.filter((k) => t >= k.a - 1e-6 && t <= k.b + 1e-6);
    const srcs = [...new Set(hits.map((k) => k.src))];
    if (srcs.length > 1) {
      if (!CUR_BEAT && src === undefined) throw new Error(`E(${t})${what ? " for " + what : ""}: ambiguous across ${srcs.length} sources (${srcs.join(", ")}) - this reel is multi-source, so write {"src": "<file>", "t": ${t}} instead of a bare time`);
      // deterministic rule: the primary source (spec.source, the recording the transcript belongs to - what a
      // speech-anchored beat means) wins; if it does not cover the time, the first covering take in output order
      const first = hits.find((k) => k.src === PRIMARY_SRC) ?? hits[0], key = `${CUR_BEAT?.id ?? CUR_BEAT?.type ?? what}@${t}`;
      if (!ambiguousWarned.has(key)) { ambiguousWarned.add(key); warn.push(`${what || "time"} ${t}s is in ${srcs.length} sources (${srcs.join(", ")}): used ${first.src} (${first.src === PRIMARY_SRC ? "the primary source" : "the first take in output order that covers it"}) - add "src" to the beat to say which recording it means`); }
      return +inTake(first, t).toFixed(3);
    }
  }
  for (const k of takes) if (t >= k.a - 1e-6 && t <= k.b + 1e-6) return +inTake(k, t).toFixed(3);
  // whisper word times are loose around pauses: a time inside a short removed
  // gap (< 1.2 s) snaps to the start of the next kept take.
  // Walk takes in SOURCE order, not array order: a reordered edit (the hook moved to the front)
  // leaves array-adjacent takes non-adjacent in the recording, and this test then compares a gap
  // that does not exist. Measured: with takes [10.06-20.12, 0.4-4.88, 7.82-9.5, 20.24-22.36],
  // E(9.8) threw "not inside any take" where source order resolved it to 6.133. Sorting a copy is
  // a no-op when takes are already in source order, so plans that never reorder are untouched.
  if (typeof t === "number") for (const bySource of bySourceOf.values()) for (let i = 0; i + 1 < bySource.length; i++) if (t > bySource[i].b && t < bySource[i + 1].a && bySource[i + 1].a - bySource[i].b < 1.2) return +bySource[i + 1].start.toFixed(3);
  // "hold:<i>+s" = s seconds into the hold after take i
  if (typeof t === "string" && t.startsWith("hold:")) { const [i, off] = t.slice(5).split("+"); return +(takes[+i].holdStart + (parseFloat(off) || 0)).toFixed(3); }
  throw new Error(`E(${t})${what ? " for " + what : ""}: not inside any take`);
};
const EB = (b, key, what = "") => E(b[key], what, beatRec(b));
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------- words -> edit-time captions ----------
const core = (w) => w.replace(/[.,!?;:]+$/, "");
const punct = (w) => w.slice(core(w).length);
// MULTIANGLE Gap 3 (consumption half): a transcript PER source. `spec.words` still names the
// primary source's, so single-source reel.json files are untouched; every other source's path is
// derived by convention from its own `src` (lib/sources.mjs) rather than through a new schema
// field, so the planner needs to learn nothing. A source whose transcript has not been produced
// yet warns and contributes no captions - the honest degradation A30 established.
const PRIMARY_SRC = spec.source ?? SOURCES[0];
const loadWords = (rel) => {
  const abs = path.resolve(proj, rel);
  if (!fs.existsSync(abs)) return null;
  return JSON.parse(fs.readFileSync(abs, "utf8")).segments
    .flatMap((s) => (s.words || []).map((w) => ({ word: w.word.trim(), start: w.start, end: w.end })));
};
// Still required, and still named by spec.words - a missing primary transcript is a build failure,
// not a reel with no captions.
// BLANK TIMELINE: `spec.words` may be absent (a project whose clips have no speech). Then the primary
// source's transcript is looked up by the per-source convention, and a missing one just means no
// captions - the same honest degradation every other transcript-less source gets below. A
// `spec.words` that IS set but points at nothing stays a build failure, as it always was.
const allWords = spec.words != null ? loadWords(spec.words) : (loadWords(wordsPathFor(PRIMARY_SRC)) ?? []);
if (!allWords) die(`words file not found: ${spec.words} (run transcribe.py first)`);
const fixes = Object.entries(spec.captions?.fixes || {});
const words = [];
console.log("\n edit-start   orig a  ->  orig b   dur   text");
// each word belongs to ONE take: the one it overlaps most (whisper stretches
// words over pauses, so a boundary word can touch two neighbouring takes)
// I-16: `spec.words` is ONE transcript, and it describes ONE recording - spec.source, the file
// prep.sh and transcribe.py were pointed at. Word times in it are therefore times in THAT
// recording, so only takes cut from it can own a word.
//
// Without this filter the candidate set was every take regardless of src, and a word was handed to
// whichever take overlapped it most in bare numbers. On a multi-source reel that silently steals
// captions across a file boundary: measured on a 2-source build where take 1 (6.0-10.0 of a
// second recording with NO transcript at all) was given "Second take starts here after a gap",
// words spoken in the FIRST recording, and rendered them over the second recording's footage.
// Nothing warned. It reached index.html, and `caption_layout.json` - the A1 gate's caption oracle
// - is written from this same ownership, so the oracle inherited the error and the gate scored the
// stolen captions as correct. An earlier 2-source build looked clean only because its take landed
// in a dead zone where the transcript happened to have no words (4.0-6.0).
//
// Single-source is unaffected by construction: every take's src defaults to spec.source, so the
// candidate set is unchanged (verified by hashing f01-f06's index.html, edit_truth.json and
// caption_layout.json before and after - all identical).
//
// Scope: this makes a foreign-source take own NO words, which is correct today because no second
// transcript exists. Giving each source its own transcript is MULTIANGLE Gap 3, and that gap's
// text covers only the ingest half - see ISSUES A30.
// The rule itself lives in lib/words.mjs so it can be asserted without a build - see
// lib/words.test.mjs, which carries the multi-source regression case.
//
// Ownership is resolved once per source, against that source's own transcript, and the results
// collected per take. A take belongs to exactly one source, so its words all come from one list
// and stay in that list's order - no cross-source interleaving to re-sort.
const wordsByTake = takes.map(() => []);
for (const s of SOURCES) {
  const rel = s === PRIMARY_SRC ? (spec.words ?? wordsPathFor(s)) : wordsPathFor(s);
  // Two sources must never resolve to the SAME transcript - that is A30 wearing a convention.
  // A source not named per lib/sources.mjs (`assets/talk-1.mp4`) derives index 0 and therefore the
  // PRIMARY path, which would hand one recording's words to another recording's takes. Caught by
  // the 2-source repro the moment this was wired up: `assets/b.mp4` has no `-N`, so it resolved to
  // `build/words.whisper.json` and stole source 0's captions all over again. Refuse instead.
  if (s !== PRIMARY_SRC && rel === (spec.words ?? wordsPathFor(PRIMARY_SRC))) {
    const n = takes.filter((k) => k.src === s).length;
    warn.push(`source ${s} is not named for the per-source convention (expected assets/talk-<N>.mp4), so no transcript of its own can be located - its ${n} take(s) carry no captions. Renaming it is MULTIANGLE Gap 3's ingest half.`);
    continue;
  }
  const list = s === PRIMARY_SRC ? allWords : loadWords(rel);
  if (!list) {
    const n = takes.filter((k) => k.src === s).length;
    warn.push(`source ${s} has no transcript at ${rel} - its ${n} take(s) carry no captions (MULTIANGLE Gap 3: run transcribe.py per source)`);
    continue;
  }
  const own = wordOwners(list, takes, s);
  list.forEach((w, wi) => { if (own[wi] >= 0) wordsByTake[own[wi]].push(w); });
}
for (const [ti, k] of takes.entries()) {
  if (SECTION_MODE && !k.inSection) continue;  // I-25 prototype: no captions for a take outside this section
  const ws = wordsByTake[ti];
  if (k.ramp) {
    const talk = ws.filter((w) => Math.min(w.end, k.b) - Math.max(w.start, k.a) > 0.08);
    if (talk.length) die(`take ${ti} has a ramp but contains speech ("${talk.slice(0, 4).map((w) => w.word.trim()).join(" ")}"); ramps are for non-speech action takes only (voice is never ramped)`);
    continue;
  }
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
// captions.dedupe (opt-in): a word repeated back to back ("marketing marketing") is shown once.
// Ported from main's template-the-monk / template-the-headline (Ahmed, 9 Oct); off unless a style asks.
if (spec.captions?.dedupe) for (let i = words.length - 1; i > 0; i--) if (core(words[i].word).toLowerCase() === core(words[i - 1].word).toLowerCase() && words[i].start - words[i - 1].end < 0.5) { words[i - 1].end = words[i].end; if (/[.?!,]$/.test(words[i].word)) words[i - 1].word = words[i].word; words.splice(i, 1); }
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
// templates/fonts-extra: fonts only some beats need (Anton for the Podcast Glow headline). Not in templates/fonts, because
// every file there becomes an @font-face in EVERY reel's page; here it is copied (and declared) only when a headline beat exists.
const EXTRA_FONT_DIR = path.join(SKILL, "templates", "fonts-extra");
const extraFonts = (spec.beats || []).some((b) => b.type === "headline") && fs.existsSync(EXTRA_FONT_DIR) ? fs.readdirSync(EXTRA_FONT_DIR).filter((f) => f.endsWith(".woff2")) : [];
const wantedFonts = new Set([...templateFonts, ...extraFonts]);
for (const f of fs.readdirSync(path.join(A, "fonts"))) if (!wantedFonts.has(f)) fs.unlinkSync(path.join(A, "fonts", f));
for (const f of templateFonts) fs.copyFileSync(path.join(SKILL, "templates", "fonts", f), path.join(A, "fonts", f));
for (const f of extraFonts) fs.copyFileSync(path.join(EXTRA_FONT_DIR, f), path.join(A, "fonts", f));

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
  // simple-icons (CC0), from vendor/simple-icons (scripts/lib/vendor.mjs): never fetched, at build or render time
  const dst = path.join(A, "icons", `${slug}.svg`);
  if (!fs.existsSync(dst)) {
    const svg = vendoredIcon("simple-icons", slug);
    if (svg == null) die(`no simple-icons slug '${slug}' (see https://simpleicons.org); pass "src" with your own image instead`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, svg);
  }
  return `assets/icons/${slug}.svg`;
};
const userAsset = (p) => {
  const src = path.resolve(proj, p);
  if (!fs.existsSync(src)) die(`asset not found: ${p}`);
  // An HTML src is a URL, not a filesystem path. path.relative() returns the OS
  // separator, so on Windows this emitted `assets\shot.png` and neither the
  // browser nor the renderer resolved it. The copy branch below always wrote a
  // forward slash, which is why ONLY assets already under assets/ were broken -
  // that is every asset placed through the timeline, which uploads into it.
  if (src.startsWith(A + path.sep)) {
    return path.relative(proj, src).split(path.sep).join("/");
  }
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
  // Nothing to measure without a transcript (the loop below visits words only), so the decode is
  // skipped - which also means a primary source that is a still image or a silent clip never
  // reaches ffmpeg here. The result is the same constant the empty loop produced before.
  const raw = allWords.length === 0 ? Buffer.alloc(0) : execFileSync("ffmpeg", ["-v", "error", "-i", path.resolve(proj, spec.source ?? PRIMARY_SRC), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const win = 800, pk = [];
  // allWords is the PRIMARY source's transcript, matched against every take. That is deliberate
  // and self-consistent: the audio decoded above is spec.source's too, so words and samples come
  // from the same recording. On a multi-source reel this measures the voice level of source 0 and
  // uses it as the reference for the whole mix - a level approximation, not a wrong render. Making
  // it per-source needs prep.sh to guarantee identical loudness across sources, which is Gap 3's
  // ingest half (-16 LUFS each); until then one reference is the honest choice.
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
// an entry with duration null is an id record with no source yet (library/SOURCES.md): it counts as no entry at all, even
// when a file of that name is on disk (it has no measured length to play it with), so a reel builds exactly as without it
const sfxEntry = (r) => { const m = sfxManifest[r]; return m && m.duration != null ? m : undefined; };
const sfxOk_ = (r) => !!(sfxEntry(r) && fs.existsSync(path.join(LIB, "sfx", sfxEntry(r).file)));
const addSfx = (t, id, why, { db = 0, lead = 0 } = {}) => {
  if (!id || id === "none") return;
  if (SFX_PROFILE === "restrained" && RESTRAINED_DROP.test(why)) return;
  // "pack:<name>" (Podcast Glow): a wav from the premium sound pack (PHANTASIC_SFX_PACK, default ~/reels/premium/sfx-pack), mixed as
  // role "impact". The pack is not shipped: a missing pack or file warns and is skipped like any other missing sound.
  if (id.startsWith("pack:")) {
    const dir = process.env.PHANTASIC_SFX_PACK || path.join(os.homedir(), "reels", "premium", "sfx-pack");
    const file = `${id.slice(5)}.wav`, src = path.join(dir, file);
    if (!fs.existsSync(src)) { missingSfx.set(`${id} (sound pack: ${dir})`, (missingSfx.get(`${id} (sound pack: ${dir})`) ?? 0) + 1); return; }
    fs.copyFileSync(src, path.join(A, "sfx", file));
    const dur = +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]).toString().trim();
    sfxEvents.push({ t: r3(Math.max(0, t - lead)), id, role: "impact", vol: volFor("impact", db), dur, src: `assets/sfx/${file}`, why });
    return;
  }
  let real = pick(id);
  let m = sfxEntry(real);
  // ---- spec.sfxFallback (opt-in; Folio, mini2): { "<id>": "<other id>" | "none" } - a sound whose file is not on this machine plays
  // the named stand-in instead (when that one is there), else it is skipped and reported below as before.
  if (spec.sfxFallback && !sfxOk_(real)) { const alt = spec.sfxFallback[real]; if (alt && alt !== "none" && sfxOk_(alt)) { real = alt; m = sfxEntry(alt); } }
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

const motionBeats = spec.beats || [];   // the same array beatsList aliases below; dropped beats are spliced out of it here
// Designer graphics (docs/MOTION-GRAPHICS-SPEC.md): a `motion` beat is opt-in per style (`"designer": true`).
// A beat that cannot be placed - style not opted in, or `at`/`to` not inside one kept take - is dropped with a
// warning, never fatal; the rest of the reel builds. Runs before anything resolves beat times, and splices the
// beat out of spec.beats so edit_truth.json only ever lists beats that were built.
for (let i = motionBeats.length - 1; i >= 0; i--) {
  const b = motionBeats[i];
  if (b.type !== "motion") continue;
  let why = null;
  // opt-in per style, EXCEPT a beat the user placed themselves ("by":"user") or any beat of a blank-origin reel: a studio
  // reel is not tied to a designer style, and silently dropping a graphic the user just added was bug 1 of the blank-timeline staging test
  if (spec.designer !== true && b.by !== "user" && spec.origin !== "blank") why = "this style does not set designer:true (and the beat is not by:\"user\" and the reel is not origin:\"blank\")";
  else if (b.to === undefined) why = "no `to`";
  else {
    try {
      const a = EB(b, "at", "motion at"), z = EB(b, "to", "motion to");
      const ka = locateTake(takes, a, FPS), kz = locateTake(takes, z - 0.001, FPS);
      if (!(z > a)) why = "`to` is not after `at`";
      else if (ka !== kz || z > ka.start + ka.dur + 1e-6) why = "`at` and `to` are not in the same kept take";
    } catch (e) { why = String(e.message).split("\n")[0]; }
  }
  if (why) {
    warn.push(`motion beat ${b.id ?? i} dropped: ${why}`);
    const rule = why.startsWith("this style does not set designer") ? "designer-off" : why === "no `to`" ? "no-to" : why.startsWith("`to` is not after") ? "span" : why.includes("same kept take") ? "take" : "time";
    let t = null; try { t = EB(b, "at", "motion at"); } catch { /* the time itself may be what failed */ }
    const plain = { "designer-off": "the reel's style does not allow designer graphics", "no-to": "it has no end time", span: "it ends before it starts", take: "it runs across a cut", time: "its time is not inside the edit" }[rule];
    recordDrop({ kind: "motion beat", id: b.id, type: "motion", at: b.at, to: b.to, t, rule, why: `The motion graphic${b.id ? ` "${b.id}"` : ""}${t != null ? ` at ${clock(t)}` : ""} was dropped because ${plain}.`, warning: `motion beat ${b.id ?? i} dropped: ${why}` });
    motionBeats.splice(i, 1);
  }
}

// ---------- Prompt Motion graphics (references/reel-json.md "Prompt Motion graphic"; lib/graphic-place.mjs) ----------
// A `graphic` beat is resolved here, before anything reads beat times (like the motion beats above): a G / P problem
// drops it with a warning (spliced out, so edit_truth.json lists only built beats). Then every graphic the reel needs
// (layers and beats) is rendered ONCE per cache key by PM2's renderGraphic, or found in assets/graphics/, in this one
// awaited pre-pass, before the first byte of the page is written: the rest of the build stays synchronous and
// deterministic. A render refusal kills the reel for a layer and drops a beat. No graphic layer or beat: nothing here runs.
const graphicLayers = LAYERS.filter((l) => l.kind === "graphic");
const graphicBeats = [];
for (let i = motionBeats.length - 1; i >= 0; i--) {
  const b = motionBeats[i];
  if (!b || b.type !== "graphic") continue;
  const g = resolveGraphicBeat(b, inspectPlaced(b, { proj, W, H }), { out: (t) => E(t, "graphic", beatRec(b)), fps: FPS, W, H });
  if (g.problem) {
    warn.push(g.problem);
    let t = null; try { t = E(b.at, "graphic", beatRec(b)); } catch { /* unmappable: recorded without a time */ }
    recordDrop({ kind: "graphic beat", id: b.id, type: "graphic", at: b.at, to: b.to, t, rule: g.code ?? null, why: `The graphic${b.id !== undefined ? ` "${b.id}"` : ""}${t != null ? ` at ${clock(t)}` : ""} was dropped because ${GRAPHIC_WHY(g.code)}.`, warning: g.problem });
    motionBeats.splice(i, 1); continue;
  }
  b._graphic = g;
  graphicBeats.unshift(b);
}
// The render pre-pass for these graphics runs further down, once the caption placer exists: the placement contract
// (P4-P6: face, caption band, director collision) is checked there first, so a refused graphic is never rendered.

// ---------- motion hold: the camera stays still under a designer graphic ----------
// Owner decision (Ahmed): on close-up footage the automatic punches and the opening push grow the face
// under the graphic. All times below are OUTPUT (edit-timeline) seconds - E() has already mapped the
// beat's recording-second `at`/`to` - and every comparison is made in whole frames, round(t * FPS).
//   1. A cadence snap (jump cut, emphasis or rhythm - anything in `cadenceSnaps`) whose start frame lies in
//      [round(at * FPS), round((to + MOTION_HOLD_EXIT) * FPS)], both ends inclusive, of any KEPT motion beat
//      is skipped. The cadence schedule is generated in full first and filtered afterwards, so every other
//      snap keeps its time, its scale and its sfx slot (the every-Nth sfx counter still counts a skipped one).
//   2. Because nothing in the window changes #snap, the scale in force at `at` - including a snap from before
//      `at` - simply stays in force until the window ends; it is not reset to 1.
//   3. openPush (the 0..dur ramp, reset at dur + 0.05) is dropped for the whole reel when any kept motion beat
//      starts at or before frame round((dur + 0.05) * FPS).
//   4. The director's explicit snaps and pushes are never touched.
const MOTION_HOLD_EXIT = 0.2;
// a room:"below" beat holds the camera (and hides captions) to to+0.55, until the footage has grown back
const motionHold = motionBeats.filter((b) => b.type === "motion").map((b) => [Math.round(EB(b, "at") * FPS), Math.round((EB(b, "to") + (normalizeRoom(b.room).room === "below" ? ROOM_EXIT_S : MOTION_HOLD_EXIT)) * FPS)]);
const inMotionHold = (t) => motionHold.some(([fa, fb]) => { const f = Math.round(t * FPS); return f >= fa && f <= fb; });
// "Making room": the footage-shrink windows of kept `room:"below"` beats, collected as the beats compile (a beat the
// compiler drops opens no room) and turned into #room tweens after the beat loop. See scripts/lib/room.mjs for the maths.
const roomFrameWins = [];
const openPushHeldByMotion = (dur) => motionHold.some(([fa]) => fa <= Math.round((dur + 0.05) * FPS));

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
  let every = cadence.every ?? 1.3; const minGap = cadence.minGap ?? 0.6;
  // cadence.targetPerMin (opt-in; Ahmed's engine/core): a TARGET pace instead of a fixed interval. The clip's own picture changes (jump cuts
  // between takes, scene in/out, leaks) are counted first; punch-ins only fill the gap to the target, so a multi-take clip isn't over-cut and
  // a one-take selfie isn't static
  let burstHold = null;
  if (cadence.targetPerMin) {
    const sceneBeats = (spec.beats || []).filter((b) => b.type === "scene" || b.type === "ground").length, leaks = (spec.beats || []).filter((b) => b.type === "leak").length;
    const natural = Math.max(0, takes.length - 1) + sceneBeats * 2 + leaks;
    const needed = cadence.targetPerMin * SPEECH / 60 - natural;
    every = needed > 0.5 ? Math.max(minGap, SPEECH / needed) : Infinity;
    if (cadence.burst && Number.isFinite(every)) { const c = cadence.burst.count ?? 3, g = cadence.burst.gap ?? 0.5; burstHold = Math.max(g * 2, every * c - g * (c - 1)); }
    console.log(`cadence target ${cadence.targetPerMin}/min: ${natural} natural changes in ${SPEECH.toFixed(1)} s -> punch every ${Number.isFinite(every) ? every.toFixed(2) + " s" : "never"}${burstHold ? ` (bursts, hold ${burstHold.toFixed(2)} s)` : ""}`);
  }
  const scales = cadence.scales ?? [1, 1.12];
  const emphasis = new Set([].concat(spec.captions?.highlight || []).filter((h) => typeof h === "string").map((h) => h.toLowerCase()));
  const joins = takes.slice(1).map((k) => r3(k.start));
  let last = -Infinity, n = 0;
  // cadence.burst {count, gap, hold} (opt-in): punches come in clusters (count punches `gap` s apart, then a `hold` s rest), the bunched
  // rhythm of real edits instead of an even tick
  const burst = cadence.burst; let inBurst = 0;
  const need = () => burst ? (inBurst > 0 && inBurst < (burst.count ?? 3) ? (burst.gap ?? 0.5) : (burstHold ?? burst.hold ?? 4)) : every;
  const add = (t, why) => {
    const gapNow = burst && inBurst > 0 && inBurst < (burst.count ?? 3) ? Math.min(minGap, burst.gap ?? 0.5) : minGap;
    if (t - last < gapNow || t >= SPEECH - 0.3) return;
    if (snaps.some(([u]) => Math.abs(u - t) < gapNow)) { last = t; return; }
    const z = why === "emphasis" ? (cadence.emphasisScale ?? Math.max(...scales) + 0.06) : scales[n % scales.length];
    snaps.push([r3(t), z]); cadenceSnaps.add(r3(t)); last = t; n++;
    if (burst) inBurst = inBurst >= (burst.count ?? 3) ? 1 : inBurst + 1;
  };
  let joinIndex = 0;
  for (const w of words) {
    const t = r3(Math.max(0, w.start - 0.02));
    const before = last;
    while (joinIndex < joins.length && joins[joinIndex] <= w.start + 0.05) add(joins[joinIndex++], "jump cut");
    if (last !== before) continue;
    if (emphasis.has(core(w.word).toLowerCase()) || /!$/.test(w.word)) add(t, "emphasis");
    else if (t - last >= need()) add(t, "cadence");
  }
  snaps.sort((a, b) => a[0] - b[0]);
  console.log(`cadence: ${cadenceSnaps.size} punch-ins added (~${(cadenceSnaps.size / Math.max(SPEECH, 1) * 60).toFixed(0)}/min)`);
}
tl.push(`tl.set("#snap", { scale: 1 }, 0);`);
let cadenceIndex = 0;
const heldCadence = new Set();
// punch (premium kit, opt-in; hand port of phantasic 1c15911): a punch-in eases over punch.frames (default 7) instead of
// snapping, optionally with a blur that follows the zoom speed (punch.blur > 0 puts the picture on a #tx wrapper). A snap
// on a jump cut stays a hard snap (the cut hides it) unless punch.joins is true. Unset = the plain tl.set below, unchanged.
const PUNCH = spec.punch ? { frames: 7, blur: 5, ease: "power3.out", joins: false, ...spec.punch } : null;
const TX = !!(PUNCH && PUNCH.blur) || !!spec.transitions;   // #tx: the punch blur and the premium whip / zoom-through both ride on it
const joinTimesPunch = PUNCH ? takes.slice(1).map((k) => r3(k.start)) : [];
const punchTimes = [];
const easedSnaps = new Set();
const FACE_ANCHOR = !!cadence?.faceAnchor;
const snapOriginDefault = zoom.origin || "50% 29%";
let curSnapOrigin = null;   // the transform-origin last written to #snap (null = the CSS default)
let prevZ = 1;
// the GSAP lines of one applied snap. sn[2] = [x, y] (optional): the point the punch-in scales around (cadence.faceAnchor)
const snapLines = (sn, fromZ) => {
  const [t, z, so] = sn;
  const out = [];
  const eased = PUNCH && Math.abs(z - fromZ) > 0.005 && (PUNCH.joins || !joinTimesPunch.some((j) => Math.abs(j - t) < 0.04));
  const oStr = so ? `${so[0]}px ${so[1]}px` : null;
  let originStr = null;   // a transform-origin to write at this snap, or null = leave it as it is
  if (oStr && oStr !== curSnapOrigin) { originStr = oStr; curSnapOrigin = oStr; }
  else if (!oStr && curSnapOrigin && z > 1.001) { originStr = snapOriginDefault; curSnapOrigin = null; }
  const origin = originStr ? `, transformOrigin: "${originStr}"` : "";
  if (eased) {
    easedSnaps.add(sn);
    const d = r3(PUNCH.frames / FPS);
    if (originStr) out.push(`tl.set("#snap", { transformOrigin: "${originStr}" }, ${t});`);
    out.push(`tl.fromTo("#snap", { scale: ${fromZ} }, { scale: ${z}, duration: ${d}, ease: "${PUNCH.ease}", immediateRender: false }, ${t});`);
    if (PUNCH.blur) out.push(`tl.fromTo("#tx", { filter: "blur(${PUNCH.blur}px)" }, { filter: "blur(0px)", duration: ${r3(Math.max(3, PUNCH.frames - 2) / FPS)}, ease: "power2.out", immediateRender: false }, ${t});`);
  } else out.push(`tl.set("#snap", { scale: ${z}${origin} }, ${t});`);
  return out.join("\n  ");
};
const snapPatches = [];   // faceAnchor: the origin needs the face tracks, loaded further down - these lines are written then
for (const sn of snaps) {
  const [t, z] = sn;
  if (cadenceSnaps.has(t) && inMotionHold(t)) { heldCadence.add(t); cadenceIndex++; continue; }
  if (FACE_ANCHOR) { snapPatches.push({ sn, idx: tl.length, fromZ: prevZ }); tl.push(""); }
  else tl.push(snapLines(sn, prevZ));
  if (PUNCH && z > prevZ && Math.abs(z - prevZ) > 0.005 && (PUNCH.joins || !joinTimesPunch.some((j) => Math.abs(j - t) < 0.04))) punchTimes.push(t);   // for the sfx design pass
  prevZ = z;
  if (cadenceSnaps.has(t)) {
    const every = cadence.sfxEvery ?? 4;
    if (cadence.sfx && cadenceIndex % every === 0) addSfx(t, cadence.sfx, "cadence snap", { db: cadence.sfxDb ?? -6, lead: 0.04 });
    cadenceIndex++;
  } else if (zoom.snapSfx || SFX_PROFILE === "rich") addSfx(t, !zoom.snapSfx || zoom.snapSfx === true ? "whoosh" : zoom.snapSfx, "snap", { db: -6, lead: 0.05 });
}
if (heldCadence.size) {
  for (let i = snaps.length - 1; i >= 0; i--) if (heldCadence.has(snaps[i][0])) snaps.splice(i, 1);
  for (const t of heldCadence) cadenceSnaps.delete(t);
  console.log(`motion hold: ${heldCadence.size} cadence punch-in(s) skipped under a motion beat`);
}
let lastPushEnd = -1;
const pushesEdit = [];
// openPush: a slow push-in on the speaker over the opening seconds (the hook breathes in)
if (spec.openPush && !(zoom.pushes || []).some((p) => E(p.at, "push") < (spec.openPush.dur ?? 2.5)) && !openPushHeldByMotion(spec.openPush.dur ?? 2.5)) {
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

// transitions (premium kit, opt-in): whip / zoom-through on jump cuts between takes, on #tx. A join that carries its own
// take.transition (I-17: blur / whip between two recordings) keeps that one and is skipped here; a join next to a punch-in
// (within 0.3 s) is skipped too.
const transitionsAt = [];
if (spec.transitions) {
  const T = { kind: "whip", every: 1, frames: 8, strength: 1, ...spec.transitions };
  if (!["whip", "zoom", "mix"].includes(T.kind)) die(`transitions.kind must be whip, zoom or mix (got ${T.kind})`);
  const kinds = T.kind === "mix" ? ["whip", "zoom"] : [T.kind];
  let k = 0;
  takes.slice(1).forEach((tk, i) => {
    const t = r3(tk.start);
    if ((i + 1) % T.every !== 0 && !takes[i].ramp && !takes[i + 1].ramp) return;   // ramp boundaries always get one
    if (tk.transition || takes[i].holdFrames) return;
    if (SECTION_MODE && !(takes[i].inSection && tk.inSection)) return;   // a join across a section boundary has no other side in this composition (as for take.transition)
    if (punchTimes.some((p) => Math.abs(p - t) < 0.3)) return;
    const kind = kinds[k % kinds.length];
    PK.txTransition(tl, kind, t, { fps: FPS, frames: T.frames, dir: k % 2 ? -1 : 1, strength: T.strength });
    transitionsAt.push({ t, kind }); k++;
  });
  if (transitionsAt.some((x) => x.kind === "whip")) premiumDefs.push(PK.WHIP_SVG);
  console.log(`transitions: ${transitionsAt.map((x) => `${x.kind}@${x.t}`).join(", ") || "none"}`);
}

// ---------- the speaker ----------
// I-16 / Gap 2: SRC was one file wired through here nine times. It is now the FIRST source, kept
// under the old name for the single-source paths that are genuinely about "the recording" as a
// whole (the matte, motionCtx), while anything per-take reads k.src instead.
const SRC = SOURCES[0];
for (const s of SOURCES) {
  if (!fs.existsSync(path.resolve(proj, s))) {
    die(SOURCES.length > 1
      ? `source ${s} missing (take.src names it; ${SOURCES.length} sources in this reel) - Gap 3 is not built, so per-source files are placed by hand for now`
      : `source ${s} missing; run prep.sh first`);
  }
}
const srcDurOf = new Map(SOURCES.map((s) => [s, parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.resolve(proj, s)]).toString())]));
// spec.sourceGrade "<ffmpeg -vf chain>" (opt-in; hand port of phantasic 0b5bd5a + 3910075): a real colour grade baked into each
// recording once (curves highlight roll-off, balance, vignette), so a blown window drops back without any cut-out. Cached as
// assets/<recording>-graded-<hash>.mp4. PER RECORDING: with sourceExposure (default 132, false = off) each recording's face zone
// luma is measured on its own and a gamma lifts or lowers its mid-tones before the chain, so every recording lands on the same
// look from its own exposure; the hash includes that recording's gamma. Take timing, words, faces and edit_truth keep the
// ORIGINAL recording's name; only the media tags and the stills read the graded file (mediaOf).
const mediaOf = new Map(SOURCES.map((s) => [s, s]));
const gradeGamma = {}, gradeCast = {};
if (spec.sourceGrade) {
  for (const s of SOURCES) {
    let chain = spec.sourceGrade;
    // spec.sourceNeutral (0..1, opt-in; Chrome Motion sets 0.65): cast neutralising. The recording's mean chroma (U/V over the
    // whole frame, one sample a second) is measured and that fraction of it is subtracted before exposure and the grade, so a
    // coloured room (a purple LED studio) comes out steel grey instead of magenta. Per recording, like the exposure.
    if (spec.sourceNeutral) {
      const k = Math.min(1, Math.max(0, +spec.sourceNeutral || 0));
      const cs = execFileSync("ffmpeg", ["-v", "error", "-i", path.resolve(proj, s), "-vf", "fps=1,signalstats,metadata=print:key=lavfi.signalstats.UAVG:file=-,metadata=print:key=lavfi.signalstats.VAVG:file=-", "-f", "null", "-"], { maxBuffer: 1 << 26 }).toString();
      const avg = (key) => { const v = [...cs.matchAll(new RegExp(key + "=([\\d.]+)", "g"))].map((m) => +m[1]); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 128; };
      const du = r3((avg("UAVG") - 128) * k), dv = r3((avg("VAVG") - 128) * k);
      gradeCast[s] = [du, dv];
      if (Math.abs(du) + Math.abs(dv) > 1) chain = `lutyuv=u='clip(val-(${du}),16,240)':v='clip(val-(${dv}),16,240)',${chain}`;
      console.log(`cast ${s}: mean chroma U ${(du / k + 128).toFixed(1)} V ${(dv / k + 128).toFixed(1)} -> subtract (${du}, ${dv})`);
    }
    if (spec.sourceExposure !== false) {
      const out = execFileSync("ffmpeg", ["-v", "error", "-i", path.resolve(proj, s), "-vf", "fps=1,crop=iw*0.5:ih*0.35:iw*0.25:ih*0.15,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"], { maxBuffer: 1 << 26 }).toString();
      const ys = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => +m[1]);
      if (ys.length) {
        const y = ys.reduce((a, b) => a + b, 0) / ys.length, gamma = Math.min(1.35, Math.max(0.8, 1 + ((spec.sourceExposure ?? 132) - y) / 180));
        gradeGamma[s] = r3(gamma);
        if (Math.abs(gamma - 1) > 0.02) chain = `eq=gamma=${gamma.toFixed(3)},${chain}`;
        console.log(`exposure ${s}: face-zone luma ${y.toFixed(1)} -> gamma ${gamma.toFixed(3)}`);
      }
    }
    // the hash covers the recording's size too: a replaced source file must not reuse a stale graded copy
    const tag = createHash("md5").update(chain + "|" + fs.statSync(path.resolve(proj, s)).size).digest("hex").slice(0, 8), g = `assets/${path.basename(s).replace(/\.[^.]+$/, "")}-graded-${tag}.mp4`;
    if (!fs.existsSync(path.resolve(proj, g))) { console.log(`grading ${s} (sourceGrade)...`); execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.resolve(proj, s), "-vf", chain, "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", path.resolve(proj, g)]); }
    mediaOf.set(s, g);
  }
}
// spec.relight (opt-in; references/reel-json.md "Empire depth relight"): coloured side light on the REAL footage, shaped by a
// depth map (Depth Anything V2 Small, run locally by scripts/depth_map.py, cached as assets/<recording>-depth.mp4). The relit
// copy (assets/<recording>-relit-<hash>.mp4, from the sourceGrade'd file when that is set) replaces the media like sourceGrade
// does; takes, words, faces and edit_truth keep the recording's own name. Only recordings with a person in them are relit
// (the primary, and any with a face track - the same rule as stage). With matte / stage the cut-out is relit too (below).
const RELIGHT = spec.relight == null || spec.relight === false ? null : (() => { try { return RL.normalizeRelight(spec.relight); } catch (e) { die(e.message); } })();
const relitMatteOf = new Map();
const relightable = (s) => s === SRC || fs.existsSync(path.join(proj, facePathFor(s)));
if (RELIGHT) {
  for (const s of SOURCES.filter(relightable)) {
    try { mediaOf.set(s, RL.ensureRelit(proj, s, mediaOf.get(s), RELIGHT)); } catch (e) { die(e.message); }
  }
  console.log(`relight: ${SOURCES.filter(relightable).map((s) => `${s} -> ${mediaOf.get(s)}`).join(", ")}`);
}
// Every take must fit inside its OWN recording. With one source this is the check that already
// existed implicitly via srcDur; with several it is the only thing standing between a typo in
// take.src and a take that silently plays black.
for (const [i, k] of takes.entries()) {
  const d = srcDurOf.get(k.src);
  if (k.b > d + 0.05) die(`take ${i} ends at ${k.b}s but ${k.src} is only ${d.toFixed(2)}s long`);
}
// clamped against the duration of the take's OWN recording (a hold or outro still taken from a second
// source must not be limited by the first one's length)
const stillAt = (t, src = SRC) => String(Math.max(0, Math.min(t, srcDurOf.get(src) - 0.12)));
const fadeLane = (d) => JSON.stringify({ version: 1, lanes: [{ target: "volume", points: [{ t: 0, v: 0 }, { t: r3(2 / FPS), v: 1 }, { t: r3(d - 3 / FPS), v: 1 }, { t: r3(d), v: 0 }] }] });
const rampsAt = [];   // {t0, peak, end, scene?} for the sfx design pass and the caption windows
const takeHtml = takes.map((k, i) => {
  if (SECTION_MODE && !k.inSection) return "";  // I-25 prototype: this take isn't on screen in this section
  if (k.ramp) {
    // the picture is pre-rendered with ffmpeg on the speed curve (premium kit); muted, no captions
    let rc;
    try { rc = PK.rampClip({ src: path.resolve(proj, mediaOf.get(k.src)), mediaStart: k.a, D: k.dur, ramp: k.ramp, fps: FPS, outDir: A, tag: `take${i}`, srcDur: srcDurOf.get(k.src) }); } catch (e) { die(`take ${i}: ${e.message}`); }
    rampsAt.push({ t0: r3(k.start), peak: r3(k.start + rc.peakAt), end: r3(k.start + k.dur) });
    console.log(`ramp take ${i}: ${k.a}-${k.b} s source -> ${k.dur.toFixed(2)} s (${rc.minSpeed}x..${rc.maxSpeed}x), muted`);
    return `
      <video id="take-${i}" src="${rc.src}" data-start="${r3(k.start)}" data-duration="${r3(k.dur)}" data-media-start="0" data-track-index="0" muted playsinline></video>`;
  }
  let h = `
      <video id="take-${i}" src="${mediaOf.get(k.src)}" data-start="${r3(k.start)}" data-duration="${r3(k.dur)}" data-media-start="${k.a}" data-track-index="0" muted playsinline></video>`;
  if (k.holdFrames) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", stillAt(k.a + k.dur - 1 / FPS, k.src), "-i", path.resolve(proj, mediaOf.get(k.src)), "-frames:v", "1", "-strict", "unofficial", "-q:v", "2", "-update", "1", path.join(A, `hold-${i}.jpg`)]);
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
  // I-25 prototype: a join between a take outside this section and one inside it has no "other
  // side" to dissolve from/to in this composition - not render-verified (f01 has no transitions).
  if (SECTION_MODE && (!takes[i - 1].inSection || !takes[i].inSection)) continue;
  if (!JOIN_TRANSITIONS.has(kind)) die(`take ${i}: unknown transition '${kind}'; have: ${[...JOIN_TRANSITIONS].join(", ")}`);
  if (takes[i - 1].holdFrames) die(`take ${i}: transition '${kind}' follows a hold on take ${i - 1} (a frozen still, nothing to dissolve from)`);
  if (Math.min(takes[i - 1].dur, takes[i].dur) < 0.3) warn.push(`take ${i}: '${kind}' transition on a take under 0.3s may clip`);
  // transitionDur: the join's total length in seconds, optional. Unset, joinDurations() returns
  // exactly what this block computed inline before the field existed (lib/joins.mjs and its
  // test), so a reel that does not use it builds byte-identical.
  const durProblem = joinDurProblem(takes[i].transitionDur);
  if (durProblem) die(`take ${i}: transitionDur ${durProblem}`);
  takeJoins.push({
    i, kind, T: r3(takes[i].start),
    ...joinDurations(kind, takes[i].transitionDur, takes[i - 1].dur, takes[i].dur),
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
const takeAudio = takes.map((k, i) => {
  if (SECTION_MODE && !k.inSection) return "";  // I-25 prototype: this take's audio isn't in this section
  if (k.ramp) return "";                         // a ramped action take is muted (the voice is never ramped)
  return `
  <audio id="take-${i}-audio" src="${k.src}" data-start="${r3(k.start)}" data-duration="${r3(k.dur)}" data-media-start="${k.a}" data-track-index="${10 + (i % 2)}" data-automation='${DUCK.length ? takeVolumeLane(k.dur, FPS, k.start, DUCK.map(([a, b]) => [a - (SECTION_MODE ? SECTION_START : 0), b - (SECTION_MODE ? SECTION_START : 0)])) : fadeLane(k.dur)}'></audio>`;
}).join("");
let matteHtml = "";
// I-16: the matte is deliberately NOT per-source yet. One talk-matte.webm is cut from SRC and then
// every take indexes into it by its own k.a - so a take from a second recording would read the
// FIRST recording's cut-out at that timestamp and show the wrong person, silently. Refusing is the
// only honest option until there is a matte per source, which is MULTIANGLE Gap 6's territory
// (per-source framing) and not in this change.
// spec.stage (below) and ground beats lift the single-source rule: each take reads the matte of its own recording
// A `ground` beat (speaker cut out over a page) takes the same per-recording route as `stage`: each take reads the matte of its own recording.
const perSrcMatte = !!spec.stage || (spec.beats || []).some((b) => b.type === "ground");
if (spec.matte && SOURCES.length > 1 && !perSrcMatte) {
  die(`spec.matte with ${SOURCES.length} sources is not supported: one matte is cut from ${SRC}, and every take indexes it by its own source time, so takes from the other recording(s) would show the wrong cut-out - drop spec.matte, or keep this reel single-source (MULTIANGLE Gap 6)`);
}
const matteCutOf = (s) => (s === SRC ? "assets/talk-matte.webm" : `assets/${path.basename(s).replace(/\.[^.]+$/, "")}-matte.webm`);
// relight: the cut-out shows the relit subject (its alpha over the relit colour); without relight this is the cut itself
const matteRelOf = (s) => relitMatteOf.get(s) ?? matteCutOf(s);
// stage: a recording is cut out only when it has a face track (a screen recording or a photo has no person to cut out)
const stageMatted = (s) => s === SRC || fs.existsSync(path.join(proj, facePathFor(s)));
// relight: the cut-out of recording `s` (already cut) gets the relit colour; matteRelOf(s) reads it from then on
const relightMatte = (s) => {
  if (!RELIGHT || !relightable(s) || relitMatteOf.has(s)) return;
  try { relitMatteOf.set(s, RL.ensureRelitMatte(proj, s, matteCutOf(s), mediaOf.get(s))); } catch (e) { die(e.message); }
};
// cut the window file for recording seconds [w.a, w.b] (cached by name)
const cutWindow = (w) => {
  const mp = path.resolve(proj, w.rel);
  if (fs.existsSync(mp)) return;
  const cut = path.join(proj, "build", `matte-src@${Math.round(w.a * 1000)}-${Math.round(w.b * 1000)}.mp4`);
  // cut by FRAME INDEX on a constant-rate timeline that starts at 0 (fps=FPS:start_time=0), not by a time seek: frame j of the
  // window file is then frame round(a * FPS) + j of the whole-recording matte, which (like the plate) fills a video stream
  // that starts after 0 (prep.sh's talk.mp4 starts at 0.033 s) with its first frame. A time seek was one frame early.
  const f0 = Math.round(w.a * FPS), f1 = Math.round(w.b * FPS);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.resolve(proj, SRC), "-vf", `fps=${FPS}:start_time=0,trim=start_frame=${f0}:end_frame=${f1},setpts=PTS-STARTPTS`, "-fps_mode", "passthrough", "-an", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", cut]);
  cutMatte(cut, mp, `${SRC} ${r3(w.a)}-${r3(w.b)}s`);
  fs.rmSync(cut, { force: true });
};
// cut the speaker out of recording `s` (project-relative or absolute) into `mp` (hyperframes remove-background), unless cached
const cutMatte = (s, mp, label) => {
  if (fs.existsSync(mp)) return;
  console.log(`cutting the speaker out of ${label} (hyperframes remove-background, ~4 fps; cached in ${path.relative(proj, mp).split(path.sep).join("/")})...`);
  // npx is a .cmd shim on Windows and CreateProcess cannot launch it directly, so this
  // threw ENOENT and took every `behind` beat with it (they die() without a matte).
  const npx = process.platform === "win32" ? ["cmd", ["/c", "npx"]] : ["npx", []];
  // MATTE_THREADS=T (opt-in, integer >= 1): the same matte, onnxruntime held to T threads (lib/matte.mjs); unset: as before
  const threads = matteThreads();
  // written to <name>.part.webm and renamed when done: a killed build never leaves a truncated matte that the next
  // build would take as cached (the tool picks its format from the extension, so the name ends in .webm)
  writeAtomically(mp, (out) => {
    if (threads) cutMatteThreaded([npx[0], [...npx[1], "hyperframes@0.8.81", "remove-background"]], path.resolve(proj, s), out, { cwd: proj, threads, warn: (m) => { console.warn(m); warn.push(m); } });
    else execFileSync(npx[0], [...npx[1], "hyperframes@0.8.81", "remove-background", path.resolve(proj, s), "-o", out], { stdio: ["ignore", "ignore", "pipe"], cwd: proj, maxBuffer: 1 << 28 });
  });
  console.log("  matte done");
};
// matteClip window cut (opt-in, single recording, no take transitions, no cached whole-recording matte): only the recording
// around each clipped cut-out piece (+-1 s, frame-aligned, in recording seconds) is cut out, into
// assets/talk-matte@<startMs>-<endMs>.webm. The pieces are known only after the beats are laid out, so the cut waits for the
// matteClip block below (windowCut); the whole-recording cut here is skipped.
const windowCut = !!(spec.matte && spec.matteClip && spec.matteWindows && !spec.stage && SOURCES.length === 1 && !takeJoins.length && !fs.existsSync(path.resolve(proj, matteCutOf(SRC))));
if (spec.matte) {
  if (!windowCut) for (const s of perSrcMatte ? SOURCES.filter(stageMatted) : [SRC]) {
    cutMatte(path.resolve(proj, s), path.resolve(proj, matteCutOf(s)), s);
    relightMatte(s);
  }
  matteHtml = takes.map((k, i) => (perSrcMatte && !stageMatted(k.src)) ? "" : `
      <video id="matte-${i}" class="matte" src="${matteRelOf(k.src)}" data-start="${r3(k.start)}" data-duration="${r3(k.dur)}" data-media-start="${k.a}" data-track-index="2" muted playsinline></video>`).join("");
  // the cut-out layer mirrors the plate's join transition so a `behind` beat never shows the
  // matte hard-cutting on top of a plate that is whipping or blurring underneath it.
  for (const { i, kind, T, outDur, inDur } of takeJoins) if (!perSrcMatte || (stageMatted(takes[i - 1].src) && stageMatted(takes[i].src))) pushJoinTransition(`#matte-${i - 1}`, `#matte-${i}`, kind, T, outDur, inDur);
}
// stage (premium, opt-in; hand port of phantasic d5b11ea + Podcast Glow v0.2-v0.5): the speaker is cut out (matte, one per
// recording) and composited on a designed set; the plate is hidden. Ahmed's version cuts ONE matte from spec.source and
// indexes it by every take's own source time; here each take reads the matte of ITS OWN recording (assets/<name>-matte.webm,
// cut on demand), a recording with no face track is left un-matted and plays as the plain plate, and the head-top track
// (which sets the subject scale) is read per recording.
// stage.windows [{at, to, set?}]: the set only on those moments; stage.sets {key: {...}}: a set per window.
let stageBgHtml = "", stageCss = "", stageFgHtml = "", SUBJ = 1, headTopAt = null;   // headTopAt(src, a, b): the highest head top in a recording's cut-out (stage only)
const stageWins = [];
if (spec.stage) {
  if (FORMAT !== "9:16") warn.push(`stage is tuned for 9:16 (head-top track, subject scale and set sizes); ${FORMAT} may look off`);
  const st = { bg: "neon", scale: 1, rim: true, safeTop: 210, room: 150, ...spec.stage };
  const trackOf = new Map();
  const headTrack = (src) => {
    if (trackOf.has(src)) return trackOf.get(src);
    const cache = path.join(proj, "build", src === SRC ? "headtop.json" : `headtop-${path.basename(src).replace(/\.[^.]+$/, "")}.json`);
    let track = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) : null;
    if (!track) {
      const raw = execFileSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", path.resolve(proj, matteRelOf(src)), "-vf", "fps=5,alphaextract,scale=108:192", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 28 });
      const N = 108 * 192; track = [];
      for (let f = 0; f * N < raw.length; f++) {
        let top = null;
        for (let y = 0; y < 192 && top === null; y++) for (let x = 22; x < 86; x++) if (raw[f * N + y * 108 + x] > 128) { top = y * (H / 192); break; }
        track.push([r3(f / 5), top]);
      }
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, JSON.stringify(track));
    }
    trackOf.set(src, track);
    return track;
  };
  headTopAt = (src, o0, o1) => { const v = headTrack(src).filter(([t, y]) => y !== null && t >= o0 - 0.2 && t <= o1 + 0.2).map(([, y]) => y); return v.length ? Math.min(...v) : null; };
  const mattedTakes = takes.map((k) => stageMatted(k.src));
  if (!mattedTakes.some(Boolean)) warn.push("stage: no recording has a face track, so nothing is cut out (every take plays as the plain plate)");
  // auto subject scale (anchored at the bottom): the highest head top in the used (matted) takes sits >= safeTop + room
  const tops = takes.filter((k, i) => mattedTakes[i]).map((k) => headTopAt(k.src, k.a, k.b)).filter((y) => y !== null);
  const ht = tops.length ? Math.min(...tops) : 300;
  SUBJ = st.fixedScale ?? r3(Math.min(st.scale, (H - (st.safeTop + st.room)) / Math.max(1, H - ht)));   // stage.fixedScale: a framed shot that keeps its size
  const inSec = (k) => !(SECTION_MODE && !k.inSection);
  if (st.wrap !== false) matteHtml += takes.map((k, i) => !mattedTakes[i] || !inSec(k) ? "" : ["r", "b"].map((c) => `
      <video id="matte-${c}${i}" class="matte-l matte-${c}" src="${matteRelOf(k.src)}" data-start="${r3(k.start)}" data-duration="${r3(k.dur)}" data-media-start="${k.a}" data-track-index="${c === "r" ? 30 : 31}" muted playsinline></video>`).join("")).join("");
  matteHtml = `<div id="stage-subj" style="position:absolute;inset:0;transform:translateY(${st.offsetY ?? 0}px) scale(${SUBJ});transform-origin:50% 100%">${matteHtml}</div>`;
  console.log(`stage: subject head top ${ht}px -> subject scale ${SUBJ} (bottom-anchored), ${mattedTakes.filter(Boolean).length} of ${takes.length} takes cut out`);
  const red = st.red ?? "#FF2A3A", blue = st.blue ?? "#4D6BFF";
  // stage.plate: a photographic set (a graded, blurred room still) instead of the drawn gradient; stage.practicals
  // false drops the drawn bar + lamp (the plate's own lights carry it)
  const plateSrc = st.plate ? userAsset(st.plate) : null;
  // a moving set (stage.video, or a window's set): looped to the reel length and graded once with ffmpeg
  const setClip = (cfg, name) => {
    const vOut = path.join(A, name);
    if (!fs.existsSync(vOut)) execFileSync("ffmpeg", ["-v", "error", "-y", "-stream_loop", "-1", "-i", path.resolve(proj, cfg.video), "-t", String(TOTAL + 0.5), "-an", "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},${cfg.videoGrade ?? "eq=brightness=-0.05:saturation=0.9"}`, "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", vOut]);
  };
  const gridOf = (c) => c.grid ? `<div style="position:absolute;inset:0;background-image:linear-gradient(${c.grid} ${c.gridLine ?? 1.5}px, transparent ${c.gridLine ?? 1.5}px),linear-gradient(90deg, ${c.grid} ${c.gridLine ?? 1.5}px, transparent ${c.gridLine ?? 1.5}px);background-size:${c.gridSize ?? 90}px ${c.gridSize ?? 90}px;background-position:center;-webkit-mask-image:radial-gradient(80% 60% at 50% 40%, #000 30%, transparent 85%);mask-image:radial-gradient(80% 60% at 50% 40%, #000 30%, transparent 85%)"></div>` : "";
  const glowLayer = (c) => c.glow ? `<div style="position:absolute;inset:0;background:radial-gradient(42% 30% at 50% ${c.glowY ?? 34}%, ${glowOf(c.glow)}, transparent 75%)"></div>` : "";
  let setVideo = "";
  if (st.video && !st.windows) {
    setClip(st, "stage-set.mp4");
    setVideo = `<video id="stage-set" class="fill" src="assets/stage-set.mp4" data-start="0" data-duration="${r3(SECTION_MODE ? SECTION_TOTAL : TOTAL)}" data-track-index="40" muted playsinline style="opacity:${st.videoOpacity ?? 1}"></video>`;
  }
  stageBgHtml = `<div id="stage-bg" style="position:absolute;inset:0;overflow:hidden;background:${plateSrc ? `#050507 url(${plateSrc}) center / cover no-repeat` : st.video ? "#060606" : `radial-gradient(120% 70% at 22% 18%, ${st.haze ?? "#16196a"} 0%, #0a0a1c 42%, #050507 75%)`}">`
    + setVideo + glowLayer(st) + gridOf(st)
    + (st.video ? "" : `<div style="position:absolute;inset:0;background:radial-gradient(55% 45% at 92% 55%, rgba(255,30,50,.28), transparent 70%)"></div>`)
    + (st.practicals === false ? "" : `<div style="position:absolute;left:${st.barX ?? 950}px;top:${st.barY ?? 420}px;width:18px;height:${st.barH ?? 980}px;border-radius:9px;background:${red};box-shadow:0 0 18px ${red},0 0 60px ${red},0 0 160px rgba(255,20,40,.65)${st.practicalBlur ? `;filter:blur(${st.practicalBlur}px)` : ""}"></div>`
    + `<div style="position:absolute;left:${st.bulbX ?? 70}px;top:${st.bulbY ?? 560}px;width:56px;height:56px;border-radius:50%;background:#c9d4ff;box-shadow:0 0 24px ${blue},0 0 80px ${blue},0 0 200px rgba(77,107,255,.6)${st.practicalBlur ? `;filter:blur(${st.practicalBlur}px)` : ""}"></div>`)
    + `<div style="position:absolute;left:0;right:0;bottom:0;height:520px;background:linear-gradient(180deg,transparent,rgba(0,0,0,.55))"></div></div>`;
  // matte edge: alpha steepened (the soft fringe that carried the old white wall goes) + erode; sides of the source frame
  // fade out (stage.sideFade, % of the width) so a shrunk subject never shows the crop's straight edges; coloured light
  // wraps (tinted copies of the cut-out, masked to one side, screen-blended) put the set's red / blue on the face
  stageBgHtml += `<svg width="0" height="0" style="position:absolute"><filter id="stage-choke" color-interpolation-filters="sRGB" x="-5%" y="-5%" width="110%" height="110%"><feComponentTransfer in="SourceAlpha" result="a0"><feFuncA type="linear" slope="2" intercept="-0.5"/></feComponentTransfer><feMorphology in="a0" operator="erode" radius="${st.erode ?? 3}" result="e"/><feGaussianBlur in="e" stdDeviation="${st.feather ?? 1.6}" result="eb"/><feComposite in="SourceGraphic" in2="eb" operator="in"/></filter></svg>`;
  const sf = st.sideFade ?? 8;
  const sideMask = `-webkit-mask-image: linear-gradient(to right, transparent 0%, #000 ${sf}%, #000 ${100 - sf}%, transparent 100%); mask-image: linear-gradient(to right, transparent 0%, #000 ${sf}%, #000 ${100 - sf}%, transparent 100%);`;
  // the plates the stage covers: every take of a matted recording (an un-matted recording keeps its plate)
  const PLATE = mattedTakes.every(Boolean) ? 'video[id^="take-"], img[id^="hold-"]' : takes.flatMap((k, i) => mattedTakes[i] ? [`#take-${i}`, `#hold-${i}`] : []).join(", ");
  stageCss = `${st.windows || !PLATE ? "" : `${PLATE} { opacity: 0 !important; }`}
  .matte { filter: url(#stage-choke) ${st.subjectGrade ?? "brightness(.94) contrast(1.1)"}; ${sideMask} }
  .matte-l { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; mix-blend-mode: screen; pointer-events: none; }
  .matte-r { filter: url(#stage-choke) brightness(.8) sepia(1) saturate(9) hue-rotate(-38deg); opacity: ${st.wrapR ?? 0.85}; -webkit-mask-image: linear-gradient(to left, #000 0%, rgba(0,0,0,.6) ${Math.round((st.wrapSpan ?? 48) * 0.46)}%, transparent ${st.wrapSpan ?? 48}%); mask-image: linear-gradient(to left, #000 0%, rgba(0,0,0,.6) ${Math.round((st.wrapSpan ?? 48) * 0.46)}%, transparent ${st.wrapSpan ?? 48}%); }
  .matte-b { filter: url(#stage-choke) brightness(.75) sepia(1) saturate(9) hue-rotate(185deg); opacity: ${st.wrapB ?? 0.75}; -webkit-mask-image: linear-gradient(to right, #000 0%, rgba(0,0,0,.5) ${Math.round((st.wrapSpan ?? 45) * 0.44)}%, transparent ${st.wrapSpan ?? 45}%); mask-image: linear-gradient(to right, #000 0%, rgba(0,0,0,.5) ${Math.round((st.wrapSpan ?? 45) * 0.44)}%, transparent ${st.wrapSpan ?? 45}%); }
  .stage-fg { position: absolute; pointer-events: none; z-index: 2; }`;
  // stage.fg: foreground props (a cut-out PNG: mic, lamp) in front of the speaker AND the type, defocused
  for (const [fi, f] of (st.fg || []).entries()) stageFgHtml += `<img id="stage-fg${fi}" class="stage-fg" src="${userAsset(f.src)}" style="left:${f.x ?? 0}px;top:${f.y ?? 1300}px;width:${f.w ?? 600}px;transform:rotate(${f.rot ?? 0}deg)${f.flip ? " scaleX(-1)" : ""};filter:blur(${f.blur ?? 3}px) brightness(${f.bright ?? 1}) drop-shadow(0 0 ${f.rim ?? 0}px ${f.rimColor ?? "rgba(255,40,60,.6)"})" />`;
  if (st.windows) {
    let winHtml = "";
    for (const [i, w] of st.windows.entries()) {
      const key = w.set ?? "main", cfg = { ...st, ...(st.sets?.[key] || {}) };
      const a = E(w.at, "stage window"), b = E(w.to, "stage window");
      let vid = "";
      if (cfg.video) {
        setClip(cfg, `stage-set-${key}.mp4`);
        vid = `<video id="stage-wv${i}" class="fill" src="assets/stage-set-${key}.mp4" data-start="${r3(a)}" data-duration="${r3(b - a)}" data-media-start="${r3(a + (SECTION_MODE ? SECTION_START : 0))}" data-track-index="${41 + i}" muted playsinline></video>`;
      }
      winHtml += `<div id="stage-w${i}" style="position:absolute;inset:0;overflow:hidden;opacity:0;background:${cfg.bgColor ?? "#060606"}">${vid}${glowLayer(cfg)}${gridOf(cfg)}</div>`;
      stageWins.push([a, b, i]);
    }
    stageBgHtml += `<div id="stage-wins" style="position:absolute;inset:0">${winHtml}</div>`;
    // between windows the real footage plays and the cut-out is hidden
    if (stageWins.length) {
      if (stageWins[0][0] > 0.05) tl.push(`tl.set(".matte", { autoAlpha: 0 }, 0);`);
      for (const [a, b, i] of stageWins) {
        tl.push(`tl.set('${PLATE}', { opacity: 0 }, ${r3(a)}); tl.set(".matte", { autoAlpha: 1 }, ${r3(a)}); tl.set("#stage-w${i}", { opacity: 1 }, ${r3(a)});`);
        tl.push(`tl.set('${PLATE}', { opacity: 1 }, ${r3(b)}); tl.set(".matte", { autoAlpha: 0 }, ${r3(b)}); tl.set("#stage-w${i}", { opacity: 0 }, ${r3(b)});`);
      }
    }
  }
}
// the outro is a real still of the last frame, frozen under the end card
const last = takes.at(-1);
if (OUTRO > 0) execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", stillAt(last.a + last.dur - 1 / FPS, last.src), "-i", path.resolve(proj, mediaOf.get(last.src)), "-frames:v", "1", "-strict", "unofficial", "-q:v", "2", "-update", "1", path.join(A, "outro.jpg")]);
const outroHtml = OUTRO > 0 ? `
      <img id="outro-still" class="fill" src="assets/outro.jpg" data-start="${r3(SPEECH)}" data-duration="${r3(OUTRO)}" data-track-index="0" />` : "";
// outroFade (opt-in): the held last frame fades to black instead of freezing (Ahmed's The Monk 2)
if (OUTRO > 0 && spec.outroFade) tl.push(`tl.fromTo("#outro-still", { autoAlpha: 1 }, { autoAlpha: 0, duration: ${r3(OUTRO)}, ease: "power1.inOut", immediateRender: false }, ${r3(SPEECH)});`);

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
// MULTIANGLE Gap 6: a face track per source, same convention as the transcripts - `spec.face`
// names the primary source's, every other is derived from its own `src`. A source with no track
// of its own falls back to the primary's inside makePlacer, which is wrong but is what happened
// before this existed; the warning says so rather than letting it pass silently.
const faces = {};
for (const sname of SOURCES) {
  const rel = sname === PRIMARY_SRC ? (spec.face || "build/face.json") : facePathFor(sname);
  const abs = path.resolve(proj, rel);
  if (fs.existsSync(abs)) faces[sname] = JSON.parse(fs.readFileSync(abs, "utf8"));
  else if (SOURCES.length > 1) {
    // BLANK TIMELINE: a source with no face track of its own (a screen recording, a photo, a clip
    // without a person) is framed as "no face seen": captions and cards use the no-face placement,
    // not the primary source's face, which is not what is on screen. Empty samples, not null -
    // makePlacer only falls back to the single-source `face` when a source has no entry at all.
    faces[sname] = { samples: [] };
    warn.push(`source ${sname} has no face track at ${rel} - treated as having no face (centre framing); run face_track.py for it if it shows a person`);
  }
}
if (!face) warn.push(`no ${path.relative(proj, facePath)}: captions sit at a fixed height and may cover the face; run scripts/face_track.py first`);
// A face.json is pixel coordinates in whatever W/H face_track.py measured. If that
// doesn't match this build's canvas (project built in one format, face.json tracked
// against another), every caption placement is silently wrong - same failure class
// as a stale format assumption, just one level up, so this dies loudly rather than
// placing captions against the wrong pixel space. Older face.json files predating
// this field have no w/h to check, so they fall back to a warning, not a die.
// I-19, the engine half: a mismatch is no longer automatically fatal. prep.sh's non-9:16 formats
// do not re-run face tracking - they crop (or letterbox) the very frame face_track.py already
// measured - and they write build/crop-<fmt>.json describing exactly that transform. When such a
// plan is present and provably describes THIS build, the mismatch is expected and the plan is the
// answer to it: every face coordinate maps as coord * scale + offset, which is what safezone.mjs's
// makePlacer cropScale/cropOffsetX/cropOffsetY do (A15 added them for this).
//
// "Provably describes this build" is two separate equalities, and both matter:
//   - plan.W/H === this canvas    - the plan is for the format we are building, not another one;
//   - plan.srcW/srcH === face.w/h - the plan's INPUT space is the space face.json is already in.
// The second is the one that would otherwise rot silently: prep.sh computes scale/offsets from
// whatever file it was handed, so a 1:1 prepped from an original 4K recording carries a plan whose
// numbers are right for 4K coordinates and wrong for the 1080x1920 ones face.json holds. Without
// the check, captions would be placed against the wrong pixel space - the precise thing the die()
// here exists to prevent - while looking perfectly fine in the logs.
//
// MULTIANGLE Gap 6, the crop half: this used to run ONCE, for the primary source only, and the
// resulting single (cropScale, cropOffsetX, cropOffsetY) was handed to makePlacer for every
// source. prep.sh now writes a crop plan per (source, format) pair (I-16 Gap 3 ingest half,
// `980682c`) - each sidecar carries its own `srcW`/`srcH` because two cameras genuinely have
// different native dimensions - so this runs per source and builds a `crops` map keyed by
// `take.src`, which makePlacer consults per take. 9:16 stays the identity transform either way
// (face.w/h === W/H short-circuits below), which is why this was invisible on every fixture and
// every reel built so far.
const crops = {};
for (const sname of SOURCES) {
  const f = faces[sname];
  if (!f) continue; // no track at all for this source; already warned above
  if (f.w == null || f.h == null) {
    if (sname === PRIMARY_SRC) warn.push(`${path.relative(proj, facePath)} has no w/h; cannot verify it matches this build's ${W}x${H} canvas - re-run face_track.py to add it`);
    continue;
  }
  if (f.w === W && f.h === H) continue; // already in canvas space (the 9:16 case) - no plan needed
  // The primary source's path is NOT `cropPathFor(sname, FORMAT)` even when that would compute the
  // same string - it is pinned to the unsuffixed name regardless of how spec.source happens to be
  // spelled, mirroring the exact special case the face/words loops above already use
  // (`sname === PRIMARY_SRC ? spec.face : facePathFor(sname)`, `... ? spec.words : wordsPathFor(s)`).
  // All three exist for the same reason: the primary recording is "index 0" by ROLE (it is the one
  // prep.sh is run on without an index argument), not by whatever string spec.source contains, and
  // a reel.json that happens to name its only/primary source "talk-1.mp4" must still find the files
  // prep.sh actually wrote for an unindexed run. There is no `spec.crop` field to make this
  // explicit the way spec.face/spec.words do, so the pin here is unconditional rather than a
  // fallback - unlike face/words, nothing else could ever override a primary source's crop path.
  const relCrop = sname === PRIMARY_SRC ? `build/crop-${FORMAT.replace(":", "x")}.json` : cropPathFor(sname, FORMAT);
  const cropPathN = path.join(proj, relCrop);
  const cropPlanN = fs.existsSync(cropPathN) ? JSON.parse(fs.readFileSync(cropPathN, "utf8")) : null;
  const subject = sname === PRIMARY_SRC ? path.relative(proj, facePath) : `source ${sname}'s face track`;
  const why = !cropPlanN ? `no ${relCrop} to map it through (run scripts/prep.sh for this format and source, which writes one)`
    : cropPlanN.W !== W || cropPlanN.H !== H ? `${relCrop} is a plan for ${cropPlanN.W}x${cropPlanN.H}, not this build's ${W}x${H}`
    : cropPlanN.srcW == null || cropPlanN.srcH == null ? `${relCrop} predates srcW/srcH, so the space it maps FROM cannot be verified - re-run scripts/prep.sh for this format`
    : cropPlanN.srcW !== f.w || cropPlanN.srcH !== f.h ? `${relCrop} maps from ${cropPlanN.srcW}x${cropPlanN.srcH} but ${subject} is ${f.w}x${f.h} - the plan was computed from a different recording than the face was tracked on`
    : null;
  if (why) die(`${subject} is ${f.w}x${f.h} but this build is ${W}x${H} (spec.format '${FORMAT}'): ${why}`);
  if (!(cropPlanN.scale > 0)) die(`${relCrop} has a non-positive scale ${cropPlanN.scale}`);
  crops[sname] = { scale: cropPlanN.scale, offsetX: cropPlanN.offsetX, offsetY: cropPlanN.offsetY };
  console.log(`${subject} ${f.w}x${f.h} -> ${W}x${H} via ${relCrop} (mode=${cropPlanN.mode}, scale ${cropPlanN.scale}, offset ${cropPlanN.offsetX},${cropPlanN.offsetY})`);
}
// Backward-compat scalar: the primary source's own plan, or identity - exactly what the single
// global value was before this loop existed. makePlacer still takes these as its no-`crops`
// default, and a single-source build never has more than this one entry anyway.
const { scale: cropScale = 1, offsetX: cropOffsetX = 0, offsetY: cropOffsetY = 0 } = crops[PRIMARY_SRC] || {};
// cadence.faceAnchor (opt-in; hand port of phantasic 1c15911): every punch-in scales around the speaker's face instead of a fixed
// point - x = the face centre, y = the top of the head (or the default origin when the head sits lower) minus headroom - measured
// over the whole hold of that snap. A punch then never pushes the head out of frame, on any framing. Per source: each take's
// own face track (and crop plan) is used, a source with no track gets no anchor (plain punch around zoom.origin).
// The caption placer (safezone.mjs) is NOT told the origin: it still models the face scaling around zoom.origin.
if (FACE_ANCHOR) {
  const [dox, doy] = snapOriginDefault.split(/\s+/).map((v, i) => (parseFloat(v) / 100) * (i ? H : W));
  const pad = cadence.faceAnchor.headroom ?? 24;
  const track = new Map(SOURCES.map((s) => [s, ((faces[s] || {}).samples || []).filter((x) => x[1] != null)]));
  const nearest = (samples, o) => { let b = null, bd = 1e9; for (const x of samples) { const d = Math.abs(x[0] - o); if (d < bd) { bd = d; b = x; } } return bd < 1.5 ? b : null; };
  const faceAt = (t) => {
    const k = locateTake(takes, t, FPS);
    const o = (t >= k.start && t < k.start + k.dur) ? k.a + (t - k.start) : k.b;
    const f = nearest(track.get(k.src) || [], o);
    if (!f) return null;
    const { scale: cs, offsetX: cox, offsetY: coy } = crops[k.src] || { scale: 1, offsetX: 0, offsetY: 0 };
    return { top: f[1] * cs + coy, cx: ((f[3] + f[4]) / 2) * cs + cox, bot: f[2] * cs + coy, l: f[3] * cs + cox, r: f[4] * cs + cox };   // bot/l/r: faceAnchor.fit
  };
  for (const [i, sn] of snaps.entries()) {
    if (sn[1] <= 1.001) continue;
    const t1 = i + 1 < snaps.length ? snaps[i + 1][0] : SPEECH;
    const fs0 = [];
    for (let t = sn[0]; t < t1; t += 0.2) { const f = faceAt(Math.min(t, TOTAL - 0.01)); if (f) fs0.push(f); }
    if (!fs0.length) continue;
    const top = Math.min(...fs0.map((f) => f.top));
    const cx = fs0.map((f) => f.cx).sort((a, b) => a - b)[Math.floor(fs0.length / 2)];
    sn[2] = [Math.round(Math.max(0, Math.min(W, cx))), Math.round(Math.max(0, Math.min(doy, top - pad)))];
    // ---- faceAnchor.fit (opt-in; Ahmed's Keynote hardening f88943d, per source): shrink the punch-in until the whole zoomed
    // face box (ears included) stays inside the frame with a margin, and the face stays under maxFaceH of the frame height
    // (wide shots punch in fully, close-ups barely). Uses the same per-take face + crop plan as the anchor above.
    if (cadence.faceAnchor.fit) {
      const [ox] = sn[2], L = Math.min(...fs0.map((f) => f.l)), R = Math.max(...fs0.map((f) => f.r)), B = Math.max(...fs0.map((f) => f.bot));
      const m = cadence.faceAnchor.margin ?? 36, fh = B - top, caps = [(cadence.faceAnchor.maxFaceH ?? 0.4) * H / Math.max(1, fh)];
      if (R > ox + 1) caps.push((W - m - ox) / (R - ox));
      if (L < ox - 1) caps.push((ox - m) / (ox - L));
      const zc = Math.min(sn[1], ...caps);
      sn[1] = zc < 1.06 ? 1 : +zc.toFixed(3);
    }
  }
  console.log(`cadence faceAnchor: ${snaps.filter((x) => x[2]).length} punch-ins anchored on the face`);
  for (const p of snapPatches) tl[p.idx] = snapLines(p.sn, p.fromZ);
}
const placer = makePlacer({ face, faces, takes, zoom: { ...zoom, snapsEdit: snaps, pushesEdit }, TOTAL: SECTION_MODE ? SECTION_TOTAL : TOTAL, platform, ideal: spec.captions?.y ?? Math.round(H * 1180 / 1920), H, W, cropScale, cropOffsetX, cropOffsetY, crops, fps: FPS });
// lib/safezone.mjs keeps its card rectangles private; podcast captions ask "is a card in the way" (placer.clash), so shadow the same list
// here: every placer.card() result is recorded, and clash() finds the first one that overlaps in time and in height. No output changes.
{
  const cardRects = [], placeCard = placer.card;
  placer.card = (t0, t1, h, ...rest) => { const r = placeCard(t0, t1, h, ...rest); if (r) cardRects.push({ t0, t1, y0: r.y, y1: r.y + h }); return r; };
  placer.clash ??= (t0, t1, y, h) => cardRects.find((o) => t0 < o.t1 && t1 > o.t0 && y < o.y1 && y + h > o.y0);
}

// ---------- Prompt Motion graphics, the placement contract (P4-P6) and the render pre-pass ----------
// docs/GRAPHICS-ROUTES.md (phantasic) D2: an HTML graphic obeys the typed route's placement rules, and the build
// enforces them (refuse, never warn: the automatic path has no reviewer). The rules are checkContract in
// lib/graphic.mjs; the geometry is the caption placer's own (the face under the camera in force at each sampled
// instant, the first-choice caption band for this reel's caption height). Layer windows are absolute output seconds;
// the placer counts from the section start, like hiddenCaps below. A layer that fails dies; a beat is dropped with
// the problem as a warning and spliced out, like a G / P problem. Then the surviving graphics render, as before.
if (graphicLayers.length || graphicBeats.length) {
  const capH = Math.round((spec.captions?.size ?? brand.capSize) * 2.2);   // the planner's cap_h (designer_validate.Geometry)
  const secOff = SECTION_MODE ? SECTION_START : 0;
  const others = [];
  for (const b of spec.beats || []) {
    if (!b || typeof b !== "object" || typeof b.type !== "string") continue;
    if (GRAPHIC_NOT_AN_OVERLAY.includes(b.type) || GRAPHIC_CAMERA_BEATS.includes(b.type)) continue;
    try {
      const s0 = E(b.at, "graphic contract", beatRec(b));
      const e0 = b.to !== undefined ? E(b.to, "graphic contract", beatRec(b)) : s0 + GRAPHIC_LIMITS.overlayDefaultS;
      if (Number.isFinite(s0) && Number.isFinite(e0) && e0 > s0) others.push({ kind: `${b.type} beat`, s: s0, e: e0 });
    } catch { /* a beat whose time cannot be mapped is refused by its own check later; nothing of it is on screen */ }
  }
  if (spec.banner?.text) others.push({ kind: "title banner", s: spec.banner.from ?? 0, e: Math.min(spec.banner.to ?? TOTAL, TOTAL) });
  // P5 needs captions to protect: a reel that draws none (captions.style "none") has no band
  const noCaps = spec.captions?.style === "none";
  const geo = { faceAt: placer.faceAt, band: noCaps ? null : placer.band, capH, total: SECTION_MODE ? SECTION_TOTAL : TOTAL, others };
  for (const l of graphicLayers) {
    const p = checkContract({ mode: l.graphic.mode, box: l.box, t0: r3(l.t0 - secOff), t1: r3(l.t1 - secOff), hideCaptions: l.hideCaptions, overCaptions: l.overCaptions }, geo);
    if (p.length) die(graphicLayerProblem(l.id, l.graphic.html, p[0]));
  }
  for (let i = graphicBeats.length - 1; i >= 0; i--) {
    const b = graphicBeats[i], g = b._graphic;
    const pc = checkContractCoded({ mode: g.mode, box: g.box, t0: g.t0, t1: g.t1, hideCaptions: g.hideCaptions, overCaptions: b.overCaptions === true }, geo);
    if (!pc.length) continue;
    warn.push(graphicBeatProblem(_gl(b), b.html, pc[0].text));
    recordDrop({ kind: "graphic beat", id: b.id, type: "graphic", at: b.at, to: b.to, t: g.t0, rule: pc[0].code, why: `The graphic${b.id !== undefined ? ` "${b.id}"` : ""} at ${clock(g.t0)} was dropped because ${GRAPHIC_WHY(pc[0].code)}.`, warning: graphicBeatProblem(_gl(b), b.html, pc[0].text) });
    motionBeats.splice(motionBeats.indexOf(b), 1);
    graphicBeats.splice(i, 1);
  }
}
if (graphicLayers.length || graphicBeats.length) {
  let gdeps = {};
  try { gdeps = await testDeps(); } catch (e) { die(e.message); }
  const gopts = { proj, W, H, fps: FPS, deps: gdeps, log: (m) => console.log(m), done: new Map() };
  // layers first, one at a time: the first layer that cannot be rendered kills the reel before any beat is rendered
  for (const l of graphicLayers) {
    const [r] = await prepareGraphics([l.graphic], gopts);
    if (!r.ok) die(graphicLayerProblem(l.id, l.graphic.html, r.reasons[0]));
    Object.assign(l.graphic, { file: r.file, key: r.key });
  }
  const res = await prepareGraphics(graphicBeats.map((b) => b._graphic), gopts);
  graphicBeats.forEach((b, i) => {
    const r = res[i];
    if (r.ok) { Object.assign(b._graphic, { file: r.file, key: r.key }); for (const w of b._graphic.warnings) warn.push(w); return; }
    warn.push(graphicBeatProblem(_gl(b), b.html, r.reasons[0]));
    recordDrop({ kind: "graphic beat", id: b.id, type: "graphic", at: b.at, to: b.to, t: b._graphic.t0, rule: (r.codes || [])[0] ?? null, why: `The graphic${b.id !== undefined ? ` "${b.id}"` : ""} at ${clock(b._graphic.t0)} was dropped because ${GRAPHIC_WHY((r.codes || [])[0])}.`, warning: graphicBeatProblem(_gl(b), b.html, r.reasons[0]) });
    motionBeats.splice(motionBeats.indexOf(b), 1);
  });
}


// legibility gate (OFF unless spec.legibility.behind is set; ported from engine/review-fixes a30d106). The value is the
// share of a behind-the-head word that must stay visible (e.g. 0.6): the speaker's matte is modelled as head (face
// box + hair margin) + neck + shoulders/body to the bottom of the frame, over the beat's whole span. A word that
// would be hidden more than allowed moves above the head (shrinking to 60% at most); with no headroom it is drawn IN
// FRONT of the speaker at the same place, with a soft shadow. Outcomes are build warnings, never failures.
const gateBehind = (text, size, y, t0, t1, charW, what) => {
  const min = spec.legibility?.behind;
  if (!min || !face) return { y, size, front: false };
  const sp = placer.span(t0, t1);
  if (!sp.seen) return { y, size, front: false };
  const fw = sp.right - sp.left, fh = sp.bottom - sp.top;
  const occ = [
    { x0: sp.left - fw * 0.1, x1: sp.right + fw * 0.1, y0: sp.top - fh * 0.04, y1: sp.bottom },
    { x0: sp.left + fw * 0.12, x1: sp.right - fw * 0.12, y0: sp.bottom, y1: sp.bottom + fh * 0.16 },
    { x0: sp.left - fw * 0.8, x1: sp.right + fw * 0.8, y0: sp.bottom + fh * 0.16, y1: H },
  ];
  const box = (yy, ss) => { const w = Math.min(W * 0.99, String(text).length * ss * charW), top = yy + ss * 0.06; return { x0: W / 2 - w / 2, x1: W / 2 + w / 2, y0: top, y1: top + ss * 0.78 }; };
  const vis = (bx) => 1 - occ.reduce((a, o) => a + Math.max(0, Math.min(bx.x1, o.x1) - Math.max(bx.x0, o.x0)) * Math.max(0, Math.min(bx.y1, o.y1) - Math.max(bx.y0, o.y0)), 0) / ((bx.x1 - bx.x0) * (bx.y1 - bx.y0));
  const v0 = vis(box(y, size));
  if (v0 >= min) return { y, size, front: false };
  const headTop = occ[0].y0;
  for (const k of [1, 0.85, 0.7, 0.6]) {
    const ss = Math.round(size * k), yy = Math.round(headTop - 20 - ss * 0.86);
    if (yy >= placer.safeTop && vis(box(yy, ss)) >= min) { warn.push(`${what}: ${Math.round(v0 * 100)}% visible behind the head, moved above it${k < 1 ? ` at ${Math.round(k * 100)}%` : ""}`); return { y: yy, size: ss, front: false }; }
  }
  warn.push(`${what}: ${Math.round(v0 * 100)}% visible behind the head and no headroom, drawn in front of the speaker`);
  return { y, size, front: true };
};
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
const CAP_FADE = 0.08;   // the captions' hide fade (the #caps tween below); a graphic's window starts it this much early
const CAP_BACK = 0.05;   // the re-show starts this much before a hidden window's end; a graphic's window ends this much late
for (const r of rampsAt) hiddenCaps.push([r.t0, r.end]);   // ramped action takes (premium kit) carry no captions
const uiRects = [];   // uicard rectangles (UI Story Ad #10), so podcast captions sit above them
// reel.layers[]: a motion or text layer with hideCaptions:true hides the captions while it is up, the way a
// beat's hideCaptions does. Layer times are output seconds, so a section build (which rebases takes)
// rebases them with the same offset renderLayer() uses.
for (const l of LAYERS) if (l.hideCaptions === true && (l.kind === "motion" || l.kind === "text")) hiddenCaps.push([r3(l.t0 - (SECTION_MODE ? SECTION_START : 0)), r3(l.t1 - (SECTION_MODE ? SECTION_START : 0))]);
// a graphic's captions are already gone on its first frame and come back only after its last: the 0.08 s caption fade
// ENDS at t0 and the re-show (which starts 0.05 s before a window's end) starts at t1. Measured in a real render: the
// plain [t0, t1] window left the caption over the first and the last frames of a full-frame insert.
for (const l of LAYERS) if (l.hideCaptions === true && l.kind === "graphic") hiddenCaps.push([r3(Math.max(0, l.t0 - CAP_FADE) - (SECTION_MODE ? SECTION_START : 0)), r3(l.t1 + CAP_BACK - (SECTION_MODE ? SECTION_START : 0))]);
const behindHtml = [];
const groundWins = [];   // [t0, t1] of every `ground` beat (edit seconds), for the post-loop look/matte handling
const frontHtml = [];   // behind-the-head words promoted in front of the matte by the legibility gate (spec.legibility.behind)
let outroCovered = false;   // a full-frame beat (end card, scene, motion graphic) is drawn over the whole outro
const shownCaps = []; // scenes that keep captions (captions.onlyInScenes shows ONLY these)
const faceFile = path.join(proj, spec.face || "build/face.json");
// MULTIANGLE Gap 6. This median comes from the PRIMARY source's track and has two consumers with
// different constraints:
//   - `#pip`'s CSS transform-origin (:1560) - one value baked into the stylesheet, so per-source
//     would mean animating the origin, not just choosing a track. LEFT global; noted, not fixed.
//   - `motionCtx.faceY`, whose only consumer is motion.mjs:508's pip clip-path centre - and that
//     is inside a BEAT, which has a time. So t0 -> the take that owns it -> its src -> that
//     source's median is all available, and needs no animation at all. FIXED below: `faceYAt(t)`
//     resolves the take owning edit-time `t` (`locateTake`, the same ownership logic `locate()` in
//     safezone.mjs and the take/hold loop above both already use) and returns THAT source's own
//     median, falling back to the primary's (i.e. this `faceY`) for a source with no track of its
//     own. `#pip`'s baked origin still uses `faceY` directly, unchanged.
const faceY = medianFaceY(fs.existsSync(faceFile) ? JSON.parse(fs.readFileSync(faceFile, "utf8")) : null, 700);
const faceYBySrc = new Map(SOURCES.map((s) => [s, medianFaceY(faces[s], SOURCES.length > 1 && s !== PRIMARY_SRC && !faces[s]?.samples?.length ? 700 : faceY)]));
const faceYAt = (t) => faceYBySrc.get(locateTake(takes, t, FPS)?.src) ?? faceY;
// white 24x24 glyphs for the UI Story Ad #10 pills (drawn here, no icon font)
const UI_GLYPHS = {
  check: `<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  doc: `<path d="M6 2.5h8l4.5 4.5v14.5H6z" fill="#fff"/><path d="M14 2.5V7h4.5" fill="none" stroke="#1FC24A" stroke-width="1.2"/><path d="M8.5 11h7M8.5 14h7M8.5 17h5" stroke="#1FC24A" stroke-width="1.4" stroke-linecap="round"/>`,
  report: `<path d="M5 3h10l4 4v14H5z" fill="#fff"/><path d="M8 17v-3M11.5 17v-6M15 17v-4" stroke="#1FC24A" stroke-width="1.8" stroke-linecap="round"/>`,
  chart: `<path d="M4 20h16" stroke="#fff" stroke-width="2" stroke-linecap="round"/><rect x="5" y="12" width="3" height="6" rx=".6" fill="#fff"/><rect x="10.5" y="8" width="3" height="10" rx=".6" fill="#fff"/><rect x="16" y="4" width="3" height="14" rx=".6" fill="#fff"/>`,
  people: `<circle cx="9" cy="8" r="3.4" fill="#fff"/><path d="M2.5 20c.6-4 3.2-6 6.5-6s5.9 2 6.5 6z" fill="#fff"/><circle cx="16.5" cy="9" r="2.6" fill="#fff"/><path d="M16 14.2c3 .2 5 2 5.5 5.3h-4.4" fill="#fff"/>`,
  globe: `<circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-width="2"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" fill="none" stroke="#fff" stroke-width="1.6"/>`,
  image: `<rect x="3" y="4.5" width="18" height="15" rx="2" fill="none" stroke="#fff" stroke-width="2"/><circle cx="8.5" cy="9.5" r="1.8" fill="#fff"/><path d="M4 18l5.5-5.5 4 4 2.5-2.5 4 4" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`,
  book: `<path d="M4 4.5c3-1 6-1 8 1 2-2 5-2 8-1V19c-3-1-6-1-8 1-2-2-5-2-8-1z" fill="#fff"/><path d="M12 5.5V20" stroke="#1FC24A" stroke-width="1.3"/>`,
  archive: `<rect x="3" y="4" width="18" height="5" rx="1" fill="#fff"/><path d="M4.5 10h15v9.5H4.5z" fill="#fff"/><path d="M9.5 13h5" stroke="#1FC24A" stroke-width="1.8" stroke-linecap="round"/>`,
  museum: `<path d="M12 2.8L21 7.5H3z" fill="#fff"/><path d="M5 9.5v8M9.7 9.5v8M14.3 9.5v8M19 9.5v8" stroke="#fff" stroke-width="2.2"/><path d="M3 19.5h18v1.8H3z" fill="#fff"/>`,
  home: `<path d="M3.5 11L12 4l8.5 7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10.5V20h12v-9.5" fill="#fff"/>`,
  shield: `<path d="M12 2.5l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6z" fill="#fff"/><path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="#1FC24A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  heart: `<path d="M12 20.5S3.5 15.3 3.5 9.2A4.4 4.4 0 0112 7a4.4 4.4 0 018.5 2.2c0 6.1-8.5 11.3-8.5 11.3z" fill="#fff"/>`,
  clock: `<circle cx="12" cy="12" r="9" fill="#fff"/><path d="M12 7v5.3l3.4 2" fill="none" stroke="#1FC24A" stroke-width="2" stroke-linecap="round"/>`,
  star: `<path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6L12 16.7 6.6 19.6l1.1-6L3.2 9.4l6.1-.8z" fill="#fff"/>`,
  bolt: `<path d="M13.5 2L5 13.5h6L10 22l9-12h-6z" fill="#fff"/>`,
  mask: `<path d="M3 8.5c3-1.5 6-2 9-2s6 .5 9 2v4c0 3.5-4 6.5-9 6.5s-9-3-9-6.5z" fill="#fff"/><path d="M7 11h10M7 14h10" stroke="#1FC24A" stroke-width="1.3" stroke-linecap="round"/>`,
  tree: `<path d="M12 2.5l6.5 9h-3.3l4.3 6H4.5l4.3-6H5.5z" fill="#fff"/><rect x="10.8" y="17" width="2.4" height="4.5" fill="#fff"/>`,
};
const motionCtx = { premium: PK, rampScene: (media, ms, t0, t1, ramp, id) => {
  // scene.ramp (premium kit): the B-roll clip's picture is pre-rendered on a speed curve; the scene keeps its at/to window
  let rc;
  try { rc = PK.rampClip({ src: path.resolve(proj, media), mediaStart: ms, D: r3(t1 - t0), ramp, fps: FPS, outDir: A, tag: id, srcDur: parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.resolve(proj, media)]).toString()) }); } catch (e) { die(`scene ${id}: ${e.message}`); }
  rampsAt.push({ t0, peak: r3(t0 + rc.peakAt), end: t1, scene: true });
  console.log(`ramp scene ${id}: ${ms}+${rc.S} s source -> ${r3(t1 - t0)} s (${rc.minSpeed}x..${rc.maxSpeed}x)`);
  return rc;
}, conceptCenter: spec.conceptCenter, tl, E, r3, brollGrade, gmTheme: spec.gm?.theme, safeTop: placer.safeTop, esc, addSfx, brand, userAsset, artAsset, icon: (slug) => icon(slug), zoomBase: (spec.zoom || {}).base ?? 1, words, proj, LIB, faceY, faceYAt, sound: spec.sound || {}, pageScreen: spec.pageScreen, pageMap: spec.pageMap, pagePaper: spec.pagePaper, sceneIn: spec.sceneIn, sceneOut: spec.sceneOut, source: SRC, rtl, get SPEECH() { return SPEECH; }, get TOTAL() { return TOTAL; } };

// a scene that hands over to an expand/wipe scene stays underneath until the
// incoming panel has covered it
const deferredLeaks = [];   // leak beats need the pack helpers, which are defined after the beat loop (ported from main bd7ae09)
const beatsList = spec.beats || [];
// a template can carry the name tag: on screen from the first frame until the hook page cuts in (or 2.4 s)
// (R1b port)
// A12: this used to skip whenever ANY nametag beat existed, so a hand-authored plan that adds a
// third-party nametag (a guest, a co-host) silently deleted the speaker's own - no warning, no
// trace. The guard now asks "does a nametag beat for THIS speaker already exist" (matched by
// spec.nametag.name, the same string brandLayer() and a hand-authored top-level `nametag` both
// put there) instead of "does any nametag beat exist at all". A plan that repositions the self-tag
// by hand (one nametag beat, name matching spec.nametag.name) still suppresses the duplicate,
// unchanged from before; a plan that adds a DIFFERENT name no longer suppresses the self-tag.
// `spec.nametag` with no `name` set falls back to the old "any nametag beat" check - there is
// nothing to match against, so there is no self-tag identity to protect.
const selfTagName = spec.nametag?.name;
const hasSelfTag = beatsList.some((b) => b.type === "nametag" && (selfTagName ? b.name === selfTagName : true));
if (spec.nametag && !hasSelfTag) {
  // first page as the VIEWER meets it, so pick by edit time - but keep its source `at`, because
  // `until` below is a source time that gets mapped through E() with every other beat. When takes
  // are in source order E() is monotonic, so this sorts identically to sorting by `at` and no
  // existing plan changes; it only differs once a take has been moved.
  const pagesByEdit = beatsList.filter((b) => b.type === "scene").sort((x, y) => EB(x, "at") - EB(y, "at"));
  const firstPage = pagesByEdit.length ? pagesByEdit[0].at : undefined;
  const until = spec.nametag.until === "hook" && firstPage != null && firstPage < 4.5 ? firstPage - 0.05 : (spec.nametag.to ?? 2.4);
  beatsList.unshift({ type: "nametag", name: spec.nametag.name, title: spec.nametag.title, subtitle: spec.nametag.subtitle, at: spec.nametag.at ?? 0.15, to: Math.max(1.2, until), sfx: false });
}
// drop (premium kit, opt-in): talk -> riser -> ~3 f of silence -> boom -> a beat-locked cut ladder of B-roll shots
// (Belmar / Iman DNA: 18 f x4, 12 f x6, 9 f x4), a 3 f white flash on every Nth cut, SFX lifted a few dB inside the drop.
// drop.hold = i puts the ladder on take i's hold (frozen air after the take, voice gone); drop.at = a source second
// inside one plain take otherwise. drop.shots = scene options per shot (src | self, media, ramp...), cycled.
// A style may carry drop defaults (bpm, beats, overlap): the drop itself runs only when the reel places it (hold / at / shots).
let dropWin = null, dropFlashHtml = "";
const talkInGap = (a, b) => words.some((w) => w.start < b && w.end > a);
if (spec.drop && (spec.drop.hold != null || spec.drop.at != null || spec.drop.shots)) {
  const DR = { ladder: [18, 18, 18, 18, 12, 12, 12, 12, 12, 12, 9, 9, 9, 9], gap: 3, flashEvery: 3, flash: 0.6, lift: 3, riser: "cinematic-rumble-riser", boom: "cinematic-deep-boom", tail: "whoosh-cine", cutSfx: "tech-camera-flash", in: "cut", ...spec.drop };
  if (!spec.beats) spec.beats = beatsList;   // the ladder scenes are beats: edit_truth.json lists them
  if (!DR.shots?.length) die("drop needs shots: [{ self: <source s> } | { src: <clip> }, ...]");
  if (DR.hold == null && DR.at == null) die("drop needs hold: <take index> or at: <source second>");
  if (DR.hold != null && !takes[DR.hold]) die(`drop.hold ${DR.hold}: there is no take ${DR.hold}`);
  for (const k of ["riser", "boom", "tail", "cutSfx"]) {
    const v = DR[k];
    const ok = v === false || v == null || (typeof v === "string" && v) || (Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && x));
    if (!ok) die(`drop.${k} must be a sound id, a non-empty list of sound ids, false or "none" (got ${JSON.stringify(v)})`);
  }
  // drop.bpm + drop.beats (opt-in): the ladder in beats of the music bed, rounded on the running total so the cuts
  // stay on the beat grid (no drift from rounding each shot to whole frames)
  if (DR.bpm && DR.beats?.length) { const spb = 60 / DR.bpm; let acc = 0, prevF = 0; DR.ladder = DR.beats.map((n) => { acc += n * spb; const f = Math.round(acc * FPS); const d = f - prevF; prevF = f; return d; }); }
  // on a hold the silence is the hold's first DR.gap frames (the voice has just stopped), so the ladder starts after it
  const at = (off) => DR.hold != null ? `hold:${DR.hold}+${r3(off + DR.gap / FPS)}` : r3(DR.at + off);
  const T0 = E(at(0), "drop");
  let off = 0;
  DR.ladder.forEach((f, i) => {
    const d = f / FPS, sh = DR.shots[i % DR.shots.length];
    beatsList.push({ type: "scene", kind: "image", zoom: [1.0, 1.06], ...sh, at: at(off), to: at(off + d + (DR.overlap ?? 0) / FPS), in: i === 0 ? DR.in : "cut", out: "cut", sfx: false, _drop: true });
    off += d;
  });
  dropWin = [T0, r3(T0 + off)];
  console.log(`drop at ${T0}s: ${DR.ladder.length} cuts in ${off.toFixed(2)} s (ladder ${DR.ladder.join("/")} f)`);
  motionCtx.dropPlan = DR;
}
const HANDOVER = 0.45;
const hzLists = [];   // Authority (hormozi): edit-time spans of the split-screen lists, where the captions move up (captions.listY)
// I-25: the resolved [t0, t1] every beat actually occupies on the output timeline, captured as a
// side effect of this loop (same pattern as sfxEvents/slotUsed below) rather than re-derived later
// - the HANDOVER extension a few lines down is exactly the kind of resolution a second
// implementation could silently drift from. lib/sections.mjs uses this to decide which take joins
// a beat spans, so it never becomes a section boundary.
const beatSpans = [];
// #fx holds: the windows in which a popcard keeps the camera defocused ({a: its defocus tween starts, aEnd: that tween ends,
// b: its focus-return tween starts, ret: that tween's length, blur, dim}). Every other tween on #fx's filter (look.refocus pulls,
// captions.energyPunch, a leak's bloom) used to end on "blur(0px) brightness(1)". Which of two overlapping GSAP tweens on one
// property shows depends on the seek: frame by frame forward, the one that updates last (the later END); a jump, the later
// START. So a tween that ends after the card's defocus has ended re-sharpened the speaker for the rest of the card.
// fxAim(start, dur) is the hold such a tween must settle into: it ends after the defocus ended (aEnd) and no later than the
// focus-return ends (b + ret), and it starts before the return does - then the card's own tweens agree with it under both
// seek orders, and the return still has the last word. A tween ending after b + ret keeps its sharp end (it outlives the card).
// Overlapping cards: the hold with the latest start wins (its defocus tween is the one that started last).
const fxHolds = [];
const fxAim = (start, dur) => fxHolds.filter((h) => start < h.b - 1e-6 && start + dur > h.aEnd + 1e-6 && start + dur <= h.b + h.ret + 1e-6).sort((p, q) => p.a - q.a).at(-1);
// the hold a tween STARTS in (its from-state keeps the card's dim, so a punch that outlives the card does not flash bright)
const fxIn = (t) => fxHolds.filter((h) => t >= h.a - 1e-6 && t < h.b - 1e-6).sort((p, q) => p.a - q.a).at(-1);
const fxRest = (h, bright = 1) => h ? `blur(${h.blur}px) brightness(${r3(h.dim * bright)})` : `blur(0px) brightness(${bright})`;
const fxLeaks = [];   // leak bloom tweens on #fx (tl index + times), re-aimed after the loop if they land inside a popcard hold
for (const b of beatsList) {
  CUR_BEAT = b;
  const id = `b${n++}`;
  const t0 = EB(b, "at", `${b.type} at`);
  let t1 = b.to === undefined ? (b.type === "endcard" ? TOTAL : t0 + (b.type === "meme" ? 1.8 : 2.5)) : EB(b, "to", `${b.type} to`);
  if (b.type === "scene" && beatsList.some((o) => o !== b && o.type === "scene" && ["expand", "wipe"].includes(o.in) && Math.abs(EB(o, "at") - t1) < 0.06)) t1 = r3(Math.min(TOTAL, t1 + HANDOVER));
  if (b.type === "graphic") t1 = b._graphic.t1;   // its resolved end: the default window, or shortened by after "cut"
  beatSpans.push({ t0, t1 });
  const dur = r3(t1 - t0);
  if (["endcard", "scene", "motion", "ground", "headpage", "photostack", "starflash"].includes(b.type) && (b.type !== "starflash" || b.field) && t0 <= SPEECH + 1e-3 && t1 >= TOTAL - 0.5 / FPS) outroCovered = true;
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
    if (!slotPos) {
      warn.push(`${b.type} at ${b.at}: the face fills the frame, no room beside it: skipped`);
      recordDrop({ kind: "sticker", id: b.id, type: b.type, at: b.at, to: b.to, t: t0, rule: "no-room", why: `The ${b.type} at ${clock(t0)} was left out because the speaker's face fills the frame and there is no room beside it.`, warning: `${b.type} at ${b.at}: the face fills the frame, no room beside it: skipped` });
      continue;
    }
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
      if (!fs.existsSync(svgPath)) {   // from vendor/lucide-static, never fetched
        const svg = vendoredIcon("lucide-static", b.name);
        if (svg == null) die(`no Lucide icon '${b.name}' (see https://lucide.dev/icons)`);
        fs.mkdirSync(path.dirname(svgPath), { recursive: true });
        fs.writeFileSync(svgPath, svg);
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
      inner = `<div id="${id}-in" class="ov logo" style="left:${b.x ?? (slotPos ? slotPos.x : SLOT.x)}px;top:${b.y ?? (slotPos ? slotPos.y : SLOT.y)}px;background:${b.bg || "#fff"}"><img src="${img}" style="${b.invert ? "filter:invert(1);" : ""}"/></div>`;
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
        const memeDefault = meta.sfx && sfxEntry(meta.sfx) ? meta.sfx : sfxManifest["vine-boom"] ? "vine-boom" : "cinematic-deep-boom" in sfxManifest ? "cinematic-deep-boom" : "impact";
        beatSfx(b, t0, memeDefault, "meme image");
      }
      break;
    }
    case "endcard": {
      if (b.variant === "caps") {
        // Caps / chapter card (opt-in, hand port of phantasic Empire + Noir): a black frame (b.bg "none" = a soft dark band
        // over the picture, "smoke" = dark smoke), small letter-spaced caps typed on - or, with font "serif", an italic
        // Instrument Serif chapter title that keeps its case ("|" in a title is a line break), optional arrow, optional fade
        // to black. {title, accent, at, to, fade, color, font: "serif"|"mono", size, y, arrow, instant, bg}
        const col = b.color ?? "#3BFF6B", fade = b.fade ?? 0.8, title = b.font === "serif" ? (b.title ?? "Follow for more") : (b.title ?? "FOLLOW FOR MORE").toUpperCase();
        const acc = (b.accent ?? "").toUpperCase();
        const chars = [...title].map((c, k) => c === "|" ? `<br id="${id}-c${k}">` : `<span id="${id}-c${k}" style="display:none">${c === " " ? "&nbsp;" : esc(c)}</span>`);
        if (acc && title.includes(acc)) { const i0 = title.indexOf(acc); chars.splice(i0, 0, `<span style="color:${col};text-shadow:0 0 16px ${col}">`); chars.splice(i0 + acc.length + 1, 0, "</span>"); }
        const mono = b.font === "mono";
        // every card face fits its longest line in the 960 px text box (letters + tracking per em: mono .66, tracked caps .86, serif .5)
        const tSize = Math.min(b.size ?? (mono ? 40 : 60), Math.floor(960 / Math.max(1, Math.max(...title.split("|").map((l) => l.length)) * (mono ? 0.66 : b.font === "serif" ? 0.5 : 0.86))));
        const bgCss = b.bg === "none" ? "linear-gradient(180deg, transparent 38%, rgba(0,0,0,.55) 47%, rgba(0,0,0,.55) 55%, transparent 64%)" : b.bg === "smoke" ? "radial-gradient(70% 40% at 30% 30%, #2a2a2e 0%, transparent 70%), radial-gradient(60% 35% at 75% 70%, #232327 0%, transparent 70%), #111113" : "#000";
        const ty = b.y ?? Math.round(860 * H / 1920);
        inner = `<div id="${id}-bg" style="position:absolute;inset:0;background:${bgCss}"></div>`
          + `<div id="${id}-t" style="position:absolute;left:60px;right:60px;top:${ty}px;text-align:center;font:${b.font === "serif" ? `italic 400 ${tSize}px/1.15 'Instrument Serif', Georgia, serif;letter-spacing:.02em` : mono ? `700 ${tSize}px/1.3 'JetBrains Mono', monospace;letter-spacing:.06em` : `800 ${tSize}px/1.2 Montserrat, system-ui, sans-serif;letter-spacing:.24em`};color:#fff;text-shadow:0 0 14px rgba(255,255,255,.45)">${chars.join("")}</div>`
          + (b.arrow === false ? "" : `<svg id="${id}-a" viewBox="0 0 40 48" style="position:absolute;left:${Math.round(W / 2 - 30)}px;top:${ty + 90}px;width:84px;height:100px;margin-left:-12px;filter:drop-shadow(0 0 12px ${col})"><path d="M20 4 V40 M6 27 L20 42 L34 27" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`)
          + (fade > 0 ? `<div id="${id}-k" style="position:absolute;inset:0;background:#000"></div>` : "");
        tl.push(`ft("#${id}-bg", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 }, ${t0});`);
        // b.instant: the title lands whole (a cut, not typed), so no frame ever shows half a word
        const n = [...title].length, cps = b.instant ? 1e6 : Math.max(30, n / 0.5);
        tl.push(`tl.set("#${id}-t span[id]", { display: "none" }, 0);`);
        for (let k = 0; k < n; k++) if ([...title][k] !== "|") tl.push(`tl.set("#${id}-c${k}", { display: "inline" }, ${r3(t0 + 0.2 + k / cps)});`);
        const ta = r3(t0 + 0.25 + n / cps);
        if (b.arrow !== false) tl.push(`ft("#${id}-a", { autoAlpha: 0, y: -24 }, { autoAlpha: 1, y: 0, duration: 0.25, ease: "back.out(2)" }, ${ta});`);
        if (b.arrow !== false) tl.push(`tl.to("#${id}-a", { y: 12, duration: 0.3, yoyo: true, repeat: 5, ease: "sine.inOut" }, ${r3(ta + 0.25)});`);
        if (fade > 0) tl.push(`ft("#${id}-k", { autoAlpha: 0 }, { autoAlpha: 1, duration: ${fade}, ease: "power1.in" }, ${r3(Math.max(ta + 0.3, t1 - fade))});`);
        hiddenCaps.push([t0, t1]);
        beatSfx(b, b.arrow === false ? t0 : ta, b.arrow === false ? "tick-1" : "ding-1", b.arrow === false ? "mono card" : "end card arrow", { db: -6 });
        break;
      }
      inner = `<div id="${id}-dim" class="ov dim"></div><div id="${id}-in" class="ov endcard">${b.title ? `<div class="ec-title">${esc(b.title)}</div>` : ""}${b.line ? `<div class="ec-line">${esc(b.line)}</div>` : ""}${b.url ? `<div class="ec-url">${esc(b.url)}</div>` : ""}</div>`;
      tl.push(`ft("#${id}-dim", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 }, ${t0});`);
      tl.push(enter(`#${id}-in`, r3(t0 + 0.1), "slide"));
      beatSfx(b, t0, "whoosh", "endcard");
      break;
    }
    case "headline": {
      // Podcast Glow (hand port of phantasic d8bb43a + 866dc8f): a small white sans line over a HUGE condensed yellow word with a
      // glow ("WE HAVE" / "NO IDEA"). The small words land on their spoken times (b.smallAt), the big word slams in on b.bigAt.
      // pos "low" (lower half), "top" (hook question at the top), "left" (stacked top-left). behind: true puts it between the
      // plate and the speaker cut-out (needs "matte": true, or a stage); with spec.legibility.behind it goes through the same
      // gate as a `behind` word. arrow: "left" | "right" draws a hand-drawn yellow arrow to the word. Sizes and y constants are
      // 9:16 pixels, scaled to the format.
      const hk = H / 1920, wk = W / 1080;
      const SMALL = String(b.small ?? "").toUpperCase().trim(), BIG = String(b.big ?? "").toUpperCase();
      if (!BIG) die(`headline at ${b.at} has no \`big\` word`);
      const pos = b.pos ?? "low", left = pos === "left";
      const behindMatte = !!(b.behind && spec.matte);
      const avail = (left || behindMatte ? 860 : 980) * wk;   // behind the head it rides the punch-ins, so it keeps a crop margin
      const bigLen = BIG.replace(/\s+/g, "").length + (BIG.split(/\s+/).length - 1) * 0.3;
      let bsz = Math.min(b.size ?? 330, Math.floor(avail / (Math.max(2.5, bigLen) * 0.58)));
      const ssz = Math.min(b.smallSize ?? 78, Math.floor(avail / (Math.max(4, SMALL.length) * 0.64)));
      let y = b.y;
      let arrowOn = b.arrow;
      if (y === undefined) {
        if (pos === "top" || left) y = placer.safeTop + (b.dy ?? 0);
        else {
          const sp = placer.span(t0, t1);
          const under = sp && sp.seen ? sp.bottom + 30 : 1050 * hk;
          const room = placer.safeBottom + 40 - Math.max(under, 980 * hk);
          const smallH = SMALL ? ssz * 1.05 : 0;
          if (room >= smallH + bsz * 0.98) y = Math.round(Math.max(under, 980 * hk));
          else if (room >= smallH + 170 * hk) { bsz = Math.floor((room - smallH) / 0.98); y = Math.round(Math.max(under, 980 * hk)); }
          else if (spec.glow?.keepLow) {
            // glow.keepLow (opt-in): a low headline never jumps to the top band; it sits as low as the safe area allows, over the
            // chest (the approved Podcast Glow sample), shrinking the big word only if the block would not fit, and with no arrow
            const floorY = 980 * hk, bottom = placer.safeBottom + 40, fitB = Math.floor((bottom - floorY - smallH) / 0.98);
            const ky = Math.round(Math.max(floorY, bottom - (smallH + Math.min(bsz, fitB) * 0.98)));
            // never over the mouth (face track, through the punch-ins): the block's top stays 60 px under the mouth line
            const mouthClear = !(sp && sp.seen) || ky >= sp.mouth + 60 * hk;
            if (fitB < Math.min(bsz, 170 * hk) || !mouthClear) {   // no readable big word fits, or it would cover the mouth: the old top band
              warn.push(`headline "${BIG}" at ${b.at}: glow.keepLow ${mouthClear ? `has no room for a big word >= ${Math.round(170 * hk)}px in the lower frame` : "would cover the mouth"}, so it goes to the top band`);
              y = placer.safeTop + 40 * hk; arrowOn = undefined;
            } else { bsz = Math.min(bsz, fitB); y = ky; arrowOn = undefined; }
          }
          else { y = placer.safeTop + 40 * hk; arrowOn = undefined; }   // a close-up with no room under the chin: the headline goes to the top band (no arrow)
        }
      }
      let front = false;
      if (behindMatte && !spec.stage) {
        // the legibility gate models the speaker unscaled; a stage rescales the subject, so it is skipped there
        const by = y + (SMALL ? ssz * 1.05 : 0), g = gateBehind(BIG, bsz, by, t0, t1, 0.58, `headline "${BIG}" at ${b.at}`);
        y += g.y - by; bsz = g.size; front = g.front;
      }
      const blockH = (SMALL ? ssz * 1.05 : 0) + bsz * 0.98;
      const smallWords = SMALL ? SMALL.split(/\s+/) : [];
      const tryEb = (t) => { try { return E(t); } catch { return null; } };
      const smallAt = (b.smallAt || []).map((x) => tryEb(x));
      const bigT = b.bigAt !== undefined ? Math.max(t0, tryEb(b.bigAt) ?? t0) : t0;
      const align = left ? "left" : "center";
      const hcol = b.color ?? "#FFD21E";
      const arrow = arrowOn ? `<svg id="${id}-ar" class="hl-ar" viewBox="0 0 160 200" style="${arrowOn === "left" ? "left:70px" : "right:70px"};top:${Math.round(y + (SMALL ? ssz : 0) + bsz * 0.75)}px;${arrowOn === "left" ? "" : "transform:scaleX(-1)"}"><path id="${id}-arp" d="M120 190 C 40 170, 20 110, 60 30" fill="none" stroke="${hcol}" stroke-width="7" stroke-linecap="round" stroke-dasharray="260" stroke-dashoffset="260"/><path id="${id}-arh" d="M34 52 L60 26 L84 54" fill="none" stroke="${hcol}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity="0"/></svg>` : "";
      const shade = (pos === "top" || left) && b.shade !== false ? `<div class="hl-sh" style="height:${Math.round(y + blockH + 220 * hk)}px"></div>` : "";
      const body = shade + `<div id="${id}-in" class="hl" style="top:${Math.round(y)}px;text-align:${align};${left ? "left:64px;right:120px" : "left:40px;right:40px"}">${SMALL ? `<div class="hl-s" style="font-size:${ssz}px">${smallWords.map((w, k) => `<span id="${id}-s${k}">${esc(w)}</span>`).join(" ")}</div>` : ""}<div id="${id}-b" class="hl-b" style="font-size:${bsz}px;color:${hcol}">${esc(BIG)}</div></div>${arrow}`;
      smallWords.forEach((_, k) => tl.push(`ft("#${id}-s${k}", { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.09, ease: "power3.out" }, ${r3(Math.min(bigT, Math.max(t0, smallAt[k] ?? t0)))});`));
      tl.push(`ft("#${id}-b", { autoAlpha: 0, scale: 1.45, filter: "blur(10px)" }, { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: 0.16, ease: "expo.out" }, ${r3(bigT)});`);
      if (t1 - bigT > 0.4) tl.push(`tl.to("#${id}-b", { scale: 1.05, duration: ${r3(t1 - bigT - 0.18)}, ease: "none" }, ${r3(bigT + 0.18)});`);
      if (arrowOn) { tl.push(`tl.to("#${id}-arp", { strokeDashoffset: 0, duration: 0.28, ease: "power2.out" }, ${r3(bigT + 0.12)});`); tl.push(`tl.to("#${id}-arh", { opacity: 1, duration: 0.05 }, ${r3(bigT + 0.36)});`); }
      hiddenCaps.push([t0, t1]);
      if (b.sfx === undefined) { addSfx(r3(bigT - 0.1), "whoosh-2", "headline whoosh", { db: -6 }); addSfx(bigT, "impact-1", "headline slam", { db: -3 }); if (arrowOn) addSfx(r3(bigT + 0.12), "pen-short", "headline arrow", { db: -8 }); }
      else beatSfx(b, bigT, "impact-1", "headline");
      if (behindMatte) {
        (front ? frontHtml : behindHtml).push(`<div id="${id}" class="clip behind" data-start="${t0}" data-duration="${dur}" data-track-index="1">${body}</div>`);
        continue;
      }
      inner = body;
      break;
    }
    // ---- Authority / Hormozi beats (lib/hormozi.mjs, hand port of phantasic b928b75 + 684837f): hz-title, hz-name, hz-list, hz-note ----
    case "hz-title": case "hz-name": case "hz-list": case "hz-note": {
      if (b.type === "hz-name" && b.avatar === undefined) {
        // a face still of the speaker, cut from the recording the beat is on (b.src, else the primary one) with THAT recording's
        // face track: samples [t, top, bottom, left, right, eyes, mouth]; centred on eyes/mouth, b.avatarCrop [x, y, side] overrides
        const asrc = SOURCES.includes(b.src) ? b.src : PRIMARY_SRC, at = b.avatarAt ?? (takes.find((k) => k.src === asrc) ?? takes[0]).a + 1;
        const smp = ((faces[asrc] || {}).samples || []).filter((x) => x[1] != null).sort((p, q) => Math.abs(p[0] - at) - Math.abs(q[0] - at))[0];
        const em = smp && smp[6] > smp[5] ? smp[6] - smp[5] : 200;
        const [cx, cy, sz] = b.avatarCrop ? [b.avatarCrop[0] + b.avatarCrop[2] / 2, b.avatarCrop[1] + b.avatarCrop[2] / 2, b.avatarCrop[2]] : smp ? [Math.min((smp[3] + smp[4]) / 2, smp[3] + em * 1.4), (smp[5] + smp[6]) / 2 - em * 0.2, Math.round(em * 3.2)] : [W / 2, faceY, 560];
        // face coordinates are in the pixel space of the recording the track was made on; clamp the crop to that recording's real frame
        const [sw, sh] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path.resolve(proj, mediaOf.get(asrc))]).toString().trim().split("x").map(Number);
        const side = Math.min(sw, sh, W, Math.max(200, sz)), x0 = Math.round(Math.max(0, Math.min(sw - side, cx - side / 2))), y0 = Math.round(Math.max(0, Math.min(sh - side, cy - side / 2)));
        const aname = asrc === PRIMARY_SRC ? "hz-avatar.jpg" : `hz-avatar-${srcIndex.get(asrc)}.jpg`;
        execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", stillAt(at, asrc), "-i", path.resolve(proj, mediaOf.get(asrc)), "-frames:v", "1", "-vf", `crop=${side}:${side}:${x0}:${y0},scale=240:240`, "-q:v", "2", "-update", "1", path.join(A, aname)]);
        b.avatar = `assets/${aname}`;
      }
      inner = hzBeat(b, id, t0, t1, { tl, r3, esc, E, addSfx });
      if (b.type === "hz-list") hzLists.push([t0, t1]);
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
      const g = gateBehind(b.text, size, y, t0, t1, 0.74, `behind word "${b.text}" at ${b.at}`);
      (g.front ? frontHtml : behindHtml).push(`<div id="${id}" class="clip behind" data-start="${t0}" data-duration="${dur}" data-track-index="1"><div id="${id}-in" class="behind-in" style="top:${g.y}px;font-size:${g.size}px;color:${b.color ?? brand.accent}${g.front ? ";text-shadow:0 6px 28px rgba(0,0,0,.45)" : ""}">${esc(b.text)}</div></div>`);
      tl.push(`ft("#${id}-in", { autoAlpha: 0, y: 80, scaleY: 1.6 }, { autoAlpha: 1, y: 0, scaleY: 1, duration: 0.45, ease: "expo.out" }, ${t0});`);
      tl.push(`tl.to("#${id}-in", { autoAlpha: 0, y: -40, duration: 0.2, ease: "power2.in" }, ${r3(t1 - 0.22)});`);
      beatSfx(b, t0, "impact", "behind word");
      break;
    }
    case "ground": {
      // (R1 B1 port of phantasic 0fd3ff2 + red-poster-fix2: gateBehind, b.lead, frame-0 fix, hideCaptions)
      // the speaker CUT OUT over a flat page: a full-frame ground replaces the room behind them (between the plate and
      // the matte), e.g. a maroon magazine page, grid paper, a teal card. {at, to, color | paper: "grid"|"cream"|"white",
      // gradient: [c1, c2], backdrop: "<css filter>", grain, text, textColor, textSize, textY, lead, leadSize, leadY, leadColor,
      // hideCaptions, ink, in: "fade", gridColor, gridSize}. Needs "matte": true. On a multi-source reel each take reads the
      // matte of its own recording (a recording with no face track has none, and shows no speaker over the page: warned).
      if (!spec.matte) die("a 'ground' beat needs \"matte\": true (a person cut-out of talk.mp4)");
      if (SOURCES.length > 1) { const bare = takes.filter((k) => !stageMatted(k.src) && k.start < t1 && k.start + k.dur > t0); if (bare.length) warn.push(`ground at ${t0}s: ${[...new Set(bare.map((k) => k.src))].join(", ")} has no face track, so no cut-out speaker is drawn over the page there`); }
      groundWins.push([t0, t1, b]);
      const papers = { cream: "#EFE8DA", white: "#F7F7F5", grid: "#F4F3EF" };
      // backdrop: "grayscale(1) contrast(1.1)" keeps the room but filters it (B&W room, colour speaker on top)
      const base = b.backdrop ? "transparent" : b.gradient ? `linear-gradient(180deg, ${b.gradient[0]} 0%, ${b.gradient[1]} 100%)` : (b.color ?? papers[b.paper] ?? brand.accent);
      const gc = b.gridColor ?? "rgba(0,0,0,.07)", grid = b.paper === "grid" ? `background-image:linear-gradient(${gc} 1px, transparent 1px),linear-gradient(90deg, ${gc} 1px, transparent 1px);background-size:${b.gridSize ?? 54}px ${b.gridSize ?? 54}px;` : "";
      // text sits above the head by default (face track), else at textY / 300
      let gsz = Math.min(b.textSize ?? 180, Math.floor(980 / Math.max(1, String(b.text || "").length * 0.62))), gy = b.textY, gFront = false;
      if (gy === undefined) { const sp = face ? placer.span(t0, t1) : null; gy = sp && sp.seen ? Math.round(Math.max(placer.safeTop, sp.top - gsz - 30)) : 300; }
      if (b.text) { const g = gateBehind(b.text, gsz, gy, t0, t1, 0.62, `ground word "${b.text}" at ${b.at}`); gy = g.y; gsz = g.size; gFront = g.front; }
      const txt = b.text ? `<div id="${id}-t" class="ground-t" style="position:absolute;left:0;right:0;text-align:center;font-weight:900;line-height:.9;letter-spacing:-0.04em;font-family:${brand.displayFont ? `'${brand.displayFont}', ` : ""}Inter, system-ui, sans-serif;top:${gy + 230}px;font-size:${gsz}px;color:${b.textColor ?? "#fff"}${gFront ? ";text-shadow:0 6px 28px rgba(0,0,0,.4)" : ""}">${esc(b.text)}</div>` : "";
      // b.lead (opt-in): a small serif line under the word carrying the words spoken while the page is up, so speech under a poster is never
      // uncaptioned. leadY = its top (page px), else under the word
      const leadHtml = b.lead ? `<div id="${id}-ld" style="position:absolute;left:60px;right:60px;text-align:center;font-family:'Instrument Serif',Georgia,serif;font-size:${b.leadSize ?? 66}px;line-height:1.05;color:${b.leadColor ?? b.textColor ?? "#fff"};top:${(b.leadY ?? (gy + Math.round(gsz * 0.95))) + 230}px">${esc(b.lead)}</div>` : "";
      behindHtml.push(`<div id="${id}" class="clip ground" data-start="${t0}" data-duration="${dur}" data-track-index="1" style="position:absolute;inset:-12%;pointer-events:none;background:${base}${b.backdrop ? `;backdrop-filter:${b.backdrop};-webkit-backdrop-filter:${b.backdrop}` : ""}"><div class="ground-g" style="position:absolute;inset:0;${grid}${b.grain === false ? "" : "box-shadow: inset 0 0 220px rgba(0,0,0,.18);"}"></div>${gFront ? "" : txt}${leadHtml}</div>`);
      // the word in front of the speaker: same frame (inset -12%) and timing, drawn above the matte
      if (gFront) frontHtml.push(`<div id="${id}-f" class="clip" data-start="${t0}" data-duration="${dur}" data-track-index="3" style="position:absolute;inset:-12%;pointer-events:none">${txt}</div>`);
      // a cut is a set: a 0.01 s tween from 0 left the page's first frame empty (raw room on frame 0 of a reel). A ground from frame 0
      // gets only the "show" set: two sets at the same time 0 (hide, then show) left it hidden for its whole span when the renderer
      // seeks frames (the room showed through for the first ground page)
      if (b.in === "fade") tl.push(`ft("#${id}", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 }, ${t0});`);
      else tl.push(t0 > 0.001 ? `tl.set("#${id}", { autoAlpha: 0 }, 0); tl.set("#${id}", { autoAlpha: 1 }, ${t0});` : `tl.set("#${id}", { autoAlpha: 1 }, 0);`);
      // captions switch to dark ink while a light page is up (paper/white/cream, or b.ink), and back after
      const ink = b.ink ?? (["grid", "cream", "white"].includes(b.paper) ? "#111" : null);
      if (ink) { tl.push(`tl.set(".cw, .cap-group, .cap-group .w, .ew:not(.eser):not(.ealarm)", { color: "${ink}", textShadow: "none" }, ${t0});`); tl.push(`tl.set(".cw, .cap-group, .cap-group .w, .ew:not(.eser):not(.ealarm)", { clearProps: "color,textShadow" }, ${t1});`); }
      if (b.text) tl.push(`ft("#${id}-t", { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: "expo.out" }, ${r3(t0 + 0.05)});`);
      // b.hideCaptions (opt-in): the page's one huge word IS the caption (a caption over it doubled the word)
      if (b.hideCaptions) hiddenCaps.push([t0, r3(t1 + 0.06)]);
      beatSfx(b, t0, "whoosh", "ground page");
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
    // ---- effect (opt-in beat; Explainer hook title, hand port of phantasic engine/core + mini2-explainer b.fit) ----
    // small spaced caps / ONE boxed word / small spaced caps ("THE / HALO / EFFECT"), each line landing as it is spoken, top third
    // over the footage. b.fit: the boxed word shrinks to fit 1080 px. CSS: EXPLAINER_CSS, written only when an effect beat exists.
    case "effect": {
      const ls = (b.lines || []).map((l, i) => {
        const at = r3(Math.max(t0, l.at != null ? E(l.at, "effect line") : t0 + i * 0.2));
        tl.push(`ft("#${id}-l${i}", { autoAlpha: 0, y: 14, filter: "blur(6px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.16, ease: "power3.out" }, ${at});`);
        if (l.box) tl.push(`ft("#${id}-b${i}", { scaleX: 0 }, { scaleX: 1, duration: 0.22, ease: "power3.out" }, ${at});`);
        return l.box ? `<div id="${id}-l${i}" class="ef-box"><i id="${id}-b${i}" style="background:${b.color ?? brand.accent}"></i><span${b.fit ? ` style="font-size:${Math.min(128, Math.floor(900 / (0.9 * Math.max(1, l.text.length))))}px"` : ""}>${esc(l.text.toUpperCase())}</span></div>`
          : `<div id="${id}-l${i}" class="ef-sm">${esc(l.text.toUpperCase())}</div>`;
      }).join("");
      inner = `<div id="${id}-in" class="ov ef" style="top:${b.y ?? 240}px">${ls}</div>`;
      tl.push(`tl.to("#${id}-in", { autoAlpha: 0, duration: 0.15 }, ${r3(t1 - 0.15)});`);
      beatSfx(b, t0, "whoosh", "effect title", { db: -8 });
      break;
    }
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
      // opt-in (popcard.object / objectFilter / glow / stage / outFade / dim, hand port of Ahmed's build.mjs): object mode shows a cut-out PNG with no photo frame, stage is a page behind the card, outFade lets the card leave before the focus returns
      const obj = b.object ?? spec.popcard?.object;
      const objFx = obj ? `;border:none;border-radius:0;box-shadow:none;filter:${spec.popcard?.objectFilter ?? "grayscale(1) brightness(1.15)"} drop-shadow(0 0 28px ${spec.popcard?.glow ?? brand.accent}) drop-shadow(0 18px 40px rgba(0,0,0,.6))` : "";
      const face = b.ui ? uiCard(b.ui, `${id}u`, t0, t1, motionCtx).html : `<img id="${id}-img" class="popcard-img" src="${img}" style="max-width:${w}px;max-height:${h}px${objFx}" />`;
      const stage = b.stage ?? spec.popcard?.stage;
      inner = `${stage ? `<div id="${id}-stg" style="position:absolute;inset:0;background:${stage}"></div>` : ""}<div id="${id}-in" class="ov popcard" style="top:${y}px">${face}${b.label ? `<div id="${id}-lab" class="popcard-lab" style="background:${brand.accent};font-size:${b.labelSize ?? 64}px">${esc(b.label)}</div>` : ""}</div>`;
      tl.push(`ft("#${id}-in", { xPercent: -50, autoAlpha: 0, rotationY: ${b.tilt ?? 70}, rotationX: -12, scale: 0.72, filter: "blur(14px)" }, { xPercent: -50, autoAlpha: 1, rotationY: 0, rotationX: 0, scale: 1, filter: "blur(0px)", duration: 0.45, ease: "expo.out" }, ${t0});`);
      tl.push(`tl.to("#${id}-in", { y: -14, duration: ${r3(Math.max(0.3, t1 - t0 - 0.3))}, ease: "sine.inOut" }, ${r3(t0 + 0.3)});`);
      if (b.label) tl.push(`ft("#${id}-lab", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.24, ease: "power3.out" }, ${r3(t0 + 0.18)});`);
      const outFade = b.outFade ?? spec.popcard?.outFade;
      if (outFade) tl.push(`tl.to("#${id}-in", { autoAlpha: 0, scale: 0.94, duration: ${outFade}, ease: "power2.in" }, ${r3(t1 - outFade - 0.12)});`);
      if (b.defocus !== false) {
        tl.push(`tl.to("#fx", { filter: "blur(${b.blur ?? 9}px) brightness(${b.dim ?? spec.popcard?.dim ?? 0.72})", duration: 0.25, ease: "power2.out" }, ${t0});`);
        tl.push(`tl.to("#fx", { filter: "blur(0px) brightness(1)", duration: ${outFade ? 0.14 : 0.26}, ease: "power2.out" }, ${r3(outFade ? t1 - 0.14 : t1 - 0.3)});`);
        fxHolds.push({ a: t0, aEnd: r3(t0 + 0.25), b: r3(outFade ? t1 - 0.14 : t1 - 0.3), ret: outFade ? 0.14 : 0.26, blur: b.blur ?? 9, dim: b.dim ?? spec.popcard?.dim ?? 0.72 });
      }
      hiddenCaps.push([t0, t1]);
      beatSfx(b, t0, "pop-whoosh-light", "pop card", { db: -4 });
      break;
    }
    // ---- R1 B1 port of phantasic engine/core (origin/main): opt-in beat types of Ahmed's library bundle -----------------------------
    // uicard / photostack / headpage / cover / whiteflash (UI Story Ad #10), starflash (Iman Gadzhi shorts transition), boxline / like
    // (Podcast), label / pin (Breakdown). Additive: no existing case is touched. Page CSS: LIBRARY_CSS, written only when such a beat exists.
    case "pills": {
      // UI Story Ad #10 (afterpranav, opt-in beat): a checklist of white pills, each with a green slanted tab holding
      // a white glyph, dropping in one by one over the footage as each item is said; the stack blurs out at `to`.
      // {at, to, y, w, items: [{text, glyph, at}]}; style "pills": {w, h, gap, tab, color, size, y}
      const P = spec.pills || {};
      const W = b.w ?? P.w ?? 672, H = P.h ?? 104, gap = P.gap ?? 62, tab = P.tab ?? 150, green = P.color ?? "#1FC24A";
      const y0 = b.y ?? P.y ?? 900;
      const items = b.items.map((it, i) => {
        const at = r3(Math.max(t0, it.at != null ? E(it.at, "pill") : t0 + i * 0.4));
        tl.push(`ft("#${id}-p${i}", { autoAlpha: 0, x: -70, scale: 0.92, filter: "blur(8px)" }, { autoAlpha: 1, x: 0, scale: 1, filter: "blur(0px)", duration: 0.3, ease: "back.out(1.7)" }, ${at});`);
        tl.push(`ft("#${id}-t${i}", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.32, ease: "power2.out" }, ${r3(at + 0.12)});`);
        beatSfx(it, at, P.sfx ?? "pop", "pill", { db: P.sfxDb ?? -6 });
        const g = UI_GLYPHS[it.glyph ?? "check"] ?? UI_GLYPHS.check;
        return `<div id="${id}-p${i}" style="position:absolute;left:0;top:${i * (H + gap)}px;width:${W}px;height:${H}px;border-radius:${Math.round(H * 0.26)}px;background:#fff;box-shadow:0 12px 34px rgba(0,0,0,.38);overflow:hidden">`
          + `<div style="position:absolute;left:0;top:0;bottom:0;width:${tab}px;background:${green};clip-path:polygon(0 0,100% 0,74% 100%,0 100%)"></div>`
          + `<svg viewBox="0 0 24 24" style="position:absolute;left:${Math.round(tab * 0.2)}px;top:${Math.round(H * 0.24)}px;width:${Math.round(H * 0.52)}px;height:${Math.round(H * 0.52)}px">${g}</svg>`
          + `<div id="${id}-t${i}" style="position:absolute;left:${tab}px;right:20px;top:0;bottom:0;display:flex;align-items:center;justify-content:center;font:600 ${P.size ?? 38}px/1 Inter, system-ui, sans-serif;color:#141414;letter-spacing:-0.025em;white-space:nowrap">${esc(it.text)}</div></div>`;
      });
      inner = `<div id="${id}-in" class="ov" style="position:absolute;left:${Math.round(540 - W / 2)}px;top:${y0}px;width:${W}px;height:${b.items.length * (H + gap)}px">${items.join("")}</div>`;
      tl.push(`tl.to("#${id}-in", { autoAlpha: 0, scale: 1.05, filter: "blur(18px)", duration: 0.3, ease: "power2.in" }, ${r3(t1 - 0.3)});`);
      if (b.hideCaptions !== false) hiddenCaps.push([t0, t1]);
      break;
    }
    case "uicard": {
      // UI Story Ad #10 (opt-in beat): a white rounded card holding a picture (a map, a screen) pops up over the lower
      // half while the speaker keeps talking; optional yellow pins drop on cue. {at, to, src|art, y, w, h, pad, fit, pins: [{x, y, at}] (% of the card)}
      const img = b.art ? artAsset(b.art) : userAsset(b.src);
      const W = b.w ?? 840, H = b.h ?? 480, y = b.y ?? 1060, pad = b.pad ?? 30;
      const pins = (b.pins || []).map((pn, k) => {
        const at = r3(Math.max(t0, pn.at != null ? E(pn.at, "pin") : t0 + 0.4 + k * 0.15));
        tl.push(`ft("#${id}-pn${k}", { autoAlpha: 0, y: -40, scale: 0.4 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: "back.out(2.6)" }, ${at});`);
        return `<svg id="${id}-pn${k}" viewBox="0 0 24 32" style="position:absolute;left:calc(${pn.x}% - 22px);top:calc(${pn.y}% - 58px);width:44px;height:58px;filter:drop-shadow(0 4px 6px rgba(0,0,0,.35))"><path d="M12 0C5.4 0 0 5.2 0 11.7 0 20.5 12 32 12 32s12-11.5 12-20.3C24 5.2 18.6 0 12 0z" fill="${pn.color ?? "#F5D90A"}"/><circle cx="12" cy="11.5" r="4.6" fill="#fff"/></svg>`;
      }).join("");
      uiRects.push({ t0, t1, y0: y, y1: y + H });   // podcast captions step above the card
      inner = `<div id="${id}-in" class="ov" style="position:absolute;left:${Math.round(540 - W / 2)}px;top:${y}px;width:${W}px;height:${H}px;border-radius:${b.radius ?? 58}px;background:#fff;box-shadow:0 26px 64px rgba(0,0,0,.5);overflow:hidden"><img src="${img}" style="position:absolute;left:${pad}px;top:${pad}px;width:${W - 2 * pad}px;height:${H - 2 * pad}px;object-fit:${b.fit ?? "contain"}"/>${pins}</div>`;
      tl.push(`ft("#${id}-in", { autoAlpha: 0, scale: 0.6, y: 80, filter: "blur(10px)" }, { autoAlpha: 1, scale: 1, y: 0, filter: "blur(0px)", duration: 0.36, ease: "back.out(1.6)" }, ${t0});`);
      tl.push(`tl.to("#${id}-in", { autoAlpha: 0, scale: 0.86, filter: "blur(8px)", duration: 0.2, ease: "power2.in" }, ${r3(t1 - 0.2)});`);
      beatSfx(b, t0, "pop-whoosh-light", "ui card", { db: -5 });
      break;
    }
    case "photostack": {
      // UI Story Ad #10 (opt-in beat): a white page where a grey rounded frame (slightly tilted back) holds a photo
      // with a dark label pill on its lower edge, over a soft blue disc that pulses on each swap; photos and labels
      // change on cue. {at, to, items: [{src|art, label, at}], disc}
      const fw = b.w ?? 700, fh = b.h ?? 600, cy0 = b.y ?? 960;
      const pics = b.items.map((it, k) => {
        const at = r3(Math.max(t0, it.at != null ? E(it.at, "photostack item") : t0 + k * 1.2));
        const src = it.art ? artAsset(it.art) : userAsset(it.src);
        if (k > 0) {
          tl.push(`ft("#${id}-ph${k}", { autoAlpha: 0, scale: 1.08 }, { autoAlpha: 1, scale: 1, duration: 0.22, ease: "power2.out" }, ${at});`);
          tl.push(`ft("#${id}-lb${k}", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01 }, ${at});`);
          tl.push(`tl.set("#${id}-lb${k - 1}", { autoAlpha: 0 }, ${at});`);
          tl.push(`ft("#${id}-fr", { scale: 0.94 }, { scale: 1, duration: 0.3, ease: "back.out(2.4)" }, ${at});`);
          beatSfx(it, at, "pop", "photostack swap", { db: -8 });
        }
        tl.push(`ft("#${id}-dk", { autoAlpha: 0, scale: 0.7 }, { autoAlpha: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, ${at});`);
        tl.push(`tl.to("#${id}-dk", { autoAlpha: 0, scale: 0.85, duration: 0.35, ease: "power2.in" }, ${r3(at + 0.55)});`);
        tl.push(`ft("#${id}-lt${k}", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.35, ease: "power2.out" }, ${r3(at + 0.08)});`);
        return [`<img id="${id}-ph${k}" src="${src}" style="position:absolute;left:24px;top:24px;width:${fw - 48}px;height:${fh - 150}px;object-fit:cover;border-radius:40px${k ? ";opacity:0" : ""}"/>`,
          `<div id="${id}-lb${k}" style="position:absolute;left:44px;right:44px;bottom:30px;height:78px;border-radius:40px;background:#17171a;display:flex;align-items:center;justify-content:center${k ? ";opacity:0" : ""}"><span id="${id}-lt${k}" style="font:600 32px/1 Inter, system-ui, sans-serif;color:#fff;letter-spacing:-0.02em;white-space:nowrap">${esc(it.label ?? "")}</span></div>`];
      });
      inner = `<div id="${id}-in" style="position:absolute;inset:0;background:#fff">`
        + `<div id="${id}-dk" style="position:absolute;left:${540 - fw * 0.58}px;top:${cy0 - fw * 0.42}px;width:${fw * 1.16}px;height:${fw * 0.84 + fh * 0.4}px;border-radius:50%;background:radial-gradient(ellipse at 50% 55%, ${b.disc ?? "#2F6BFF"} 0 62%, rgba(47,107,255,0) 72%)"></div>`
        + `<div style="position:absolute;inset:0;perspective:1400px"><div id="${id}-fr" style="position:absolute;left:${540 - fw / 2}px;top:${cy0 - fh / 2}px;width:${fw}px;height:${fh}px;border-radius:64px;background:#E8E8EB;box-shadow:0 30px 60px rgba(0,0,0,.18);transform:rotateX(9deg);overflow:hidden">${pics.map((x) => x[0]).join("")}${pics.map((x) => x[1]).join("")}</div></div></div>`;
      // the frame is on the page from its first frame (a fade-in left one empty white frame) and springs up into place
      tl.push(`ft("#${id}-fr", { autoAlpha: 1, scale: 0.82, y: 50 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.32, ease: "back.out(1.8)" }, ${t0});`);
      hiddenCaps.push([t0, r3(t1 + 0.06)]);   // the captions come back after the page, not over its last frames
      beatSfx(b, t0, "pop-whoosh-light", "photostack", { db: -5 });
      break;
    }
    case "headpage": {
      // UI Story Ad #10 (opt-in beat): the white opening page. The spoken words type on at the top in small dark
      // sans, a picture sits in a soft green glow in the middle (a map, an object) with an optional red pin, and
      // round avatars with a blue star badge pop in around it. {at, to, src|art, glow, pin, avatars: [{src, at}]}
      const hw = words.filter((w) => w.start >= t0 - 0.02 && w.start < t1);
      const head = hw.map((w, k) => {
        tl.push(`ft("#${id}-w${k}", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.05 }, ${r3(Math.max(t0, w.start - 0.02))});`);
        return `<span id="${id}-w${k}" style="opacity:0">${esc(w.word)} </span>`;
      }).join("");
      const img = b.src || b.art ? (b.art ? artAsset(b.art) : userAsset(b.src)) : null;
      const ring = [[-330, -250], [330, -250], [-360, 190], [360, 190], [0, 330], [-170, -360], [170, -360]];
      const av = (b.avatars || []).map((a, k) => {
        const at = r3(Math.max(t0, a.at != null ? E(a.at, "avatar") : t0 + 0.5 + k * 0.25));
        const [dx, dy] = a.pos ?? ring[k % ring.length];
        tl.push(`ft("#${id}-a${k}", { autoAlpha: 0, scale: 0.3 }, { autoAlpha: 1, scale: 1, duration: 0.3, ease: "back.out(2.6)" }, ${at});`);
        beatSfx(a, at, "pop", "avatar", { db: -10 });
        return `<div id="${id}-a${k}" style="position:absolute;left:${540 + dx - 78}px;top:${(b.y ?? 900) + dy - 78}px;width:156px;height:156px"><img src="${userAsset(a.src)}" style="width:156px;height:156px;border-radius:50%;object-fit:cover;border:6px solid #fff;box-shadow:0 8px 22px rgba(0,0,0,.25)"/><svg viewBox="0 0 24 24" style="position:absolute;left:58px;bottom:-16px;width:40px;height:40px"><circle cx="12" cy="12" r="11" fill="#2F6BFF" stroke="#fff" stroke-width="2"/><path d="M12 6.2l1.7 3.6 3.9.5-2.9 2.7.8 3.9L12 15l-3.5 1.9.8-3.9-2.9-2.7 3.9-.5z" fill="#fff"/></svg></div>`;
      }).join("");
      const cy = b.y ?? 900;
      inner = `<div id="${id}-in" style="position:absolute;inset:0;background:#fff">`
        + `<div style="position:absolute;left:150px;right:150px;top:${b.textY ?? 360}px;text-align:center;font:600 ${b.textSize ?? 44}px/1.18 Inter, system-ui, sans-serif;color:#141414;letter-spacing:-0.03em">${head}</div>`
        + `<div id="${id}-gl" style="position:absolute;left:${540 - 400}px;top:${cy - 270}px;width:800px;height:540px;border-radius:50%;background:radial-gradient(ellipse, ${b.glow ?? "#3CF06A"} 0 58%, rgba(60,240,106,0) 71%)"></div>`
        + (img ? `<img id="${id}-im" src="${img}" style="position:absolute;left:${540 - (b.imgW ?? 520) / 2}px;top:${cy - (b.imgH ?? 420) / 2}px;width:${b.imgW ?? 520}px;height:${b.imgH ?? 420}px;object-fit:contain${b.imgBlend === false ? "" : ";mix-blend-mode:multiply"}"/>` : "")
        + (b.pin ? `<svg id="${id}-pin" viewBox="0 0 24 32" style="position:absolute;left:${518}px;top:${cy - 90}px;width:44px;height:58px;filter:drop-shadow(0 4px 5px rgba(0,0,0,.35))"><path d="M12 0C5.4 0 0 5.2 0 11.7 0 20.5 12 32 12 32s12-11.5 12-20.3C24 5.2 18.6 0 12 0z" fill="#E5242B"/><circle cx="12" cy="11.5" r="4.6" fill="#fff"/></svg>` : "")
        + av + `</div>`;
      tl.push(`ft("#${id}-gl", { scale: 0.6, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.4, ease: "back.out(1.6)" }, ${t0});`);
      tl.push(`tl.to("#${id}-gl", { keyframes: [{ scale: 1.06, opacity: 0.75, duration: 0.8, ease: "sine.inOut" }, { scale: 1, opacity: 1, duration: 0.8, ease: "sine.inOut" }], repeat: ${Math.max(0, Math.floor((t1 - t0 - 0.4) / 1.6) - 1)} }, ${r3(t0 + 0.4)});`);
      if (b.pin) tl.push(`ft("#${id}-pin", { autoAlpha: 0, y: -50 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: "bounce.out" }, ${r3(t0 + 0.3)});`);
      hiddenCaps.push([t0, r3(t1 + 0.06)]);
      break;
    }
    case "cover": {
      // opt-in content beat: hides something burned into the SOURCE (a lower-third, a subtitle) under a soft band in
      // the colour of what is around it. {at, to, y0, y1, color, feather (px), opacity}
      const y0 = b.y0 ?? 1450, y1 = b.y1 ?? 1920, f = b.feather ?? 120, col = b.color ?? "#0b0b0d";
      inner = `<div id="${id}-in" style="position:absolute;left:0;right:0;top:${y0 - f}px;height:${y1 - y0 + f}px;opacity:${b.opacity ?? 0.96};background:linear-gradient(180deg, transparent 0, ${col} ${f}px, ${col} 100%)"></div>`;
      tl.push(`ft("#${id}-in", { autoAlpha: 0 }, { autoAlpha: ${b.opacity ?? 0.96}, duration: 0.01 }, ${t0});`);
      break;
    }
    case "whiteflash": {
      // UI Story Ad #10 (opt-in beat): a quick white wash over the footage (the ref's cut between two ideas)
      inner = `<div id="${id}-in" style="position:absolute;inset:0;background:${b.color ?? "#fff"}"></div>`;
      tl.push(`ft("#${id}-in", { autoAlpha: 0 }, { autoAlpha: ${b.peak ?? 0.82}, duration: ${b.rise ?? 0.12}, ease: "power2.in" }, ${t0});`);
      tl.push(`tl.to("#${id}-in", { autoAlpha: 0, duration: ${r3(Math.max(0.1, t1 - t0 - (b.rise ?? 0.12)))}, ease: "power2.out" }, ${r3(t0 + (b.rise ?? 0.12))});`);
      beatSfx(b, t0, "whoosh", "white flash", { db: -8 });
      break;
    }
    case "starflash": {
      // a white four-point star bursts from the centre and floods the frame, then clears (the Iman Gadzhi shorts
      // transition). With `field: [c1, c2]` the flash cuts to a colour field where the star settles as a mark and
      // optional `text` lands. {at, to, color, y (% of height), field, text, textColor, textSize, textY}
      const col = b.color ?? "#FFFFFF";
      const star = `<svg id="${id}-s" viewBox="-50 -50 100 100" style="position:absolute;left:50%;top:${b.y ?? 50}%;width:600px;height:600px;margin:-300px 0 0 -300px;filter:drop-shadow(0 0 24px ${col}) drop-shadow(0 0 60px ${col})"><path d="M0,-50 C4,-8 8,-4 50,0 C8,4 4,8 0,50 C-4,8 -8,4 -50,0 C-8,-4 -4,-8 0,-50Z" fill="${col}"/></svg>`;
      const field = b.field ? `<div id="${id}-f" style="position:absolute;inset:0;background:linear-gradient(180deg, ${b.field[0]} 0%, ${b.field[1] ?? b.field[0]} 100%)"></div>` : "";
      const txt = b.text ? `<div id="${id}-t" style="position:absolute;left:0;right:0;top:${b.textY ?? 1150}px;text-align:center;font:900 ${b.textSize ?? 110}px/1 Inter, system-ui, sans-serif;letter-spacing:-0.03em;color:${b.textColor ?? "#fff"};text-shadow:0 0 30px rgba(255,255,255,.5)">${esc(b.text)}</div>` : "";
      if (field) hiddenCaps.push([r3(t0 + 0.28), t1]);   // the brand card is clean: captions hide under it
      inner = `${field}<div id="${id}-w" style="position:absolute;inset:0;background:${col}"></div>${star}${txt}`;
      if (field) tl.push(`ft("#${id}-f", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01 }, ${r3(t0 + 0.3)});`);
      tl.push(`ft("#${id}-s", { scale: 0.05, rotation: -40, autoAlpha: 1 }, { scale: 1.6, rotation: 0, duration: 0.32, ease: "expo.out" }, ${t0});`);
      tl.push(`ft("#${id}-w", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12, ease: "power2.in" }, ${r3(t0 + 0.18)});`);
      tl.push(`tl.to("#${id}-w", { autoAlpha: 0, duration: 0.3, ease: "power2.out" }, ${r3(t0 + 0.32)});`);
      tl.push(`tl.to("#${id}-s", { scale: ${field ? 0.9 : 3.2}, autoAlpha: ${field ? 1 : 0}, duration: 0.45, ease: "power2.out" }, ${r3(t0 + 0.32)});`);
      if (txt) tl.push(`ft("#${id}-t", { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: "expo.out" }, ${r3(t0 + 0.4)});`);
      beatSfx(b, t0, "whoosh", "star flash", { db: -6 });
      break;
    }
    case "boxline": {
      // Podcast: a white box with black heavy caps (the hook question, a pull quote in quotes). It slaps in slightly
      // tilted; an optional label (a name / title) sits off its corner with a hand-drawn arrow
      const txt = (b.quotes ? `‘${b.text}’` : b.text).toUpperCase();  // the speaker's words, no added punctuation
      const x = b.x ?? 70, w = b.w ?? 640;
      let y = b.y ?? 1120, nowrap = !!(spec.boxline?.dodgeFace || spec.boxline?.fitLabel), labLeft = x + w - 180, labDy = b.labelDy ?? 150, hideCap = b.hideCaptions !== false;
      // spec.boxline.dodgeFace (opt-in, The Podcast): the box (and its name label) never covers the face, measured on
      // screen over the box's whole life (punch-ins included): its own y if clear, else under the chin, else above the
      // head, else as low as the safe area allows. b.prefer "above" tries above the head first (a title over a
      // talking clip). The label sits under the box's real height and is kept inside the frame (fitLabel).
      if (spec.boxline?.dodgeFace || spec.boxline?.fitLabel) {
        const sz = b.size ?? 54, inner = w - 52, words_ = txt.split(/\s+/);
        let lines = 1, cur = 0;
        for (const wd of words_) { const ww = wd.length * sz * 0.68, sp = sz * 0.28; if (cur && cur + sp + ww > inner) { lines++; cur = ww; } else cur += (cur ? sp : 0) + ww; }
        const bh = Math.round(lines * sz * 1.02 + 38);
        labDy = b.labelDy ?? bh + 14;
        if (b.label) labLeft = Math.max(40, Math.min(labLeft, 1080 - 60 - Math.round(90 + 6 + String(b.label).length * 46 * 0.58)));
        const H_ = bh + (b.label ? 14 + 70 : 0);
        if (spec.boxline?.dodgeFace && face) {
          const sp = placer.span(t0, t1), lo = placer.safeTop, hi = placer.safeBottom - H_, g = 30;
          const clear = (yy) => !sp.seen || yy >= sp.bottom + g || yy + H_ <= sp.top - g;
          const below = sp.seen ? Math.max(y, sp.bottom + g) : y, above = sp.seen ? sp.top - g - H_ : y;
          const order = b.prefer === "above" ? [above, y, below] : [y, below, above];
          const pick = order.find((yy) => yy >= lo && yy <= hi && clear(yy));
          if (pick !== undefined) y = Math.round(pick);
          else { y = Math.round(Math.max(lo, hi)); if (b.prefer === "above") hideCap = true; }
          // a title above the head with captions running: the captions step around it
          // (only when it really sits above the head; anywhere lower it takes the caption band, so captions hide)
          if (!hideCap && sp.seen && y + H_ > sp.top - g) hideCap = true;
          if (!hideCap) uiRects.push({ t0, t1, y0: y, y1: y + H_ });
        }
      }
      const lab = b.label ? `<div id="${id}-lab" class="bx-lab" style="left:${labLeft}px;top:${y + labDy}px${nowrap ? ";white-space:nowrap" : ""}"><svg viewBox="0 0 80 60"><path d="M70 6 C 50 10, 20 20, 12 50" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M4 38 L12 52 L24 42" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${esc(b.label)}</span></div>` : "";
      inner = `<div id="${id}-in" class="ov bx" style="left:${x}px;top:${y}px;width:${w}px;font-size:${b.size ?? 54}px;transform:rotate(${b.tilt ?? -1.5}deg)">${esc(txt)}</div>${lab}`;
      tl.push(`ft("#${id}-in", { autoAlpha: 0, scale: 1.25, rotation: ${(b.tilt ?? -1.5) - 6} }, { autoAlpha: 1, scale: 1, rotation: ${b.tilt ?? -1.5}, duration: 0.18, ease: "back.out(2)" }, ${t0});`);
      if (b.label) tl.push(`ft("#${id}-lab", { autoAlpha: 0, x: 20 }, { autoAlpha: 1, x: 0, duration: 0.25, ease: "power3.out" }, ${r3(t0 + 0.2)});`);
      if (hideCap) hiddenCaps.push([t0, t1]);
      beatSfx(b, t0, "impact-1", "box line", { db: -8 });
      break;
    }
    case "like": {
      // Podcast: a Like pill pops up, a cursor glides in and clicks it (the pill flips to "Liked")
      const x = b.x ?? 470, y = b.y ?? 1500;
      inner = `<div id="${id}-in" class="ov lk" style="left:${x}px;top:${y}px"><span id="${id}-a">👍 Like</span><span id="${id}-b" style="display:none">👍 Liked</span></div><div id="${id}-cur" class="ov lk-cur" style="left:${x + 150}px;top:${y + 60}px"><svg viewBox="0 0 24 24"><path d="M5 2 L5 20 L10 15 L13 22 L16 21 L13 14 L20 14 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg></div>`;
      tl.push(`ft("#${id}-in", { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: 0.2, ease: "back.out(2.4)" }, ${t0});`);
      tl.push(`ft("#${id}-cur", { autoAlpha: 0, x: 140, y: 120 }, { autoAlpha: 1, x: 0, y: 0, duration: 0.35, ease: "power2.out" }, ${r3(t0 + 0.15)});`);
      const click = r3(t0 + 0.55);
      tl.push(`tl.to("#${id}-cur", { scale: 0.85, duration: 0.06, yoyo: true, repeat: 1 }, ${click});`);
      tl.push(`tl.to("#${id}-in", { scale: 0.92, duration: 0.06, yoyo: true, repeat: 1 }, ${click});`);
      tl.push(`tl.set("#${id}-a", { display: "none" }, ${click}); tl.set("#${id}-b", { display: "inline" }, ${click}); tl.set("#${id}-in", { backgroundColor: "#0A66C2" }, ${click});`);
      beatSfx(b, click, "click-1", "like click", { db: -2 });
      break;
    }
    case "label": {
      // Breakdown: a top label (serif italic, white on the accent box). The letters write on one by one while the
      // box grows in behind them from the right; it holds until `to`
      const chars = [...b.text];
      const step = Math.min(0.04, (b.typeFor ?? 0.35) / chars.length);
      inner = `<div id="${id}-in" class="ov lbl" style="top:${b.y ?? 300}px"><div id="${id}-box" class="lbl-box" style="background:${b.color ?? brand.accent}"></div><div class="lbl-txt">${chars.map((c, k) => `<span id="${id}-c${k}" style="display:none">${c === " " ? "&nbsp;" : esc(c)}</span>`).join("")}</div></div>`;
      chars.forEach((c, k) => tl.push(`tl.set("#${id}-c${k}", { display: "inline" }, ${r3(t0 + k * step)});`));
      tl.push(`ft("#${id}-box", { clipPath: "inset(0% 0% 0% 100%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.3, ease: "power3.out" }, ${r3(t0 + 0.05)});`);
      tl.push(`ft("#${id}-in", { xPercent: -50, autoAlpha: 1 }, { xPercent: -50, autoAlpha: 1, duration: 0.01 }, ${t0});`);
      tl.push(`tl.to("#${id}-in", { autoAlpha: 0, y: -20, duration: 0.18, ease: "power2.in" }, ${r3(t1 - 0.18)});`);
      beatSfx(b, t0, "typing-1", "label type-on", { db: -10 });
      break;
    }
    case "pin": {
      // Breakdown CTA: the keyword flickers in (on/off on alternate frames) in a red→purple→blue gradient and stays
      // pinned at the top to the end
      inner = `<div id="${id}-in" class="ov pin" style="top:${b.y ?? 260}px;font-size:${b.size ?? 170}px">${esc(b.text)}</div>`;
      for (let k = 0; k < 6; k++) tl.push(`tl.set("#${id}-in", { autoAlpha: ${k % 2 ? 0 : 1} }, ${r3(t0 + k / 30)});`);
      tl.push(`tl.set("#${id}-in", { autoAlpha: 1, xPercent: -50 }, ${r3(t0 + 6 / 30)});`);
      tl.push(`tl.set("#${id}-in", { xPercent: -50 }, 0);`);
      beatSfx(b, t0, "impact-2", "pinned CTA", { db: -6 });
      break;
    }
    case "leak": {
      // a warm light-leak flash (a real burn/leak clip, screen-blended) with a bloom on the camera: the "$80" transition
      deferredLeaks.push({ b, t0, t1 });
      fxLeaks.push({ i: tl.length, t0, t1, bloom: b.bloom ?? 1.5 });
      tl.push(`tl.to("#fx", { filter: "blur(0px) brightness(${b.bloom ?? 1.5})", duration: 0.1, ease: "power2.out" }, ${t0});`);
      tl.push(`tl.to("#fx", { filter: "blur(0px) brightness(1)", duration: 0.25, ease: "power2.in" }, ${r3(Math.max(t0 + 0.12, t1 - 0.25))});`);
      beatSfx(b, t0, "whoosh", "light leak", { db: -6 });
      break;
    }
    case "mood": {
      // a whole sentence drops to black and white (hard cut in and out, like a grade change between shots)
      // with look.target the final grade is only known later: a placeholder, filled in once the target is measured
      const g = spec.look?.target ? "__LOOK_GRADE__" : spec.look?.grade ?? "";
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

    case "motion": {
      const resolveImage = (src) => {
        if (/^assets\/[^\0]+\.(png|jpe?g|webp|gif|svg)$/i.test(src) && !src.split("/").includes("..")) {
          const full = path.resolve(proj, src);
          return full.startsWith(A + path.sep) && fs.existsSync(full) ? src : null;
        }
        return /^[a-z0-9-]{1,48}$/.test(src) && fs.existsSync(path.join(LIB, "art", `${src}.jpg`)) ? artAsset(src) : null;
      };
      const mg = compileMotion(b, { id, t0, t1, W, H, brand, resolveImage, beatId: b.id });
      for (const m of mg.warnings || []) warn.push(m);
      if (!mg.ok) {
        warn.push(`motion beat ${b.id ?? "?"} dropped: ${mg.reason}`);
        recordDrop({ kind: "motion beat", id: b.id, type: "motion", at: b.at, to: b.to, t: t0, rule: "compile", why: `The motion graphic${b.id ? ` "${b.id}"` : ""} at ${clock(t0)} was dropped because it could not be drawn (${mg.reason}).`, warning: `motion beat ${b.id ?? "?"} dropped: ${mg.reason}` });
        continue;
      }
      recordMotionParts({ id: b.id, type: "motion", at: b.at, to: b.to }, mg, t0);
      inner = mg.html;
      for (const l of mg.lines) tl.push(l);
      if (mg.hideCaptions) hiddenCaps.push([t0, t1]);
      if (mg.room === "below") roomFrameWins.push(roomFrames(t0, t1, FPS));
      beatSfx({ sfx: mg.sfx }, t0, "whoosh", "motion graphic");
      break;
    }

    case "graphic": {
      // Prompt Motion (lib/graphic-place.mjs): the pre-rendered file in a timed <video>, in its box (an insert: the
      // whole canvas, above the other beats)
      const g = b._graphic;
      inner = graphicBeatHtml(id, g, { t0, dur, esc, rel: g.file });
      for (const l of graphicBeatTweens(id, g, t0, t1)) tl.push(l);
      if (g.hideCaptions) hiddenCaps.push([r3(Math.max(0, t0 - CAP_FADE)), r3(t1 + CAP_BACK)]);   // gone from t0 to t1 (see CAP_FADE)
      if (g.mode === "overlay" && crossesUi(g.box, PLATFORMS[platform], W, H)) warn.push(`graphic ${_gl(b)}: ${graphicReason("GW7", { platform: PLATFORMS[platform].name })}`);
      beatSfx(b, t0, "none", "graphic");
      break;
    }

    default:
      die(`unknown beat type '${b.type}'`);
  }
  if (b.type === "behind" || b.type === "ground") continue;
  if (!["endcard", "scene", "motion", "headpage", "photostack", "whiteflash", "cover", "graphic"].includes(b.type) && !(b.type === "meme" && memeLib(b.id).meta.clip) && !(b.type === "popcard" && (b.outFade ?? spec.popcard?.outFade))) tl.push(exit(`#${id}-in`, t1));
  const clipMeme = b.type === "meme" && memeLib(b.id).meta.clip;
  overlays.push({ html: b.type === "graphic"
    ? `<div id="${id}" class="layer"${b._graphic.mode === "insert" ? ' style="z-index:5"' : ""}>${inner}</div>` // untimed: its <video> is the timed element
    : clipMeme
    ? `<div id="${id}" class="layer">${inner}</div>` // the <video> inside is the timed element; a timed wrapper would break it
    : `<div id="${id}" class="clip layer" data-start="${t0}" data-duration="${dur}" data-track-index="${b.type === "scene" ? 4 : inSlot ? 3 : 2}"${b.type === "endcard" && b.bg === "none" ? ' style="z-index:5"' : ""}>${inner}</div>` });   // an over-footage card sits above B-roll scenes (premium-iman 95eaa38)
}

CUR_BEAT = null;
// .look-ov marks the brand tint, grain and vignette so a flat page can switch them off while it is up. Emitted ONLY when a ground
// page (without backdrop) or look.cleanScenes asks for it, so every other reel's markup is unchanged.
const groundFlat = groundWins.filter(([, , g]) => !g.backdrop && g.tint !== true);
const LOOK_OV = groundFlat.length > 0 || !!spec.look?.cleanScenes;
const OV = LOOK_OV ? " look-ov" : "";
// a layer never straddles a section boundary (lib/sections.mjs): its span counts like a beat's
for (const l of LAYERS) beatSpans.push({ t0: l.t0, t1: l.t1 });
// a leak bloom inside a popcard hold blooms the defocused camera and settles back on the defocus, not on sharp (fxAim); a leak
// outside every hold keeps its exact tweens, so a reel without that overlap builds byte-identically. L.i is the bloom's index in
// tl, pushed in the leak case above (the return is L.i + 1); nothing between there and here removes or reorders tl lines.
for (const L of fxLeaks) {
  const back = r3(Math.max(L.t0 + 0.12, L.t1 - 0.25)), hb = fxAim(L.t0, 0.1), hr = fxAim(back, 0.25);
  if (hb) tl[L.i] = `tl.to("#fx", { filter: "${fxRest(hb, L.bloom)}", duration: 0.1, ease: "power2.out" }, ${L.t0});`;
  if (hr) tl[L.i + 1] = `tl.to("#fx", { filter: "${fxRest(hr)}", duration: 0.25, ease: "power2.in" }, ${back});`;
}

// ---------- making room: shrink the whole footage stack under a `room:"below"` motion beat ----------
// Windows merge (overlap -> one shrink); #room wraps #pip and scales about the canvas top centre, OUTSIDE the
// camera, so a face point maps as room(camera(p)). The uncovered canvas shows the style's ink colour via #roomfill.
// Captions hide over each merged [tA, tB]. Nothing is emitted when there is no such beat (byte-identical builds).
const roomWins = roomWindows(roomFrameWins, FPS);
for (const w of roomWins) {
  // the card (rounded corners + shadow) rides the same tween, so it shares the scale's duration and ease
  const cardOff = JSON.stringify(roomCardCss(0, W, H)).slice(1, -1), cardOn = JSON.stringify(roomCardCss(1, W, H)).slice(1, -1);
  tl.push(`ft("#room", { scale: 1, ${cardOff} }, { scale: ${ROOM_SCALE}, ${cardOn}, force3D: false, duration: ${r3(w.easeIn[1] - w.easeIn[0])}, ease: "${ROOM_EASE_NAME}" }, ${r3(w.easeIn[0])});`);
  tl.push(`ft("#room", { scale: ${ROOM_SCALE}, ${cardOn} }, { scale: 1, ${cardOff}, force3D: false, duration: ${r3(w.easeOut[1] - w.easeOut[0])}, ease: "${ROOM_EASE_NAME}" }, ${r3(w.easeOut[0])});`);
  tl.push(`ft("#roomfill", { opacity: 0 }, { opacity: 1, duration: 0.01, ease: "none" }, ${r3(w.tA)});`);
  tl.push(`ft("#roomfill", { opacity: 1 }, { opacity: 0, duration: 0.01, ease: "none" }, ${r3(w.tB)});`);
  hiddenCaps.push([w.tA, w.tB]);
}

for (const s of Array.isArray(spec.sfx) ? spec.sfx : []) addSfx(E(s.at, "sfx"), s.id, "manual", { db: s.db ?? 0, lead: s.lead ?? 0 });

// library/sfx/timing.json (from scripts/sfx_index.py): per sound its length and the time of its peak. Absent = every sound
// peaks at its start, which only costs placement accuracy.
const sfxTiming = (() => { try { return JSON.parse(fs.readFileSync(path.join(LIB, "sfx", "timing.json"), "utf8")); } catch { return {}; } })();
if (dropWin) {
  // drop.riser / boom / tail / cutSfx: an id, or a list of ids where the first one on disk plays (none: the first is reported as skipped)
  const DR = { ...motionCtx.dropPlan }, timing = sfxTiming;
  for (const k of ["riser", "boom", "tail", "cutSfx"]) if (Array.isArray(DR[k])) DR[k] = DR[k].find(sfxOk_) ?? DR[k][0];
  const [T0, T1] = dropWin, gapS = DR.gap / FPS;
  const n0 = sfxEvents.length;
  if (DR.riser) {
    const tm = timing[DR.riser] || { peak_t: 1 };
    const s0 = r3(T0 - gapS - tm.peak_t);
    const nr = sfxEvents.length;
    if (s0 >= 0) { addSfx(s0, DR.riser, "drop riser (tops out before the gap)", { db: DR.riserDb ?? 2 }); if (sfxEvents.length > nr) { const e = sfxEvents.at(-1); e.dur = r3(T0 - gapS - s0); e.fade = 0.03; } }
  }
  addSfx(T0, DR.boom, "drop boom", { db: DR.boomDb ?? 0 });
  if (DR.tail) addSfx(r3(T0 + 0.02), DR.tail, "drop tail", { db: DR.tailDb ?? -2 });
  // the cut ladder: a flash + a quiet flash sound on every Nth cut
  const cuts = beatsList.filter((b) => b._drop).map((b) => E(b.at)).slice(1);
  let flashHtml = "";
  cuts.forEach((t, i) => {
    if (!DR.flashEvery || (i + 1) % DR.flashEvery) return;
    flashHtml += `<div id="dropflash-${i}" class="clip" data-start="${t}" data-duration="${r3(3 / FPS)}" data-track-index="6" style="position:absolute;inset:0;z-index:7;background:#fff;opacity:0;pointer-events:none"></div>`;
    tl.push(`tl.fromTo("#dropflash-${i}", { opacity: ${DR.flash} }, { opacity: 0, duration: ${r3(3 / FPS)}, ease: "power1.in", immediateRender: false }, ${t});`);
    if (DR.cutSfx) addSfx(t, DR.cutSfx, "drop flash cut", { db: DR.cutDb ?? -2 });
  });
  // the gap: nothing plays in the last frames before the boom (voice included: the drop sits in a pause / hold)
  for (const e of sfxEvents) if (e.t < T0 - gapS && e.t + e.dur > T0 - gapS && !e.fade) { e.dur = r3(T0 - gapS - e.t); e.fade = 0.03; }
  // loudness lift: everything in the SFX bus inside the drop comes up DR.lift dB (master.py brings the whole mix back to target)
  for (const e of sfxEvents.slice(n0)) if (e.t >= T0 - 0.01 && e.t < T1) e.vol = r3(Math.min(1, e.vol * Math.pow(10, DR.lift / 20)));
  if (talkInGap(T0 - gapS, T0)) warn.push(`drop at ${T0}s: speech inside the ${DR.gap}-frame silence before the boom; move drop.at into a pause`);
  dropFlashHtml = flashHtml;
}

// ---------- SFX design pass (premium kit, opt-in: sfxDesign {density}, or sfx: {density} as an object) ----------
const SFX_DESIGN = spec.sfxDesign ?? (spec.sfx && !Array.isArray(spec.sfx) ? spec.sfx : null);
if (SFX_DESIGN) {
  if (!["low", "med", "high"].includes(SFX_DESIGN.density ?? "med")) die(`sfxDesign.density must be low, med or high (got ${SFX_DESIGN.density})`);
  const tryT = (t) => { try { return E(t); } catch { return null; } };
  const sceneBeats = beatsList.filter((b) => b.type === "scene");
  // scene.cutSfx (opt-in): a burst member (rapid swap) gets its own small sound instead of the major-cut chain
  const brollIn = sceneBeats.filter((b) => ["image", "window"].includes(b.kind) && !b._drop && !b.cutSfx).map((b) => tryT(b.at)).filter((t) => t != null);
  for (const b of sceneBeats.filter((x) => x.cutSfx)) { const t = tryT(b.at); if (t != null) addSfx(Math.max(0, t - 0.01), b.cutSfx, "burst cut", { db: b.cutDb ?? -6 }); }
  const majors = [...brollIn, ...rampsAt.filter((r) => !r.scene).map((r) => r.t0)];
  const inDrop = (t) => dropWin && t >= dropWin[0] - 0.05 && t < dropWin[1];
  const sceneTrans = sceneBeats.filter((b) => ["whip", "zoom"].includes(b.in ?? spec.sceneIn)).map((b) => ({ t: tryT(b.at), kind: b.in ?? spec.sceneIn })).filter((x) => x.t != null);
  const textIns = [
    ...beatsList.filter((b) => !["scene", "leak", "mood", "ground", "behind", "meme", "emoji", "logo", "icon", "nametag"].includes(b.type)).map((b) => ({ t: tryT(b.at), why: b.type })),
    ...sceneBeats.filter((b) => !["image", "window"].includes(b.kind)).map((b) => ({ t: tryT(b.at), why: `${b.kind} page`, scene: true })),
  ].filter((x) => x.t != null);
  const hl = new Set([].concat(spec.captions?.highlight || []).filter((h) => typeof h === "string").map((h) => core(h).toLowerCase()));
  // word pops, spaced by density (DNA: Belmar ~1 per caption block = 1.7 s, Iman ~1 per phrase, Monologue ~1 per word
  // = 82/min); highlight words always pop. Nothing pops inside the drop (the ladder has its own sounds).
  const popGap = SFX_DESIGN.popGap ?? { low: 1.7, med: 0.8, high: 0.3 }[SFX_DESIGN.density ?? "med"];
  let lastPop = -9;
  const pops = words.filter((w) => {
    if (dropWin && w.start >= dropWin[0] - 0.3 && w.start < dropWin[1]) return false;
    const hit = hl.has(core(w.word).toLowerCase()) || /!$/.test(w.word);
    if (w.start - lastPop < (hit ? 0.25 : popGap)) return false;
    lastPop = w.start; return true;
  }).map((w) => r3(w.start));
  PK.sfxDesign(SFX_DESIGN, { majors, transitions: [...transitionsAt, ...sceneTrans], joins: takes.slice(1).map((k) => r3(k.start)), textIns, punches: punchTimes, pops, ramps: rampsAt.filter((r) => !inDrop(r.t0)) },
    { addSfx, sfxEvents, timing: sfxTiming, words, voiceP95, ROLE_DB, TOTAL, log: (m) => console.log(m), has: sfxOk_ });
}

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
// An event with a .fade (a riser cut at the boom) gets a volume lane that ends on silence. NOTE: sounds added after this point
// (type-card hits, list marks, zoom swishes, leaks, object pops, burns...) are dropped from the mix because the tags are built
// here; sound.completeMix: true builds them at write time instead, so every planned hit plays. Off by default so every existing
// style keeps the mix it was approved with. NOTE the key: Ahmed's engine calls this `sound.complete`, and a dozen fork styles already
// carry that as data (breakdown, gadzhi-*, hormozi, mono, monologue, podcast*, ...). Reading it would change their mix, so the
// premium styles use this separate opt-in until someone decides to switch the older ones.
const sfxFade = (e) => { const d = r3(Math.min(e.dur, TOTAL - e.t)); return ` data-automation='${JSON.stringify({ version: 1, lanes: [{ target: "volume", points: [{ t: 0, v: 1 }, { t: r3(Math.max(0, d - e.fade)), v: 1 }, { t: d, v: 0 }] }] })}'`; };
const sfxTag = (e, i) => `<audio id="sfx-${i}" src="${e.src}" data-start="${e.t}" data-duration="${r3(Math.min(e.dur, TOTAL - e.t))}" data-track-index="${14 + (i % 4)}" data-volume="${e.vol}"${e.fade ? sfxFade(e) : ""}></audio>`;
const sfxAudio = sfxEvents.filter((e) => !e.id.startsWith("meme:")).map(sfxTag);
const sfxAudioAll = () => sfxEvents.filter((e) => !e.id.startsWith("meme:")).sort((a, b) => a.t - b.t).map(sfxTag);

// `bandBottom`: the reserved band's bottom edge (canvas px), for a block anchored by its bottom (mac-47, lower-face)
motionCtx.placeCaption = (t0, t1, h) => { const p = placer.place(t0, t1, h); return { ...p, bandBottom: Math.round(p.y + h) }; };
motionCtx.sidePad = placer.sidePad;

// ---------- captions ----------
const cap = { style: "house", group: 3, highlight: null, ...(spec.captions || {}) };
if (cap.style === "clean" && !cap.highlight) cap.highlight = brand.accent;
// box: the Closer (whole phrase on a solid accent box); condensed: the Headline (tall 1-2 word caps);
// serif: the Monk (small lowercase serif, no motion)
const CAP_SIZES = { lux: cap.size ?? 46, noir: cap.size ?? 54, pill: 66, box: cap.size ?? 60, condensed: cap.size ?? 104, serif: cap.size ?? 52, sessions: cap.size ?? 64 };
// noir (premium kit, hand port of phantasic dc92283): cinema subtitles - sentence-case serif, the whole line at once, sitting
// in the lower letterbox bar at a fixed height (it does not go through the face-aware placer); ONE emphasis word per line
// goes gold italic (captions.emph words, else the longest word of 5+ letters; captions.gold sets the colour)
// lux (premium kit, hand port of phantasic 2771fee / a206d9e, used by Chrome Motion and Prestige): small sentence caps at a fixed
// height, revealed word by word (captions.revealDur, default 0.12 s), ONE emphasis word per line bloomed 1.5x that lands in a single
// frame (captions.emph words, else the longest word of 5+ letters; autoEmph false = only captions.emph)
if (cap.style === "lux") { cap.pop ??= false; cap.reveal ??= "word"; cap.revealDur ??= 0.12; cap.upper ??= true; if (spec.captions?.group == null) cap.group = 4; }
if (cap.style === "hormozi") { cap.pop ??= false; cap.reveal ??= "none"; }   // Authority: white sentence-case caps, the keyword in heavy weight (group 3 is the default)
if (cap.style === "noir") { cap.pop ??= false; cap.reveal ??= "none"; if (spec.captions?.group == null) cap.group = 6; }
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
// cap.breakOnCut (opt-in): a jump cut between hand-picked takes ends the caption group (a new sentence on a new take)
const cutBetween = (a, b) => !!cap.breakOnCut && takes.some((k, ki) => ki > 0 && a.start < k.start - 0.01 && b.start >= k.start - 0.02);
for (const w of words) {
  if (cur.length && (w.start - cur.at(-1).end > 0.6 || cutBetween(cur.at(-1), w))) { groups.push(cur); cur = []; }
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
  // cap.minWords (opt-in, default 1 = the one-word-orphan rule as before): fold groups of up to this many words
  if (!SMART || wc(groups[i]) > (cap.minWords ?? 1) || groups.length < 2) continue;
  const g = groups[i], prev = groups[i - 1], next = groups[i + 1];
  const joinsPrev = prev && !/[.?!]$/.test(prev.at(-1).word) && g[0].start - prev.at(-1).end < 0.6 && wc(prev) <= cap.group + 1 && !cutBetween(prev.at(-1), g[0]);
  const joinsNext = next && !/[.?!]$/.test(g[0].word) && next[0].start - g[0].end < 0.6 && wc(next) <= cap.group + ((cap.minWords ?? 1) > 1 ? 2 : 0) && !cutBetween(g.at(-1), next[0]);
  if (joinsPrev) { prev.push(...g); groups.splice(i--, 1); }
  else if (joinsNext) { next.unshift(...g); groups.splice(i--, 1); }
}
// fast talk: a phrase on screen for under ~0.5 s can't be read; give it the next phrase's words too
const MIN_READ = cap.minRead ?? 0.5;
for (let i = 0; i < groups.length - 1; i++) {
  const g = groups[i], next = groups[i + 1];
  if (!SMART || next[0].start - g[0].start >= MIN_READ || /[.?!]$/.test(g.at(-1).word)) continue;
  if (wc(g) + wc(next) > cap.group + 4 || cutBetween(g.at(-1), next[0])) continue;
  g.push(...next); groups.splice(i + 1, 1); i--;
}
// captions.onlyInScenes: the recording already has burned-in captions, so ours
// appear only over scenes that cover them (e.g. an image scene)
const complement = (wins) => { const out = []; let c = 0; for (const [a, b] of [...wins].sort((x, y) => x[0] - y[0])) { if (a > c) out.push([c, a]); c = Math.max(c, b); } if (c < TOTAL) out.push([c, TOTAL + 1]); return out; };
// every caption style hides under full-screen scenes (editorial handles its own)
if (cap.style !== "editorial" && cap.style !== "none") {
  const wins = cap.onlyInScenes ? complement(shownCaps) : hiddenCaps;
  const merged = [];
  // a page that runs to the end of speech keeps the captions hidden to the end (they faded back in for the last
  // frames and the tail hold froze a stray word over an end card); local times in a section build
  const speechL = SECTION_MODE ? SPEECH - SECTION_START : SPEECH, totalL = SECTION_MODE ? SECTION_TOTAL : TOTAL;
  for (const [a, b0] of [...wins].sort((x, y) => x[0] - y[0])) { const b = b0 >= speechL - 0.1 ? totalL + 1 : b0; if (merged.length && a <= merged.at(-1)[1] + 0.05) merged.at(-1)[1] = Math.max(merged.at(-1)[1], b); else merged.push([a, b]); }
  tl.push(`tl.set("#caps", { autoAlpha: 1 }, 0);`);
  for (const [a, b] of merged) { tl.push(`tl.to("#caps", { autoAlpha: 0, duration: 0.08 }, ${r3(a)});`); tl.push(`tl.to("#caps", { autoAlpha: 1, duration: 0.12 }, ${r3(b - (cap.reshowLate ? -0.01 : 0.05))});`); }   // cap.reshowLate (opt-in; Explainer r2): back only after a hard-cut page is gone (no half-faded pill over its last frames)
}
if (cap.breakOnCut) cap.cutTimes = takes.slice(1).map((k) => k.start);  // edit seconds of the jump cuts, for motion.mjs's editorial blocks
// One emphasis word per caption group (styles that mark a hero word: Noir today; the same hook serves Lux / Authority).
// -1 for every other style, which keeps their span markup exactly class="w".
const EMPH_STYLES = new Set(["noir", "lux", "hormozi"]);
const FIXED_Y = { noir: 1690, lux: 1540 };   // fixed-height caption styles (9:16 pixels): they bypass the face-aware placer
// the fixed y of a caption block in 9:16 pixels, or null for a style that is placed by the face-aware placer. hormozi has two:
// captions.fixedY (1150) normally, captions.listY (720) while a split-screen list is up.
const fixedYOf = (style, s, e) => style === "hormozi" ? (hzLists.some(([a, b]) => s < b && e > a) ? (cap.listY ?? 720) : (cap.fixedY ?? 1150)) : FIXED_Y[style] ? (cap.fixedY ?? FIXED_Y[style]) : null;
const emphSet = new Set((cap.emph || []).map((x) => x.toLowerCase().replace(/[^a-z0-9']/g, "")));
const bareEmph = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
const emphIndexOf = (g) => {
  if (!EMPH_STYLES.has(cap.style)) return -1;
  let i = g.findIndex((w) => emphSet.has(bareEmph(w.word)));
  if (i < 0 && cap.autoEmph !== false) { let best = 4; g.forEach((w, k) => { const L = bareEmph(w.word).length; if (L > best) { best = L; i = k; } }); }
  return i;
};
// glow (Podcast Glow, hand port of phantasic d8bb43a, studied from @kayzee.edits): ONE word at a time, heavy caps in yellow
// with a soft yellow glow, at chest height (captions.fixedY, 9:16 pixels scaled to the format); a word under ~0.14 s rides
// with the next one. Headline beats take over the band while they are up. Fixed height like noir, so it bypasses the
// placer except for dodging the face, and each block is still logged for caption_layout.json / qa.py.
const glowHtml = cap.style !== "glow" ? "" : (() => {
  const gs = []; let cur = [];
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const short = prev && prev.end - prev.start < (cap.joinUnder ?? 0.14) && cur.length < 2 && (prev.word + w.word).length <= 13 && w.start - prev.end < 0.12;
    if (cur.length && !short) { gs.push(cur); cur = []; }
    cur.push(w);
  });
  if (cur.length) gs.push(cur);
  const S = cap.size ?? 70, Y = Math.round((cap.fixedY ?? 1230) * H / 1920), C = cap.color ?? "#FFD21E";
  return gs.map((g, gi) => {
    const s = r3(Math.max(0, g[0].start - 0.03));
    const nextS = gi + 1 < gs.length ? gs[gi + 1][0].start - 0.03 : SPEECH;
    const e = r3(Math.min(Math.max(g.at(-1).end + 0.12, s + 0.2), nextS, SPEECH, takeEndAt(takes, FPS, g.at(-1).start, SPEECH)));
    if (e - s < 0.05) return "";
    const txt = g.map((w) => w.word.replace(/[,.;:!?"]+$/, "").replace(/^["]+/, "").toUpperCase()).join(" ");
    const size = Math.min(S, Math.floor(960 * W / 1080 / (Math.max(4, txt.length) * 0.72)));
    let y = Y;
    if (cap.dodgeFace !== false) { const sp = placer.span(s, Math.max(s, e - 0.05)); if (sp.seen && y < sp.bottom + 10 && y + size > sp.top) y = Math.round(Math.min(placer.safeBottom - size, sp.bottom + 24)); }
    placer.log.push({ t0: +s.toFixed(2), t1: +e.toFixed(2), y, h: size, mode: "glow", scale: 1, face: null });
    tl.push(`ft("#gw${gi}", { scale: 0.82, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.07, ease: "back.out(2.2)" }, ${s});`);
    return `<div id="gw${gi}" class="gw clip" style="top:${y}px;font-size:${size}px;color:${C}" data-start="${s}" data-duration="${r3(e - s)}" data-track-index="5">${esc(txt)}</div>`;
  }).join("\n      ");
})();
// ---- captions.keywordAt (opt-in; Ahmed's f88943d): director plans give { word: [source seconds] } -> edit seconds, so a keyword
// treatment fires on the occurrence the director picked, not on every repeat (motion.mjs reads cap.keywordTimes)
if (cap.keywordAt) {
  cap.keywordTimes = {};
  for (const [wd, ts] of Object.entries(cap.keywordAt)) cap.keywordTimes[wd] = ts.map((t) => { try { return E(t, "keywordAt"); } catch { return -99; } });
}
const edit = cap.style === "editorial" ? buildEditorialCaptions(words, cap, motionCtx, cap.onlyInScenes ? complement(shownCaps) : hiddenCaps) : null;
// noir orphan guard (opt-in by style): the browser wraps a caption block at max-width 900px, which can strand ONE word alone
// on the last line. Estimate the greedy wrap (Instrument Serif ~0.42em per character, 0.24em of margin per word, a 0.25em
// space) and, when the last line would be a single word and the line before it holds 3+ words, return the index of the word
// that should open the last line instead (one word moves down, so the last line has 2). -1 = leave the block alone.
const noirOrphanBreak = (g, size) => {
  const room = 900, wd = (w) => (caseOf(w.word).length * 0.42 + 0.24) * size, sp = 0.25 * size;
  const lines = []; let line = [], x = 0;
  g.forEach((w, i) => { const ww = wd(w); if (line.length && x + sp + ww > room) { lines.push(line); line = []; x = 0; } x += (line.length ? sp : 0) + ww; line.push(i); });
  lines.push(line);
  if (lines.length < 2 || lines.at(-1).length !== 1 || lines.at(-2).length < 3) return -1;
  return lines.at(-2).at(-1);
};
// duo: one word at a time in two sizes. Calm lines are a small word at chest height; energy spans
// (cap.energy, source seconds) are a big word. Serif words (cap.serif / cap.serifSpans) switch to the
// italic display serif inside the same flow. Every word clears out of a blur, about three frames.
const tryE = (t) => { try { return E(t); } catch { return null; } };
// captions.energy / serifSpans / stairs: [from, to] pairs of recording seconds -> edit seconds. A pair that does not resolve to ONE kept
// take (outside every take, or ambiguous between recordings: write {src, t}) is dropped with a warning, never widened to the whole reel.
const capSpans = (xs, what) => (xs || []).flatMap(([a, b]) => {
  const x = tryE(a), y = tryE(b);
  if (x === null || y === null) {
    warn.push(`captions.${what} [${JSON.stringify(a)}, ${JSON.stringify(b)}] does not resolve to one kept take: dropped`);
    recordDrop({ kind: "caption treatment", id: `captions.${what}`, type: what, at: a, to: b, t: x, rule: "take", why: `A caption treatment (captions.${what}) was dropped because its time is not inside one kept take.`, warning: `captions.${what} [${JSON.stringify(a)}, ${JSON.stringify(b)}] does not resolve to one kept take: dropped` });
    return [];
  }
  return [[x, y]];
});
// podcast: 1-3 words in heavy caps at the lower third; cap.keys words in the key colour (yellow); a group that holds
// a key word and others stacks: the others small above, the key big under them ("what's the / NUMBER 1 CUE")
const podcastHtml = cap.style !== "podcast" ? "" : (() => {
  const bareOf = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  const keys = new Set((cap.keys || []).map(bareOf)), reds = new Set((cap.reds || []).map(bareOf));
  const groups = []; let cur = [];
  words.forEach((w, i) => {
    const prev = words[i - 1];
    // cap.splitAtPages (opt-in): a page beginning or ending between two words splits the group, so words said under a page
    // do not linger on the footage after it
    const crossesPage = cap.splitAtPages && prev && hiddenCaps.some(([ha, hb]) => (prev.start < ha && w.start >= ha - 0.02) || (prev.start < hb && w.start >= hb - 0.08));
    if (cur.length && (crossesPage || cur.length >= (cap.maxWords ?? 3) || w.start - prev.end > 0.3 || /[.?!,]$/.test(prev.word) || keys.has(bareOf(prev.word)))) { groups.push(cur); cur = []; }
    cur.push(w);
  });
  if (cur.length) groups.push(cur);
  const S = cap.size ?? 78, KS = cap.keySize ?? 120, SS = cap.smallSize ?? 50, Y = Math.round((cap.fixedY ?? 1250) * H / 1920);
  return groups.map((g, gi) => {
    const s = r3(Math.max(0, g[0].start - 0.04));
    const nextS = gi + 1 < groups.length ? groups[gi + 1][0].start - 0.04 : SPEECH;
    let e = r3(Math.min(g.at(-1).end + 0.25, nextS, SPEECH, takeEndAt(takes, FPS, g.at(-1).start, SPEECH)));
    // splitAtPages: a group said under a page ends with the page (it would otherwise reappear on the footage)
    if (cap.splitAtPages) { const win = hiddenCaps.find(([ha, hb]) => s >= ha - 0.05 && s < hb); if (win) e = r3(Math.min(e, win[1] - 0.06)); }
    if (e - s < 0.05) return "";
    const ki = g.findIndex((w) => keys.has(bareOf(w.word)) || reds.has(bareOf(w.word)));
    const colourOf = (w) => reds.has(bareOf(w.word)) ? (cap.red ?? "#F0333A") : keys.has(bareOf(w.word)) ? (cap.key ?? "#FFD43B") : "#fff";
    // cap.smallStyle "italic" (opt-in): words that are not the key stay in their own case, small italic sans (the afterpranav lead line)
    const soft = cap.smallStyle === "italic";
    const span = (w, k, size, isKey = keys.has(bareOf(w.word)) || reds.has(bareOf(w.word))) => soft && !isKey
      ? `<span id="pc${gi}w${k}" class="pcw pcs" style="font-size:${size}px">${esc(w.word.replace(/[,.]$/, ""))}</span>`
      : `<span id="pc${gi}w${k}" class="pcw${isKey ? " pck" : ""}" style="font-size:${size}px;color:${colourOf(w)}">${esc(w.word.replace(/[,.]$/, "").toUpperCase())}</span>`;
    g.forEach((w, k) => { if (k > 0) tl.push(`ft("#pc${gi}w${k}", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.04 }, ${r3(Math.max(s, w.start - 0.03))});`); });
    tl.push(`ft("#pc${gi}", { scale: 0.92 }, { scale: 1, duration: 0.1, ease: "back.out(2.5)" }, ${s});`);
    let body;
    if (ki >= 0 && g.length > 1) {
      const others = g.map((w, k) => [w, k]).filter(([, k]) => k !== ki);
      const fit = (w) => Math.floor(940 / (Math.max(3, w.word.replace(/[^\w]/g, "").length) * 0.74));  // heavy caps ~0.74 em per letter
      const keyW = g[ki], ksz = Math.min(KS, fit(keyW));
      body = `<div class="pc-small">${others.map(([w, k]) => span(w, k, SS)).join(" ")}</div><div class="pc-key">${span(keyW, ki, ksz)}</div>`;
    } else {
      const big = ki >= 0;
      const fit = (w) => Math.floor(940 / (Math.max(3, w.word.replace(/[^\w]/g, "").length) * 0.74));
      const total = g.reduce((n, w) => n + w.word.length + 1, 0);
      const line = big ? Math.min(KS, fit(g[0])) : soft ? Math.min(SS, Math.floor(940 / (total * 0.5))) : Math.min(S, Math.floor(940 / (total * 0.72)));
      body = `<div>${g.map((w, k) => span(w, k, line)).join(" ")}</div>`;
    }
    // a card (big / strike / list ...) in the band at the same time: the caption steps below it, else above it
    const hgt = Math.round(ki >= 0 && g.length > 1 ? SS * 1.15 + KS : (ki >= 0 ? KS : S) * 1.15);
    let y = Y;
    // cap.dodgeFace (opt-in): on a close-up the chest line would sit on the mouth, so the caption drops under the
    // chin (or as low as the safe area allows)
    if (cap.dodgeFace) {
      const sp = placer.span(s, Math.max(s, e - 0.05));
      if (sp.seen && y < sp.mouth + 30) y = Math.round(Math.min(placer.safeBottom - hgt, Math.max(y, sp.bottom + 20)));
    }
    const ui = uiRects.find((r) => s < r.t1 && e > r.t0 && y < r.y1 && y + hgt > r.y0);
    if (ui) y = Math.max(placer.safeTop, ui.y0 - hgt - 26);
    const hit = e - s > 0.35 ? placer.clash(s + 0.15, e - 0.15, y, hgt) : placer.clash(s, e, y, hgt);
    if (hit) y = hit.y1 + 24 + hgt <= placer.safeBottom ? hit.y1 + 24 : Math.max(placer.safeTop, hit.y0 - 24 - hgt);
    placer.log.push({ t0: +s.toFixed(2), t1: +e.toFixed(2), y: Math.round(y), h: hgt, mode: "podcast", scale: 1, face: null });
    return `<div id="pc${gi}" class="pc-group clip" style="top:${Math.round(y)}px" data-start="${s}" data-duration="${r3(e - s)}" data-track-index="5">${body}</div>`;
  }).join("\n      ");
})();
const energySpans = cap.style === "duo" ? capSpans(cap.energy, "energy") : [];   // edit-second [from, to] of each energy span (duo)
const duoHtml = cap.style !== "duo" ? "" : (() => {
  const energy = energySpans, serifSpans = capSpans(cap.serifSpans, "serifSpans");
  const bareOf = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  const serifSet = new Set((cap.serif || []).map(bareOf));
  const inSpan = (xs, t) => xs.some(([a, b]) => t >= a - 0.02 && t < b);
  let faceBandPrev = null;
  return words.map((w, i) => {
    const next = words[i + 1];
    const s = r3(Math.max(0, w.start - 0.03));
    const e = r3(Math.min(next ? next.start - 0.03 : SPEECH, w.end + (cap.hold ?? 0.6), SPEECH, takeEndAt(takes, FPS, w.start, SPEECH)));
    if (e - s < 0.04) return "";
    const big = inSpan(energy, w.start);
    const serif = serifSet.has(bareOf(w.word)) || inSpan(serifSpans, w.start);
    const size = Math.round((big ? (cap.energySize ?? 112) : (cap.calmSize ?? 44)) * (serif ? 1.22 : 1));
    const pl = cap.fixedY ? { y: Math.round((big ? (cap.energyY ?? cap.fixedY - 40) : cap.fixedY) * H / 1920) } : placer.place(s, e, size * 1.25);
    // cap.dodgeMouth (opt-in, px of clearance under the mouth centre; Ahmed's mini2-breakdown): on a close-up the fixed chest line sits on the
    // mouth, so the word drops just under it (the mouth over the word +-1 s, 40 px steps so it does not jitter). A face off to the side
    // never moves the word, and a one-sample blip is ignored (75th percentile of the mouth over the window, not its maximum)
    if (cap.fixedY && cap.dodgeMouth) {
      const ms = [];
      for (let t = Math.max(0, s - 1); t <= e + 1; t += 0.1) {
        const sp = placer.span(t, t);
        if (sp.seen && (sp.left + sp.right) / 2 > W * 0.28 && (sp.left + sp.right) / 2 < W * 0.72) ms.push(sp.mouth);
      }
      ms.sort((a, b) => a - b);
      const mouth = ms.length ? ms[Math.floor(ms.length * 0.75)] : -1;
      if (mouth > 0) pl.y = Math.min(placer.safeBottom - size * 1.1, Math.max(pl.y, Math.ceil((mouth + cap.dodgeMouth) / 40) * 40));
    }
    // the fixed chest line on a close face: a word whose box would cross the eyes-to-chin band (eyes less a quarter of the
    // brow, to the chin, camera-mapped over the word) moves under the chin, else above the eyes, 40 px steps. A word that
    // already clears the band never moves. Opt-in (cap.faceBand: true, pitch); cap.dodgeMouth keeps its own rule
    if (cap.fixedY && !cap.dodgeMouth && cap.faceBand === true) {
      const sp = placer.span(s, e), bh = Math.round(size * 1.25);
      const b0 = sp.eyes - (sp.eyes - sp.top) * 0.25, b1 = sp.bottom, clear = (y) => y + bh <= b0 - 24 || y >= b1 + 24;
      if (sp.seen && pl.y < b1 && pl.y + bh > b0) {
        const under = Math.ceil((b1 + 24) / 40) * 40, over = Math.floor((b0 - 24 - bh) / 40) * 40;
        // hold the previous dodged height while it still clears this word's face, so consecutive words do not jitter
        if (faceBandPrev != null && clear(faceBandPrev) && faceBandPrev >= placer.safeTop && faceBandPrev + bh <= placer.safeBottom) pl.y = faceBandPrev;
        else if (under + bh <= placer.safeBottom) pl.y = under;
        else if (over >= placer.safeTop) pl.y = over;
        else {
          // neither side of the face fits inside the safe area (a face filling the frame): the safe top is the least bad place
          pl.y = placer.safeTop;
          console.warn(`WARN caption "${w.word}" at ${s.toFixed(2)}s: the face fills the frame, no room above or below it; placed at the safe top (${pl.y}px)`);
        }
        faceBandPrev = pl.y === under || pl.y === over || pl.y === faceBandPrev ? pl.y : null;
      } else faceBandPrev = null;
    }
    if (cap.fixedY) placer.log.push({ t0: +s.toFixed(2), t1: +e.toFixed(2), y: pl.y, h: Math.round(size * 1.25), mode: "duo", scale: 1, face: null });
    tl.push(`ft("#dw${i}", { autoAlpha: 0.2, filter: "blur(${big ? 8 : 5}px)" }, { autoAlpha: 1, filter: "blur(0px)", duration: ${big ? 0.12 : 0.08}, ease: "power2.out" }, ${s});`);
    return `<div id="dw${i}" class="duo clip${big ? " big" : ""}${serif ? " ser" : ""}" style="top:${pl.y}px;font-size:${size}px" data-start="${s}" data-duration="${r3(e - s)}" data-track-index="5">${esc(caseOf(w.word.replace(/,$/, "")))}</div>`;
  }).join("\n      ");
})();
// cluster: each phrase is a little typographic composition (the "$80 edit" look): lead-in words small above, ONE
// hero word 3-4x bigger, trailing words small under it; every word clears out of a blur as it is spoken and the
// cluster builds until the phrase ends. cap.heroes (words), cap.serif (hero words drawn in the display serif),
// cap.script (words written on in handwriting), cap.stairs ([[from,to]] source spans set as a diagonal staircase).
const clusterHtml = cap.style !== "cluster" ? "" : (() => {
  const bareOf = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");   // apostrophes dropped: "don't" = "don’t" = "dont"
  const STOP = new Set("a an the to of and or but in on at for with my your his her their our is are was be been so if that this it i you we they he she me us them do does did have has had just really very what which who how im youre dont".split(" "));
  const heroes = new Set((cap.heroes || []).map(bareOf)), serif = new Set((cap.serif || []).map(bareOf)), script = new Set((cap.script || []).map(bareOf));
  const glowSet = new Set((cap.glowWords || []).map(bareOf));
  const stairs = capSpans(cap.stairs, "stairs");
  const inStairs = (t) => stairs.some(([a, b]) => t >= a - 0.02 && t < b);
  // phrases: break on punctuation, a pause > 0.35 s, a stairs boundary, or 6 words
  const phrases = []; let cur = [];
  words.forEach((w, i) => {
    const prev = words[i - 1];
    // a cutaway starting or ending between two words splits the phrase, so each side gets its own visible hero
    const crossesScene = prev && hiddenCaps.concat(shownCaps).some(([a, b]) => (prev.start < a && w.start >= a - 0.02) || (prev.start < b && w.start >= b - 0.02));
    if (cur.length && (cur.length >= (cap.maxWords ?? 6) || w.start - prev.end > 0.35 || crossesScene || inStairs(w.start) !== inStairs(prev.start) || /[.?!,]$/.test(prev.word))) { phrases.push(cur); cur = []; }
    cur.push(w);
  });
  if (cur.length) phrases.push(cur);
  const S = cap.smallSize ?? 44, HS = cap.heroSize ?? 168, X0 = cap.x ?? 150;
  let html = "", lastHeroSfx = -99;
  phrases.forEach((ph, pi) => {
    const s = r3(Math.max(0, ph[0].start - 0.04)), nextS = pi + 1 < phrases.length ? phrases[pi + 1][0].start - 0.04 : SPEECH;
    let e = r3(Math.min(nextS, ph.at(-1).end + (cap.hold ?? 0.45), SPEECH, takeEndAt(takes, FPS, ph.at(-1).start, SPEECH)));
    // cap.splitAtPages (opt-in): a phrase said under a page ends with the page (it would otherwise rebuild on the footage after it)
    if (cap.splitAtPages) { const s0 = ph[0].start; const win = hiddenCaps.find(([ha, hb]) => s0 >= ha - 0.05 && s0 < hb); if (win) e = r3(Math.min(e, win[1] - 0.06)); }
    if (e - s < 0.05) return;
    let y = Math.round((cap.fixedY ?? 1150) * H / 1920);
    // avoidFace: the face-aware placer picks the zone (below the chin, above the head, else as low as the platform
    // allows) instead of a fixed height, so close-ups never get captions across the mouth
    if (cap.avoidFace && face) {
      // a quiet phrase (no listed hero, heroFallback "none") is one small line: reserve only that, so it can sit lower
      const quiet = cap.heroFallback === "none" && !ph.some((w) => heroes.has(bareOf(w.word)));
      y = quiet ? placer.place(s, e, Math.round(S * 1.4)).y + Math.round(S * 0.6) : placer.place(s, e, Math.round(S * 2.5 + HS)).y + Math.round(HS * 0.75);
    }
    // captions.chestBand (opt-in; Ahmed's Name Reveal / Monochrome Cinema Stark round 3): on a close-up with the speaker on screen the caption
    // never goes on the face. The chin is estimated at mouth + chinPad: with the chin below chinMax there is no room, so the phrase gets NO
    // caption (cards and stills carry the words); otherwise it is one small line between the chin and the safe bottom.
    let closeQuiet = false;
    if (cap.chestBand && face && !beatsList.some((b) => b.type === "scene" && tryE(b.at) !== null && tryE(b.at) <= s + 0.05 && (tryE(b.to) ?? TOTAL) >= e - 0.05)) {
      const sp = placer.span(s, e);
      if (sp.seen && sp.bottom > H * 0.65) {
        const chin = sp.mouth + (cap.chinPad ?? 260);
        if (chin > (cap.chinMax ?? 1430)) return;
        closeQuiet = true; y = Math.round(chin + 20 + S * 0.6);
      }
    }
    const id = `cl${pi}`;
    if (!(cap.avoidFace && face)) placer.log.push({ t0: +s.toFixed(2), t1: +e.toFixed(2), y: Math.round(y), h: Math.round(S * 2.5 + HS), mode: "cluster", scale: 1, face: null });
    const wspan = (w, k, cls, size) => {
      const isScript = script.has(bareOf(w.word));
      const t = r3(Math.max(s, w.start - 0.03));
      // fitWipe (motion.mjs): the write-on finishes before the phrase ends instead of being cut mid-word
      if (isScript) { const [wt, wd] = fitWipe(t, Math.max(0.35, Math.min(0.7, w.end - w.start + 0.25)), e, { min: s }); tl.push(`ft("#${id}w${k}", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% -10% 0% 0%)", duration: ${r3(wd)}, ease: "power1.inOut" }, ${r3(wt)});`); }
      // 3-frame land with a light blur: a longer, heavier blur reads as a ghosted double on a still frame
      else tl.push(`ft("#${id}w${k}", { autoAlpha: 0, filter: "blur(4px)", y: 6 }, { autoAlpha: 1, filter: "blur(0px)", y: 0, duration: 0.1, ease: "power2.out" }, ${t});`);
      const isGlow = glowSet.has(bareOf(w.word));   // captions.glowWords: the one or two words that get the accent colour + glow
      return `<span id="${id}w${k}" class="cw ${cls}${isScript ? " scr" : ""}${isGlow ? " glw" : ""}" style="font-size:${isScript ? Math.round(size * 1.5) : size}px">${esc(caseOf(w.word.replace(/[,.]$/, "")))}</span>`;
    };
    if (inStairs(ph[0].start)) {
      // staircase: each word one step down and to the right
      const step = cap.stairStep ?? [70, 78];
      html += `<div id="${id}" class="cl clip" style="left:${X0}px;top:${y - 200}px" data-start="${s}" data-duration="${r3(e - s)}" data-track-index="5">${ph.map((w, k) => `<div class="cl-row" style="margin-left:${k * step[0]}px;height:${step[1]}px">${wspan(w, k, "st", cap.stairSize ?? 72)}</div>`).join("")}</div>`;
      return;
    }
    // hero: a listed hero word, else the longest non-stop word
    // the LAST listed hero in the phrase wins: the payoff word usually closes the line ("I know that AI is HERE")
    let hi = -1; ph.forEach((w, k) => { if (heroes.has(bareOf(w.word))) hi = k; });
    // heroFallback "none": a phrase without a listed hero stays all small (Monochrome Cinema: filler lines are quiet)
    if ((hi < 0 && cap.heroFallback === "none") || closeQuiet) {
      html += `<div id="${id}" class="cl clip" style="${cap.align === "center" || cap.align === "block" ? "left:540px;transform:translateX(-50%)" : `left:${X0}px`};top:${y - Math.round(S * 0.6)}px" data-start="${s}" data-duration="${r3(e - s)}" data-track-index="5"><div class="cl-row lead">${ph.map((w, k) => wspan(w, k, "sm", S) + " ").join("")}</div></div>`;
      return;
    }
    if (hi < 0) { let best = -1; ph.forEach((w, k) => { const b = bareOf(w.word); if (!STOP.has(b) && b.length > best) { best = b.length; hi = k; } }); }
    if (hi < 0) hi = ph.length - 1;
    const hero = ph[hi], heroSerif = serif.has(bareOf(hero.word));
    const hsz = Math.min(HS, Math.floor(860 / Math.max(2, bareOf(hero.word).length * (heroSerif ? 0.5 : 0.58))));
    const lead = ph.slice(0, hi), tail = ph.slice(hi + 1);
    const line = (ws, off, cls) => ws.length ? `<div class="cl-row ${cls}">${ws.map((w, k) => wspan(w, off + k, "sm", S) + " ").join("")}</div>` : "";
    html += `<div id="${id}" class="cl clip" style="${cap.align === "center" || cap.align === "block" ? "left:540px;transform:translateX(-50%)" : `left:${X0}px`};top:${y - Math.round(hsz * 0.75)}px" data-start="${s}" data-duration="${r3(e - s)}" data-track-index="5">${line(lead, 0, "lead")}<div class="cl-row hero">${wspan(hero, hi, heroSerif ? "hs" : "hb", hsz)}</div>${line(tail, hi + 1, "tail")}</div>`;
    // heroSfxGap: at most one hero whoosh per N seconds (Monochrome Cinema measured ~35 hits/min, not one per hero)
    if (cap.heroSfx !== false && hero.start - lastHeroSfx >= (cap.heroSfxGap ?? 0)) { lastHeroSfx = hero.start; addSfx(Math.max(0, hero.start - 0.04), cap.heroSfx ?? "whoosh", "cluster hero", { db: spec.sound?.heroDb ?? -10 }); }
  });
  return html;
})();
// type (premium, opt-in): the Empire / Iman Gadzhi card. One phrase at a time in glowing heavy ALL CAPS, typed on
// letter by letter behind a blinking cursor bar, replaced (never stacked) by the next phrase. cap.reds (spoken words)
// turn their phrase into a verdict card: those words go red with a red glow at redScale x size, the card slams in with
// a 3-frame shake and a low hit; calm cards get an alternating pop. Placed by the face-aware placer (captions.prefer).
const typeHtml = cap.style !== "type" ? "" : (() => {
  const bareOf = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  const reds = new Set((cap.reds || []).map(bareOf));
  // a red written with its punctuation ("language.") only fires on that spoken form, so the same word mid-sentence
  // stays white; a bare red ("language") fires everywhere
  const redExact = new Map((cap.reds || []).filter((r) => /[.,!?;:]$/.test(r.trim())).map((r) => [bareOf(r), r.trim().toLowerCase()]));
  const isRedWord = (word) => reds.has(bareOf(word)) && (!redExact.has(bareOf(word)) || word.trim().toLowerCase() === redExact.get(bareOf(word)));
  const S0 = cap.size ?? 96, MAXW = cap.maxWidth ?? 860, CHW = cap.charW ?? 0.74, CPS = cap.cps ?? 30, TYPE_MAX = cap.typeMax ?? 0.42;
  const RS = cap.redScale ?? 1.22;
  let html = "", popN = 0, lastTick = -9;
  // cap.maxChars: a phrase longer than this (letters + spaces) becomes consecutive cards, so no card shrinks small
  const MAXC = cap.maxChars ?? 22, tGroups = [];
  const isRedW = (w) => isRedWord(w.word);
  for (const g of groups) {
    let cur = [], n = 0;
    for (const w of g) {
      const L = w.word.trim().length;
      const redBreak = cap.redAlone !== false && cur.length && isRedW(w) !== isRedW(cur.at(-1)) && (isRedW(w) || cur.some(isRedW));
      if (cur.length && (n + 1 + L > MAXC || redBreak)) { tGroups.push(cur); cur = []; n = 0; }
      cur.push(w); n += (n ? 1 : 0) + L;
    }
    if (cur.length) { if (cur.length === 1 && !isRedW(cur[0]) && !(tGroups.at(-1) || []).some(isRedW) && tGroups.length && tGroups.at(-1).length && g.includes(tGroups.at(-1)[0]) && tGroups.at(-1).reduce((a, w) => a + w.word.trim().length + 1, 0) + cur[0].word.trim().length <= MAXC + 6) tGroups.at(-1).push(...cur); else tGroups.push(cur); }
  }
  const groupsT = tGroups;
  groupsT.forEach((g, gi) => {
    const s = Math.max(0, g[0].start - 0.05);
    const nextS = gi + 1 < groupsT.length ? groupsT[gi + 1][0].start - 0.05 : SPEECH;
    const e = Math.min(g.at(-1).end + (cap.tail ?? 0.3), nextS, SPEECH, g.at(-1).end + (cap.maxHold ?? 99), takeEndAt(takes, FPS, g.at(-1).start, SPEECH));
    // transcript quote marks ("What is...") are speech punctuation, not caption text
    const ws = g.map((w) => ({ text: caseOf(w.word.trim().replace(/["\u201C\u201D]/g, "")), red: isRedWord(w.word), w }));
    const isRed = ws.some((x) => x.red);
    // lines: one line when it fits at a readable size, else two balanced lines (break at the most even split)
    const em = (x) => x.text.length * (x.red ? RS : 1) + 0.35;
    const width1 = ws.reduce((n, x) => n + em(x), 0);
    let lines = [ws];
    if (width1 * S0 * CHW > MAXW && ws.length > 1) {
      let best = 1, bd = 1e9;
      for (let k = 1; k < ws.length; k++) { const a = ws.slice(0, k).reduce((n, x) => n + em(x), 0), b = width1 - a; if (Math.abs(a - b) < bd) { bd = Math.abs(a - b); best = k; } }
      lines = [ws.slice(0, best), ws.slice(best)];
    }
    const widest = Math.max(...lines.map((l) => l.reduce((n, x) => n + em(x), 0)));
    // red verdicts are wide caps with a glow: size them on a wider letter estimate so they never touch the frame edge
    let size = Math.max(cap.minSize ?? 54, Math.min(S0, Math.floor((isRed ? (cap.redMaxWidth ?? MAXW) : MAXW) / (widest * (isRed ? CHW * (cap.redCharW ?? 1.14) : CHW)))));
    let lineH = size * 1.06 * (isRed ? RS : 1);
    let pl;
    // the take that owns this card, for the head-top track of ITS recording (a recording with no cut-out falls back to the placer)
    const ownTake = spec.stage && cap.behind && headTopAt ? locateTake(takes, s, FPS) : null;
    if (ownTake && stageMatted(ownTake.src)) {
      // the block must read above the crown: when the head sits high, shrink the type to the room that is there
      // (premium-iman 642e90e; only reached with stage + captions.behind, so no other style changes)
      const q0 = ownTake.a + (s - ownTake.start), q1 = ownTake.a + (Math.min(e, ownTake.start + ownTake.dur) - ownTake.start);
      const ht0 = headTopAt(ownTake.src, q0, q1) ?? 300, crown = 1920 - SUBJ * (1920 - ht0);
      const room = crown - (cap.safeTop ?? 200), need = lines.length * lineH - lineH * (cap.overlap ?? 0.3);
      if (need > room && room > 0) { size = Math.max(cap.minSize ?? 54, Math.floor(size * room / need)); lineH = size * 1.06 * (isRed ? RS : 1); }
    }
    if (ownTake && stageMatted(ownTake.src)) {
      // behind the head: the block's bottom line dips `overlap` x its height under the crown, so the head covers the
      // middle of the last line (the DtFS look); never above the platform's top bar
      const o0 = ownTake.a + (s - ownTake.start), o1 = ownTake.a + (Math.min(e, ownTake.start + ownTake.dur) - ownTake.start), ht = headTopAt(ownTake.src, o0, o1) ?? 300;
      const htS = 1920 - SUBJ * (1920 - ht), blockH = lines.length * lineH;
      pl = { y: Math.round(Math.max(cap.safeTop ?? 200, htS + lineH * (cap.overlap ?? 0.3) - blockH)), mode: "behind" };
      placer.log.push({ t0: r3(s), t1: r3(e), y: pl.y, h: Math.round(blockH), mode: "behind", scale: 1, face: null });
    } else pl = placer.place(s, e, lines.length * lineH + 20);
    const id = `tc${gi}`;
    let k = 0;
    const lineStart = [];
    const body = lines.map((l, li) => { lineStart.push(k); return `<div class="tc-line">${l.map((x, xi) => {
      const chars = [...x.text].map((c) => `<span id="${id}c${k++}" class="tc-ch">${esc(c)}</span>`).join("");
      return `<span class="tc-w${x.red ? " tc-red" : ""}">${chars}</span>${xi < l.length - 1 ? `<span id="${id}c${k++}" class="tc-ch tc-sp"> </span>` : ""}`;
    }).join("")}<span id="${id}-cur${li}" class="tc-cur"${li ? ' style="opacity:0"' : ""}></span></div>`; }).join("");
    const nCh = k;
    html += `<div id="${id}" class="tc clip${isRed ? " tc-hot" : ""}" style="top:${pl.y}px;font-size:${size}px${pl.scale && pl.scale < 1 ? `;transform:translateX(-50%) scale(${pl.scale});transform-origin:50% 0` : ""}" data-start="${r3(s)}" data-duration="${r3(Math.max(0.1, e - s))}" data-track-index="5"><div id="${id}-in" class="tc-in">${body}</div></div>`;
    // typewriter: 1 letter per frame (30 cps), faster when the phrase would take longer than typeMax to type
    // cap.redInstant: a verdict card lands whole (it slams, it isn't typed); cap.blurIn: every card arrives out of a
    // short motion blur (the ref's ghosted swap), 4 frames
    const cps = isRed && cap.redInstant ? 1e6 : Math.max(CPS, nCh / TYPE_MAX);
    if (cap.blurIn) tl.push(`ft("#${id}-in", { filter: "blur(${cap.blurIn}px)", opacity: 0.35 }, { filter: "blur(0px)", opacity: 1, duration: 0.13, ease: "power2.out" }, ${r3(Math.max(0.02, s))});`);
    tl.push(`tl.set("#${id} .tc-ch", { display: "none" }, 0);`);
    if (cap.wordReveal) {
      // whole words land on their spoken start (no half-typed word is ever on screen); the space after a word comes
      // with it. Char ids run line by line: word chars, then one space id between words of a line. (premium-iman b0d13c1)
      let c = 0;
      lines.forEach((l) => l.forEach((x, xi) => {
        const n = [...x.text].length + (xi < l.length - 1 ? 1 : 0), at = r3(Math.max(0.02, s, Math.min(e - 0.1, x.w.start - 0.03)));
        for (let j = 0; j < n; j++) tl.push(`tl.set("#${id}c${c + j}", { display: "inline" }, ${isRed && cap.redInstant ? r3(Math.max(0.02, s)) : at});`);
        c += n;
      }));
    } else for (let c = 0; c < nCh; c++) tl.push(`tl.set("#${id}c${c}", { display: "inline" }, ${r3(Math.max(0.02, s + c / cps))});`);
    const typed = cap.wordReveal ? s : s + nCh / cps;
    // the cursor: solid while typing, then blinks (0.5 s period) until the card cuts
    // one cursor per line: line i's cursor shows while it types, hands over to the next line, the last one blinks
    if (cap.cursor !== false) lineStart.forEach((c0, li) => { if (li) { tl.push(`tl.set("#${id}-cur${li - 1}", { opacity: 0 }, ${r3(s + c0 / cps)});`); tl.push(`tl.set("#${id}-cur${li}", { opacity: 1 }, ${r3(s + c0 / cps)});`); } });
    const lastCur = `#${id}-cur${lines.length - 1}`;
    if (cap.cursor === false) lineStart.forEach((_, li) => tl.push(`tl.set("#${id}-cur${li}", { opacity: 0 }, 0);`));
    else for (let t = typed + 0.25, on = false; t < e - 0.05; t += 0.25, on = !on) tl.push(`tl.set("${lastCur}", { opacity: ${on ? 1 : 0} }, ${r3(t)});`);
    if (isRed) {
      tl.push(`ft("#${id}-in", { scale: ${cap.slam ?? 1.14} }, { scale: 1, duration: 0.2, ease: "power3.out" }, ${r3(s)});`);
      [4, -4, 3, 0].forEach((dx, j) => tl.push(`tl.set("#${id}-in", { x: ${dx} }, ${r3(s + j / FPS)});`));
      addSfx(s, cap.redSfx ?? "cinematic-cine-hit", "type card hit (red)", { db: cap.redDb ?? -4 });
    } else if (cap.popSfx !== false) addSfx(s, (cap.popSfx ?? ["pop-1", "pop-2"])[popN++ % 2], "type card in", { db: cap.popDb ?? -2 });
    // typing ticks: one per word, never denser than tickGap
    if (cap.ticks !== false) ws.forEach((x, xi) => { if (xi && x.w.start - lastTick >= (cap.tickGap ?? 0.5) && x.w.start < e) { lastTick = x.w.start; addSfx(x.w.start, "tick-1", "type tick", { db: cap.tickDb ?? -8 }); } });
  });
  return html;
})();
const capHtml = cap.style === "type" ? typeHtml : cap.style === "podcast" ? podcastHtml : cap.style === "cluster" ? clusterHtml : cap.style === "duo" ? duoHtml : cap.style === "glow" ? glowHtml : cap.style === "none" || edit ? "" : groups.map((g, gi) => {
  const s = Math.max(0, g[0].start - 0.05);
  const nextS = gi + 1 < groups.length ? groups[gi + 1][0].start - 0.05 : SPEECH;
  const e = Math.min(g.at(-1).end + 0.3, nextS, SPEECH, g.at(-1).end + (cap.maxHold ?? 99), takeEndAt(takes, FPS, g.at(-1).start, SPEECH));
  const emphI = emphIndexOf(g);
  g.forEach((w, wi) => {
    // captions.popSafe (opt-in): long words pop less, so the grown word never eats the space to its neighbours
    // (the kit test's "NOBODYYEAH,": a 1.08 pop on a 6-letter word grows ~0.17 em per side into a 0.28 em gap)
    const popS = cap.popSafe ? r3(1 + Math.min(0.08, 0.12 / Math.max(1, caseOf(w.word.trim()).length * 0.72))) : 1.08;
    if (cap.pop !== false) tl.push(`ft("#cg${gi}w${wi}", { scale: 1 }, { scale: ${popS}, duration: 0.08, yoyo: true, repeat: 1, ease: "power1.out" }, ${r3(w.start)});`);
    // reveal: word -> each word appears when it's spoken; the box is already sized for the whole phrase
    // R1b port (Broadsheet): the pop-in scales the INNER box (#cgNin), never #cgN itself. #cgN is centred by
    // translateX(-50%); a tween on it makes GSAP turn that -50% into px with a guess that depends on whether the
    // caption webfont had loaded when it first read the group, so the box landed up to ~50 px right of centre
    if (cap.style === "clipping" && wi === 0) tl.push(`ft("#cg${gi}in", { scale: 0.9 }, { scale: 1, duration: 0.12, ease: "back.out(2.5)" }, ${r3(s)});`);
    // the emphasis word (lux) lands at full strength in one frame: a fading hero word reads as a ghost
    if (cap.reveal === "word" && wi > 0) tl.push(`ft("#cg${gi}w${wi}", { autoAlpha: 0 }, { autoAlpha: 1, duration: ${cap.style === "lux" && wi === emphI ? 0.01 : (cap.revealDur ?? 0.05)} }, ${r3(Math.max(s, w.start - 0.02))});`);
    if (cap.highlight) tl.push(`tl.set("#cg${gi}w${wi}", { color: "${cap.highlight}" }, ${r3(w.start)}); tl.set("#cg${gi}w${wi}", { color: "#fff" }, ${r3(Math.min(w.end + 0.02, e - 0.01))});`);
  });
  const capSize = CAP_SIZES[cap.style] ?? (cap.style === "clean" ? (cap.size ?? brand.capSize) : (cap.size ?? 56));
  // noir / lux sit at a fixed height in the lower letterbox bar (cap.fixedY is in 9:16 pixels, scaled to other formats);
  // the block is still logged so caption_layout.json / qa.py see it
  const fy = fixedYOf(cap.style, s, e);
  // clipping (Broadsheet, mac-45): reserve the band the tilted box is DRAWN in, from the font's advances and the CSS
  // below (lib/caption-metrics.mjs), not size x 1.3: the box's 18 px of vertical padding and the tilt (up to
  // (width + 40) x sin(tilt) more on one side) put a one-line block ~81-95 px tall against 75 reserved. The placer
  // places that band; the group's CSS top is the band's top plus how far the box reaches above it.
  const tiltDeg = cap.tilt ? (gi % 2 ? -cap.tilt : cap.tilt * 0.7) : 0;
  const clipExt = cap.style === "clipping" && fy == null
    ? (sc = 1) => clippingExtent(g.map((w) => caseOf(w.word)), { size: cap.size ?? 58, maxWidth: W - 2 * placer.sidePad, deg: tiltDeg, scale: sc, ...(HOST_EMOJI.source === "host" ? { emojiEm: HOST_EMOJI.em } : {}) }) : null;
  const reserveH = clipExt ? Math.ceil(clipExt().up) + Math.ceil(clipExt().down) : capSize * (["pill", "box"].includes(cap.style) ? 1.6 : 1.3);
  const pl = fy != null ? { y: Math.round(fy * H / 1920), mode: cap.style, scale: 1 } : placer.place(s, e, reserveH);
  // whole px, rounded outward: the band is ceil(up) + ceil(down) and the top sits ceil(up) into it, so the drawn box
  // [top - up, top + down] never leaves [pl.y, pl.y + band] (the placer itself rounds y to whole px)
  const cssTop = clipExt ? pl.y + Math.ceil(clipExt(pl.scale && pl.scale < 1 ? pl.scale : 1).up) : pl.y;
  if (fy != null) placer.log.push({ t0: +s.toFixed(2), t1: +e.toFixed(2), y: pl.y, h: Math.round(capSize * 1.3), mode: cap.style, scale: 1, face: null });
  // captions.backing false (opt-in): no grey box over the lower face, a heavy text shadow instead
  // captions.backingUntil: <edit s> (opt-in): only blocks starting before it get the box; later ones the shadow
  const noBox = cap.backing === false || (typeof cap.backingUntil === "number" && s >= cap.backingUntil);
  const backed = pl.mode === "lower-face" && !noBox && !["pill", "box", "sessions"].includes(cap.style);
  const shadowed = pl.mode === "lower-face" && noBox;
  const orphanAt = cap.style === "noir" ? noirOrphanBreak(g, capSize) : -1;   // index of the word that opens the last line, or -1
  const tilt = cap.tilt ? `;rotate:${tiltDeg}deg` : "";  // R1b port (Broadsheet clippings)
  const look = backed ? " cap-backed" : shadowed ? " cap-shadow" : "";
  const body = g.map((w, wi) => `<span id="cg${gi}w${wi}" class="w${wi === emphI ? " emph" : ""}">${esc(caseOf(w.word))}</span>`).map((sp, wi) => wi === 0 ? sp : (wi === orphanAt ? "<br>" : "<wbr>") + sp).join("");
  // clipping (Broadsheet): two boxes. The outer #cgN places, centres (translateX(-50%)) and tilts, all static CSS that
  // nothing animates; the inner #cgNin carries the box and the pop-in tween. (The tilt stays on the outer: CSS
  // composes rotate with the -50% translate, which lifts/lowers the box by half its width x sin(tilt), up to ~6 px;
  // moving the tilt inside would drop that and move every box vertically.)
  const clipping = cap.style === "clipping";
  // mac-47: a lower-face block (the close-up fallback, already at the bottom of the safe area) is anchored by its BOTTOM
  // edge at the bottom of the band the placer reserved, so a block that wraps to more lines than reserved grows UP over
  // the chest instead of down into the platform's bottom UI. Clipping keeps its measured band (mac-45); fixed-height
  // styles never take this path.
  // `translate` (the individual CSS property, not `transform`): GSAP never writes it, and the caption container is not
  // canvas-sized, so a CSS `bottom` would be measured from the wrong edge (measured: blocks 700+ px off)
  // mac-53: the same for a block BELOW the face (or with no face) whose band ends less than one more line above the safe
  // bottom: a wrap there would also spill into the bottom UI (measured: clean on a close-up, 2 blocks, 48 px). A block
  // with a line of room below it stays top-anchored, and blocks above the head are never moved.
  const nearBottom = !["above", "above-compact"].includes(pl.mode) && pl.y + 2 * reserveH > placer.safeBottom;
  const vpos = (pl.mode === "lower-face" || nearBottom) && !clipExt && fy == null ? `top:${Math.round(pl.y + reserveH)}px;translate:0 -100%` : `top:${cssTop}px`;
  return `<div id="cg${gi}" class="cap-group clip${clipping ? "" : look}" style="${vpos}${tilt}${pl.scale && pl.scale < 1 ? `;transform:translateX(-50%) scale(${pl.scale});transform-origin:50% 0` : ""}" data-start="${r3(s)}" data-duration="${r3(Math.max(0.1, e - s))}" data-track-index="5">${clipping ? `<div id="cg${gi}in" class="cap-in${look}">${body}</div>` : body}</div>`;
}).join("\n      ");

const cyr = /[\u0400-\u04FF]/.test(JSON.stringify(spec.beats || []) + words.map((w) => w.word).join(" "));
const UI_FONT = brand.font || (cyr ? "Inter" : "Geist");
const capCss = cap.style === "type"
  ? `.tc { position: absolute; left: 50%; transform: translateX(-50%); width: max-content; max-width: 960px; text-align: center; pointer-events: none; }
  .tc-in { font-family: ${cap.font ?? brand.font ?? "Montserrat"}, system-ui, sans-serif; font-weight: ${cap.weight ?? 900}; line-height: 1.06; letter-spacing: ${cap.tracking ?? "0.01em"}; color: ${cap.ink ?? "#FFFFFF"}; transform-origin: 50% 60%;
    text-shadow: 0 0 ${cap.glow ?? 20}px rgba(255,255,255,${cap.glowA ?? 0.55}), 0 0 ${Math.round((cap.glow ?? 20) * 2.4)}px rgba(255,255,255,${(cap.glowA ?? 0.55) * 0.4}), 0 3px 14px rgba(0,0,0,.65), 0 1px 2px rgba(0,0,0,.6); }
  .tc-line { white-space: nowrap; }
  .tc-red { color: ${cap.red ?? "#FF2A2A"}; font-size: ${cap.redScale ?? 1.22}em; text-shadow: 0 0 ${cap.redGlow ?? cap.glow ?? 20}px rgba(255,0,0,${cap.redGlowA ?? 0.6}), 0 0 ${Math.round((cap.redGlow ?? cap.glow ?? 20) * 2.4)}px rgba(255,0,0,${(cap.redGlowA ?? 0.6) * 0.6}), 0 3px 14px rgba(0,0,0,.7), 0 1px 2px rgba(0,0,0,.6); }
  .tc-cur { display: inline-block; width: .09em; height: .86em; margin-left: .06em; vertical-align: -0.08em; background: currentColor; box-shadow: 0 0 12px rgba(255,255,255,.7); }
  .tc-hot .tc-cur { background: ${cap.red ?? "#FF2A2A"}; box-shadow: 0 0 12px rgba(255,0,0,.7); }`
  : cap.style === "cluster"
  ? `.cl { position: absolute; display: flex; flex-direction: column; align-items: flex-start; pointer-events: none; }
  .cl-row { white-space: nowrap; line-height: 1; }
  .cl-row.lead { margin: 0 0 4px 6px; } .cl-row.tail { margin: 6px 0 0 ${cap.align === "center" ? 0 : Math.round((cap.heroSize ?? 168) * 0.35)}px; }
  ${cap.align === "center" ? ".cl { align-items: center; text-align: center; }" : ""}
  ${cap.heroGlow ? `.cw.hb, .cw.hs { text-shadow: 0 0 18px ${cap.heroGlow}, 0 0 42px ${cap.heroGlow}, 0 4px 24px rgba(0,0,0,.45); }` : ""}
  .cw { display: inline-block; color: ${cap.ink ?? "#fff"}; text-shadow: ${cap.ink && cap.ink !== "#fff" ? "none" : "0 4px 24px rgba(0,0,0,.45)"}; }
  .cw.sm { font-family: ${cap.font ?? UI_FONT}, system-ui, sans-serif; font-weight: 600; letter-spacing: -0.03em; margin-right: 0.24em; }
  .cw.hb { font-family: ${cap.font ?? UI_FONT}, system-ui, sans-serif; font-weight: 800; letter-spacing: -0.06em; line-height: .86;${cap.heroItalic ? " font-style: italic;" : ""}${cap.heroColor ? ` color: ${cap.heroColor};` : ""} }
  ${cap.smallItalic ? `.cw.sm { font-style: italic; font-weight: 500; }` : ""}
  ${cap.smallSerif ? `.cw.sm { font-family: "${cap.serifFont ?? "Instrument Serif"}", Georgia, serif !important; font-weight: 400 !important; letter-spacing: -0.01em !important; }` : ""}
  .cw.hs { font-family: "${cap.serifFont ?? "Instrument Serif"}", Georgia, serif; font-weight: 400; letter-spacing: -0.03em; line-height: .9; }
  ${cap.serifItalic ? ".cw.hs { font-style: italic; letter-spacing: -0.02em; }" : ""}
  ${cap.glowColor ? `.cw.glw { color: ${cap.glowColor} !important; text-shadow: 0 0 16px ${cap.glowColor}, 0 0 40px ${cap.glowColor}, 0 4px 22px rgba(0,0,0,.45) !important; }` : ""}
  ${cap.serifItalic ? `.cw.hs { font-style: italic; font-weight: 600; letter-spacing: -0.04em;${cap.heroColor ? ` color: ${cap.heroColor};` : ""} }` : ""}
  .cw.st { font-family: ${cap.font ?? UI_FONT}, system-ui, sans-serif; font-weight: 700; letter-spacing: -0.04em; }
  .cw.scr { font-family: "${cap.scriptFont ?? "Yellowtail"}", cursive; font-weight: 400; letter-spacing: 0; }`
  : cap.style === "podcast"
  ? `.pc-group { position: absolute; left: 50%; transform: translateX(-50%); text-align: center; white-space: nowrap; line-height: .95; font-family: ${cap.font ?? "Inter"}, system-ui, sans-serif; font-weight: 900; letter-spacing: -0.02em; }
  .pcw { display: inline-block; margin: 0 0.13em; text-shadow: 0 3px 0 rgba(0,0,0,.55), 0 6px 24px rgba(0,0,0,.6); }
  .pc-small { margin-bottom: 2px; }
  .pc-key .pcw { letter-spacing: -0.035em; }
  ${cap.smallStyle === "italic" ? `.pcs { font-family: ${cap.smallFont ?? "Inter"}, system-ui, sans-serif; font-style: italic; font-weight: 500; letter-spacing: -0.03em; margin: 0 0.1em; color: #fff; text-shadow: 0 2px 14px rgba(0,0,0,.6); }` : ""}
  ${cap.keyFont ? `.pck { font-family: "${cap.keyFont}", ${cap.font ?? "Inter"}, sans-serif; }` : ""}${cap.keyItalic ? `.pck { font-style: italic; font-weight: 800; }` : ""}
  ${cap.keyGradient ? `.pck { background: linear-gradient(180deg, ${cap.keyGradient.join(", ")}); -webkit-background-clip: text; background-clip: text; color: transparent !important; text-shadow: none; padding: 0 0.08em; filter: drop-shadow(0 0 ${cap.keyGlow ?? 16}px ${cap.keyGlowColor ?? "rgba(242,193,78,.45)"}) drop-shadow(0 4px 8px rgba(0,0,0,.55)); }` : ""}`
  : cap.style === "duo"
  ? `.duo { position: absolute; left: 50%; transform: translateX(-50%); white-space: nowrap; line-height: 1; font-family: ${cap.font ?? UI_FONT}, system-ui, sans-serif; font-weight: 600; letter-spacing: -0.05em; color: #fff; text-shadow: 0 2px 16px rgba(0,0,0,.35); }
  .duo.big { font-weight: 700; letter-spacing: -0.055em; text-shadow: 0 6px 26px rgba(0,0,0,.4); }
  .duo.ser { font-family: "${cap.serifFont ?? "Instrument Serif"}", Georgia, serif; font-style: italic; font-weight: 400; letter-spacing: -0.02em; }`
  : cap.style === "hormozi"
  ? `.cap-group { font-family: Montserrat, ${UI_FONT}, system-ui, sans-serif; font-size: ${cap.size ?? 60}px; font-weight: 500; color: #fff; letter-spacing: -.5px; line-height: 1.2; max-width: 900px; text-shadow: 0 2px 10px rgba(0,0,0,.7), 0 0 2px rgba(0,0,0,.6); }
     .cap-group .w { margin: 0 .12em; } .cap-group .w.emph { font-weight: 800; }`
  : cap.style === "lux"
  ? `.cap-group { font-family: Montserrat, ${UI_FONT}, system-ui, sans-serif; font-size: ${cap.size ?? 46}px; font-weight: 700; color: #fff; letter-spacing: .02em; line-height: 1.25; max-width: 860px; text-shadow: 0 0 10px rgba(255,255,255,.35), 0 2px 10px rgba(0,0,0,.65); }
     .cap-group .w { margin: 0 .14em; } .cap-group .w.emph { font-size: 1.5em; font-weight: 800; vertical-align: -.08em; text-shadow: 0 0 18px rgba(255,236,200,.65), 0 0 40px rgba(255,190,120,.35), 0 2px 12px rgba(0,0,0,.6); }`
  : cap.style === "glow"
  ? `.gw { position: absolute; left: 50%; transform: translateX(-50%); white-space: nowrap; text-align: center; font-family: ${cap.font ?? "Montserrat"}, Inter, sans-serif; font-weight: 800; letter-spacing: 0.01em; line-height: 1; text-shadow: 0 0 14px ${cap.glow ?? rgbaOf(cap.color ?? brand.accent, 0.75)}, 0 0 36px ${cap.glow2 ?? rgbaOf(cap.color ?? brand.accent, 0.45)}, 0 3px 10px rgba(0,0,0,.55); }`
  : cap.style === "noir"
  ? `.cap-group { font-family: 'Instrument Serif', 'EB Garamond', Georgia, serif; font-size: ${cap.size ?? 54}px; font-weight: 400; color: #F2EFE8; letter-spacing: .01em; line-height: 1.12; max-width: 900px; text-shadow: 0 1px 6px rgba(0,0,0,.8); }
     .cap-group .w { margin: 0 .12em; } .cap-group .w.emph { font-style: italic; color: ${cap.gold ?? "#E2BE6A"}; text-shadow: 0 0 14px rgba(226,190,106,.45), 0 1px 6px rgba(0,0,0,.8); }`
  : cap.style === "clean"
  ? `.cap-group { font-family: ${UI_FONT}, "Noto Sans Arabic", system-ui, sans-serif; font-size: ${cap.size ?? brand.capSize}px; font-weight: 800; color: #fff; letter-spacing: -1px; text-shadow: 0 4px 18px rgba(0,0,0,.55), 0 1px 3px rgba(0,0,0,.6); }`
  : cap.style === "pill"
  ? (cap.pillKit
    // captions.pillKit (opt-in; Explainer r1): size / light (white pill, dark ink) / radius, and words that inherit the pill's ink
    ? `.cap-group { font-family: ${UI_FONT}, "Noto Sans Arabic", system-ui, sans-serif; font-size: ${cap.size ?? 66}px; font-weight: 800; color: ${cap.light ? "#111" : "#fff"}; background: ${cap.light ? "rgba(255,255,255,.96)" : "rgba(12,12,14,.88)"}; border-radius: ${cap.radius ?? 22}px; padding: ${cap.light ? "10px 26px 14px" : "16px 32px"}; max-width: 900px; letter-spacing: ${cap.light ? "-0.02em" : "normal"}; box-shadow: ${cap.light ? "0 6px 18px rgba(0,0,0,.25)" : "none"}; }
  .cap-group .w { color: inherit !important; }`
    : `.cap-group { font-family: ${UI_FONT}, "Noto Sans Arabic", system-ui, sans-serif; font-size: 66px; font-weight: 800; color: #fff; background: rgba(12,12,14,.88); border-radius: 22px; padding: 16px 32px; max-width: 900px; }`)
  : cap.style === "box"
  ? `.cap-group { font-family: ${brand.font || "Montserrat"}, "Noto Sans Arabic", system-ui, sans-serif; font-size: ${CAP_SIZES.box}px; font-weight: 900; line-height: 1.08; color: ${cap.ink ?? brand.ink ?? "#111"}; background: ${cap.boxColor ?? brand.accent}; border-radius: 12px; padding: 10px 24px 14px; max-width: 860px; text-align: center; box-shadow: 0 10px 28px rgba(0,0,0,.28); }
  .cap-group .w { margin: 0 ${cap.wordGap ?? "0.14em"}; }`
  : cap.style === "condensed"
  ? `.cap-group { font-family: ${cap.font ?? "Oswald"}, "Noto Sans Arabic", sans-serif; font-size: ${CAP_SIZES.condensed}px; font-weight: 700; line-height: .95; letter-spacing: 1px; color: ${cap.color ?? "#fff"}; max-width: 920px; text-align: center; text-shadow: 0 6px 22px rgba(0,0,0,.6), 0 2px 4px rgba(0,0,0,.7); }`
  : cap.style === "clipping"
  // the box is on the inner .cap-in; its -20px side margins cancel its 20px padding, so the outer group's width and
  // max-width (and so where lines wrap and where the box is centred) are what they were when the box was the group
  ? `.cap-group { font-family: Gloock, "Noto Sans Arabic", Georgia, serif; font-size: ${cap.size ?? 58}px; line-height: 1.08; letter-spacing: -0.01em; color: #fbf8f1; max-width: 900px; text-align: center; }
  .cap-in { margin: 0 -20px; background: #141210; padding: 6px 20px 12px; box-shadow: 0 10px 22px rgba(0,0,0,.35); }
  .cap-group .w { margin: 0 0.12em; }`
  : cap.style === "sessions"
  // R1b port: restyled to match editorial-collage's locked look (shares this style key with alif.json,
  // which had no CATALOG.md-tracked caption rate and no fixture dependency - see R1b's report for the tradeoff)
  ? `.cap-group { font-family: "${cap.font ?? "Instrument Serif"}", "Noto Sans Arabic", Georgia, serif; font-size: ${CAP_SIZES.sessions}px; font-weight: 400; line-height: 1.12; letter-spacing: -0.05em; color: #fff; max-width: 860px; text-align: center; -webkit-text-stroke: 0.2px #fff; text-shadow: 0 0 8px rgba(255,255,255,.4), 0 0 1px rgba(255,255,255,.85); }
  .cap-group { background: rgba(98,98,104,.6); padding: 5px 14px 10px; border-radius: 1px; }
  .cap-group .w { margin: 0 0.055em; }`
  : cap.style === "serif"
  ? `.cap-group { font-family: ${cap.font ?? "EB Garamond"}, "Noto Sans Arabic", Georgia, serif; font-size: ${CAP_SIZES.serif}px; font-weight: 500; line-height: 1.15; color: ${cap.color ?? "#E7C66B"}; max-width: 900px; text-align: center; text-shadow: ${cap.shadow === "strong" ? "0 1px 2px rgba(0,0,0,.9), 0 3px 9px rgba(0,0,0,.75), 0 6px 26px rgba(0,0,0,.6)" : "0 2px 12px rgba(0,0,0,.55)"}; }
  .cap-group .w { margin: 0 0.12em; }${cap.scrim ? `
  /* captions.scrim (0-1, opt-in; Ahmed's The Monk 2): a soft dark radial scrim behind each caption, no hard box */
  .cap-group::before { content: ""; position: absolute; z-index: -1; left: -170px; right: -170px; top: -80px; bottom: -70px; pointer-events: none; background: radial-gradient(ellipse at 50% 50%, rgba(0,0,0,${cap.scrim}) 0%, rgba(0,0,0,${(cap.scrim * 0.55).toFixed(2)}) 45%, rgba(0,0,0,0) 78%); }` : ""}`
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

// ---------- layers (reel.layers[]; lib/layers.mjs) ----------
// Two containers, both their own stacking context: #layers sits above the footage and the beats' .layer band
// (z 3) and below the captions (z 8); #layers-top (overCaptions) above them. Within one, `z` then array order.
let layersUnderHtml = "", layersOverHtml = "", layerAudioHtml = "";
if (LAYERS.length) {
  const resolveLayerImage = (src) => {
    if (/^assets\/[^\0]+\.(png|jpe?g|webp|gif|svg)$/i.test(src) && !src.split("/").includes("..")) {
      const full = path.resolve(proj, src);
      return full.startsWith(A + path.sep) && fs.existsSync(full) ? src : null;
    }
    return /^[a-z0-9-]{1,48}$/.test(src) && fs.existsSync(path.join(LIB, "art", `${src}.jpg`)) ? artAsset(src) : null;
  };
  const under = [], over = [];
  for (const l of [...LAYERS].sort((x, y) => x.z - y.z || x.index - y.index)) {
    if (SECTION_MODE && !(l.t0 >= SECTION_START - 1e-6 && l.t0 < SECTION_END - 1e-6)) continue;   // another section's layer
    // mac-55: a motion layer's left-out elements and tweens are recorded like a beat's (the layer itself never drops: it dies)
    const compileLayerMotion = (beat, c) => { const mg = compileMotion(beat, c); if (mg.ok) recordMotionParts({ id: l.id, type: "motion layer", at: l.at, to: l.to ?? null }, mg, l.t0); return mg; };
    const r = renderLayer(l, { W, H, brand, uiFont: UI_FONT, esc, compileMotion: compileLayerMotion, resolveColor, resolveImage: resolveLayerImage, off: SECTION_MODE ? SECTION_START : 0 }, l.index);
    for (const m of r.warnings) warn.push(m);
    if (r.dropped) continue;
    if (l.kind === "graphic" && l.graphic.mode === "overlay" && crossesUi(l.box, PLATFORMS[platform], W, H)) warn.push(`layer ${l.id}: ${graphicReason("GW7", { platform: PLATFORMS[platform].name })}`);
    for (const line of r.lines) tl.push(line);
    (l.overCaptions ? over : under).push(r.html);
    if (r.audio) layerAudioHtml += `
  ${r.audio}`;
  }
  if (under.length) layersUnderHtml = `<div id="layers" class="lyr" style="z-index:4">${under.join("")}</div>
  `;
  if (over.length) layersOverHtml = `
  <div id="layers-top" class="lyr" style="z-index:9">${over.join("")}</div>`;
}

// ---------- watermark (spec.watermark = { text, opacity?, font? }) and colour tint (spec.look.tint) ----------
let brandHtml = "";
const TOP_UI = Math.round(H * 0.08);   // nothing static in the top 8% (phone status bar / app header)
// watermark.spread (opt-in): the header words spread across the full width, one span each (Magazine Spread's header row)
if (spec.watermark?.text && spec.watermark.spread) brandHtml += `<div style="position:absolute;top:${Math.max(TOP_UI, spec.watermark.y ?? 120)}px;left:${spec.watermark.x ?? 60}px;right:${spec.watermark.x ?? 60}px;display:flex;justify-content:space-between;z-index:9;font-family:'${spec.watermark.font ?? "Inter"}',system-ui,sans-serif;font-weight:600;font-size:${spec.watermark.size ?? 24}px;letter-spacing:0.04em;color:#fff;opacity:${spec.watermark.opacity ?? 0.9};pointer-events:none">${String(spec.watermark.text).replace(/ /g, " ").trim().split(/\s+/).map((w) => `<span>${esc(w)}</span>`).join("")}</div>`;
else if (spec.watermark?.text) brandHtml += `<div style="position:absolute;top:${Math.max(TOP_UI, spec.watermark.y ?? 120)}px;right:${spec.watermark.x ?? 60}px;z-index:9;font-family:'${spec.watermark.font ?? "Instrument Serif"}',Georgia,serif;font-size:${spec.watermark.size ?? 54}px;letter-spacing:-0.5px;color:#fff;opacity:${spec.watermark.opacity ?? 0.38};pointer-events:none">${esc(spec.watermark.text)}</div>`;
// a pinned show logo top-left (podcast): small spaced caps over one big word
if (spec.showLogo) brandHtml += `<div class="show-logo" style="left:${spec.showLogo.x ?? 70}px;top:${spec.showLogo.y ?? 150}px;opacity:${spec.showLogo.opacity ?? 0.92}"><i>${esc(spec.showLogo.small ?? "")}</i><b>${esc(spec.showLogo.big ?? "")}</b></div>`;
if (spec.look?.tint) brandHtml += `<div${LOOK_OV ? ' class="look-ov"' : ""} style="position:absolute;inset:0;z-index:3;pointer-events:none;background:${spec.look.tint.color ?? "#1d6b75"};mix-blend-mode:${spec.look.tint.blend ?? "soft-light"};opacity:${spec.look.tint.opacity ?? 0.22}"></div>`;
// look.target {sat, luma, satGain, satMin, satMax, lumaMin, lumaMax} (opt-in; Ahmed's engine/core): steer the grade toward the template's
// measured look on THIS footage. The clip's own saturation/luma (look_stats.py, kept takes of the PRIMARY recording only) are pushed
// through the style grade's saturate/brightness/contrast, and one extra saturate()+brightness() closes the gap (clamped, so a grey clip is
// never forced to neon). If the clip cannot be measured (no python with OpenCV) the style grade is used as is, with a warning.
if (spec.look?.target) {
  const g = spec.look.grade && spec.look.grade !== "none" ? spec.look.grade : "";
  const fnum = (name, dflt) => { const m = new RegExp(`${name}\\(([\\d.]+)\\)`).exec(g); return m ? parseFloat(m[1]) : dflt; };
  try {
    if (SOURCES.length > 1) warn.push(`look.target: measured on the primary recording (${SRC}) only; the ${SOURCES.length - 1} other recording(s) are graded by the same numbers`);
    const stats = path.join(path.dirname(fileURLToPath(import.meta.url)), "look_stats.py");
    const venv = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".venv");
    // python is not "python3" everywhere: .venv first (Scripts\python.exe on Windows, bin/python elsewhere), then the launchers
    const pys = [path.join(venv, "Scripts", "python.exe"), path.join(venv, "bin", "python")].filter((p) => fs.existsSync(p))
      .concat(process.platform === "win32" ? ["py", "python"] : ["python3", "python"]);
    const args = [stats, path.resolve(proj, SRC), "--takes", JSON.stringify(takes.filter((k) => k.src === SRC).map((k) => [k.a, k.b]))];
    let st = null, lastErr = "";
    for (const py of pys) {
      try { st = JSON.parse(execFileSync(py, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); break; } catch (e) { lastErr = String(e.stderr || e.message); }
    }
    if (!st) throw new Error(lastErr.trim().split("\n").at(-1) || "no python found");
    const T = spec.look.target, clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    // satGain: how much the finished reel's saturation exceeds the grade's prediction for this template
    // (contrast, tint, coloured captions and cards), calibrated from held-out renders
    const predSat = st.sat * fnum("saturate", 1) * (T.satGain ?? 1), predLuma = ((st.luma * fnum("brightness", 1)) - 128) * fnum("contrast", 1) + 128;
    const ks = T.sat ? clamp(T.sat / Math.max(1, predSat), T.satMin ?? 0.55, T.satMax ?? 1.3) : 1;
    const kb = T.luma ? clamp(T.luma / Math.max(1, predLuma), T.lumaMin ?? 0.75, T.lumaMax ?? 1.2) : 1;
    spec.look.grade = `${g} saturate(${ks.toFixed(3)}) brightness(${kb.toFixed(3)})`.trim();
    console.log(`look target: clip sat ${st.sat} luma ${st.luma} -> predicted ${predSat.toFixed(0)}/${predLuma.toFixed(0)}, target ${T.sat ?? "-"}/${T.luma ?? "-"}: saturate ${ks.toFixed(2)} brightness ${kb.toFixed(2)}`);
  } catch (e) { warn.push(`look.target: could not measure the clip (${String(e.message).slice(0, 80)}); style grade used as is`); }
  // fill the mood placeholder (a mood beat written before the target was measured); never leave __LOOK_GRADE__ in the page
  for (let i = 0; i < tl.length; i++) if (typeof tl[i] === "string" && tl[i].includes("__LOOK_GRADE__")) tl[i] = tl[i].replaceAll("__LOOK_GRADE__", spec.look.grade ?? "").replace('filter: " grayscale', 'filter: "grayscale').replace('filter: "" }', 'filter: "none" }');
}
if (spec.look?.grade) tl.push(`tl.set("#base", { filter: "${spec.look.grade}" }, 0);`);
if (premiumDefs.length) brandHtml += premiumDefs.join("");

// ---------- light leaks (spec.leaks = { every, color?, at? }) ----------
// A warm burn-through flash that hides a cut between sections. Auto: on take joins, spaced by `every` seconds.
let leakHtml = "";
if (spec.leaks) {
  const every = spec.leaks.every ?? 8, color = spec.leaks.color ?? "255,176,64";
  const times = spec.leaks.at ? spec.leaks.at.map((t) => E(t, "leak")) : [];
  if (!spec.leaks.at) {
    let last = -Infinity;
    for (const k of takes.slice(1)) if (k.start - last >= every && k.start > 2 && k.start < SPEECH - 2) { times.push(r3(k.start)); last = k.start; }
    // ---- leaks.sentenceFallback (opt-in; Ahmed's Keynote hardening f88943d): a one-take clip has no joins, so put the flash
    // on sentence ends (whisper word gaps are unreliable, so punctuation decides); with no punctuation, the biggest word gap
    // inside each stretch. Works on the edit-time `words` list, so it is source-agnostic.
    if (spec.leaks.sentenceFallback) {
      const want = Math.floor((SPEECH - 4) / (every + 3));
      for (let i = 0; i + 1 < words.length && times.length < want; i++) {
        const gap = words[i + 1].start - words[i].end, t = words[i].end + gap / 2;
        if (/[.?!]$/.test(words[i].word) && t > 3 && t < SPEECH - 3 && times.every((x) => Math.abs(x - t) >= every)) times.push(r3(t));
      }
      for (let c = 6; c < SPEECH - 4 && times.length < want; c += every + 3) {
        if (times.some((x) => Math.abs(x - c) < every)) continue;
        let best = null;
        for (let i = 0; i + 1 < words.length; i++) { const t = (words[i].end + words[i + 1].start) / 2, gap = words[i + 1].start - words[i].end; if (Math.abs(t - c) <= 2 && (!best || gap > best.gap)) best = { t, gap }; }
        if (best && times.every((x) => Math.abs(x - best.t) >= every)) times.push(r3(best.t));
      }
      times.sort((a, b) => a - b);
    }
  }
  // ---- leaks.faceSafe (opt-in): the flash is masked out over the speaker's face. Per source: the median face box of the
  // recording that is on screen at time t (its own face track and crop plan); a source with no track gets no mask.
  const leakMaskAt = (t) => {
    if (!spec.leaks.faceSafe) return "";
    const k = locateTake(takes, Math.min(t, TOTAL - 0.01), FPS), fs_ = ((faces[k.src] || {}).samples || []).filter((s) => s[1] != null);
    if (!fs_.length) return "";
    const { scale: cs, offsetX: cox, offsetY: coy } = crops[k.src] || { scale: 1, offsetX: 0, offsetY: 0 };
    const med = (i) => fs_.map((s) => s[i]).sort((a, b) => a - b)[Math.floor(fs_.length / 2)];
    const cx = ((med(3) + med(4)) / 2 * cs + cox) / W * 100, cy = ((med(1) + med(2)) / 2 * cs + coy) / H * 100, rx = (med(4) - med(3)) * cs / W * 100 * (spec.leaks.maskScale ?? 1.5), ry = (med(2) - med(1)) * cs / H * 100 * (spec.leaks.maskScale != null ? spec.leaks.maskScale * 0.93 : 1.4);   // leaks.maskScale (opt-in; Ahmed's Keynote 3, ff71824): the face hole vs the face box. A close-up face fills the frame, so 1.5x hid the whole flash
    const g = `radial-gradient(ellipse ${rx.toFixed(1)}% ${ry.toFixed(1)}% at ${cx.toFixed(1)}% ${cy.toFixed(1)}%, transparent 55%, #000 100%)`;
    return `-webkit-mask-image:${g};mask-image:${g};`;
  };
  const leakPeak = spec.leaks.peak ?? 1;   // leaks.peak / x / y (opt-in): flash strength and where its glow sits
  times.forEach((t, i) => {
    const clip = packOf && packClip(packOf, "leaks");
    // Alif: a flash is never silent; the whoosh rides it
    if (spec.sound?.leaks) addSfx(t - 0.3, spec.sound.leakSfx ?? "whoosh-cine", "light leak", { db: spec.sound.leakDb ?? -12 });
    if (clip) { packOverlay(clip, t - 0.35, 1.3, { blend: "screen", z: 7, opacity: 1, media: spec.leaks.media ?? 1.2, fadeIn: 0.25, fadeOut: 0.5, filter: spec.leaks.boost ?? "brightness(1.9) saturate(1.25)" }); return; }
    // leaks.shape "edge" / leaks.blend / leaks.hold / leaks.fadeOut (all opt-in; Ahmed's Keynote 3, ff71824). Defaults reproduce the old
    // flash exactly: a centred glow, blend "screen", 0.9 s clip, a 0.55 s burn-out right after the peak. "edge" is a warm orange burn
    // entering from one frame edge (alternating sides), never the centre; hold keeps the peak, fadeOut is a slower burn-out.
    const lHold = spec.leaks.hold ?? 0, lOut = spec.leaks.fadeOut ?? 0.55;
    const leakBg = spec.leaks.shape === "edge"
      ? `radial-gradient(ellipse 95% 75% at ${i % 2 ? 100 : 0}% ${spec.leaks.y ?? 38}%, rgba(255,150,40,0.95) 0%, rgba(255,105,25,0.55) 38%, rgba(255,80,10,0) 78%)`
      : `radial-gradient(ellipse 120% 90% at ${spec.leaks.x ?? 30}% ${spec.leaks.y ?? 40}%, rgba(${color},0.95) 0%, rgba(${color},0.55) 35%, rgba(255,90,20,0.18) 70%, rgba(0,0,0,0) 100%)`;
    leakHtml += `<div id="leak${i}" class="clip" data-start="${r3(Math.max(0, t - 0.25))}" data-duration="${r3(0.9 + lHold + Math.max(0, lOut - 0.55))}" data-track-index="10" style="position:absolute;inset:0;z-index:7;pointer-events:none;mix-blend-mode:${spec.leaks.blend ?? "screen"};opacity:0;${leakMaskAt(t)}background:${leakBg}"></div>`;
    tl.push(`ft("#leak${i}", { opacity: 0 }, { opacity: ${leakPeak}, duration: 0.22, ease: "power2.in" }, ${r3(Math.max(0, t - 0.22))});`);
    tl.push(`tl.to("#leak${i}", { opacity: 0, duration: ${lOut}, ease: "power2.out" }, ${r3(t + 0.05 + lHold)});`);
  });
  if (times.length) console.log(`light leaks: ${times.length} at ${times.join(", ")}`);
}

// ---------- 8mm film gate over B-roll scenes (scene option gate: "8mm", or spec.scenes.<kind>.gate) ----------
if (packOf) for (const b of beatsList) {
  const sd = (spec.scenes || {})[b.kind] || {};
  if (b.type !== "scene" || (b.gate ?? sd.gate) !== "8mm") continue;
  const t0 = EB(b, "at"), t1 = EB(b, "to");
  const matte = packClip(packOf, "8mm-gate"), dust = packClip(packOf, "8mm-dust");
  if (matte) packOverlay(matte, t0, t1 - t0, { blend: "multiply", z: 6, opacity: 1, fadeIn: 0.05, fadeOut: 0.1 });
  if (dust) packOverlay(dust, t0, t1 - t0, { blend: "screen", z: 6, opacity: 0.7, fadeIn: 0.05, fadeOut: 0.1 });
}

// ---------- film burns (spec.burns = { at?, onScenes? }) ----------
if (spec.burns && packOf) {
  const times = (spec.burns.at || []).map((t) => E(t, "burn"));
  if (spec.burns.onScenes) for (const b of beatsList) if (b.type === "scene" && ["image", "window", "tv"].includes(b.kind)) times.push(EB(b, "at"));
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
    brandFlash({ ...spec.openFlash, dur: sf.dur ?? 0.35, db: sf.db ?? -10, sfx: sf.sfxIn ?? spec.openFlash.sfx }, r3(Math.max(0, EB(b, "at") - 0.12)), "burn into cutaway");
    if (sf.out !== false) brandFlash({ ...spec.openFlash, dur: sf.dur ?? 0.35, db: (sf.db ?? -10) - 3, sfx: sf.sfxOut ?? spec.openFlash.sfx }, r3(EB(b, "to") - 0.2), "burn out to speaker", { side: "right" });
  }
}
if (spec.openFlash) {
  // default = the reel's first frame: the start of the first take in OUTPUT order. It used to be E(0) (source
  // time 0), which threw "not inside any take" when the first take starts after 0 (e.g. a = 0.05) and
  // pointed at the wrong take on a reordered edit. inTake(takes[0], a) is exactly what E(0) returned whenever
  // the first take starts at source 0, so those reels build byte-identically.
  const f = spec.openFlash, t = f.at == null ? +inTake(takes[0], takes[0].a).toFixed(3) : E(f.at, "open flash"), dur = f.dur ?? 0.4;
  const [c1, c2] = f.color ?? ["255,92,40", "255,150,120"];
  leakHtml += `<div id="oflash" class="clip" data-start="${r3(t)}" data-duration="${r3(dur)}" data-track-index="11" style="position:absolute;inset:0;z-index:8;pointer-events:none;mix-blend-mode:screen;opacity:0;background:radial-gradient(ellipse 70% 55% at 4% 74%, rgba(${c1},1) 0%, rgba(${c1},.85) 40%, rgba(${c1},0) 100%), radial-gradient(ellipse 45% 70% at 0% 30%, rgba(${c2},.85) 0%, rgba(${c2},0) 100%), linear-gradient(90deg, rgba(${c1},.55) 0%, rgba(${c1},0) 45%)"></div>`;
  tl.push(`ft("#oflash", { opacity: 0.6, xPercent: -25 }, { opacity: 1, xPercent: 0, duration: ${r3(dur * 0.25)}, ease: "power2.out" }, ${r3(t)});`);
  tl.push(`tl.to("#oflash", { opacity: 0, xPercent: -20, duration: ${r3(dur * 0.55)}, ease: "power2.in" }, ${r3(t + dur * 0.4)});`);
  const pickBurn = (name) => {
    const src = path.join(LIB, "packs", packOf, "burns", name);
    // openFlash.clipOptional (opt-in; Folio, mini2): a licensed pack that is not restored here must not fail the build - the brand-colour
    // flash still plays, only the burn texture on top of it is skipped
    if (!fs.existsSync(src) && f.clipOptional) { console.log(`WARNING openFlash.clip '${name}' is not in packs/${packOf}/burns; flash without the burn texture`); return null; }
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

// ---------- end fade (spec.endFade, opt-in: seconds; Folio, mini2) ----------
// the picture dips to black over the last endFade seconds, so the reel never stops on a frozen frame
if (spec.endFade) {
  const fd = Math.min(spec.endFade, TOTAL - 0.1);
  leakHtml += `<div id="endfade" class="clip" data-start="${r3(TOTAL - fd)}" data-duration="${r3(fd)}" data-track-index="16" style="position:absolute;inset:0;z-index:50;background:#000;opacity:0;pointer-events:none"></div>`;
  tl.push(`ft("#endfade", { opacity: 0 }, { opacity: 1, duration: ${r3(fd)}, ease: "power1.in" }, ${r3(TOTAL - fd)});`);
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
  const scenes = beatsList.filter((b) => b.type === "scene").map((b) => [EB(b, "at"), EB(b, "to")]);
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
  const scenes = beatsList.filter((b) => b.type === "scene").map((b) => [EB(b, "at"), EB(b, "to")]);
  const shown = [];
  fs.mkdirSync(path.join(A, "logos"), { recursive: true });
  words.forEach((w) => {
    const key = w.word.toLowerCase().replace(/[^a-z0-9]/g, "");
    const brand2 = BRANDS.find(([re]) => re.test(key));
    if (!brand2) return;
    const [, slug, color] = brand2, t = r3(Math.max(0, w.start - 0.05));
    if (shown.some((m) => m.slug === slug && t - m.t < 8)) return;       // named twice in a row: one tile
    const svg = path.join(A, "logos", `${slug}.svg`);
    if (!fs.existsSync(svg)) {   // from vendor/simple-icons, never fetched
      const body = vendoredIcon("simple-icons", slug);
      if (body == null) { warn.push(`no logo for ${slug}`); return; }
      fs.writeFileSync(svg, body);
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
  const busy = beatsList.filter((b) => b.type === "scene" || b.type === "nametag" || b.type === "slam").map((b) => [EB(b, "at") - 0.6, EB(b, "to") + 0.8]);
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
    // objectPops.faceAware (opt-in; Folio, mini2): the card goes in the reaction slot beside the head of the recording on screen at t
    // (placer.slot is per source) instead of the fixed top-right spot, and is skipped when the face fills the frame
    let px = P.x ?? 720, py = P.y ?? 300, psc = 1;
    if (P.faceAware) {
      const sl = placer.slot(t, t + hold, w, Math.round(w * 1.25));
      if (!sl) continue;
      px = sl.x; py = sl.y; psc = sl.scale ?? 1;
      if (psc < (P.minScale ?? 0.6)) continue;
    }
    const wq = psc === 1 ? w : Math.round(w * psc);
    const id = `op${k++}`, rot = k % 2 ? 4 : -5;
    // the label is what they said: "day-to-day", "time", "money" (a hyphenated phrase stays whole)
    const label = (words[i].word.toLowerCase().split(/\s+/).find((p) => p.replace(/[^a-z0-9]/g, "") === one) || one).replace(/[^a-z0-9'-]/g, "");
    const src = userAsset(path.join(LIB, "engravings", "png", `${obj}.png`));
    leakHtml += `<div id="${id}" class="clip" data-start="${t}" data-duration="${r3(hold + 0.3)}" data-track-index="15" style="position:absolute;left:${px}px;top:${py}px;width:${wq}px;z-index:9;pointer-events:none;transform:rotate(${rot}deg)">
      <div style="background:#efece4;padding:${Math.round(wq * 0.07)}px;border-radius:6px;box-shadow:0 16px 36px rgba(0,0,0,.32), 0 2px 0 rgba(255,255,255,.4) inset"><img src="${src}" style="display:block;width:100%"/></div>
      <div id="${id}-lab" style="display:inline-block;position:relative;margin:${psc === 1 ? -26 : Math.round(-26 * psc)}px 0 0 ${Math.round(wq * 0.12)}px;padding:2px 16px 8px 12px;background:${brand.accent};color:#f4efe6;font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:${psc === 1 ? (P.labelSize ?? 58) : Math.round((P.labelSize ?? 58) * Math.max(psc, 0.8))}px;letter-spacing:-0.04em;line-height:1;white-space:nowrap;transform:rotate(${-rot * 0.6}deg);box-shadow:0 10px 22px rgba(0,0,0,.25)">${esc(label)}</div></div>`;
    tl.push(`ft("#${id}-lab", { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: 0.3, ease: "power2.out" }, ${r3(t + 0.18)});`);
    tl.push(`ft("#${id}", { autoAlpha: 0, scale: 0.55, y: 30 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.3, ease: "back.out(1.8)" }, ${t});`);
    tl.push(`tl.to("#${id}", { autoAlpha: 0, scale: 0.85, y: -10, duration: 0.22, ease: "power2.in" }, ${r3(t + hold)});`);
    // A21: route through the same `spec.sound.<feature> !== false` opt-out `nametag` etc. use (:863,
    // :880) - this pop-up used to be unconditional, so the only way to silence it was spec.objectPops:
    // false, which also removes the visual.
    if (spec.sound?.objects !== false) {
      addSfx(t, "paper-quick", `pop-up in: ${obj}`, { db: -6 });
      const [sfx, hero] = OBJECT_SFX_BUILD[obj] || [];
      if (sfx) addSfx(t + 0.08, sfx, `pop-up: ${obj}`, { db: hero ? 8 : 0 });
    }
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
    const a = EB(b, "at"), z = EB(b, "to");
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

  // A26: a full-frame scene draws its own heading in the same band as the banner, so the two
  // collide - measured on a monologue reel where the banner sat across a paper page's serif line,
  // both legible, neither readable. Neither layer is wrong on its own, which is why nothing caught
  // it. The banner yields: it is the persistent furniture, the page is the moment.
  //
  // Scene beats are the full-frame carriers, the same set build.mjs already keeps the zoom swish
  // out of (see the music-bed block below). Spans are merged first so two adjacent pages do not
  // make the banner flash back on for a few frames between them, and clamped to the banner's own
  // window so a scene before `from` or after `to` pushes no tween at all.
  if (spec.banner.hideOnScenes !== false) {
    const raw = beatsList.filter((b) => b.type === "scene" && typeof b.at === "number")
      .map((b) => [EB(b, "at") - 0.12, EB(b, b.to !== undefined ? "to" : "at") + 0.12])
      .filter(([a, z]) => z > from && a < to)
      .map(([a, z]) => [Math.max(a, from), Math.min(z, to)])
      .sort((x, y) => x[0] - y[0]);
    const spans = [];
    for (const [a, z] of raw) {
      const last = spans[spans.length - 1];
      if (last && a <= last[1] + 0.25) last[1] = Math.max(last[1], z);
      else spans.push([a, z]);
    }
    for (const [a, z] of spans) {
      tl.push(`tl.to("#title-banner", { autoAlpha: 0, duration: 0.16, ease: "power2.in" }, ${r3(a)});`);
      if (z < to - 0.2) tl.push(`tl.to("#title-banner", { autoAlpha: 1, duration: 0.16, ease: "power2.out" }, ${r3(z)});`);
    }
    if (spans.length) console.log(`banner: hidden across ${spans.length} full-frame scene span(s)`);
  }
}

// ---------- music bed ----------
let musicHtml = "";
// Alif: a punch-in is barely audible, a tiny air swish ~20 dB under the voice (not during full-screen scenes)
if (spec.sound?.zoom && cadenceSnaps.size) {
  const sceneWins = beatsList.filter((b) => b.type === "scene").map((b) => [EB(b, "at") - 0.1, EB(b, "to") + 0.1]);
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
  // ---- music.fallback (opt-in; Ahmed's a09781d): a bed that is not on disk (a licensed track not restored on this machine) falls
  // back to music.fallback when that one is, else the reel builds without music (the music.optional path below). Nothing happens
  // unless the style / reel sets `fallback`, so a missing bed with no fallback still fails loudly as before.
  if (spec.music.fallback && spec.music.id && !spec.music.src) {
    const man_ = JSON.parse(fs.readFileSync(path.join(LIB, "music", "manifest.json"), "utf8"));
    const onDisk = (id) => !!man_[id] && fs.existsSync(path.join(LIB, "music", man_[id].file));
    if (!onDisk(spec.music.id)) {
      const fb = onDisk(spec.music.fallback) ? spec.music.fallback : null;
      console.log(`WARNING music bed "${spec.music.id}" is not in library/music; ${fb ? `using fallback "${fb}"` : "rendering without music"}`);
      spec.music = fb ? { ...spec.music, id: fb } : { ...spec.music, optional: true };
    }
  }
  const drops = spec.music.drops;
  if (drops) {
    const times = [];
    if (drops === "auto" || drops.auto) {
      const scenes = beatsList.filter((b) => b.type === "scene").map((b) => EB(b, "at"));
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
  const lastScene = spec.music.payoffAt != null ? E(spec.music.payoffAt, "payoff") : beatsList.filter((b) => b.type === "scene").map((b) => EB(b, "at")).sort((a, b) => a - b).at(-1);
  if (lastScene && spec.music.payoff !== false && spec.music.drops) {
    const len = spec.music.dropLen ?? 0.5;
    addSfx(r3(lastScene - len - 1.25), spec.music.riserSfx ?? "riser-1", "riser into the payoff", { db: spec.music.riserDb ?? -2 });
    addSfx(r3(lastScene), spec.music.hitSfx ?? "cinematic-cine-hit", "payoff hit", { db: spec.music.hitDb ?? -6 });
  }
  // music.alignDrop (opt-in): the bed's own drop (a track second) lands on the drop's first cut; music.dropLift dB
  // raises the bed from there to the end (the voice has left)
  if (dropWin && spec.music.alignDrop != null) {
    spec.music = { ...spec.music, start: r3(Math.max(0, spec.music.alignDrop - dropWin[0])) };
    if (spec.music.dropLift) spec.music.lifts = [...(spec.music.lifts || []), { a: dropWin[0], b: TOTAL + 1, db: spec.music.dropLift, ramp: 0.03 }];
    console.log(`music: track ${spec.music.alignDrop}s lands on the drop at ${dropWin[0]}s (start ${spec.music.start}), lift ${spec.music.dropLift ?? 0} dB`);
  }
  // music.optional (opt-in, set by premium-noir): a bed whose audio is not shipped (library/music has the manifest, not the
  // mp3s - see buildMusic) is skipped with a warning instead of failing the build. Every other music spec still fails loudly.
  const musicMissing = spec.music.optional === true && spec.music.id && !spec.music.src && (() => {
    const man = JSON.parse(fs.readFileSync(path.join(LIB, "music", "manifest.json"), "utf8"));
    return !man[spec.music.id] || !fs.existsSync(path.join(LIB, "music", man[spec.music.id].file));
  })();
  if (musicMissing) {
    warn.push(`music '${spec.music.id}' is not available on disk (music.optional): the reel builds without a music bed`);
    console.log(`music: '${spec.music.id}' not on disk, skipped (music.optional)`);
  } else {
    const m = buildMusic(spec.music, motionCtx, execFileSync, path, fs);
    musicHtml = m.html;
    console.log(`music: ${spec.music.id || spec.music.src} at ${m.I} LUFS -> volume ${m.vol} (${spec.music.db ?? -20} dB under the voice)`);
  }
}

// style.master ({ lufs, ratio, threshold, lra, postLimit }) is Ahmed's final-master recipe (opt-in; mini2): written to build/master.json
// for a caller to hand to scripts/master.py (--lufs --ratio --threshold --lra --post-limit), or `master.py --from-json build/master.json`.
// master.fadeOut (opt-in; Ahmed's Monk 3 / Headline fix, phantasic 2023064): master.py fades the VOICE out, so the fade must END where
// speech ends (fadeEnd), not over the silent outro tail; without fadeOut the file is exactly what it was.
if (spec.master) fs.writeFileSync(path.join(proj, "build", "master.json"), JSON.stringify(spec.master.fadeOut ? { ...spec.master, fadeEnd: Math.round((SPEECH + 0.06) * 1000) / 1000 } : spec.master));

// Explainer (opt-in beats / scenes; hand port of phantasic engine/core): the CSS of the `effect` hook title and the `cutout` concept page.
// Written into index.html ONLY when such a beat / scene exists, so every other reel is byte-identical.
// Ahmed's library-bundle beats (boxline, like, label, pin) and Pitch's popcard and titlebox: their page CSS, written only when such a beat exists (so every other reel is byte-identical).
const LIBRARY_CSS = (beats_, spec_) => {
  const has = (t) => beats_.some((b) => b.type === t);
  return (spec_.showLogo ? `
  .show-logo { position: absolute; z-index: 9; color: #fff; font-family: Inter, system-ui, sans-serif; text-align: center; line-height: 1; pointer-events: none; text-shadow: 0 2px 10px rgba(0,0,0,.5); }
  .show-logo i { display: block; font-style: normal; font-weight: 700; font-size: 30px; letter-spacing: .12em; }
  .show-logo b { display: block; font-weight: 900; font-size: 64px; letter-spacing: -0.02em; }` : "")
  // popcard (Pitch pop cards; phantasic 2fba97c engine/core build.mjs + motion.mjs, lost in the b060367 / 54a2f04 port): the card
  // column centred by left 50% + the tween's xPercent -50, the white photo frame, the accent label under it; and the "bars" UI card's
  // bar (width, rounded top, grows from the bottom), which overrides the window-bar .ui-bar rule in MOTION_CSS. Scoped to .ui-bars on
  // purpose (main's rule is unscoped and also shrank a scene kind "ui" window card's title bar to 120 px)
  + (has("popcard") ? `
  .popcard { position: absolute; left: 50%; width: max-content; display: flex; flex-direction: column; align-items: center; perspective: 1200px; }
  .popcard-img { display: block; border-radius: 10px; border: 10px solid #fff; box-shadow: 0 26px 60px rgba(0,0,0,.45); }
  .popcard-lab { margin-top: 22px; font-family: Inter, system-ui, sans-serif; font-weight: 600; letter-spacing: -0.05em; color: #fff; padding: 4px 22px 10px; line-height: 1.05; white-space: nowrap; }` : "")
  + (beats_.some((b) => b.type === "popcard" && b.ui?.type === "bars") ? `
  .ui-bars .ui-bar { width: 120px; border-radius: 14px 14px 4px 4px; transform-origin: 50% 100%; }` : "")
  + (has("boxline") ? `
  .bx { position: absolute; background: #fff; color: #0b0b0b; font-family: Inter, system-ui, sans-serif; font-weight: 900; line-height: 1.02; letter-spacing: -0.02em; padding: 18px 26px 20px; text-align: center; box-shadow: 0 14px 40px rgba(0,0,0,.35); transform-origin: 50% 50%; }
  .bx-lab { position: absolute; display: flex; align-items: flex-start; gap: 6px; color: #fff; font-family: Inter, system-ui, sans-serif; font-weight: 700; font-size: 46px; text-shadow: 0 2px 10px rgba(0,0,0,.7); }
  .bx-lab svg { width: 90px; height: 70px; }` : "")
  + (has("like") ? `
  .lk { position: absolute; background: #1877F2; color: #fff; font-family: Inter, system-ui, sans-serif; font-weight: 700; font-size: 62px; padding: 12px 34px 16px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
  .lk-cur { position: absolute; width: 70px; height: 70px; }
  .lk-cur svg { width: 100%; height: 100%; filter: drop-shadow(0 3px 6px rgba(0,0,0,.5)); }` : "")
  + (has("label") ? `
  .lbl { position: absolute; left: 50%; display: inline-block; }
  .lbl-box { position: absolute; inset: 0; border-radius: 4px; }
  .lbl-txt { position: relative; color: #fff; font-family: "Instrument Serif", Georgia, serif; font-style: italic; font-size: 84px; line-height: 1; padding: 10px 30px 18px; white-space: nowrap; }` : "")
  // titlebox (Pitch hook title; phantasic 2fba97c engine/core build.mjs, lost in the b060367 port): left 50% + the tween's
  // xPercent -50 centre the box, which grows with the typed letters; without this rule the box sat at left 0, half off screen
  + (has("titlebox") ? `
  .tbox { position: absolute; left: 50%; transform-origin: 0% 50%; }
  .tbox-in { display: inline-block; color: #fff; font-family: Inter, system-ui, sans-serif; font-weight: 600; letter-spacing: -0.05em; line-height: 1.05; padding: 6px 22px 12px; white-space: nowrap; box-shadow: 0 10px 30px rgba(0,0,0,.25); }` : "")
  + (has("pin") ? `
  .pin { position: absolute; left: 50%; font-family: Inter, system-ui, sans-serif; font-weight: 800; letter-spacing: -0.06em; line-height: 1; white-space: nowrap; background: linear-gradient(90deg, #F0333A, #9B3BE8 50%, #2124E7); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 6px 20px rgba(0,0,0,.35)); }` : "");
};
const EXPLAINER_CSS = (spec_, beats_) => {
  const hasEffect = beats_.some((b) => b.type === "effect"), hasCut = beats_.some((b) => b.type === "scene" && b.kind === "cutout"), hasBd = beats_.some((b) => b.type === "scene" && (b.kind === "chapter" || b.kind === "title"));
  return (hasEffect ? `
  .ef { position: absolute; left: 0; right: 0; text-align: center; color: #fff; text-shadow: 0 3px 16px rgba(0,0,0,.55); }
  .ef-sm { font-family: Inter, system-ui, sans-serif; font-weight: 600; font-size: 54px; letter-spacing: .35em; margin: 6px 0; padding-left: .35em; }
  .ef-box { position: relative; display: inline-block; padding: 4px 30px 12px; margin: 4px 0; }
  .ef-box i { position: absolute; inset: 0; transform-origin: 0 50%; }
  .ef-box span { position: relative; font-family: "Playfair Display", Georgia, serif; font-weight: 800; font-size: 128px; letter-spacing: .04em; line-height: 1; color: #fff; text-shadow: none; }` : "")
  + (hasCut ? `
  .co-grain { position: absolute; inset: 0; }
  .co-art { position: absolute; left: 140px; right: 140px; top: 330px; height: 860px; overflow: hidden; box-shadow: 0 30px 60px rgba(0,0,0,.35); }
  .co-art img { width: 100%; height: 100%; object-fit: cover; filter: grayscale(1) contrast(1.2) brightness(1.02); }
  .co-art.eng { background: #F4EFE3; left: 170px; right: 170px; top: 360px; height: 800px; }
  .co-art.eng img { object-fit: contain; padding: 70px; box-sizing: border-box; mix-blend-mode: multiply; filter: grayscale(1) contrast(1.15); }
  .co-art.wd { display: flex; align-items: center; justify-content: center; }
  .co-word { font-family: "Playfair Display", Georgia, serif; font-weight: 800; color: #111; line-height: 1.02; letter-spacing: .02em; text-align: center; padding: 0 40px; white-space: nowrap; }
  .co-bars { position: absolute; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .co-bar { background: #0b0b0b; color: #fff; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 64px; letter-spacing: .02em; padding: 6px 20px 12px; white-space: nowrap; min-height: 1em; }
  .co-bar:empty { display: none; }` : "")
  + (hasBd ? `
  .ch-num { position: absolute; left: 0; right: 0; top: 50%; margin-top: -760px; height: 1520px; line-height: 1520px; text-align: center; font-family: "Instrument Serif", Georgia, serif; font-style: italic; font-size: 1400px; letter-spacing: -0.04em; }
  .ch-word { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); text-align: center; font-family: Inter, system-ui, sans-serif; font-weight: 600; font-size: 132px; letter-spacing: -0.05em; line-height: 1; white-space: nowrap; }
  .ch-word.ser { font-family: "Instrument Serif", Georgia, serif; font-style: italic; font-weight: 400; font-size: 160px; letter-spacing: -0.02em; }
  .ti-blk { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); text-align: center; transform-origin: 50% 50%; }
  .ti-line { font-family: "Instrument Serif", Georgia, serif; font-size: 190px; line-height: .92; letter-spacing: 0.01em; color: #fff; text-transform: uppercase; }` : "");
};

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
// headline beat (Podcast Glow) css: written only into a reel that has one, so every other page is unchanged
const HL_CSS = (spec.beats || []).some((b) => b.type === "headline") ? `
  .hl { position: absolute; pointer-events: none; }
  .hl-sh { position: absolute; left: 0; right: 0; top: 0; pointer-events: none; background: linear-gradient(180deg, rgba(0,0,0,.72) 0%, rgba(0,0,0,.45) 55%, rgba(0,0,0,0) 100%); }
  .hl-s { font-family: Montserrat, Inter, sans-serif; font-weight: 800; color: #fff; line-height: 1.02; letter-spacing: 0.005em; white-space: nowrap; text-shadow: 0 0 22px rgba(255,255,255,.28), 0 4px 16px rgba(0,0,0,.65); }
  .hl-s span { display: inline-block; }
  .hl-b { font-family: Anton, Oswald, sans-serif; font-weight: 400; line-height: .92; letter-spacing: 0.005em; white-space: nowrap; transform-origin: 50% 60%; text-shadow: 0 0 26px ${rgbaOf(cap.color ?? brand.accent, 0.55)}, 0 0 70px ${rgbaOf(cap.color ?? brand.accent, 0.35)}, 0 8px 22px rgba(0,0,0,.55); }
  .hl-ar { position: absolute; width: 170px; height: 215px; overflow: visible; filter: drop-shadow(0 0 10px ${rgbaOf(cap.color ?? brand.accent, 0.5)}); }` : "";
const look = spec.look || {};
// #fx is the optional blur / punch layer between #push and the footage (look.refocus, captions.energyPunch, look.fx). It is emitted ONLY
// when one of them is on. (The popcard defocus and the leak bloom also tween "#fx"; on a reel that has none of these keys they find no
// element and do nothing - as before.) look.fx === true (opt-in style key, set only in styles whose approved sample shows the popcard
// defocus / leak bloom) turns the layer on by itself, so those two tweens land.
const FX_ON = look.fx === true || !!look.refocus || (cap.style === "duo" && !!cap.energyPunch);
if (look.exposure && look.exposure !== 1) tl.push(`tl.set("#pip", { filter: "brightness(${look.exposure}) contrast(${look.contrast ?? 1.04})" }, 0);`);
const grainHtml = look.grain ? `<div id="grain" class="look-grain${OV}" style="opacity:${look.grain}"></div>` : "";
// spec.letterbox { h }: black cinema bars top + bottom (h px each, 9:16 pixels scaled to the format), above the picture and
// grain, under the captions (z 7; captions z 8, layers/watermark z 9)
const lbxH = spec.letterbox ? Math.round((spec.letterbox.h ?? 300) * H / 1920) : 0;
const letterboxHtml = spec.letterbox ? `<div class="lbx" style="position:absolute;left:0;right:0;top:0;height:${lbxH}px;background:#000;z-index:7"></div><div class="lbx" style="position:absolute;left:0;right:0;bottom:0;height:${lbxH}px;background:#000;z-index:7"></div>` : "";
const vignetteHtml = look.vignette ? `<div class="look-vignette${OV}" style="background:radial-gradient(ellipse at 50% 42%, rgba(0,0,0,0) 45%, rgba(0,0,0,${look.vignette}) 100%)"></div>` : "";
// matteWindows (opt-in, with matte): the 4 fps cut-out is only needed while a behind word or a ground page is up; left on for the
// whole reel it ghosts over the 30 fps plate, so it is shown only in those windows
if (spec.matte && spec.matteWindows && !spec.stage) {
  const wins = beatsList.map((b, i) => [b, beatSpans[i]]).filter(([b]) => ["behind", "ground"].includes(b.type)).map(([, sp]) => [sp.t0, sp.t1]).sort((p, q) => p[0] - q[0]);
  const merged = []; for (const w of wins) { const m = merged.at(-1); if (m && w[0] <= m[1] + 0.05) m[1] = Math.max(m[1], w[1]); else merged.push([...w]); }
  // never two sets on the same instant (a hide and a show both at 0 left the cut-out hidden in the render)
  if (!merged.length || merged[0][0] > 0.05) tl.push(`tl.set(".matte", { autoAlpha: 0 }, 0);`);
  for (const [a, b] of merged) { if (a > 0.05) tl.push(`tl.set(".matte", { autoAlpha: 1 }, ${r3(a - 0.02)});`); tl.push(`tl.set(".matte", { autoAlpha: 0 }, ${r3(b + 0.02)});`); }
  // matteClip (opt-in; glow.hookGround sets it): the cut-out <video> covers only those windows instead of every whole take, so the
  // renderer extracts (alpha, so PNG: ~1.4 MB a 1080x1920 frame) and pushes into Chrome only the frames that are shown. A take
  // transition tweens #matte-<i> as a whole, so a reel with one keeps the full-length cut-out.
  if (spec.matteClip) {
    if (takeJoins.length) warn.push("matteClip: this reel has take transitions (blur/whip), so the cut-out stays on its full takes");
    else {
      // the clipped pieces: [take, piece index, edit start, edit end, recording second at the start]
      const pieces = takes.flatMap((k, i) => (perSrcMatte && !stageMatted(k.src)) ? [] : merged.map(([a, b]) => [Math.max(k.start, a > 0.05 ? a - 0.02 : 0), Math.min(k.start + k.dur, b + 0.02)]).filter(([s, e]) => e - s > 0.5 / FPS).map(([s, e], j) => [k, i, j, s, e, k.a + (s - k.start)]));
      // window cut: the recording around every piece (+-1 s, frame-aligned, overlapping ones merged), in recording seconds
      let wins = [];
      if (windowCut) {
        for (const w of pieces.map(([, , , s, e, m0]) => [Math.max(0, Math.floor((m0 - 1) * FPS) / FPS), Math.ceil((m0 + (e - s) + 1) * FPS) / FPS]).sort((p, q) => p[0] - q[0])) { const m = wins.at(-1); if (m && w[0] <= m[1]) m[1] = Math.max(m[1], w[1]); else wins.push([...w]); }
        wins = wins.map(([a, b]) => ({ a, b, rel: `assets/talk-matte@${Math.round(a * 1000)}-${Math.round(b * 1000)}.webm` }));
        wins.forEach(cutWindow);
        // relight: each window cut-out carries the relit colour of the SAME frames (the relit file cut on the same frame indices)
        if (RELIGHT && relightable(SRC)) for (const w of wins) {
          try { w.rel = RL.ensureRelitMatte(proj, SRC, w.rel, mediaOf.get(SRC), { win: [Math.round(w.a * FPS), Math.round(w.b * FPS), FPS] }); } catch (e) { die(e.message); }
        }
      }
      // a piece reads the window file that holds it, else the whole-recording matte (cut now if it is not there)
      const srcOf = (k, m0, d) => {
        const w = wins.find((x) => x.a <= m0 + 1e-3 && m0 + d <= x.b + 1e-3);
        if (w) return [w.rel, r3(m0 - w.a)];
        cutMatte(path.resolve(proj, k.src), path.resolve(proj, matteCutOf(k.src)), k.src);
        relightMatte(k.src);
        return [matteRelOf(k.src), r3(m0)];
      };
      matteHtml = pieces.map(([k, i, j, s, e, m0]) => {
        const [src, ms] = srcOf(k, m0, e - s);
        return `
      <video id="matte-${i}${j ? `-${j}` : ""}" class="matte" src="${src}" data-start="${r3(s)}" data-duration="${r3(e - s)}" data-media-start="${ms}" data-track-index="2" muted playsinline></video>`;
      }).join("");
    }
  }
}
// ground pages (flat colour/paper behind the cut-out speaker) always skip the brand tint, so white stays white
for (const [a, b] of groundFlat) { tl.push(`tl.set(".look-ov", { visibility: "hidden" }, ${r3(a)});`); tl.push(`tl.set(".look-ov", { visibility: "visible" }, ${r3(b)});`); }
// look.cleanScenes: flat graphic pages (word pages, highlight pages) stay clean; the tint, vignette and grain belong to the camera picture only
if (look.cleanScenes) for (const [b, sp] of beatsList.map((b, i) => [b, beatSpans[i]]).filter(([b]) => (b.type === "scene" && ["wordpage", "highlight", "cardpage"].includes(b.kind)) || b.type === "mood" || b.type === "headpage" || b.type === "photostack")) {
  tl.push(`tl.set(".look-ov", { visibility: "hidden" }, ${r3(sp.t0)});`); tl.push(`tl.set(".look-ov", { visibility: "visible" }, ${r3(sp.t1)});`);
}
// look.refocus {blur, dur}: the video opens, and the camera comes back from every page, out of focus and pulls sharp
if (look.refocus) {
  const pulls = [0, ...beatsList.map((b, i) => [b, beatSpans[i]]).filter(([b]) => b.type === "scene" || b.type === "headpage" || b.type === "photostack").map(([, sp]) => sp.t1)].filter((t) => t < TOTAL - 0.3);
  // a pull that lands inside a popcard hold settles on the card's defocus (fxAim), not on sharp
  for (const t of pulls) { const h = fxAim(t, look.refocus.dur ?? 0.3); tl.push(`tl.fromTo("#fx", { filter: "blur(${look.refocus.blur ?? 14}px) brightness(${(h ?? fxIn(t))?.dim ?? 1})" }, { filter: "${fxRest(h)}", duration: ${look.refocus.dur ?? 0.3}, ease: "power2.out", immediateRender: ${t === 0} }, ${r3(t)});`); }
}
// captions.energyPunch {scale, blur} (duo only): every energy span opens with a zoom punch that smears for a few frames, then settles
if (cap.style === "duo" && cap.energyPunch) for (const [t] of energySpans) {
  // a punch that lands inside a popcard hold keeps the card's dim and settles on its defocus (fxAim), not on sharp
  const pt = r3(Math.max(0, t - 0.02)), ph = fxAim(pt, 0.28), pf = ph ?? fxIn(pt);
  tl.push(`tl.fromTo("#fx", { scale: ${cap.energyPunch.scale ?? 1.14}, filter: "blur(${pf ? Math.max(pf.blur, cap.energyPunch.blur ?? 7) : cap.energyPunch.blur ?? 7}px) brightness(${pf ? pf.dim : 1})" }, { scale: 1, filter: "${fxRest(ph)}", duration: 0.28, ease: "power3.out", immediateRender: false }, ${r3(Math.max(0, t - 0.02))});`);
  addSfx(Math.max(0, t - 0.02), "zoom-sweep-short", "energy punch", { db: spec.sound?.zoomDb ?? -10 });
}
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
  #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: ${spec.look?.rootBg ?? "#000"}; font-family: ${UI_FONT}, system-ui, sans-serif; }
  #base, #snap, #push { position: absolute; inset: 0; transform-origin: ${zoom.origin || "50% 29%"}; }
  #base { transform: scale(${zoom.base ?? 1});${zoom.originY !== undefined ? ` transform-origin: 50% ${zoom.originY}%;` : ""}${look.grade ? ` filter: ${look.grade};` : ""} }
  #pip { position: absolute; inset: 0; z-index: 1; transform-origin: ${W / 2}px ${faceY}px; }${roomWins.length ? `
  #roomfill { position: absolute; inset: 0; z-index: 1; opacity: 0; pointer-events: none; background: ${resolveColor(ROOM_FILL, brand)}; }
  #room { position: absolute; left: var(--room-ix, 0px); right: var(--room-ix, 0px); top: 0; bottom: var(--room-ib, 0px); z-index: 1; overflow: hidden; border-radius: var(--room-r, 0px); will-change: transform; transform-origin: 50% 0; }
  #roomin { position: absolute; left: calc(var(--room-ix, 0px) * -1); top: 0; width: ${W}px; height: ${H}px; }` : ""}
${FX_ON ? `  #fx { position: absolute; inset: 0; transform-origin: 540px ${faceY}px; filter: blur(0px) brightness(1); }\n` : ""}  .behind { position: absolute; inset: 0; pointer-events: none; }${HL_CSS}
  .behind-in { position: absolute; left: -40px; right: -40px; text-align: center; font-weight: 900; line-height: .86; letter-spacing: -6px; text-transform: uppercase; white-space: nowrap; font-family: ${brand.displayFont ? `"${brand.displayFont}", ` : ""}${UI_FONT}, sans-serif; }
  .matte { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }${spec.matteFilter ? `
  .matte { filter: ${spec.matteFilter}; }` : ""}${stageCss ? `\n  ${stageCss}` : ""}
  .look-grain { position: absolute; inset: 0; z-index: 6; pointer-events: none; mix-blend-mode: overlay; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='400' height='400' filter='url(%23n)' opacity='0.9'/></svg>"); }
  .look-vignette { position: absolute; inset: 0; z-index: 6; pointer-events: none; }
  .layer { z-index: 3; }
  #caps, #ecaps { z-index: 8; }${spec.stage && cap.behind ? `
  /* captions.behind: the type sits BETWEEN the set and the cut-out speaker, so the head really covers it (premium-iman 642e90e) */
  #pip > #caps { z-index: 1; } #pip > #base { z-index: 2; }` : ""}
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
  .cap-backed { background: rgba(8,8,10,.55); border-radius: 20px; padding: 6px 22px; -webkit-text-stroke: 0 !important; }${cap.backing === false || typeof cap.backingUntil === "number" ? `
  .cap-shadow { text-shadow: 0 2px 4px rgba(0,0,0,.85), 0 6px 22px rgba(0,0,0,.75), 0 0 2px rgba(0,0,0,.9) !important; }
  .eshadow .ew { text-shadow: 0 2px 4px rgba(0,0,0,.85), 0 6px 22px rgba(0,0,0,.75), 0 0 2px rgba(0,0,0,.9); }` : ""}
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
  ${(spec.beats || []).some((b) => b.type === "scene" && String(b.kind).startsWith("gm-")) ? GM_CSS : ""}${(spec.beats || []).some((b) => String(b.type).startsWith("hz-")) ? `\n  :root { --hz-accent: ${brand.accent}; }\n  ${HZ_CSS}` : ""}${MOTION_CSS(brand, rtl)}${LAYERS.length ? layersCss() : ""}${EXPLAINER_CSS(spec, beatsList)}${LIBRARY_CSS(beatsList, spec)}${spec.captions?.editorialShadow === "strong" ? `
  /* captions.editorialShadow "strong" (opt-in; Ahmed's f88943d): editorial captions legible on bright or busy footage */
  .ew { text-shadow: 0 1px 2px rgba(0,0,0,.9), 0 3px 8px rgba(0,0,0,.7), 0 6px 26px rgba(0,0,0,.6); }
  .ew.ebold { text-shadow: 0 2px 3px rgba(0,0,0,.85), 0 6px 24px rgba(0,0,0,.65); }
  .ew.ealarm { text-shadow: 0 2px 3px rgba(0,0,0,.85), 0 4px 18px rgba(0,0,0,.65); }
  .ew.eser { text-shadow: 0 0 20px ${brand.accent}88, 0 2px 3px rgba(0,0,0,.95), 0 4px 12px rgba(0,0,0,.75); }` : ""}
</style>
</head>
<body>
<div id="root" class="${spec.layout?.compact ? "compact" : ""}" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${SECTION_MODE ? SECTION_TOTAL : TOTAL}" data-fps="${FPS}">
  ${roomWins.length ? `<div id="roomfill"></div><div id="room"><div id="roomin">` : ""}<div id="pip">${stageBgHtml}${spec.stage && cap.behind ? `<div id="caps">${capHtml}</div>` : ""}<div id="base"><div id="snap"><div id="push">${FX_ON ? '<div id="fx">' : ""}${TX ? `<div id="tx" style="position:absolute;inset:0;transform-origin:50% 45%">` : ""}${takeHtml}${outroHtml}${behindHtml.join("")}${matteHtml}${TX ? "</div>" : ""}${frontHtml.join("")}${FX_ON ? "</div>" : ""}
  </div></div></div>${stageFgHtml}</div>${roomWins.length ? `</div></div>` : ""}
  ${overlays.filter((o) => o.html).map((o) => o.html).join("\n  ")}
  ${layersUnderHtml}${grainHtml}${vignetteHtml}${letterboxHtml}
  ${spec.stage && cap.behind ? "" : `<div id="caps">
      ${capHtml}
  </div>`}
  ${titleHtml}
  ${brandHtml}${layersOverHtml}
  ${leakHtml}
  ${topOverlays.join("\n  ")}${dropFlashHtml}
  ${edit ? edit.html : ""}
  ${takeAudio}${layerAudioHtml}
  ${overlays.filter((o) => o.audio).map((o) => o.audio).join("\n  ")}
  ${(spec.sound?.completeMix ? sfxAudioAll() : sfxAudio).join("\n  ")}
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
  ${SOURCES.length > 1 || spec.origin === "blank" ? `// the timeline is as long as the reel, not as long as its last tween: a preview/player that reads tl.duration() would stop at the last caption and freeze the footage
  tl.set({}, {}, ${SECTION_MODE ? SECTION_TOTAL : TOTAL});
  ` : ""}window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
// I-25 prototype: a section build writes ONLY its own composition HTML, to GE_SECTION_OUT, and
// touches none of the whole-reel artifacts below - edit_truth.json/caption_layout.json/
// sections.json/sfx_events.json/words.edit.json all describe the FULL reel's resolved timeline
// (several of them, e.g. sections.json's own computeSections() call two lines down, read `takes`
// and expect UN-rebased, whole-reel start times) and would be simply wrong if written from a
// section's rebased state. The normal (non-section) build that produces them is expected to have
// already run first; this never overwrites them.
if (SECTION_MODE) {
  fs.mkdirSync(path.dirname(SECTION_OUT), { recursive: true });
  fs.writeFileSync(SECTION_OUT, html);
  console.log(`-> ${SECTION_OUT} (section [${SECTION_START}, ${SECTION_END}), local duration ${SECTION_TOTAL}s)`);
  process.exit(0);
}
// PHANTASIC_PREVIEW_SCALE=0.5 (opt-in, iteration only): the same composition rendered at 540x960. An outer stage
// carries the composition attributes at the small size and the 1080 root is scaled into it (all layout stays 1080-based).
const PREVIEW = parseFloat(process.env.PHANTASIC_PREVIEW_SCALE || "1");
const htmlOut = PREVIEW > 0 && PREVIEW < 1 ? (() => {
  const w = Math.round(W * PREVIEW), h = Math.round(H * PREVIEW);
  console.log(`preview: ${w}x${h} (PHANTASIC_PREVIEW_SCALE=${PREVIEW})`);
  return html.replace(`<meta name="viewport" content="width=${W}, height=${H}" />`, `<meta name="viewport" content="width=${w}, height=${h}" />`)
    .replace(/<div id="root" class="([^"]*)" data-composition-id="main" data-start="0" data-width="\d+" data-height="\d+" data-duration="([^"]+)" data-fps="(\d+)">/,
      (m, cls, dur, fps) => `<div id="stage" data-composition-id="main" data-start="0" data-width="${w}" data-height="${h}" data-duration="${dur}" data-fps="${fps}" style="position:relative;width:${w}px;height:${h}px;overflow:hidden"><div id="root" class="${cls}" style="transform:scale(${PREVIEW});transform-origin:0 0;width:${W}px;height:${H}px">`)
    .replace(/<\/div>\n<script>/, "</div></div>\n<script>");
})() : html;
fs.writeFileSync(path.join(proj, "index.html"), htmlOut);
fs.mkdirSync(path.join(proj, "build"), { recursive: true });
fs.writeFileSync(path.join(proj, "build", "sfx_events.json"), JSON.stringify({ total: TOTAL, speech: SPEECH, voiceP95: r3(voiceP95), roleDb: ROLE_DB, events: sfxEvents }, null, 2));
fs.writeFileSync(path.join(proj, "build", "words.edit.json"), JSON.stringify(words));
// tail hold: with an outro and nothing full-frame drawn over it, the outro shows the RAW source still
// (assets/outro.jpg) after the last styled frame. scripts/tailhold.py (run on the render, see SKILL.md) holds the last
// styled frame over it instead. Written only when there is something to hold, and removed otherwise (a stale file
// from an earlier build must not freeze a reel that now ends on a page).
if (OUTRO > 0 && !outroCovered && !spec.outroFade) fs.writeFileSync(path.join(proj, "build", "tail.json"), JSON.stringify({ speech: r3(SPEECH), total: TOTAL, fps: FPS, hold: true }));
else fs.rmSync(path.join(proj, "build", "tail.json"), { force: true });
// mac-54: what was left out, and why (only when something was; a build that drops nothing removes an older file)
if (dropped.length) fs.writeFileSync(path.join(proj, "build", "graphics-dropped.json"), JSON.stringify({ dropped }, null, 2));
else fs.rmSync(path.join(proj, "build", "graphics-dropped.json"), { force: true });
fs.writeFileSync(path.join(proj, "build", "caption_layout.json"), JSON.stringify({ platform: placer.platform, safeTop: placer.safeTop, safeBottom: placer.safeBottom, blocks: placer.log }, null, 1));
// Resolved edit-time motion events, for the style-study accuracy harness (A1). Beat times in
// reel.json are SOURCE seconds; these are what the render actually contains, after E() maps them
// through the takes. Ground truth must come from here, never from the input spec.
// Pulled into named variables (I-25) so lib/sections.mjs's manifest can share them verbatim rather
// than re-deriving the same shape a second time - the expressions themselves are unchanged, so
// edit_truth.json's own output is unchanged.
// A17: take 0's `transition` is never validated (the join loop above starts at i=1 and only warns
// that take 0's is ignored), so it can carry the planner's raw {kind, why} object or any garbage
// string and still reach the oracle. Take 0 never joins from an earlier take, so it never gets a
// transition in the render - only takes 1.. do, once JOIN_TRANSITIONS has checked them. Dropped by
// index here rather than by truthiness, so a genuine take-1+ transition is untouched.
// premium-kit keys that touch every section (the sfx pass, the join transitions, the drop, the music alignment): part of the
// sections globalHash only when set, so a reel without them hashes as before
const PREMIUM_HASH = (spec.sfxDesign || (spec.sfx && !Array.isArray(spec.sfx)) || spec.transitions || spec.drop || spec.music?.alignDrop != null || spec.music?.lifts)
  ? { sfxDesign: spec.sfxDesign ?? (spec.sfx && !Array.isArray(spec.sfx) ? spec.sfx : null), transitions: spec.transitions ?? null, drop: spec.drop ?? null, music: spec.music ? { alignDrop: spec.music.alignDrop ?? null, dropLift: spec.music.dropLift ?? null, lifts: spec.music.lifts ?? null } : null }
  : null;
const editTruthTakes = takes.map((t, i) => ({ start: r3(t.start), dur: r3(t.dur), holdStart: r3(t.holdStart), holdFrames: t.holdFrames, ...(SOURCES.length > 1 ? { src: t.src, srcIndex: srcIndex.get(t.src) } : {}), ...(t.ramp ? { ramp: t.ramp } : {}), ...(i > 0 && t.transition ? { transition: t.transition } : {}), ...(i > 0 && t.transition && t.transitionDur !== undefined ? { transitionDur: t.transitionDur } : {}) }));
const editTruthBeats = (spec.beats || []).map((b) => ({
  type: b.type, kind: b.kind ?? null,
  at: r3(EB(b, "at", `${b.type} at`)),
  to: b.type === "graphic" ? b._graphic.t1 : b.to === undefined ? null : r3(EB(b, "to", `${b.type} to`)),
  in: b.in ?? null, out: b.out ?? null,
}));
fs.writeFileSync(path.join(proj, "build", "edit_truth.json"), JSON.stringify({
  total: TOTAL, speech: SPEECH, fps: FPS,
  // I-17: a take's `transition` names the look its join FROM the previous take carries (blur or
  // whip) instead of a hard cut; omitted entirely when unset, so a reel with no take transitions
  // still writes byte-identical edit_truth.json to before this field existed.
  // I-16: `src` is emitted only on a genuinely multi-source reel, the same way `transition` is -
  // so a single-source dump stays byte-identical to before this change, which is what keeps the A1
  // baseline valid (verified by hashing f01-f06's edit_truth.json either side). It is the first
  // half of MULTIANGLE Gap 9: expected.py cannot say "at edit 6.2 s we should be looking at camera
  // B" while the oracle does not record which camera a take came from. Scoring an angle change
  // still needs A2/A5 to work (NEXT.md item 6); this just stops the oracle being the blocker.
  ...(SOURCES.length > 1 ? { sources: SOURCES } : {}),
  takes: editTruthTakes,
  snaps: snaps.map((sn) => ({ t: r3(sn[0]), scale: sn[1], ...(sn[2] ? { origin: sn[2] } : {}), ...(easedSnaps.has(sn) ? { dur: r3(PUNCH.frames / FPS), ease: PUNCH.ease } : {}) })),
  pushes: pushesEdit.map((p) => ({ start: r3(p.a), end: r3(p.b), z: p.z, up: p.up, down: p.down })),
  // `to` matters as much as `at`: a scene animates in at `at` and out near `to`, so both are
  // events a frame-level analyzer should see.
  beats: editTruthBeats,
  // "Making room": merged footage-shrink windows (output seconds), only when a room:"below" beat was built.
  ...(roomWins.length ? { room: roomWins.map((w) => ({ start: r3(w.tA), end: r3(w.tB), scale: ROOM_SCALE })) } : {}),
  // reel.layers[]: where each layer actually landed on the output timeline (anchors resolved). Only when the reel has layers.
  ...(LAYERS.length ? { layers: layerTruth(LAYERS) } : {}),
  // premium kit (opt-in): the whip / zoom-through that spec.transitions put on a take join (#tx), only when there are any.
  // A join with its own take.transition (I-17) is NOT listed here - it is already a take field.
  ...(transitionsAt.length ? { txTransitions: transitionsAt.map((x) => ({ t: x.t, kind: x.kind })) } : {}),
}, null, 2));
// I-25: section boundaries and per-section invalidation hashes (ISSUES D3). Additive and written
// AFTER edit_truth.json, from the same already-resolved arrays that file dumps (editTruthTakes,
// editTruthBeats, words) rather than a second pass over spec - so this can never disagree with
// edit_truth.json about where a take or beat actually landed. index.html is untouched by this
// block: a single-source build's index.html/edit_truth.json/caption_layout.json stay
// byte-identical to before this existed (nothing above this line changed).
//
// NOT done, and said plainly rather than implied: this writes the MANIFEST a per-section render
// would consume - it does not itself split index.html into per-section composition files, invoke
// `hyperframes render -c <section>.html` per section, render the once-only audio composition, or
// mux/concat the results. See the I-25 commit message and ENGINE.md for what that remaining work
// is and why it did not fit this change (every beat builder in this file and in lib/motion.mjs
// bakes an ABSOLUTE edit-time into its GSAP calls; a section-relative composition needs each of
// them to accept a time origin, which is the real remaining surface, not a detail).
{
  const sections = computeSections(TOTAL, takes, { beatSpans, pushes: pushesEdit, joins: takeJoins });
  // a graphic beat's cache key is part of the hash of the section it starts in (a graphic layer's is in its layer object)
  const graphicKeys = (spec.beats || []).filter((b) => b.type === "graphic").map((b) => ({ t0: b._graphic.t0, key: b._graphic.key }));
  const manifest = buildSectionManifest(sections, { takes: editTruthTakes, beats: editTruthBeats, words, layers: LAYERS, ...(graphicKeys.length ? { graphics: graphicKeys } : {}) });
  fs.writeFileSync(path.join(proj, "build", "sections.json"), JSON.stringify({
    total: TOTAL, fps: FPS,
    // Settings that invalidate every section at once, kept separate from each section's own hash
    // so a manifest diff can tell "one caption changed" apart from "the whole reel's look
    // changed" - see lib/sections.mjs's invalidation note.
    globalHash: globalHash({ style: rawSpec.style ?? null, ...(String(rawSpec.style ?? "").startsWith("user:") ? { userStyle: preset } : {}), format: FORMAT, platform, brand, sfxProfile: SFX_PROFILE, ...(spec.sourceGrade ? { sourceGrade: spec.sourceGrade, sourceExposure: spec.sourceExposure ?? null, gradeGamma, ...(spec.sourceNeutral ? { sourceNeutral: spec.sourceNeutral, gradeCast } : {}) } : {}), ...(gradePresetUsed ? { gradePreset: gradePresetUsed } : {}), ...(PREMIUM_HASH ? { premium: PREMIUM_HASH } : {}), ...(RELIGHT ? { relight: RELIGHT } : {}) }),
    sections: manifest,
  }, null, 2));
  console.log(`sections: ${sections.length} (${sections.map((s) => `${s.start}-${s.end}`).join(", ")})`);
}
{
  const modes = {};
  for (const b of placer.log) modes[b.mode] = (modes[b.mode] || 0) + 1;
  console.log(`caption placement (${placer.platform.name}, safe y ${placer.safeTop}-${placer.safeBottom}): ${JSON.stringify(modes)}`);
  // captions.backing false / backingUntil: count the blocks that really got the grey box, not every close-up block
  const boxed = ((edit ? edit.html : capHtml).match(/ (ebacked|cap-backed)"/g) || []).length;
  if (modes["lower-face"]) warn.push(`${modes["lower-face"]} caption block(s) in close-up fallback (under the mouth, ${boxed === modes["lower-face"] ? "on a backing" : `${boxed} on the grey box, ${modes["lower-face"] - boxed} without it`}); see build/caption_layout.json`);
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
// SFX_STRICT=1 (opt-in; set it where reels ship once the pack is restored): a sound the reel asks for that plays nothing
// fails the build, one line per id, instead of the warning above. The page is still written; exit 1 says it is silent there.
if (process.env.SFX_STRICT === "1" && missingSfx.size) {
  for (const [k, n] of missingSfx) console.error(`SFX_STRICT: ${k} x${n} plays nothing (node scripts/sfx_check.mjs says why)`);
  process.exit(1);
}
console.log(`\n-> ${path.join(proj, "index.html")}`);

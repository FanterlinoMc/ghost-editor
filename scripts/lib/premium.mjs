// Premium kit for build.mjs (hand port of phantasic engine/core/scripts/lib/premium.mjs, 1c15911 and later).
// Everything here is OPT-IN per style / reel.json: a spec that sets none of these keys builds byte-identical.
//   speed ramps      take.ramp / scene.ramp         (resolveRamp, rampKnots, warpFn, rampClip; ffmpeg pre-render)
//   grade presets    look.preset                    (gradePreset; the fork's version returns {error}/resolved instead of throwing)
//   transitions      spec.transitions, scene in/out (txTransition, sceneTransIn/Out, WHIP_SVG)
//   sfx design pass  spec.sfxDesign                 (sfxDesign; every sound is optional: a missing file warns and is skipped)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------- speed ramps ----------
// A curve is keyframes [u, speed] over the shot's normalized OUTPUT time u in 0..1; speed eases between keyframes
// with smoothstep, so 1x -> 3x -> 1x has no velocity jumps.
export const RAMP_PRESETS = {
  rush: [[0, 1], [0.3, 3], [0.7, 3], [1, 1]],          // 100% -> 300% -> 100%
  surge: [[0, 1], [0.55, 3], [1, 3]],                   // builds into a fast exit (into a hard cut)
  hit: [[0, 2.6], [0.38, 2.6], [0.55, 0.5], [1, 0.5]],  // fast, then lands in 50% slow-mo (put the beat at ~0.5)
  slowmo: [[0, 0.5], [1, 0.5]],                          // 50% throughout
};
export const resolveRamp = (r) => {
  const o = typeof r === "string" ? { preset: r } : { ...r };
  const curve = o.curve ?? RAMP_PRESETS[o.preset ?? "rush"];
  if (!curve) throw new Error(`unknown ramp preset '${o.preset}' (have ${Object.keys(RAMP_PRESETS).join(", ")})`);
  return { ...o, curve: [...curve].sort((a, b) => a[0] - b[0]) };
};
const smooth = (x) => x * x * (3 - 2 * x);
export const speedAt = (curve, u) => {
  if (u <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [u0, v0] = curve[i - 1], [u1, v1] = curve[i];
    if (u <= u1) return v0 + (v1 - v0) * smooth((u - u0) / Math.max(1e-6, u1 - u0));
  }
  return curve.at(-1)[1];
};
// knots [outSec, srcSec] for an output duration D (N steps, trapezoid integration)
export const rampKnots = (curve, D, N = 30) => {
  const k = [[0, 0]];
  for (let i = 1; i <= N; i++) {
    const ua = (i - 1) / N, ub = i / N;
    k.push([r3((ub * D)), k.at(-1)[1] + (D / N) * (speedAt(curve, ua) + speedAt(curve, ub)) / 2]);
  }
  return k;
};
export const meanSpeed = (curve) => rampKnots(curve, 1, 60).at(-1)[1];
// output offset for a source offset (inverse of the knots, linear between knots)
export const warpFn = (knots) => (s) => {
  if (s <= 0) return 0;
  for (let i = 1; i < knots.length; i++) if (s <= knots[i][1]) {
    const [o0, s0] = knots[i - 1], [o1, s1] = knots[i];
    return o0 + (o1 - o0) * (s - s0) / Math.max(1e-9, s1 - s0);
  }
  return knots.at(-1)[0];
};

// Render the ramped picture: source [mediaStart, mediaStart + S] -> D seconds at fps, no audio.
// setpts maps every source frame to its warped output time (piecewise-linear inverse of the speed integral), then
// the frames are resampled to a constant fps: "dup" repeats/drops frames, "blend" (default) cross-blends neighbours
// (smooth 50% slow-mo without warping artefacts), "mci" motion-interpolates (smoothest, can smear on fast motion).
export function rampClip({ src, mediaStart, D, ramp, fps, outDir, tag, srcDur }) {
  const R = resolveRamp(ramp);
  const knots = rampKnots(R.curve, D);
  const S = knots.at(-1)[1];
  if (mediaStart + S > srcDur + 0.05) throw new Error(`ramp '${tag}': needs ${S.toFixed(2)} s of source from ${mediaStart} but the clip ends at ${srcDur.toFixed(2)} s; start earlier or shorten the shot`);
  const mode = R.interp ?? "blend";
  const key = crypto.createHash("sha1").update(JSON.stringify([path.resolve(src), mediaStart, D, R.curve, mode, fps])).digest("hex").slice(0, 10);
  const name = `ramp-${tag}-${key}.mp4`;
  const out = path.join(outDir, name);
  if (!fs.existsSync(out)) {
    // nested if() from the last knot back: out(T) for source time T
    let expr = `${knots.at(-1)[0]}`;
    for (let i = knots.length - 1; i >= 1; i--) {
      const [o0, s0] = knots[i - 1], [o1, s1] = knots[i];
      const slope = (o1 - o0) / Math.max(1e-9, s1 - s0);
      expr = `if(lt(T,${s1.toFixed(4)}),${o0.toFixed(4)}+(T-${s0.toFixed(4)})*${slope.toFixed(5)},${expr})`;
    }
    const resample = mode === "mci" ? `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`
      : mode === "blend" ? `minterpolate=fps=${fps}:mi_mode=blend` : `fps=${fps}`;
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", String(mediaStart), "-t", (S + 0.2).toFixed(3), "-i", src, "-an",
      "-vf", `setpts=PTS-STARTPTS,setpts='(${expr})/TB',${resample},trim=duration=${D.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-g", String(Math.round(fps / 2)), "-r", String(fps), out]);
  }
  const peakU = R.curve.reduce((b, k) => (k[1] > b[1] ? k : b), R.curve[0])[0];
  return { src: `assets/${name}`, S: r3(S), knots, peakAt: r3(peakU * D), maxSpeed: Math.max(...R.curve.map((k) => k[1])), minSpeed: Math.min(...R.curve.map((k) => k[1])) };
}

// ---------- grade presets ----------
// presets/grades.json: per preset an SVG tone curve per channel (feComponentTransfer tables = a 1D LUT per channel),
// an optional saturation, an optional "keep" mask (noir: everything goes mono except warm gold/amber hues), CSS after
// the SVG filter (contrast/brightness), optional sharpen, and vignette/grain/tint defaults. look.* keys set on the
// style or reel win over the preset's own vignette/grain/tint.
export function gradePreset(look, presetsFile) {
  const all = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
  const p = all[look.preset];
  if (!p || look.preset.startsWith("_")) {
    return { error: `unknown look.preset '${look.preset}' (have ${Object.keys(all).filter((k) => !k.startsWith("_")).join(", ")})` };
  }
  const id = `pk-grade-${look.preset}`;
  const tbl = (a) => a.map((x) => x.toFixed(3)).join(" ");
  const steps = [];
  let last = "SourceGraphic";
  const put = (s, res) => { steps.push(s.replace("__IN__", last).replace("__OUT__", res)); last = res; };
  if (p.keep) {
    // mono base + the kept hues composited back over it through a mask (alpha = kR*R + kG*G + kB*B + off)
    const [kr, kg, kb, off] = p.keep.mask;
    steps.push(`<feColorMatrix in="SourceGraphic" type="saturate" values="${p.keep.baseSat ?? 0}" result="mono"/>`);
    steps.push(`<feColorMatrix in="SourceGraphic" type="saturate" values="${p.keep.sat ?? 1.1}" result="kept"/>`);
    steps.push(`<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${kr} ${kg} ${kb} 0 ${off}" result="mask"/>`);
    steps.push(`<feComposite in="kept" in2="mask" operator="in" result="keptm"/>`);
    steps.push(`<feComposite in="keptm" in2="mono" operator="over" result="kmix"/>`);
    last = "kmix";
  }
  if (p.curves) put(`<feComponentTransfer in="__IN__" result="__OUT__"><feFuncR type="table" tableValues="${tbl(p.curves.r)}"/><feFuncG type="table" tableValues="${tbl(p.curves.g)}"/><feFuncB type="table" tableValues="${tbl(p.curves.b)}"/></feComponentTransfer>`, "curves");
  if (p.saturate != null && !p.keep) put(`<feColorMatrix in="__IN__" type="saturate" values="${p.saturate}" result="__OUT__"/>`, "sat");
  if (p.sharpen) { const k = p.sharpen; put(`<feConvolveMatrix in="__IN__" order="3" preserveAlpha="true" kernelMatrix="0 ${-k} 0 ${-k} ${1 + 4 * k} ${-k} 0 ${-k} 0" result="__OUT__"/>`, "sharp"); }
  const svg = `<svg width="0" height="0" style="position:absolute;width:0;height:0" aria-hidden="true"><filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${steps.join("")}</filter></svg>`;
  const grade = `url(#${id})${p.css ? " " + p.css : ""}`;
  const merged = { vignette: p.vignette, grain: p.grain, tint: p.tint, ...look, grade: look.grade && look.grade !== "none" ? `${grade} ${look.grade}` : grade };
  for (const k of Object.keys(merged)) if (merged[k] == null) delete merged[k];
  return { look: merged, svg, brollGrade: p.broll === false ? null : grade, resolved: p };
}

// ---------- punch-ins and transitions ----------
// #tx is a wrapper inside #fx that only exists when punch or transitions are on; it carries the whip/zoom-through
// moves and the punch blur, so it never fights #fx's own filters (popcards, refocus).
export const WHIP_SVG = `<svg width="0" height="0" style="position:absolute;width:0;height:0" aria-hidden="true"><filter id="pk-whip" x="-25%" y="0" width="150%" height="100%" color-interpolation-filters="sRGB"><feGaussianBlur id="pk-whip-g" stdDeviation="0 0"/></filter></svg>`;

// one transition at edit time T on #tx (whip = horizontal slide + directional blur; zoom = push through + blur)
export function txTransition(tl, kind, T, { fps = 30, frames = 8, dir = 1, strength = 1 } = {}) {
  const hOut = r3(Math.max(2, Math.floor(frames / 2)) / fps), hIn = r3(Math.max(3, Math.ceil(frames / 2) + 1) / fps);
  const a = r3(Math.max(0, T - hOut));
  if (kind === "whip") {
    const dx = Math.round(130 * strength) * dir, blur = Math.round(70 * strength);
    tl.push(`tl.set("#tx", { filter: "url(#pk-whip)" }, ${a});`);
    tl.push(`tl.fromTo("#tx", { x: 0, scale: 1 }, { x: ${-dx}, scale: 1.3, duration: ${hOut}, ease: "power2.in", immediateRender: false }, ${a});`);
    tl.push(`tl.fromTo("#pk-whip-g", { attr: { stdDeviation: "0 0" } }, { attr: { stdDeviation: "${blur} 0" }, duration: ${hOut}, ease: "power2.in", immediateRender: false }, ${a});`);
    tl.push(`tl.fromTo("#tx", { x: ${dx}, scale: 1.3 }, { x: 0, scale: 1, duration: ${hIn}, ease: "power3.out", immediateRender: false }, ${r3(T)});`);
    tl.push(`tl.fromTo("#pk-whip-g", { attr: { stdDeviation: "${blur} 0" } }, { attr: { stdDeviation: "0 0" }, duration: ${hIn}, ease: "power3.out", immediateRender: false }, ${r3(T)});`);
    tl.push(`tl.set("#tx", { filter: "none" }, ${r3(T + hIn + 0.01)});`);
  } else {
    const z = r3(1 + 0.55 * strength), blur = Math.round(16 * strength);
    tl.push(`tl.fromTo("#tx", { scale: 1, filter: "blur(0px) brightness(1)" }, { scale: ${z}, filter: "blur(${blur}px) brightness(1.18)", duration: ${hOut}, ease: "power2.in", immediateRender: false }, ${a});`);
    tl.push(`tl.fromTo("#tx", { scale: ${z}, filter: "blur(${blur}px) brightness(1.18)" }, { scale: 1, filter: "blur(0px) brightness(1)", duration: ${hIn}, ease: "power3.out", immediateRender: false }, ${r3(T)});`);
    tl.push(`tl.set("#tx", { filter: "none" }, ${r3(T + hIn + 0.01)});`);
  }
  return [a, r3(T + hIn)];
}

// scene (B-roll) in/out: a per-scene SVG filter so it can overlap the #tx whip
export const sceneWhipSvg = (id) => `<svg width="0" height="0" style="position:absolute;width:0;height:0" aria-hidden="true"><filter id="${id}-wf" x="-25%" y="0" width="150%" height="100%" color-interpolation-filters="sRGB"><feGaussianBlur id="${id}-wg" stdDeviation="0 0"/></filter></svg>`;
export function sceneTransIn(ctx, sel, id, kind, t0) {
  const { tl, r3: rr } = ctx, f = 5 / 30;
  if (kind === "whip") {
    tl.push(`tl.set("${sel}", { filter: "url(#${id}-wf)" }, ${rr(Math.max(0, t0 - 0.001))});`);
    tl.push(`ft("${sel}", { xPercent: 70 }, { xPercent: 0, duration: ${rr(f)}, ease: "power3.out" }, ${t0});`);
    tl.push(`ft("#${id}-wg", { attr: { stdDeviation: "80 0" } }, { attr: { stdDeviation: "0 0" }, duration: ${rr(f)}, ease: "power3.out" }, ${t0});`);
    tl.push(`tl.set("${sel}", { filter: "none" }, ${rr(t0 + f + 0.01)});`);
  } else if (kind === "zoom") {
    tl.push(`ft("${sel}", { scale: 1.5, filter: "blur(16px) brightness(1.2)" }, { scale: 1, filter: "blur(0px) brightness(1)", duration: ${rr(f + 1 / 30)}, ease: "power3.out" }, ${t0});`);
  }
}
export function sceneTransOut(ctx, sel, id, kind, t1) {
  const { tl, r3: rr } = ctx, f = 4 / 30;
  if (kind === "whip") {
    tl.push(`tl.set("${sel}", { filter: "url(#${id}-wf)" }, ${rr(t1 - f)});`);
    tl.push(`tl.to("${sel}", { xPercent: -70, duration: ${rr(f)}, ease: "power2.in" }, ${rr(t1 - f)});`);
    tl.push(`tl.fromTo("#${id}-wg", { attr: { stdDeviation: "0 0" } }, { attr: { stdDeviation: "80 0" }, duration: ${rr(f)}, ease: "power2.in", immediateRender: false }, ${rr(t1 - f)});`);
  } else if (kind === "zoom") {
    // explicit from-values: GSAP tweening a filter from "none" passes through brightness(0) (black frames)
    tl.push(`tl.fromTo("${sel}", { scale: 1, filter: "blur(0px) brightness(1)" }, { scale: 1.6, filter: "blur(16px) brightness(1.2)", duration: ${rr(f)}, ease: "power2.in", immediateRender: false }, ${rr(t1 - f)});`);
  }
}

// ---------- SFX design pass ----------
// Families from library/sfx/INDEX.md. Every sound is placed by its measured peak (timing.json peak_t), so a riser
// tops out exactly on the cut and a swish peaks on the frame the picture moves.
const FAM = {
  riser: ["riser-1", "cinematic-rumble-riser"],
  hit: ["cinematic-deep-boom", "impact-1"],
  tail: ["whoosh-cine"],
  soft: ["pop-whoosh-light", "whoosh-cine"],
  tick: ["click-1", "pop-1", "tick-1"],
  swish: ["zoom-sweep-small", "zoom-sweep-short"],
  whip: ["burn-whoosh-fast", "tech-digital-whoosh"],
  ramp: ["burn-whoosh-tunnel"],
};
const DENSITY = {
  low: { riser: "major", hit: "major", tail: false, text: "scenes", punch: 0, pop: true, whip: true, ramp: true, gap: 0.6 },
  med: { riser: "major", hit: "transitions", tail: true, text: "all", punch: 2, pop: true, whip: true, ramp: true, gap: 0.35 },
  high: { riser: "transitions", hit: "all", tail: true, text: "all", punch: 1, pop: true, whip: true, ramp: true, gap: 0.2 },
};

// ev: { majors:[t], transitions:[{t, kind}], joins:[t], textIns:[{t, why}], punches:[t], pops:[t], ramps:[{t, peak}] }
export function sfxDesign(cfg, ev, { addSfx, sfxEvents, timing, words, voiceP95, ROLE_DB, TOTAL, log }) {
  const D = { ...DENSITY[cfg.density ?? "med"], ...(cfg.rules || {}) };
  if (!DENSITY[cfg.density ?? "med"]) throw new Error(`sfxDesign.density must be low, med or high (got ${cfg.density})`);
  const lvl = { riser: cfg.riserDb ?? 0, hit: cfg.hitDb ?? 2, tail: cfg.tailDb ?? -4, soft: cfg.softDb ?? 0, tick: cfg.tickDb ?? -8, swish: cfg.swishDb ?? -2, whip: cfg.whipDb ?? 0, ramp: cfg.rampDb ?? 0 };
  const rr = {};
  const nextOf = (fam) => { rr[fam] = ((rr[fam] ?? -1) + 1) % FAM[fam].length; return FAM[fam][rr[fam]]; };
  const placed = [];
  const busy = (t, gap) => placed.some((p) => Math.abs(p - t) < gap);
  // place a family sound so its PEAK lands on t; cut = truncate (with a fade) so nothing rings past `until`
  const place = (fam, t, why, { until = null, force = false, gapOverride = null } = {}) => {
    const id = nextOf(fam), tm = timing[id] || { peak_t: 0, dur: 0.5 };
    const start = r3(t - tm.peak_t);
    if (start < 0 || t > TOTAL - 0.05) return false;
    if (!force && busy(t, gapOverride ?? D.gap)) return false;
    const n = sfxEvents.length;
    addSfx(start, id, `design: ${why}`, { db: lvl[fam] });
    if (sfxEvents.length === n) return false;
    const e = sfxEvents.at(-1);
    e.design = fam;
    if (until != null && start + e.dur > until) { e.dur = r3(Math.max(0.08, until - start)); e.fade = 0.06; }
    placed.push(t);
    return true;
  };
  const near = (xs, t, d = 0.06) => xs.some((x) => Math.abs(x - t) < d);
  const transT = ev.transitions.map((x) => x.t);
  const hitAt = new Set();
  // 1. major hard cuts (into/out of B-roll, ramps): riser -> hit -> tail
  const chainAt = D.riser === "transitions" ? [...ev.majors, ...transT] : ev.majors;
  for (const t of [...new Set(chainAt.map(r3))].sort((a, b) => a - b)) {
    if (D.riser) place("riser", t, "riser into the cut", { until: t + 0.04, force: true });
    if (place("hit", t, "hit on the cut", { until: t + (cfg.hitLen ?? 0.9), force: true })) hitAt.add(t);
    if (D.tail) place("tail", t + 0.12, "tail after the hit", { force: true });
  }
  // 2. whip / zoom transitions: a swish peaking on the cut (+ a hit when density says so)
  for (const x of ev.transitions) {
    if (!near(chainAt, x.t)) place("whip", x.t, `${x.kind} transition`, { force: true });
    if ((D.hit === "transitions" || D.hit === "all") && !hitAt.has(r3(x.t))) { if (place("hit", x.t, `${x.kind} hit`, { until: x.t + 0.6, force: true })) hitAt.add(r3(x.t)); }
  }
  // 3. plain jump cuts (high density only)
  if (D.hit === "all") for (const t of ev.joins) if (!near(transT, t) && !near(ev.majors, t)) place("swish", t, "jump cut");
  // 4. ramps: the speed-up whoosh peaks at max speed
  if (D.ramp) for (const r of ev.ramps) place("ramp", r.peak, "speed ramp", { until: r.end, force: true });
  // 5. text in: soft whoosh
  for (const x of ev.textIns) if (D.text === "all" || x.scene) place("soft", x.t, `text in (${x.why})`);
  // 6. punch-ins: swish on every Nth
  if (D.punch) ev.punches.forEach((t, i) => { if (i % D.punch === 0 && !near(transT, t, 0.3)) place("swish", t, "punch-in"); });
  // 7. word pops: ticks (spacing by density is chosen by the caller; DNA: about -22 dB under the voice)
  if (D.pop) for (const t of ev.pops) place("tick", t, "word pop", { gapOverride: 0.18 });

  // ducking: every non-hit sound that overlaps speech sits >= voiceGap dB under the voice p95 (hits and memes are
  // exempt: they are short and land on cuts). Applies to ALL sfx in the reel once the design pass is on.
  const gap = cfg.voiceGapDb ?? -8;
  const cap = Math.pow(10, (voiceP95 + gap + 1) / 20);
  let ducked = 0;
  for (const e of sfxEvents) {
    if (e.role === "impact" || e.role === "meme") continue;
    const end = e.t + e.dur;
    if (!words.some((w) => w.start < end && w.end > e.t)) continue;
    if (e.vol > cap) { e.vol = r3(cap); ducked++; }
  }
  const mine = sfxEvents.filter((e) => e.design);
  const by = {}; for (const e of mine) by[e.design] = (by[e.design] || 0) + 1;
  log(`sfx design (${cfg.density ?? "med"}): ${mine.length} sounds ${JSON.stringify(by)}; ${ducked} ducked to ${gap} dB under the voice`);
}

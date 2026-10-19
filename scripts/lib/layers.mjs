// reel.layers[]: things that stay at a fixed point of the FINISHED video (picture-in-picture, B-roll over
// the voice, a logo, a sticker, a user-made graphic on a clip with no speech). BLANK-TIMELINE-SPEC.md,
// "two kinds of time" and Stage 3. Reference: references/reel-json.md ("layers").
//
// The two kinds of time, restated for the one place they meet. Everything else in reel.json is in
// SOURCE seconds and follows its words when a take is cut. A layer is in OUTPUT seconds:
//   - `pin: true`            `at` is absolute output seconds; nothing before it can move it
//   - otherwise              `anchor: { take, offset }` - the layer starts `offset` seconds into
//                            take `take`'s span of the finished video, resolved here AFTER the take
//                            layout, so trimming/removing seconds from an earlier take ripples it
//   - `at` with no anchor    treated as pinned (an absolute time), the lenient reading
//
// This file is pure (no fs, no process.exit): build.mjs resolves times early (the layer's audio ducks the
// take audio, which is emitted before the beats) and renders late, and layers.test.mjs drives both
// without a browser. A layer's tweens are the same explicit `ft(...)` / `tl.fromTo(...)` calls every beat
// uses: both values given, force3D:false, ~0.3 s, so a frame is a pure function of time.

import { DESIGNER_FONTS } from "./motion-graphics.mjs";
import { reason, layerProblem, checkPlacement } from "./graphic.mjs";
import { graphicTiming, cutFrames, ignoredWarnings, centredBox, MODES as GRAPHIC_MODES } from "./graphic-place.mjs";

export const LAYER_KINDS = ["video", "image", "logo", "motion", "text", "graphic"];
export const ENTERS = ["fade", "slide-up", "pop", "none"];
export const EXITS = ["fade", "none"];
export const FITS = ["cover", "contain"];
export const AUDIOS = ["off", "duck", "mix"];
export const ID_RE = /^[a-z0-9-]{1,24}$/;
export const MEDIA_EXT = { video: /\.(mp4|mov|webm|m4v)$/i, image: /\.(png|jpe?g|webp|gif|svg)$/i };
MEDIA_EXT.logo = MEDIA_EXT.image;
export const MIN_LAYER = 0.1;          // seconds; a layer shorter than this (after clamping to the reel) is dropped
export const ENTER_DUR = 0.3;
export const DUCK_LEVEL = 0.25;        // the main track's volume while a `duck` layer plays
export const DUCK_RAMP = 0.15;
export const MAX_Z = 99;
const SHADOWS = { soft: "0 12px 36px rgba(0,0,0,.45)", strong: "0 18px 50px rgba(0,0,0,.6)" };
const ALIGN = { left: "flex-start", center: "center", right: "flex-end" };

const r3 = (x) => Math.round(x * 1000) / 1000;
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cleanText = (s, max = 200) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The corner a logo goes in when its box is left out: top right, 200 px, clear of the status-bar band. */
export const logoBox = (W) => ({ x: W - 260, y: 96, w: 200, h: 200 });

/**
 * Resolve every layer's place on the output timeline. `takes` are the laid-out takes (start, dur,
 * holdFrames), `total` the reel's length, `fps` for the hold. Never throws: a bad layer is returned in
 * `errors` (build.mjs die()s on those - validate.py has the matching checks) and a layer that cannot be
 * shown (shorter than MIN_LAYER once clamped) in `warnings`.
 * A `graphic` layer (Prompt Motion, references/reel-json.md) also needs `graphic(L)`: the static check of its file
 * (inspectGraphic's { ok, reasons, meta }; build.mjs reads the file). Its G / P problems are returned in `problems`,
 * worded exactly `layer <id>: graphic <html>: <reason>` (build.mjs die()s on the first).
 * @returns {{ layers: object[], errors: string[], warnings: string[], problems: string[] }}
 */
export function resolveLayers(raw, { takes, total, fps, W, H, graphic }) {
  const errors = [], warnings = [], layers = [], seen = new Set(), problems = [];
  if (!Array.isArray(raw)) return { layers, errors: ["layers must be an array"], warnings, problems };
  raw.forEach((L, i) => {
    const bad = (m) => errors.push(`layers[${i}]${isObj(L) && L.id ? ` (${L.id})` : ""}: ${m}`);
    if (!isObj(L)) return bad("not an object");
    if (typeof L.id !== "string" || !ID_RE.test(L.id)) return bad(`id must match [a-z0-9-]{1,24}, got ${JSON.stringify(L.id)}`);
    if (seen.has(L.id)) return bad("duplicate id");
    seen.add(L.id);
    if (!LAYER_KINDS.includes(L.kind)) return bad(`unknown kind ${JSON.stringify(L.kind)}; have: ${LAYER_KINDS.join(", ")}`);
    const kind = L.kind;
    // ---- timing ----
    const logoDefault = kind === "logo" && L.pin === undefined && L.anchor === undefined && L.at === undefined;
    const pinned = L.pin === true || logoDefault || (L.anchor === undefined && fin(L.at));
    let start;
    if (pinned) {
      start = logoDefault ? 0 : L.at ?? 0;
      if (!fin(start) || start < 0) return bad(`at must be a number >= 0 (absolute output seconds), got ${JSON.stringify(L.at)}`);
    } else {
      const a = L.anchor;
      if (!isObj(a) || !Number.isInteger(a.take)) return bad(`needs pin:true with at, or anchor { take, offset } (take is an integer index)`);
      if (a.take < 0 || a.take >= takes.length) return bad(`anchor.take ${a.take} is outside 0..${takes.length - 1}`);
      if (a.offset !== undefined && (!fin(a.offset) || a.offset < 0)) return bad(`anchor.offset must be a number >= 0, got ${JSON.stringify(a.offset)}`);
      const k = takes[a.take];
      const span = k.dur + (k.holdFrames || 0) / fps;      // the take's stretch of the finished video, hold included
      const off = a.offset ?? 0;
      if (off > span + 1e-6) warnings.push(`layer ${L.id}: anchor.offset ${off}s is past the end of take ${a.take} (${r3(span)}s), clamped`);
      start = k.start + clamp(off, 0, span);
    }
    // ---- graphic (Prompt Motion): the file's static check (G1-G35), then P1; its length defaults to the file's ----
    let g = null;
    const gp = (r) => { problems.push(layerProblem(L.id, L.html, r)); };
    if (kind === "graphic") {
      const insp = graphic ? graphic(L) : { ok: false, reasons: ["graphic layers need the build's file check"] };
      if (!insp.ok) return gp(insp.reasons[0]);
      const mode = L.mode ?? "overlay";
      if (!GRAPHIC_MODES.includes(mode)) return gp(reason("P1", { v: mode }));
      g = { mode, meta: insp.meta, tm: graphicTiming(insp.meta, L, fps) };
      for (const w of g.tm.warnings) warnings.push(`layer ${L.id}: ${w}`);
    }
    // dur: required, except a logo may leave it out = "to the end of the reel" (a graphic: its own length from `in`)
    let dur = L.dur;
    if (dur === undefined && kind === "logo") dur = Math.max(0, total - start);
    if (dur === undefined && g) dur = r3(g.tm.defaultWindow);
    if (!fin(dur) || dur <= 0) return bad(`dur must be a number > 0, got ${JSON.stringify(L.dur)}`);
    if (g) { const p = checkPlacement({ mode: g.mode, window: dur }, { W, H }); if (p.length) return gp(p[0]); }
    // clamp to the reel's length
    const t0 = r3(clamp(start, 0, Math.max(0, total - MIN_LAYER)));
    let t1 = r3(Math.min(t0 + dur, total));
    if (t1 - t0 < MIN_LAYER - 1e-6) { warnings.push(`layer ${L.id}: ${r3(t1 - t0)}s long once clamped to the reel (${total}s), dropped`); return; }
    if (t0 !== r3(start) || t1 !== r3(start + dur)) warnings.push(`layer ${L.id}: clamped to the reel, now ${t0}..${t1}s`);
    // a graphic's frame count L (after clamping; after "cut" shortens it to the graphic's length, GW2)
    if (g) {
      const Lf = Math.round((t1 - t0) * fps), cut = cutFrames(g.meta, g.tm, fps, Lf);
      for (const w of cut.warnings) warnings.push(`layer ${L.id}: ${w}`);
      t1 = r3(t0 + cut.L / fps);   // whole frames (and cut): the <video>'s data-duration is the rendered length L / fps
      g.L = cut.L;
    }
    // ---- geometry ----
    let box = L.box;
    if (kind === "logo" && box === undefined) box = logoBox(W);
    if (g && g.mode === "insert") { if (box !== undefined) warnings.push(`layer ${L.id}: ${reason("GW4")}`); box = { x: 0, y: 0, w: W, h: H }; }
    else if (g && box === undefined) box = centredBox(g.meta.size, W, H);
    if (kind !== "motion") {
      if (!isObj(box) || !["x", "y", "w", "h"].every((k) => fin(box[k])) || box.w <= 0 || box.h <= 0) return bad(`box must be { x, y, w, h } numbers with w, h > 0, got ${JSON.stringify(L.box)}`);
    }
    // ---- media ----
    if (MEDIA_EXT[kind] && (typeof L.src !== "string" || !L.src || L.src.includes("\0") || /^[a-z][a-z0-9+.-]*:|^[\\/]/i.test(L.src) || L.src.split(/[\\/]/).includes(".."))) {
      return bad(`${kind} needs src: a path inside the project (no URL, no absolute path, no ..), got ${JSON.stringify(L.src)}`);
    }
    if (MEDIA_EXT[kind] && !MEDIA_EXT[kind].test(L.src)) return bad(`${kind} src ${JSON.stringify(L.src)} has the wrong extension (want ${kind === "video" ? "mp4/mov/webm/m4v" : "png/jpg/webp/gif/svg"})`);
    if (kind === "motion" && (!Array.isArray(L.elements) || !L.elements.length)) return bad("motion needs elements[]");
    if (kind === "text" && !cleanText(L.text)) return bad("text needs a non-empty text");
    // P3 replaces the generic "20% of the box inside the canvas" rule for a graphic (only P3 is reported)
    if (g && g.mode === "overlay") { const p = checkPlacement({ mode: "overlay", box }, { W, H }); if (p.length) return gp(p[0]); }
    for (const [k, list] of [["enter", ENTERS], ["exit", EXITS], ["fit", FITS], ...(g ? [] : [["audio", AUDIOS]])]) {
      if (L[k] !== undefined && !list.includes(L[k])) return bad(`${k} must be one of ${list.join("|")}, got ${JSON.stringify(L[k])}`);
    }
    if (g) {
      for (const w of ignoredWarnings(L)) warnings.push(`layer ${L.id}: ${w}`);
      if (L.src !== undefined) warnings.push(`layer ${L.id}: ${reason("GW8")}`);
    } else if (L.audio !== undefined && L.audio !== "off" && kind !== "video") warnings.push(`layer ${L.id}: audio only applies to a video layer, ignored`);
    layers.push({
      ...L, id: L.id, kind, index: i, t0, t1, dur: r3(t1 - t0), box: box ? { x: box.x, y: box.y, w: box.w, h: box.h } : undefined,
      pin: pinned, fit: L.fit ?? (kind === "logo" ? "contain" : "cover"), enter: L.enter ?? "fade", exit: L.exit ?? "fade",
      audio: kind === "video" ? L.audio ?? "off" : "off", z: Math.round(clamp(fin(L.z) ? L.z : 0, 0, MAX_Z)),
      opacity: fin(L.opacity) ? clamp(L.opacity, 0, 1) : 1, in: fin(L.in) && L.in > 0 ? L.in : 0, overCaptions: L.overCaptions === true,
      ...(g ? {
        fit: g.mode === "insert" ? "cover" : L.fit ?? "contain", enter: L.enter ?? "none", exit: L.exit ?? "none",
        hideCaptions: typeof L.hideCaptions === "boolean" ? L.hideCaptions : g.mode === "insert",
        // the placement the render needs; `file` and `key` are filled in by build.mjs's render pre-pass
        graphic: { html: L.html, mode: g.mode, L: g.L, inF: g.tm.inF, D: g.tm.D, after: g.tm.after, size: g.meta.size, file: null, key: null },
      } : {}),
    });
  });
  return { layers, errors, warnings, problems };
}

/** Where a layer was asked to start, for edit_truth.json: the facts a measurement needs, resolved. */
export const layerTruth = (layers) => layers.map((l) => ({
  id: l.id, kind: l.kind, start: l.t0, end: l.t1, z: l.z, pin: l.pin, ...(l.overCaptions ? { overCaptions: true } : {}),
  ...(l.kind === "graphic" ? { mode: l.graphic.mode } : {}),
  ...(l.hideCaptions === true && (l.kind === "motion" || l.kind === "text" || l.kind === "graphic") ? { hideCaptions: true } : {}),
  ...(l.audio !== "off" ? { audio: l.audio } : {}),
}));

/** The windows (output seconds) in which the main track is ducked. Merged, sorted, only layers that really have sound. */
export function duckWindows(layers) {
  const w = layers.filter((l) => l.audio === "duck" && l.hasAudio !== false).map((l) => [l.t0, l.t1]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of w) { const p = out.at(-1); if (p && a <= p[1] + 2 * DUCK_RAMP) p[1] = Math.max(p[1], b); else out.push([a, b]); }
  return out;
}

/**
 * The take audio's volume lane (`data-automation`), with duck windows cut into it. `wins` are in
 * OUTPUT seconds; `start`/`d` place the take. With no window overlapping the take this is exactly the
 * lane build.mjs always wrote (so a reel without layers - or with none that duck - is byte-identical).
 */
export function takeVolumeLane(d, fps, start = 0, wins = []) {
  const lo = 2 / fps, hi = d - 3 / fps;
  const pts = [{ t: 0, v: 0 }, { t: r3(lo), v: 1 }, { t: r3(hi), v: 1 }, { t: r3(d), v: 0 }];
  const local = wins.map(([a, b]) => [clamp(a - start, lo, hi), clamp(b - start, lo, hi)]).filter(([a, b]) => b - a > 0.02);
  if (local.length) {
    const extra = [];
    for (const [a, b] of local) {
      const ramp = Math.min(DUCK_RAMP, (b - a) / 2);
      extra.push({ t: r3(a), v: 1 }, { t: r3(a + ramp), v: DUCK_LEVEL }, { t: r3(b - ramp), v: DUCK_LEVEL }, { t: r3(b), v: 1 });
    }
    // a duck that touches the take's own fade keeps the fade: the lower of the two values wins at a shared time
    const all = [...pts, ...extra].sort((x, y) => x.t - y.t || x.v - y.v);
    const merged = [];
    for (const p of all) { const q = merged.at(-1); if (q && q.t === p.t) q.v = Math.min(q.v, p.v); else merged.push({ ...p }); }
    return JSON.stringify({ version: 1, lanes: [{ target: "volume", points: merged }] });
  }
  return JSON.stringify({ version: 1, lanes: [{ target: "volume", points: pts }] });
}

/** A graphic layer with no enter animation that starts at the (section's) 0: shown by its inline style from frame 0. */
const graphicShownAtZero = (l, off = 0) => l.kind === "graphic" && l.enter === "none" && r3(l.t0 - off) <= 0;

/** The enter + exit tween lines for a layer's box. Explicit from AND to on every tween, force3D:false. */
export function layerTweens(l, off = 0) {
  const sel = `#ly-${l.id}_box`, op = r3(l.opacity), ed = r3(Math.min(ENTER_DUR, l.dur / 3));
  const t0 = r3(l.t0 - off), t1 = r3(l.t1 - off);
  const lines = [];
  const ft = (from, to) => lines.push(`ft("${sel}", ${JSON.stringify(from)}, ${JSON.stringify({ ...to, force3D: false })}, ${t0});`);
  if (l.enter === "slide-up") ft({ autoAlpha: 0, y: 60 }, { autoAlpha: op, y: 0, duration: ed, ease: "power3.out" });
  else if (l.enter === "pop") ft({ autoAlpha: 0, scale: 0.7 }, { autoAlpha: op, scale: 1, duration: ed, ease: "back.out(1.7)" });
  // fade / none also carry y: 0 on both sides. GSAP writes an identity transform on the first render of a
  // force3D:false tween that has none, so without it the box's DOM would read "transform: none" until the
  // playhead first reached it and "translate(0,0)" ever after - same pixels, but not a pure function of time
  // (motion-determinism --variant layers caught it). The baseline set at 0 now writes it up front.
  else if (l.enter === "none" && l.kind === "graphic") {
    // a graphic shows its own frame 0 AT t0: the 1 ms show tween ends at t0 instead of starting there (measured in a
    // real render: starting at t0 left the first frame of the window empty). Graphic layers only (byte-identity).
    // At t0 = 0 there is no tween: the box is visible by its own style (graphicShownAtZero, renderLayer).
    if (!graphicShownAtZero(l, off)) lines.push(`ft("${sel}", ${JSON.stringify({ autoAlpha: 0, y: 0 })}, ${JSON.stringify({ autoAlpha: op, y: 0, duration: 0.001, ease: "none", force3D: false })}, ${r3(t0 - 0.001)});`);
  }
  else if (l.enter === "none") ft({ autoAlpha: 0, y: 0 }, { autoAlpha: op, y: 0, duration: 0.001, ease: "none" });
  else ft({ autoAlpha: 0, y: 0 }, { autoAlpha: op, y: 0, duration: ed, ease: "power1.out" });
  const out = l.exit === "fade" ? ed : 0.001;
  lines.push(`tl.fromTo("${sel}", ${JSON.stringify({ autoAlpha: op })}, ${JSON.stringify({ autoAlpha: 0, duration: out, ease: l.exit === "fade" ? "power1.in" : "none", force3D: false, immediateRender: false })}, ${r3(t1 - out)});`);
  return lines;
}

/** Stylesheet for the layer containers. Only emitted when a reel has layers. */
export const layersCss = () => `
  .lyr { position: absolute; inset: 0; pointer-events: none; }
  .lyr-box { position: absolute; box-sizing: border-box; overflow: hidden; }
  .lyr-box.lyr-free { overflow: visible; }
  .lyr-text { width: 100%; height: 100%; display: flex; align-items: center; box-sizing: border-box; line-height: 1.1; }
  .lyr-text > div { max-width: 100%; overflow-wrap: break-word; }`;

/**
 * Render one resolved layer.
 * ctx: { W, H, brand, uiFont, esc, compileMotion, resolveColor, resolveImage, off (section origin, default 0) }
 * @returns {{ html: string, lines: string[], audio: string, warnings: string[], mediaIndex }}
 */
export function renderLayer(l, ctx, n = 0) {
  const { W, H, brand = {}, esc, compileMotion, resolveColor, resolveImage, off = 0 } = ctx;
  const warnings = [];
  const wid = `ly-${l.id}`, t0 = r3(l.t0 - off), dur = r3(l.dur);
  const isVideo = l.kind === "video" || l.kind === "graphic";   // a graphic is its rendered file in a <video>
  let content = "", boxCss, free = false, lines = [], audio = "";
  const fitCss = `width:100%;height:100%;object-fit:${l.fit};display:block`;
  if (l.kind === "motion") {
    // the SAME compiler as a motion beat; its own exit is turned off (the layer's exit runs on the box) and
    // its time window is the layer's, so the 0.6..8 s beat limit does not apply. room is never honoured.
    const mg = compileMotion({ id: l.id, elements: l.elements, tweens: l.tweens, dim: l.dim, exit: "none", room: "none" },
      { id: `${wid}_m`, t0, t1: r3(t0 + dur), W, H, brand, resolveImage, minSpan: MIN_LAYER, maxSpan: Infinity, dataIds: true });
    for (const m of mg.warnings || []) warnings.push(m);
    if (!mg.ok) return { html: "", lines: [], audio: "", warnings: [...warnings, `layer ${l.id} dropped: ${mg.reason}`], dropped: true };
    content = mg.html; lines = mg.lines; free = true;
    boxCss = `left:0;top:0;width:${W}px;height:${H}px`;
  } else {
    const b = l.box;
    boxCss = `left:${r3(b.x)}px;top:${r3(b.y)}px;width:${r3(b.w)}px;height:${r3(b.h)}px`;
    if (l.kind === "graphic") {
      // the pre-rendered file (in / after are baked into it: it starts at its frame 0), silent, no audio element
      content = `<video id="${wid}_v" src="${esc(l.graphic.file)}" data-start="${t0}" data-duration="${dur}" data-media-start="0" data-track-index="${40 + n}" muted playsinline style="${fitCss}"></video>`;
    } else if (isVideo) {
      content = `<video id="${wid}_v" src="${esc(l.src)}" data-start="${t0}" data-duration="${dur}" data-media-start="${r3(l.in)}" data-track-index="${40 + n}" muted playsinline style="${fitCss}"></video>`;
      if (l.audio !== "off" && l.hasAudio !== false) audio = `<audio id="${wid}_a" src="${esc(l.src)}" data-start="${t0}" data-duration="${dur}" data-media-start="${r3(l.in)}" data-track-index="${80 + n}" data-volume="1"></audio>`;
      else if (l.audio !== "off") warnings.push(`layer ${l.id}: ${l.src} has no audio stream, audio ${l.audio} ignored`);
    } else if (l.kind === "image" || l.kind === "logo") {
      content = `<img id="${wid}_i" src="${esc(l.src)}" style="${fitCss}" alt="">`;
    } else if (l.kind === "text") {
      const size = Math.round(clamp(fin(l.size) ? l.size : 64, 8, 400)), color = resolveColor(l.color ?? "#ffffff", brand) ?? "#ffffff";
      const bg = l.bg ? resolveColor(l.bg, brand) : null;
      const font = DESIGNER_FONTS.includes(l.font) ? `'${l.font}',` : "";
      const align = ALIGN[l.align] ? l.align : "center";
      content = `<div id="${wid}_t" class="lyr-text" data-layer-text="${esc(l.id)}" style="justify-content:${ALIGN[align]};text-align:${align};font-family:${font}${ctx.uiFont ?? "Inter"},system-ui,sans-serif;font-size:${size}px;font-weight:${Math.round(clamp(fin(l.weight) ? l.weight : 700, 100, 900))};color:${color};${bg ? `background:${bg};padding:${Math.round(size * 0.3)}px ${Math.round(size * 0.45)}px;` : ""}"><div>${esc(cleanText(l.text))}</div></div>`;
    }
    lines = [];
  }
  const radius = fin(l.radius) && l.radius > 0 ? `border-radius:${r3(Math.min(l.radius, 2000))}px;` : "";
  const sh = l.shadow === true ? SHADOWS.soft : SHADOWS[l.shadow] ?? "";
  const shadowCss = sh ? `box-shadow:${sh};` : "";
  const hidden = graphicShownAtZero(l, off) ? (l.opacity < 1 ? `opacity:${r3(l.opacity)};` : "") : "visibility:hidden;";
  const box = `<div id="${wid}_box" class="lyr-box${free ? " lyr-free" : ""}" data-layer-box="${esc(l.id)}" style="${hidden}${boxCss};${radius}${shadowCss}">${content}</div>`;
  // a <video> must be timed itself (a timed wrapper around it breaks the media clock), so its wrapper is
  // untimed and the box's own autoAlpha tweens are what show and hide it; every other kind sits in a timed .clip
  // (the box starts visibility:hidden inline: GSAP's baseline set is not applied at seek(0) on a fresh paused timeline,
  // so without it an empty card and its shadow show at 0:00; the enter tween's autoAlpha > 0 flips it to inherit)
  const timed = isVideo ? "" : ` clip" data-start="${t0}" data-duration="${dur}" data-track-index="${2}`;
  const html = `<div id="${wid}" class="lyr${timed}" data-layer-id="${esc(l.id)}" data-layer-kind="${l.kind}" style="z-index:${l.z}">${box}</div>`;
  return { html, lines: [...lines, ...layerTweens(l, off)], audio, warnings };
}

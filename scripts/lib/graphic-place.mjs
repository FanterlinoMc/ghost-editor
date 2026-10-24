// Prompt Motion graphic in the reel (PM3; references/reel-json.md "Prompt Motion graphic"): resolve a graphic layer's
// or beat's placement (the G/P problems, the GW warnings, the frame count L, in / after), render each graphic it
// needs ONCE per cache key through PM2's renderGraphic (graphic-render.mjs; never reimplemented here), and write the
// <video> a beat places. A layer's markup is renderLayer's (layers.mjs), the same as a video layer's.
//
// The async render fits the synchronous build as ONE pre-pass: build.mjs resolves every graphic layer (with the
// other layers) and every graphic beat (before the beat loop, like the motion-beat pre-pass), then awaits
// prepareGraphics() once, at top level, before anything is emitted. Every render is finished (or the reel died /
// the beat was dropped) before the first byte of index.html is written, so the build stays deterministic: the same
// reel + the same cached files give the same bytes. A reel with no graphic layer or beat never reaches this file.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { inspectGraphic, graphicFrames, checkPlacement, reason, beatProblem, graphicName } from "./graphic.mjs";
import { renderGraphic } from "./graphic-render.mjs";

export const MODES = ["overlay", "insert"];                 // a layer's modes
export const BEAT_MODES = [...MODES, "behind"];             // v3.6: a beat may also go behind the speaker's cut-out
// behind renders exactly as an overlay (alpha WebM, same checks, same cache key): only where it is drawn differs
export const renderMode = (mode) => (mode === "behind" ? "overlay" : mode);
export const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const STUB_CHROME = "0.0.0-stub";   // the Chrome version every test-deps render is keyed (and checked, R13) under
export const GRAPHIC_FITS = ["cover", "contain"];
const r3 = (x) => Math.round(x * 1000) / 1000;
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const goodBox = (b) => isObj(b) && ["x", "y", "w", "h"].every((k) => fin(b[k])) && b.w > 0 && b.h > 0;

/** The static check (G1-G35) of the file a layer or beat names. -> inspectGraphic's { ok, reasons, meta } */
export const inspectPlaced = (entry, { proj, W, H }) =>
  inspectGraphic(null, { html: entry.html, projectDir: proj, W, H, mode: renderMode(entry.mode ?? "overlay") });

/** The default overlay box: the design size, centred on the canvas. */
export const centredBox = (size, W, H) => ({ x: r3((W - size.w) / 2), y: r3((H - size.h) / 2), w: size.w, h: size.h });

/** in / after, the warnings they give (GW1, GW3) and the graphic's own length in frames (D, from inF). */
export function graphicTiming(meta, entry, fps) {
  const fr = graphicFrames({ duration: meta.duration, fps, inS: entry.in ?? 0, after: entry.after ?? "hold" });
  return { inF: fr.inF, D: fr.D, after: fr.after, warnings: fr.warnings, defaultWindow: (fr.D - fr.inF) / fps };
}

/** after "cut": a placement of Lf frames is shortened to the graphic's length from inF (GW2). -> { L, warnings } */
export function cutFrames(meta, timing, fps, Lf) {
  const fr = graphicFrames({ duration: meta.duration, fps, inS: timing.inF / fps, after: timing.after, frames: Lf });
  return { L: fr.L, warnings: fr.warnings };
}

/** The ignored-field warnings every placement shares: GW5 audio, GW6 fps (GW4 box and GW8 src are the caller's). */
export function ignoredWarnings(entry) {
  const w = [];
  if (entry.audio !== undefined && entry.audio !== "off") w.push(reason("GW5"));
  if (entry.fps !== undefined) w.push(reason("GW6"));
  return w;
}

/** GW7: an overlay box that crosses the platform UI zone. sz = safezone PLATFORMS[p] ({top, bottom, right, name}). */
export const crossesUi = (box, sz, W, H) => !!sz && (box.y < sz.top || box.y + box.h > H - sz.bottom || box.x + box.w > W - sz.right);

/**
 * Resolve a `type: "graphic"` beat (source seconds). Problems drop the beat (the caller warns `problem`); never throws.
 * out(t) maps one of the beat's source times to output seconds (build.mjs EB / E; it may throw).
 * -> { problem } | { t0, t1, L, inF, D, after, mode, box, fit, opacity, hideCaptions, meta, warnings }
 */
export function resolveGraphicBeat(b, insp, { out, fps, W, H }) {
  const label = graphicLabel(b);
  const drop = (r, code = null) => ({ problem: beatProblem(label, b.html, r), code });   // code: mac-54's record
  if (!insp.ok) return drop(insp.reasons[0], (insp.codes || [])[0] ?? null);
  const meta = insp.meta, mode = b.mode ?? "overlay";
  if (!BEAT_MODES.includes(mode)) return drop(reason("P1", { v: mode }).replace("overlay or insert", "overlay, insert or behind"), "P1");
  const tm = graphicTiming(meta, b, fps);
  const warnings = [...tm.warnings];
  // the window, in source seconds: to - at when both are seconds of the same recording, or the graphic's own length
  // from `in` when `to` is left out (P2 on it when it can be read: not for "end", "hold:...", two recordings). Then
  // P2 ALWAYS again on the output window E(to) - E(at): a beat across a cut can be long in source seconds and a few
  // frames long on screen.
  const srcOf = (x) => (fin(x) ? { src: null, t: x } : isObj(x) && fin(x.t) ? { src: x.src ?? null, t: x.t } : null);
  const A = srcOf(b.at), Z = b.to === undefined ? null : srcOf(b.to);
  const win = b.to === undefined ? (A ? tm.defaultWindow : undefined) : A && Z && A.src === Z.src ? Z.t - A.t : undefined;
  const p2 = (s) => checkPlacement({ mode, window: r3(s) }, { W, H });
  if (win !== undefined && p2(win).length) return drop(p2(win)[0], "P2");
  let t0, t1;
  try {
    t0 = out(b.at);
    if (b.to !== undefined) t1 = out(b.to);
    else if (A) t1 = out(fin(b.at) ? r3(b.at + win) : { ...b.at, t: r3(b.at.t + win) });
    else t1 = r3(t0 + tm.defaultWindow);   // an `at` that is not a source second: the default window in output seconds
  } catch (e) { return drop(String(e.message).split("\n")[0], "time"); }
  if (p2(t1 - t0).length) return drop(p2(t1 - t0)[0], "P2");
  const Lf = Math.round((t1 - t0) * fps);
  if (Lf < 1) return drop(reason("P2", { s: r3(t1 - t0) }), "P2");
  t1 = r3(t0 + Lf / fps);   // whole frames: the <video>'s data-duration is the rendered length L / fps
  const cut = cutFrames(meta, tm, fps, Lf);
  warnings.push(...cut.warnings);
  if (cut.L < Lf) t1 = r3(t0 + cut.L / fps);
  let box;
  if (mode === "insert") {
    if (b.box !== undefined) warnings.push(reason("GW4"));
    box = { x: 0, y: 0, w: W, h: H };
  } else if (mode === "behind" && b.box === undefined) {
    box = { x: 0, y: 0, w: W, h: H };   // full-bleed: the cut-out covers the face, so there is no free box to fit
  } else {
    if (b.box !== undefined && !goodBox(b.box)) return drop(`box must be { x, y, w, h } numbers with w, h > 0, got ${JSON.stringify(b.box)}`, "box");
    box = b.box !== undefined ? { x: b.box.x, y: b.box.y, w: b.box.w, h: b.box.h } : centredBox(meta.size, W, H);
    const p = checkPlacement({ mode, box }, { W, H });
    if (p.length) return drop(p[0], "P3");
  }
  if (b.fit !== undefined && !GRAPHIC_FITS.includes(b.fit)) return drop(`fit must be one of ${GRAPHIC_FITS.join("|")}, got ${JSON.stringify(b.fit)}`, "fit");
  warnings.push(...ignoredWarnings(b));
  return {
    html: b.html, t0, t1, L: cut.L, inF: tm.inF, D: tm.D, after: tm.after, mode, box, meta, warnings: warnings.map((w) => `graphic ${label}: ${w}`),
    fit: mode === "insert" ? "cover" : b.fit ?? "contain", opacity: fin(b.opacity) ? Math.min(1, Math.max(0, b.opacity)) : 1,
    hideCaptions: typeof b.hideCaptions === "boolean" ? b.hideCaptions : mode === "insert",
  };
}
/** How a beat is named in its problems and warnings: its id, else its `at`. */
export const graphicLabel = (b) => (b.id !== undefined ? String(b.id) : fin(b.at) ? String(b.at) : JSON.stringify(b.at));

/**
 * Render (or find cached) every graphic the reel needs, ONCE per distinct placement (html, mode, L, in, after: the
 * parts of the cache key a reel can change), one at a time, in the order given. Each job: { html, mode, L, inF, after }.
 * opts: { proj, W, H, fps, deps (renderGraphic's injectable steps), log }
 * -> Promise<results[]> in job order, each { ok, file (project-relative, "/"), key, reasons, codes, cached }
 */
export async function prepareGraphics(jobs, { proj, W, H, fps, deps = {}, log = () => {}, render = renderGraphic, done = new Map() }) {
  // done: pass the same Map to several calls (layers first, then beats) to keep one render per placement across them
  const results = [];
  for (const j of jobs) {
    const id = JSON.stringify([j.html, renderMode(j.mode), j.L, j.inF, j.after]);
    if (!done.has(id)) {
      const name = graphicName(j.html);
      const t = Date.now();
      const r = await render({ html: j.html, projectDir: proj, mode: renderMode(j.mode), W, H, fps, inS: j.inF / fps, after: j.after, frames: j.L,
        log: (m) => log(`graphic ${name}: ${m}`) }, deps);
      const rel = r.ok && r.file ? path.relative(proj, r.file).split(path.sep).join("/") : null;
      const res = { ok: !!r.ok, file: rel, key: r.key ?? null, reasons: r.reasons || [], codes: r.codes || [], cached: !!r.cached };
      log(`graphic ${name}: ${res.ok ? (res.cached ? `cached ${rel}` : `rendered ${rel} (${j.L} frames, ${((Date.now() - t) / 1000).toFixed(1)}s)`) : `refused: ${res.reasons[0]}`}`);
      done.set(id, res);
    }
    results.push(done.get(id));
  }
  return results;
}

/**
 * Tests only: GRAPHIC_TEST_DEPS names a module whose `deps` export replaces renderGraphic's external steps (Chrome,
 * the probe, `hyperframes render`). Three guards, so it can never weaken a real render or poison the cache:
 *   1. honoured only under `node --test` (NODE_TEST_CONTEXT set); anywhere else it is ignored, with a warning;
 *   2. only a module whose realpath lies inside scripts/fixtures/ of this engine (anything else dies);
 *   3. chromeVersion is forced to STUB_CHROME after the module's deps are spread, so every such render is keyed
 *      under a Chrome that does not exist, and a real Chrome's render under it is refused by R13 (nothing cached).
 */
export async function testDeps(env = process.env) {
  if (!env.GRAPHIC_TEST_DEPS) return {};
  if (!env.NODE_TEST_CONTEXT) { console.log("WARNING: GRAPHIC_TEST_DEPS is ignored outside node --test"); return {}; }
  let real = null;
  try { real = fs.realpathSync(path.resolve(env.GRAPHIC_TEST_DEPS)); } catch {}
  const dir = fs.realpathSync(FIXTURES_DIR);
  if (!real || !real.startsWith(dir + path.sep)) throw new Error(`GRAPHIC_TEST_DEPS must name a module inside ${dir.split(path.sep).join("/")}/ (got ${env.GRAPHIC_TEST_DEPS})`);
  const m = await import(pathToFileURL(real).href);
  console.log(`graphic renders STUBBED by GRAPHIC_TEST_DEPS (${path.basename(real)}): tests only`);
  return { ...m.deps, chromeVersion: () => STUB_CHROME };
}

/** A beat's markup: an untimed box (the beats' .layer band; an insert above the beats) with the timed <video>. */
export function graphicBeatHtml(id, g, { t0, dur, esc, rel }) {
  const b = g.box, name = graphicName(g.html);
  // a graphic at 0 is visible from the first frame by its own style (a 1 ms show tween cannot end at 0)
  const shown = t0 <= 0 ? (g.opacity < 1 ? `opacity:${r3(g.opacity)}` : "") : "visibility:hidden";
  const style = `position:absolute;left:${r3(b.x)}px;top:${r3(b.y)}px;width:${r3(b.w)}px;height:${r3(b.h)}px;overflow:hidden${shown ? `;${shown}` : ""}`;
  return `<div id="${id}-in" class="graphic" data-graphic="${esc(name)}" data-graphic-mode="${g.mode}" style="${style}"><video id="${id}-v" src="${esc(rel)}" data-start="${t0}" data-duration="${dur}" data-media-start="0" muted playsinline style="width:100%;height:100%;object-fit:${g.fit};display:block"></video></div>`;
}
/** Show / hide tweens for a beat's box (the graphic animates itself: no enter / exit motion). The 1 ms show tween ENDS
 *  at t0 and the hide tween ends at t1, so the window shows exactly frames [t0, t1) (measured in a real render). */
export function graphicBeatTweens(id, g, t0, t1) {
  const sel = `#${id}-in`, op = r3(g.opacity);
  return [
    ...(t0 <= 0 ? [] : [`ft("${sel}", ${JSON.stringify({ autoAlpha: 0 })}, ${JSON.stringify({ autoAlpha: op, duration: 0.001, ease: "none", force3D: false })}, ${r3(t0 - 0.001)});`]),
    `tl.fromTo("${sel}", ${JSON.stringify({ autoAlpha: op })}, ${JSON.stringify({ autoAlpha: 0, duration: 0.001, ease: "none", force3D: false, immediateRender: false })}, ${r3(t1 - 0.001)});`,
  ];
}

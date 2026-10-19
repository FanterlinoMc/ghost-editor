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
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectGraphic, graphicFrames, checkPlacement, reason, beatProblem, graphicName } from "./graphic.mjs";
import { renderGraphic } from "./graphic-render.mjs";

export const MODES = ["overlay", "insert"];
export const GRAPHIC_FITS = ["cover", "contain"];
const r3 = (x) => Math.round(x * 1000) / 1000;
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const goodBox = (b) => isObj(b) && ["x", "y", "w", "h"].every((k) => fin(b[k])) && b.w > 0 && b.h > 0;

/** The static check (G1-G35) of the file a layer or beat names. -> inspectGraphic's { ok, reasons, meta } */
export const inspectPlaced = (entry, { proj, W, H }) =>
  inspectGraphic(null, { html: entry.html, projectDir: proj, W, H, mode: entry.mode ?? "overlay" });

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
  const drop = (r) => ({ problem: beatProblem(label, b.html, r) });
  if (!insp.ok) return drop(insp.reasons[0]);
  const meta = insp.meta, mode = b.mode ?? "overlay";
  if (!MODES.includes(mode)) return drop(reason("P1", { v: mode }));
  const tm = graphicTiming(meta, b, fps);
  const warnings = [...tm.warnings];
  // the window, in source seconds: to - at, or the graphic's own length from `in` when `to` is left out
  const srcT = (x) => (fin(x) ? x : isObj(x) && fin(x.t) ? x.t : null);
  const a = srcT(b.at), z = b.to === undefined ? null : srcT(b.to);
  const win = b.to === undefined ? tm.defaultWindow : a !== null && z !== null ? z - a : undefined;
  if (win !== undefined) { const p = checkPlacement({ mode, window: r3(win) }, { W, H }); if (p.length) return drop(p[0]); }
  let t0, t1;
  try {
    t0 = out(b.at);
    t1 = b.to !== undefined ? out(b.to) : out(fin(b.at) ? r3(b.at + win) : isObj(b.at) ? { ...b.at, t: r3(b.at.t + win) } : b.at);
  } catch (e) { return drop(String(e.message).split("\n")[0]); }
  const Lf = Math.round((t1 - t0) * fps);
  if (Lf < 1) return drop(reason("P2", { s: r3(t1 - t0) }));
  const cut = cutFrames(meta, tm, fps, Lf);
  warnings.push(...cut.warnings);
  if (cut.L < Lf) t1 = r3(t0 + cut.L / fps);
  let box;
  if (mode === "insert") {
    if (b.box !== undefined) warnings.push(reason("GW4"));
    box = { x: 0, y: 0, w: W, h: H };
  } else {
    if (b.box !== undefined && !goodBox(b.box)) return drop(`box must be { x, y, w, h } numbers with w, h > 0, got ${JSON.stringify(b.box)}`);
    box = b.box !== undefined ? { x: b.box.x, y: b.box.y, w: b.box.w, h: b.box.h } : centredBox(meta.size, W, H);
    const p = checkPlacement({ mode, box }, { W, H });
    if (p.length) return drop(p[0]);
  }
  if (b.fit !== undefined && !GRAPHIC_FITS.includes(b.fit)) return drop(`fit must be one of ${GRAPHIC_FITS.join("|")}, got ${JSON.stringify(b.fit)}`);
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
export async function prepareGraphics(jobs, { proj, W, H, fps, deps = {}, log = () => {}, render = renderGraphic }) {
  const done = new Map();
  const results = [];
  for (const j of jobs) {
    const id = JSON.stringify([j.html, j.mode, j.L, j.inF, j.after]);
    if (!done.has(id)) {
      const name = graphicName(j.html);
      const t = Date.now();
      const r = await render({ html: j.html, projectDir: proj, mode: j.mode, W, H, fps, inS: j.inF / fps, after: j.after, frames: j.L,
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
 * the probe, `hyperframes render`). Its stub never opens the graphic in a browser, so it cannot reach the network;
 * its Chrome version is not a real one, so its files never share a cache key with a real render.
 */
export async function testDeps(env = process.env) {
  if (!env.GRAPHIC_TEST_DEPS) return {};
  const m = await import(pathToFileURL(path.resolve(env.GRAPHIC_TEST_DEPS)).href);
  console.log(`graphic renders STUBBED by GRAPHIC_TEST_DEPS (${env.GRAPHIC_TEST_DEPS}): tests only`);
  return m.deps;
}

/** A beat's markup: an untimed box (the beats' .layer band; an insert above the beats) with the timed <video>. */
export function graphicBeatHtml(id, g, { t0, dur, esc, rel }) {
  const b = g.box, name = graphicName(g.html);
  const style = `position:absolute;left:${r3(b.x)}px;top:${r3(b.y)}px;width:${r3(b.w)}px;height:${r3(b.h)}px;overflow:hidden;visibility:hidden`;
  return `<div id="${id}-in" class="graphic" data-graphic="${esc(name)}" data-graphic-mode="${g.mode}" style="${style}"><video id="${id}-v" src="${esc(rel)}" data-start="${t0}" data-duration="${dur}" data-media-start="0" muted playsinline style="width:100%;height:100%;object-fit:${g.fit};display:block"></video></div>`;
}
/** Show / hide tweens for a beat's box (the graphic animates itself: no enter / exit motion). The 1 ms show tween ENDS
 *  at t0 and the hide tween ends at t1, so the window shows exactly frames [t0, t1) (measured in a real render). */
export function graphicBeatTweens(id, g, t0, t1) {
  const sel = `#${id}-in`, op = r3(g.opacity);
  return [
    `ft("${sel}", ${JSON.stringify({ autoAlpha: 0 })}, ${JSON.stringify({ autoAlpha: op, duration: 0.001, ease: "none", force3D: false })}, ${r3(Math.max(0, t0 - 0.001))});`,
    `tl.fromTo("${sel}", ${JSON.stringify({ autoAlpha: op })}, ${JSON.stringify({ autoAlpha: 0, duration: 0.001, ease: "none", force3D: false, immediateRender: false })}, ${r3(t1 - 0.001)});`,
  ];
}

// Frame preview (the planner's look-and-revise step): a Prompt Motion graphic rendered at a few exact times to PNGs,
// through the SAME sandbox as renderGraphic (graphic-render.mjs), in the same order: the static rules first (a
// refused file never starts Chrome), the root uid drop (chromeUser, the per-uid host lock, sweepUid, chromeHome, and
// releaseChromeHome + the lock release on every path), the Chrome launcher shim with the network lock flags, the R12
// probe through that shim and launcher, then ONE `hyperframes render --format png-sequence` (runRender: preload,
// launcher, PID marker, timeout kill) of the engine's wrapper page (wrapperHtml: CSP, integrity pre-script, R14 glyph
// check, post-script), and the same log rules (scanLog: R1-R5, R6o, R11, R14) plus R13 (shim proof), R10 and R7.
// Not done here (a preview, not the cache gate): the second render + framemd5 (R6), R8, R9 (a frame may be blank).
// Output: an overlay frame is an RGBA PNG (transparent background); an insert is flattened onto black (flatten).
//
// How exact times are rendered in one render: the wrapper is built on a 1 ms grid (fps 1000, D = duration*1000 + 1,
// so t = duration is a frame), and hyperframes is asked for N frames at 1 fps (data-duration = N s). A tiny ENGINE
// script placed before the pre-script registers the first hf-seek listener and rewrites detail.time of frame i to
// k_i / 1000; the pre-script's own listener (unchanged) then maps it to grid frame k_i and calls window.seek(k_i / 1000).
// The graphic's scripts all run after both, as in renderGraphic. Times are rounded to the millisecond; a time outside
// 0..window.duration is REFUSED (T1, before Chrome starts), never clamped: a preview of a frame that never shows
// would mislead the planner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inspectGraphic, wrapperHtml, renderedSize, reason, fmtT } from "./graphic.mjs";
import {
  chromeUser, chromeHome, releaseChromeHome, hostLock, sweepUid, findChrome, chromeShim, chromeVersion, probeNetwork,
  runRender, sandboxLauncher, scanLog, launchedChrome, budgetFor, ffmpegBin, PROBE_URLS,
} from "./graphic-render.mjs";

export const GRID = 1000; // wrapper fps: times on a 1 ms grid
export const PREVIEW_FPS = 1; // hyperframes fps: frame i is shown at i s, rewritten to the i-th asked time
export const timeRefusal = (t, duration) => `T1: time ${t}s is outside 0..${duration}s (the graphic's window.duration): nothing rendered`;
const lastLine = (log) => String(log || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "(no output)";
// "<code>: <text>", the refusal line the CLI prints (the texts are renderGraphic's / the spec's, word for word)
const tag = (codes, reasons) => (reasons.length ? `${codes[0]}: ${reasons[0]}` : null);

// times (numbers) -> { ks: [grid frame], ts: [rounded t] } (distinct, in the order asked) or { error }
export function gridTimes(times, duration) {
  const ks = [], ts = [];
  for (const t of times) {
    if (!Number.isFinite(t) || t < 0 || t > duration) return { error: timeRefusal(t, duration) };
    const k = Math.round(t * GRID);
    if (!ks.includes(k)) { ks.push(k); ts.push(k / GRID); }
  }
  return { ks, ts };
}
// the engine's time map: before the pre-script, the first hf-seek listener; frame i (at i / PREVIEW_FPS s) -> k_i / GRID
export function timeMapScript(ks) {
  return `<script>
(function () {
  var K = ${JSON.stringify(ks)}, round = Math.round;
  EventTarget.prototype.addEventListener.call(window, "hf-seek", function (e) {
    var i = round(e.detail.time * ${PREVIEW_FPS}); if (i < 0) i = 0; if (i > K.length - 1) i = K.length - 1;
    e.detail.time = K[i] / ${GRID};
  });
})();
</script>
`;
}
// the preview page: the engine wrapper on the 1 ms grid, the time map ahead of its first script, N frames long.
// Throws if the wrapper's shape is not the one this relies on (never a silently different page).
export function framesWrapper({ html, meta, mode, W, H, ks }) {
  const D = Math.round(meta.duration * GRID) + 1;
  const page = wrapperHtml({ html, meta, mode, fps: GRID, L: D, inF: 0, D, after: "hold", W, H });
  const { w, h } = renderedSize(meta, mode, W, H);
  const root = `<div id="graphic-root" data-composition-id="graphic" data-width="${w}" data-height="${h}" data-start="0" data-duration="${+(D / GRID).toFixed(6)}" data-no-timeline>`;
  const s = page.indexOf("</style>\n<script>\n"), b = page.indexOf(`</head>\n<body>\n${root}`);
  if (s < 0 || b < 0 || b < s) throw new Error("graphic-frames: the engine wrapper changed shape (no engine <style> + <script>, or no graphic-root after </head><body>)");
  const at = s + "</style>\n".length, rb = b + "</head>\n<body>\n".length;
  const nroot = root.replace(/data-duration="[^"]*"/, `data-duration="${ks.length / PREVIEW_FPS}"`);
  return page.slice(0, at) + timeMapScript(ks) + page.slice(at, rb) + nroot + page.slice(rb + root.length);
}

// opts: { content (bytes), html (the reel.json-style path, for the messages), projectDir, mediaRoot, mode, W, H,
//         times: [s], outDir, log(fn), probeUrls, budget }
// deps: the same injectables as renderGraphic (tests stub them), plus readFrames(dir) -> [png paths in frame order] and
//       flatten(src, dst) (insert only)
// -> Promise<{ ok, frames: [{ t, file }], refused: "<code>: <text>" | null, reasons, codes, stage, secs? }>
export async function renderFrames(opts, deps = {}) {
  const D = { chromeUser, chromeHome, releaseChromeHome, hostLock, sweepUid, findChrome, chromeShim, chromeVersion, probeNetwork, runRender, readFrames, flatten, ...deps };
  const { html: htmlPath = "assets/graphics/graphic.html", projectDir = null, mode = "overlay", W = 1080, H = 1920, times = [], log = () => {} } = opts;
  const no = (codes, reasons, stage, extra = {}) => ({ ok: false, frames: [], refused: tag(codes, reasons), reasons, codes, stage, ...extra });
  const insp = inspectGraphic(opts.content ?? null, { html: htmlPath, projectDir, W, H, mode, mediaRoot: opts.mediaRoot });
  if (!insp.ok) return no(insp.codes, insp.reasons, "static");
  const meta = insp.meta;
  const g = gridTimes(times, meta.duration);
  if (g.error) return no(["T1"], [g.error.replace(/^T1: /, "")], "static");
  if (!g.ks.length) return no(["T1"], ["no times asked (--at t1,t2,...)"], "static");
  const user = D.chromeUser();
  if (user.error) return no(["R12"], [reason("R12n", { message: user.error })], "setup");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-frames-"));
  let home = null, lock = null, res, thrown = null;
  try { res = await (async () => {
    const setup = (e) => no(["R12"], [reason("R12n", { message: e.message })], "setup");
    let exe;
    try { exe = D.findChrome(); } catch (e) { return setup(e); }
    if (user.root) {
      log(`running as root: Chrome as ${user.uid}:${user.gid}; waiting for the host lock of uid ${user.uid} ...`);
      try { lock = await D.hostLock(user); } catch (e) { return setup(e); }
      const sw = D.sweepUid(user);
      if (sw.found.length) log(`killed ${sw.found.length} lingering process(es) of uid ${user.uid} before the render`);
      if (!sw.ok) return setup(new Error(sw.error));
    }
    let shim;
    try { home = D.chromeHome(user); shim = D.chromeShim(path.join(scratch, "chrome"), exe, { home, setpriv: user.setpriv || null }); } catch (e) { return setup(e); }
    const chrome = shim ? D.chromeVersion(shim) : null;
    if (!chrome) return setup(new Error(shim ? "the Chrome shim gave no --version" : "no chrome-headless-shell, or no POSIX shim (Windows)"));
    const launcher = sandboxLauncher(process.env);
    const probe = D.probeNetwork({ launcher, shim, urls: opts.probeUrls || PROBE_URLS, user });
    probe.lines.forEach((l) => log(l));
    if (!probe.ok) return no(["R12"], [probe.refusal], "probe");
    const dir = path.join(scratch, "page");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "index.html"), framesWrapper({ html: opts.content ?? fs.readFileSync(path.join(projectDir, htmlPath)), meta, mode, W, H, ks: g.ks }));
    const out = path.join(scratch, "png");
    const budget = opts.budget ?? budgetFor(g.ks.length);
    const markFile = path.join(scratch, "shim.pids");
    const r = await D.runRender({ dir, out, mode, fps: PREVIEW_FPS, format: "png-sequence", launcher, shim, markFile, chromeUid: user.root ? user.uid : null, timeoutMs: Math.round((budget + 60) * 1000), logFile: path.join(scratch, "render.log") });
    log(`render: exit ${r.status}, ${r.secs}s`);
    const found = scanLog(r.log);
    const used = launchedChrome(r.log);
    let marked = "";
    try { marked = fs.readFileSync(markFile, "utf8").trim(); } catch {}
    if (!used || !marked) found.push({ code: "R13", text: reason("R13", { v: !used ? "(no 'Browser launched' line)" : `${used} (not launched through the shim)`, k: chrome }) });
    else if (used !== chrome) found.push({ code: "R13", text: reason("R13", { v: used, k: chrome }) });
    const pngs = r.status === 0 ? D.readFrames(out) : [];
    if (r.status !== 0 || pngs.length !== g.ks.length) found.push({ code: "R10", text: reason("R10", { code: r.status, line: r.status === 0 ? `${pngs.length} PNG frames for ${g.ks.length} times` : lastLine(r.log) }) });
    if (r.secs > budget) found.push({ code: "R7", text: reason("R7", { s: r.secs, L: g.ks.length, b: budget }) });
    if (found.length) return no(found.map((f) => f.code), found.map((f) => f.text), "render", { secs: r.secs });
    fs.mkdirSync(opts.outDir, { recursive: true });
    const frames = g.ts.map((t, i) => {
      const file = path.join(opts.outDir, `f-${fmtT(t)}.png`);
      if (mode === "insert") D.flatten(pngs[i], `${file}.part`);
      else fs.copyFileSync(pngs[i], `${file}.part`);
      fs.renameSync(`${file}.part`, file);
      return { t, file };
    });
    return { ok: true, frames, refused: null, reasons: [], codes: [], stage: "done", secs: r.secs };
  })(); } catch (e) { thrown = e; }
  fs.rmSync(scratch, { recursive: true, force: true });
  let rel = null;
  try { if (home) rel = D.releaseChromeHome(home, user); } finally { if (lock) lock.release(); }
  if (rel && !rel.ok) {
    const msg = `GRAPHIC RENDER UNSAFE: ${rel.error}`;
    log(msg); console.error(msg);
    if (res && res.ok) res.frames.forEach((f) => fs.rmSync(f.file, { force: true })); // nothing from an unsafe render is kept
    if (thrown) throw thrown;
    return no(["R12"], [reason("R12c", { message: rel.error })], "release");
  }
  if (thrown) throw thrown;
  return res;
}
// hyperframes' png-sequence output dir -> its PNGs in frame order (names sort by their frame number)
export function readFrames(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.png$/i.test(n)); } catch { return []; }
  const num = (n) => { const m = /(\d+)(?!.*\d)/.exec(n); return m ? Number(m[1]) : -1; };
  return names.sort((a, b) => num(a) - num(b) || (a < b ? -1 : 1)).map((n) => path.join(dir, n));
}
// An insert is opaque in the reel (renderGraphic: an MP4 of the page on its #000 background), but hyperframes captures
// a png-sequence with a transparent page background: an insert frame is flattened onto black (opaque RGB PNG).
export function flatten(src, dst) {
  const r = spawnSync(ffmpegBin(), ["-v", "error", "-y", "-i", src, "-filter_complex", "[0]split[a][b];[a]drawbox=c=black:t=fill[bg];[bg][b]overlay=format=auto,format=rgb24", "-frames:v", "1", "-f", "image2", "-c:v", "png", dst], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" });
  if (r.status !== 0) throw new Error(`ffmpeg flatten ${src}: ${String(r.stderr || r.error || "").trim().slice(-300)}`);
}

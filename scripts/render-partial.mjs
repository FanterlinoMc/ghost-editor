#!/usr/bin/env node
// Partial rendering (mac-63, opt-in): re-render only the part of a reel an edit changed.
//
//   node scripts/render-partial.mjs <project> [-o build/reel.mp4] [--max 10] [--min 3] [--jobs 2] [--verify <full.mp4>]
//
// Run it AFTER build.mjs, in place of `node scripts/render.mjs -o ...` (which stays the default path; nothing calls this
// one unless asked). The reel is cut into WINDOWS: the sections of build/sections.json (they start at a take cut and no
// beat, push or take-join transition straddles them), frame-aligned, short ones merged and long ones split. Each window
// is rendered from the reel's OWN index.html, time-shifted, never from a separate section build:
//   - the root's data-duration becomes the window's length; every timed element (data-start) is moved by -a, a clip that
//     starts before the window is trimmed (data-media-start moved with it), a clip wholly outside it is switched off
//     (data-pr-off: display none, no src), so nothing it would never show is loaded;
//   - the timeline the page registers as window.__timelines.main is replaced by a delegating one that plays
//     the page's timeline from a to b: the renderer seeking window time t puts the page's own timeline at a + t (its
//     totalTime, nothing runtime-specific: GSAP's or the engine's tween runtime alike), exactly the time a
//     full render would seek for that frame. Every beat, caption and push renders as it does in a full render.
//   - <audio> is left out; the sound is one separate render of the page with no <video> at 1 fps (the mix does not
//     depend on the picture), cached the same way, and muxed onto the joined picture.
// A window's cache key (render-cache/<key>.mp4) is a hash of what can change its pixels: the page head (CSS, fonts), the
// root, the static body, the outerHTML and window-relative timing of every timed element active in the window, every
// script line that names one of those elements or names no element at all, the bytes of the assets they load, and the
// render settings (HyperFrames pin, fps, the vendor preload and manifest). Editing one graphic changes the key of the
// windows that graphic is on screen in, and nothing else. Windows join by stream copy (same encoder settings, each
// starts on a keyframe), so the picture is not re-encoded.
//
// stdout: one JSON line { windows, rendered, reused, seconds: { total, windows: [...], audio, join }, output, ... }.
// --verify <full.mp4>: also compare the result with a full render of the same page (PSNR per frame, audio stream bytes).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HYPERFRAMES, PRELOAD, VENDOR, runRenderAsync } from "./lib/vendor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const VOID = new Set(["img", "source", "br", "hr", "input", "meta", "link", "track", "wbr", "area", "base", "col", "embed", "param"]);

/** Frame-aligned windows over [0, total) from sections.json's sections: merge any shorter than `min` s into the previous
 *  one, split any longer than `max` s evenly. Returns [{ a, b, fa, fb }] (seconds and frame indices, fb exclusive). */
export function planWindows(sections, total, fps, { min = 3, max = 10 } = {}) {
  const F = Math.round(total * fps);
  let cuts = [...new Set([0, ...sections.map((s) => Math.round(s.start * fps)), F])].filter((f) => f >= 0 && f <= F).sort((x, y) => x - y);
  const merged = [cuts[0]];
  for (const c of cuts.slice(1)) {
    if (c === F) { if (F - merged.at(-1) < min * fps && merged.length > 1) merged.pop(); merged.push(F); }
    else if (c - merged.at(-1) >= min * fps) merged.push(c);
  }
  const out = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const fa = merged[i], fb = merged[i + 1], n = Math.ceil((fb - fa) / (max * fps));
    for (let k = 0; k < n; k++) {
      const x = fa + Math.round((k * (fb - fa)) / n), y = fa + Math.round(((k + 1) * (fb - fa)) / n);
      out.push({ fa: x, fb: y, a: r6(x / fps), b: r6(y / fps) });
    }
  }
  return out;
}

/** Every outermost element carrying data-start (except the root): [{ start, end, tag, open, s, d, ids, html }].
 *  `start`/`end` are string offsets of the whole element, `open` the opening tag. Build-generated HTML only (balanced
 *  tags, quoted attributes): this is not a general HTML parser. */
export function timedElements(html) {
  const out = [];
  const openRe = /<([a-zA-Z][\w-]*)\b([^>]*?\sdata-start="([^"]*)"[^>]*)>/g;
  let m;
  while ((m = openRe.exec(html))) {
    if (/data-composition-id=/.test(m[2])) continue;
    const tag = m[1].toLowerCase(), start = m.index;
    let end = openRe.lastIndex;
    if (!(VOID.has(tag) || m[0].endsWith("/>"))) {
      const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
      re.lastIndex = end;
      let depth = 1, t;
      while (depth && (t = re.exec(html))) { if (t[1]) depth--; else if (!t[0].endsWith("/>")) depth++; end = re.lastIndex; }
      if (depth) throw new Error(`unbalanced <${tag}> at ${start}`);
    }
    const piece = html.slice(start, end);
    const d = +((/\sdata-duration="([^"]*)"/.exec(m[2]) || [])[1] ?? NaN);
    out.push({ start, end, tag, open: m[0], s: +m[3], d, ids: [...piece.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]), html: piece });
    openRe.lastIndex = end;   // outermost only
  }
  return out;
}

const active = (e, a, b) => !Number.isFinite(e.d) ? true : e.s < b - 1e-9 && e.s + e.d > a + 1e-9;
const setAttr = (tag, name, value) => new RegExp(`\\s${name}="[^"]*"`).test(tag) ? tag.replace(new RegExp(`\\s${name}="[^"]*"`), ` ${name}="${value}"`) : tag.replace(/\s*\/?>$/, (end) => ` ${name}="${value}"${end}`);

function splitPage(html) {
  const s0 = html.indexOf("<script>", html.indexOf("<body")), s1 = html.indexOf("</script>", s0);
  if (s0 < 0 || s1 < 0) throw new Error("no inline timeline <script> in the page");
  return { head: html.slice(0, html.indexOf("<body")), body: html.slice(html.indexOf("<body"), s0), script: html.slice(s0 + 8, s1), tail: html.slice(s1) };
}

// A timed element the window never shows: kept (the timeline's selectors and getElementById still find it), untimed and
// hidden. A <video> becomes an empty <div> with the same id and class: a src-less <video> makes HyperFrames wait 45 s for
// it to decode, in calibration and again in every capture worker.
function off(e) {
  let open = e.open.replace(/\sdata-(start|duration|media-start|track-index)="[^"]*"/g, "").replace(/\ssrc="[^"]*"/, "").replace(/^<([\w-]+)/, "<$1 data-pr-off");
  if (e.tag !== "video") return open + e.html.slice(e.open.length);
  open = open.replace(/^<video\b/, "<div").replace(/\s(muted|playsinline|autoplay|loop|preload(="[^"]*")?)(?=[\s>/])/g, "").replace(/\s*\/?>$/, ">");
  return `${open}</div>`;
}

/** The window [a, b) as a page of its own (picture only). */
export function windowPage(html, a, b) {
  const els = timedElements(html);
  let out = "", at = 0;
  for (const e of els) {
    out += html.slice(at, e.start);
    let open = e.open, rest = e.html.slice(e.open.length);
    if (e.tag === "audio") { at = e.end; continue; }                       // the sound is rendered separately
    if (!active(e, a, b)) {
      out += off(e);
      at = e.end;
      continue;
    } else if (Number.isFinite(e.d)) {
      const s2 = Math.max(e.s, a), cut = s2 - e.s;
      open = setAttr(open, "data-start", r6(s2 - a));
      open = setAttr(open, "data-duration", r6(Math.min(e.s + e.d, b) - s2));
      const ms = /\sdata-media-start="([^"]*)"/.exec(open);
      if (ms && cut > 0) open = setAttr(open, "data-media-start", r6(+ms[1] + cut));
    }
    out += open + rest;
    at = e.end;
  }
  out += html.slice(at);
  out = out.replace(/(<div id="root"[^>]*\sdata-duration=")[^"]*"/, `$1${r6(b - a)}"`);
  out = out.replace("</head>", "<style>[data-pr-off]{display:none !important}</style>\n</head>");
  // the page's own timeline, played from a to b: window time t = reel time a + t
  // a delegating timeline, not a GSAP one: it works with whatever runtime the page carries (GSAP before mac-65, the
  // engine's tween runtime after), because it only calls the inner timeline's totalTime / pause
  const shim = `\n<script>(() => { const inner = window.__timelines.main, A = ${a}, D = ${r6(b - a)}; inner.pause();
  let now = 0;
  const w = { totalTime(t, s) { if (t === undefined) return now; now = t; inner.totalTime(A + t, s); return w; },
    time(t, s) { return w.totalTime(t, s); }, seek(t, s) { return w.totalTime(t, s); },
    progress(p, s) { return p === undefined ? (D ? now / D : 0) : w.totalTime(p * D, s); },
    duration() { return D; }, totalDuration() { return D; }, timeScale(v) { return v === undefined ? 1 : w; },
    pause() { return w; }, play() { return w; }, paused() { return true; }, isActive() { return false; },
    getChildren() { return []; }, kill() { return w; }, eventCallback() { return w; } };
  window.__timelines.main = w; })();</script>\n`;
  const i = out.lastIndexOf("</body>");
  return out.slice(0, i) + shim + out.slice(i);
}

/** The whole reel with no picture work: every <video> switched off, 1 frame a second. Its render is the sound. */
export function audioPage(html) {
  let out = "", at = 0;
  for (const e of timedElements(html)) {
    out += html.slice(at, e.start);
    out += e.tag === "video" ? off(e) : e.html;
    at = e.end;
  }
  out += html.slice(at);
  return out.replace(/(<div id="root"[^>]*\sdata-fps=")[^"]*"/, '$11"').replace("</head>", "<style>[data-pr-off]{display:none !important}</style>\n</head>");
}

const assetHashes = new Map();
function assetHash(proj, rel) {
  const f = path.resolve(proj, rel);
  if (!fs.existsSync(f)) return `missing:${rel}`;
  const st = fs.statSync(f), k = `${f}:${st.size}:${st.mtimeMs}`;
  if (!assetHashes.has(k)) assetHashes.set(k, sha(fs.readFileSync(f)).slice(0, 16));
  return assetHashes.get(k);
}
const srcs = (piece) => [...piece.matchAll(/\s(?:src|poster|href)="([^"#:]+)"/g)].map((x) => x[1]).filter((u) => !/^(data|blob|https?):/.test(u));

/** The cache key of window [a, b): everything that can change its pixels, and nothing outside it (see the header). */
export function windowKey(html, a, b, { proj = ".", settings = {} } = {}) {
  const { head, body, script } = splitPage(html);
  const els = timedElements(html);
  const owner = new Map();
  for (const e of els) for (const id of e.ids) owner.set(id, e);
  const on = els.filter((e) => e.tag !== "audio" && active(e, a, b));
  const onIds = new Set(on.flatMap((e) => e.ids));
  let staticBody = body;
  for (const e of [...els].reverse()) staticBody = staticBody.replace(e.html, "");
  staticBody = staticBody.replace(/(<div id="root"[^>]*?)\sdata-duration="[^"]*"/, "$1");
  const lines = script.split("\n").filter((l) => {
    const ids = [...l.matchAll(/#([\w-]+)|getElementById\("([\w-]+)"\)/g)].map((x) => x[1] || x[2]).filter((id) => owner.has(id));
    return !ids.length || ids.some((id) => onIds.has(id));
  });
  const parts = {
    v: 1, settings, len: r6(b - a), head, staticBody, lines,
    els: on.map((e) => ({ rel: r6(e.s - a), d: e.d, html: e.html })),
    assets: [...new Set([...on.flatMap((e) => srcs(e.html)), ...srcs(head), ...srcs(staticBody)])].sort().map((u) => [u, assetHash(proj, u)]),
  };
  return sha(JSON.stringify(parts)).slice(0, 24);
}

export function audioKey(html, { proj = ".", settings = {} } = {}) {
  const els = timedElements(html).filter((e) => e.tag === "audio");
  const dur = (/<div id="root"[^>]*\sdata-duration="([^"]*)"/.exec(html) || [])[1];
  return sha(JSON.stringify({ v: 1, settings, dur, els: els.map((e) => e.html), assets: [...new Set(els.flatMap((e) => srcs(e.html)))].sort().map((u) => [u, assetHash(proj, u)]) })).slice(0, 24);
}

// ----------------------------------------------------------------------------------------------------------------------
function renderPage(proj, pageRel, out, extra = []) {
  return runRenderAsync(["-c", pageRel, "-o", out, "--quiet", ...extra], { cwd: proj }).then((r) => ({ ...r, error: r.error || (r.status ? r.stderr.slice(-1500) : "") }));
}
const ff = (args) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8", maxBuffer: 1 << 26 }); if (r.status) throw new Error(`ffmpeg ${args.join(" ")}: ${r.stderr}`); return r; };
const probe = (f, q) => spawnSync("ffprobe", ["-v", "error", ...q, "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim();

export async function renderPartial(proj, { output = "build/reel.mp4", max = 10, min = 3, jobs = 2, fpsArg = null } = {}) {
  const T0 = Date.now();
  const html = fs.readFileSync(path.join(proj, "index.html"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(proj, "build", "sections.json"), "utf8"));
  const fps = fpsArg || manifest.fps || +((/data-fps="(\d+)"/.exec(html) || [])[1] || 30);
  const settings = { hyperframes: HYPERFRAMES, fps, preload: sha(fs.readFileSync(PRELOAD)).slice(0, 16), vendor: sha(fs.readFileSync(path.join(VENDOR, "manifest.json"))).slice(0, 16), shim: sha(windowPage.toString()).slice(0, 16) };
  const cache = path.join(proj, "build", "render-cache");
  fs.mkdirSync(cache, { recursive: true });
  const wins = planWindows(manifest.sections || [{ start: 0 }], manifest.total, fps, { min, max }).map((w) => ({ ...w, key: windowKey(html, w.a, w.b, { proj, settings }) }));
  const todo = wins.filter((w) => !fs.existsSync(path.join(cache, `${w.key}.mp4`)));
  const times = [];
  const queue = [...todo];
  const worker = async () => {
    for (let w; (w = queue.shift());) {
      const page = `.render-partial-${w.key}.html`, tmp = path.join(cache, `${w.key}.part.mp4`);
      fs.writeFileSync(path.join(proj, page), windowPage(html, w.a, w.b));
      const r = await renderPage(proj, page, tmp, ["-f", String(fps)]);
      fs.rmSync(path.join(proj, page), { force: true });
      const n = r.status === 0 ? +probe(tmp, ["-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets"]) : -1;
      if (r.status !== 0 || n !== w.fb - w.fa) throw new Error(`window ${w.a}-${w.b}: ${r.status !== 0 ? r.error : `${n} frames, want ${w.fb - w.fa}`}`);
      fs.renameSync(tmp, path.join(cache, `${w.key}.mp4`));
      times.push({ a: w.a, b: w.b, seconds: r.seconds });
    }
  };
  // the sound: one render of the picture-less page, keyed on the audio elements alone
  const aKey = audioKey(html, { proj, settings });
  const aFile = path.join(cache, `audio-${aKey}.m4a`);
  let audioSeconds = 0;
  const audioJob = async () => {
    if (fs.existsSync(aFile)) return;
    const page = `.render-partial-audio-${aKey}.html`, tmp = path.join(cache, `audio-${aKey}.part.mp4`);
    fs.writeFileSync(path.join(proj, page), audioPage(html));
    const r = await renderPage(proj, page, tmp, ["-f", "1"]);
    fs.rmSync(path.join(proj, page), { force: true });
    if (r.status !== 0) throw new Error(`audio: ${r.error}`);
    ff(["-i", tmp, "-map", "0:a:0", "-c", "copy", aFile]);
    fs.rmSync(tmp, { force: true });
    audioSeconds = r.seconds;
  };
  await Promise.all([...Array.from({ length: Math.max(1, Math.min(jobs, todo.length || 1)) }, worker), audioJob()]);
  // join: stream copy, then the sound
  const t1 = Date.now();
  const list = path.join(cache, "concat.txt");
  fs.writeFileSync(list, wins.map((w) => `file '${w.key}.mp4'`).join("\n") + "\n");
  const pic = path.join(cache, "joined.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-map", "0:v:0", "-c", "copy", pic]);
  const out = path.resolve(proj, output);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  ff(["-i", pic, "-i", aFile, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", "-shortest", out]);
  fs.rmSync(pic, { force: true }); fs.rmSync(list, { force: true });
  return { windows: wins.length, rendered: todo.length, reused: wins.length - todo.length, audio: audioSeconds ? "rendered" : "reused",
    seconds: { total: (Date.now() - T0) / 1000, windows: times, audio: audioSeconds, join: (Date.now() - t1) / 1000 }, output: out,
    plan: wins.map((w) => ({ a: w.a, b: w.b, key: w.key, cached: !todo.includes(w) })) };
}

/** Compare two mp4s frame by frame (PSNR, Y) and their audio streams (decoded samples). */
export function compare(a, b) {
  const r = spawnSync("ffmpeg", ["-v", "info", "-i", a, "-i", b, "-lavfi", "[0:v][1:v]psnr=stats_file=-", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const per = [...r.stdout.matchAll(/n:(\d+) mse_avg:[\d.]+ mse_y:[\d.]+ .*?psnr_avg:([\d.]+|inf)/g)].map((m) => (m[2] === "inf" ? Infinity : +m[2]));
  const pcm = (f) => spawnSync("ffmpeg", ["-v", "error", "-i", f, "-map", "0:a:0", "-f", "s16le", "-ac", "2", "-ar", "48000", "-"], { maxBuffer: 1 << 30 }).stdout;
  const pa = pcm(a), pb = pcm(b);
  let maxd = 0;
  for (let i = 0; i + 1 < Math.min(pa.length, pb.length); i += 2) maxd = Math.max(maxd, Math.abs(pa.readInt16LE(i) - pb.readInt16LE(i)));
  return { frames: [probe(a, ["-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets"]), probe(b, ["-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets"])].map(Number),
    psnrMin: per.length ? Math.min(...per) : null, psnrMean: per.length ? per.filter(Number.isFinite).reduce((x, y) => x + y, 0) / Math.max(1, per.filter(Number.isFinite).length) : null,
    audioBytes: [pa.length, pb.length], audioSame: pa.equals(pb), audioMaxDiff: maxd };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const oi = argv.indexOf("-o");
  const proj = argv.find((x, i) => !x.startsWith("-") && !["-o", "--max", "--min", "--jobs", "--verify"].includes(argv[i - 1]));
  if (!proj) { console.error("usage: node scripts/render-partial.mjs <project> [-o build/reel.mp4] [--max 10] [--min 3] [--jobs 2] [--verify <full.mp4>]"); process.exit(1); }
  try {
    const r = await renderPartial(proj, { output: oi >= 0 ? argv[oi + 1] : "build/reel.mp4", max: +opt("max", 10), min: +opt("min", 3), jobs: +opt("jobs", 2) });
    if (opt("verify")) r.verify = compare(r.output, path.resolve(proj, opt("verify")));
    process.stdout.write(JSON.stringify(r) + "\n");
  } catch (e) { console.error(`render-partial: ${e.message}`); process.exit(1); }
}

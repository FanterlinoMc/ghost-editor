// Prompt Motion graphic render (PM2): static check, wrapper page, two independent `hyperframes render`s inside a
// network sandbox, the R rules on both logs and outputs, the determinism check, and the atomic write of the cached
// file. Spec: references/reel-json.md "Prompt Motion graphic". Not called by build.mjs yet (PM3).
//
// Network isolation (the production container has no OS-level lockdown: no CAP_NET_ADMIN, no unshare, no egress
// firewall; so the isolation is at the BROWSER level and the same on macOS and Linux):
//   1. A Chrome launcher shim (HYPERFRAMES_BROWSER_PATH) that execs the pinned headless shell with CHROME_FLAGS: every
//      request through a dead proxy (127.0.0.1:9; covers IP literals), every host name but localhost unresolvable,
//      no QUIC, WebRTC limited to proxied UDP (= none), no background networking; loopback is proxied too
//      ("<-loopback>") except HyperFrames' own render server, whose ephemeral port the preload records in
//      GRAPHIC_RENDER_ORIGINS before Chrome starts (chromeShim).
//   2. scripts/offline-preload.cjs in the Node process: every non-loopback fetch / http(s) / socket refused, logged
//      `vendor: blocked <url>` (R1). The page itself has the CSP meta and the navigation trap (wrapper).
//   3. Optional GRAPHIC_SANDBOX: an extra launcher command around the whole render (a JSON array, or words split on
//      spaces; e.g. `sandbox-exec -f <profile>` on a Mac, `unshare -rn` where allowed). Unset: none.
// The probe is the safety net, before EVERY render: the shimmed Chrome (inside the same launcher) must FAIL to load
// http://1.1.1.1/ and http://169.254.169.254/, and the preloaded Node must fail to fetch them; else the render is
// refused (R12) and nothing starts. The Chrome half runs in graphic-probe.mjs (CDP over a pipe, real timers).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  inspectGraphic, graphicFrames, graphicKey, renderedSize, graphicName, outputName, wrapGraphic, reason, sha256,
  REFUSED, RENDERER, LIMITS, fmtT,
} from "./graphic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRELOAD = path.join(HERE, "..", "offline-preload.cjs").split(path.sep).join("/");
export const PROBE_URLS = ["http://1.1.1.1/", "http://169.254.169.254/"];
export const CHROME_FLAGS = [
  "--proxy-server=http://127.0.0.1:9",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost",
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-background-networking",
  "--no-pings",
];
// R12 texts come from REASONS; the Node half of the probe (not in the spec) reuses them
const SANDBOX_REFUSED = (url) => reason("R12", { url });
const SANDBOX_UNPROVEN = (message) => reason("R12n", { message });
// R7 budget: wall seconds of ONE render for L frames. Measured on the Mac mini (M4, 2026-10-19, under the shim), the
// slower of the two renders (--workers 1): 60 frames 4.7 s (1080x1080), 300 frames 15.4 s (1080x1080) / 13.8 s
// (insert 1080x1920), 900 frames 40.0 s. The spec's provisional 20 + 0.25 L (245 s at 900) is tightened to 20 + 0.15 L
// (155 s at 900, 3.9x the Mac; 65 s at 300, 4.2x): headroom for the CPU-only Linux container, which is not measured yet.
export const BUDGET = { base: 20, perFrame: 0.15 };
export const budgetFor = (L) => +(BUDGET.base + BUDGET.perFrame * L).toFixed(2);
// PRODUCER_EXPERIMENTAL_FAST_CAPTURE=false: measured, a single-worker render on macOS switches to drawElement capture
// (multi-worker renders fall back to screenshots), and the two captures differ in pixels: frame 0 differed. Both renders
// are pinned to screenshot capture so the determinism check compares like with like.
export const RENDER_ENV = { DO_NOT_TRACK: "1", HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_NO_AUTO_INSTALL: "1", PRODUCER_EXPERIMENTAL_FAST_CAPTURE: "false" };

const isWin = process.platform === "win32";
const npx = () => (isWin ? ["cmd", ["/c", "npx"]] : ["npx", []]);
const strip = (s) => String(s || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

// ---------- the optional launcher ----------
export function sandboxLauncher(env = process.env) {
  const v = (env.GRAPHIC_SANDBOX || "").trim();
  if (!v || v === "none") return { argv: [], label: "no extra launcher" };
  const argv = v.startsWith("[") ? JSON.parse(v) : v.split(/\s+/);
  return { argv, label: `GRAPHIC_SANDBOX=${argv.join(" ")}` };
}

// ---------- the probe (R12) ----------
const PROBE_CHILD = path.join(HERE, "graphic-probe.mjs");
const NODE_PROBE = `Promise.all(process.argv.slice(1).map((u) => fetch(u, { signal: AbortSignal.timeout(3000) }).then(() => "REACHED " + u, (e) => "FAILED " + u))).then((r) => console.log(r.join("|")));`;
// Chrome (the shim, inside the launcher) and the preloaded Node must both FAIL to load every url.
// -> { ok, lines[], refusal? }. urls: PROBE_URLS (+ a LAN listener URL in the isolation check)
export function probeNetwork({ launcher, shim, urls = PROBE_URLS, spawn = spawnSync }) {
  const lines = [];
  if (!shim) return { ok: false, lines, refusal: SANDBOX_UNPROVEN("no Chrome launcher shim (chrome-headless-shell not found, or Windows)") };
  const r = spawn(process.execPath, [PROBE_CHILD, JSON.stringify({ bin: shim, launcher: launcher.argv, urls })], { encoding: "utf8", timeout: 60000, env: { ...process.env, NODE_OPTIONS: "" } });
  let res = null;
  try { res = JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch {}
  const chrome = res ? res.lines : [];
  const n = spawn(...(() => { const a = [...launcher.argv, process.execPath, "-e", NODE_PROBE, ...urls]; return [a[0], a.slice(1)]; })(),
    { encoding: "utf8", timeout: 30000, env: { ...process.env, NODE_OPTIONS: `--require "${PRELOAD}"` } });
  const node = String(n.stdout || "").trim().split("|").filter(Boolean);
  chrome.forEach((l) => lines.push(`probe chrome: ${l}`));
  node.forEach((l) => lines.push(`probe node: ${l}`));
  const reached = [...chrome, ...node].find((l) => l.startsWith("REACHED"));
  if (reached) return { ok: false, lines, refusal: SANDBOX_REFUSED(reached.split(" ")[1]) };
  if (!res || res.error || chrome.length !== urls.length) return { ok: false, lines, refusal: SANDBOX_UNPROVEN(`Chrome: ${res ? res.error || "answered " + chrome.length + " of " + urls.length : String(r.stderr || "no output").trim().slice(-200)}`) };
  if (node.length !== urls.length) return { ok: false, lines, refusal: SANDBOX_UNPROVEN(`Node: ${String(n.stdout || n.stderr || "no output").trim().slice(-200)}`) };
  return { ok: true, lines };
}

// ---------- hyperframes + Chrome ----------
let hfBin = null;
// the hyperframes CLI entry of the pinned version, resolved once OUTSIDE the sandbox (npx needs the registry; inside the
// sandbox npm waits ~70 s for it), then run as `node <bin>` inside the launcher
export function resolveHyperframes() {
  if (hfBin) return hfBin;
  const [cmd, pre] = npx();
  const r = spawnSync(cmd, [...pre, "-y", "-p", RENDERER, "-c", isWin ? "where hyperframes" : "command -v hyperframes"], { encoding: "utf8", env: { ...process.env, ...RENDER_ENV, NODE_OPTIONS: "" } });
  const bin = String(r.stdout || "").trim().split(/\r?\n/)[0];
  if (r.status !== 0 || !bin) throw new Error(`cannot resolve ${RENDERER}: ${strip(r.stderr).trim().slice(-300)}`);
  let real = fs.realpathSync(bin);
  if (isWin && /\.cmd$/i.test(real)) real = path.join(path.dirname(real), "node_modules", "hyperframes", "dist", "cli.js");
  let dir = path.dirname(real);
  while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  if (`${pkg.name}@${pkg.version}` !== RENDERER) throw new Error(`resolved ${pkg.name}@${pkg.version}, want ${RENDERER}`);
  return (hfBin = real);
}
export function findChrome(env = process.env) {
  const given = env.HYPERFRAMES_BROWSER_PATH || env.PRODUCER_HEADLESS_SHELL_PATH;
  if (given) return given;
  for (const base of [path.join(os.homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell"), path.join(os.homedir(), ".cache", "puppeteer", "chrome-headless-shell")]) {
    if (!fs.existsSync(base)) continue;
    for (const v of fs.readdirSync(base).sort().reverse()) {
      const vd = path.join(base, v);
      if (!fs.statSync(vd).isDirectory()) continue;
      for (const sub of fs.readdirSync(vd)) {
        const exe = path.join(vd, sub, isWin ? "chrome-headless-shell.exe" : "chrome-headless-shell");
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}
// a launcher shim that execs the real headless shell with the network flags (POSIX only; Windows: no shim). Loopback is
// proxied too ("<-loopback>"), except the origins in GRAPHIC_RENDER_ORIGINS: HyperFrames' own render server, recorded by
// the preload when it starts listening (before Chrome is launched). Unset: no loopback at all (the render fails, R10).
export function chromeShim(dir, chrome) {
  if (isWin || !chrome) return null;
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, "chrome-headless-shell");
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(shim, `#!/bin/sh
BYPASS='<-loopback>'
if [ -n "$GRAPHIC_RENDER_ORIGINS" ]; then BYPASS="$BYPASS;$GRAPHIC_RENDER_ORIGINS"; fi
exec ${q(chrome)} ${CHROME_FLAGS.map(q).join(" ")} "--proxy-bypass-list=$BYPASS" "$@"
`, { mode: 0o755 });
  return shim;
}

// ---------- versions for the key (v2) ----------
export const chromeVersion = (bin) => { const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30000 }); const v = String(r.stdout || "").trim().split(/\s+/).pop(); return /^\d+(\.\d+)+$/.test(v || "") ? v : null; };
export const ffmpegBin = (env = process.env) => env.HYPERFRAMES_FFMPEG_PATH || env.FFMPEG_PATH || "ffmpeg";
export const ffmpegVersion = (bin = ffmpegBin()) => { const r = spawnSync(bin, ["-version"], { encoding: "utf8" }); const m = /ffmpeg version (\S+)/.exec(String(r.stdout || "")); return m ? m[1] : null; };
export const launchedChrome = (log) => { const m = /Browser launched \(HeadlessChrome\/([^,\s)]+)/.exec(strip(log)); return m ? m[1] : null; };

// ---------- the log rules (R1-R5, R10, R11) ----------
// -> [{ code, text }] in log order
export function scanLog(log) {
  const out = [];
  const seen = new Set();
  const add = (code, text) => { if (!seen.has(text)) { seen.add(text); out.push({ code, text }); } };
  for (const raw of strip(log).split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if (line.includes("violates the following Content Security Policy directive")) {
      m = /'((?:https?|wss?|ftp|blob|file):[^']*)'/.exec(line) || /'([^']+)'/.exec(line);
      add("R1", reason("R1", { url: m ? m[1] : "(unknown url)" }));
    } else if ((m = /vendor: blocked (\S+)/.exec(line))) add("R1", reason("R1", { url: m[1] }));
    else if ((m = /net::ERR_(PROXY_CONNECTION_FAILED|NAME_NOT_RESOLVED|BLOCKED_BY_CLIENT|ACCESS_DENIED)\b.*?((?:https?|wss?):\/\/\S+)?$/.exec(line)) && /\[Browser:/.test(line)) add("R1", reason("R1", { url: m[2] || `(net::ERR_${m[1]})` }));
    else if ((m = /\[Browser:PAGEERROR\]\s*(.*)$/.exec(line))) add("R2", reason("R2", { message: m[1] }));
    else if ((m = new RegExp(REFUSED + "(.*)$").exec(line))) {
      const r = m[1].trim();
      let x;
      if (r.startsWith("window.seek is not a function")) add("R3", reason("R3"));
      else if ((x = /^seek\(([^)]*)\) threw: (.*)$/.exec(r))) add("R4", reason("R4", { t: x[1], message: x[2] }));
      else if ((x = /^seek\(([^)]*)\) returned a Promise/.exec(r))) add("R4", reason("R4p", { t: x[1] }));
      else if ((x = /^window\.duration \/ window\.size changed at load \(static (.*), at load (.*)\)$/.exec(r))) add("R5", reason("R5", { a: x[1], b: x[2] }));
      else if (r.startsWith("navigated")) add("R11", reason("R11"));
      else add("R2", reason("R2", { message: r }));
    }
  }
  return out;
}
const lastLine = (log) => strip(log).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "(no output)";

// ---------- frames: framemd5, alpha ----------
export function frameMd5(file, mode) {
  const args = mode === "insert" ? ["-v", "error", "-i", file, "-pix_fmt", "yuv420p", "-f", "framemd5", "-"] : ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-pix_fmt", "yuva420p", "-f", "framemd5", "-"];
  const r = spawnSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg framemd5 ${file}: ${String(r.stderr).trim().slice(-300)}`);
  return r.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());
}
// R6: -> null when equal, else the reason
export function compareFrames(a, b, fps) {
  if (a.length !== b.length) return reason("R6n", { a: a.length, b: b.length });
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return reason("R6", { i, t: fmtT(i / fps) });
  return null;
}
// R9: the largest alpha value over all frames (0 = every frame fully transparent)
export function maxAlpha(file) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", "format=yuva420p,alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg alpha ${file}: ${String(r.stderr).trim().slice(-300)}`);
  return Math.max(0, ...[...r.stdout.matchAll(/YMAX=(\d+)/g)].map((m) => Number(m[1])));
}

// ---------- one hyperframes render inside the launcher ----------
export function runRender({ dir, out, mode, fps, workers, launcher, shim, logFile }) {
  const argv = [...launcher.argv, process.execPath, resolveHyperframes(), "render", "--format", mode === "insert" ? "mp4" : "webm", "-f", String(fps), "-q", "looks", ...(workers ? ["--workers", String(workers)] : []), "-o", out, dir];
  const env = { ...process.env, ...RENDER_ENV, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${PRELOAD}"`.trim() };
  if (shim) { env.HYPERFRAMES_BROWSER_PATH = shim; delete env.PRODUCER_HEADLESS_SHELL_PATH; }
  const t0 = process.hrtime.bigint();
  const r = spawnSync(argv[0], argv.slice(1), { cwd: dir, env, encoding: "utf8", maxBuffer: 1 << 28 });
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const log = `${r.stdout || ""}\n${r.stderr || ""}${r.error ? `\n${r.error.message}` : ""}`;
  if (logFile) fs.writeFileSync(logFile, strip(log));
  return { status: r.status ?? -1, secs: +secs.toFixed(2), log };
}

// ---------- renderGraphic ----------
// opts: { content (the file's bytes; or read from projectDir + html), html (the reel.json field), projectDir, mode, W, H, fps, inS, after, frames, outDir, buildDir, id,
//         budget (seconds, override), log(fn) }
// -> { ok, reasons[], codes[], file?, cached?, key, L, renders: [{secs, status}], probe }
export function renderGraphic(opts) {
  const { html: htmlPath = "assets/graphics/graphic.html", projectDir = null, mode = "overlay", W = 1080, H = 1920, fps = 30, inS = 0, after = "hold", frames, log = () => {} } = opts;
  let html = opts.content ?? null;
  if (html == null && projectDir) { const abs = path.join(projectDir, htmlPath); if (fs.existsSync(abs)) html = fs.readFileSync(abs); }
  const insp = inspectGraphic(html, { html: htmlPath, projectDir, W, H, mode, mediaRoot: opts.mediaRoot });
  if (!insp.ok) return { ok: false, reasons: insp.reasons, codes: insp.codes, stage: "static" };
  const meta = insp.meta;
  const fr = graphicFrames({ duration: meta.duration, fps, inS, after, frames });
  fr.warnings.forEach((w) => log(`warning: ${w}`));
  const { w, h } = renderedSize(meta, mode, W, H);
  const media = meta.media.map((m) => [m.path, sha256(fs.readFileSync(m.abs))]);
  const name = graphicName(htmlPath);
  const outDir = opts.outDir || (projectDir ? path.join(projectDir, "assets", "graphics") : path.join(os.tmpdir(), "graphics"));
  const buildDir = opts.buildDir || (projectDir ? path.join(projectDir, "build") : path.join(os.tmpdir(), "graphic-build"));
  const scratch = path.join(buildDir, "graphics", ".sandbox");
  const chromeBin = findChrome();
  const shim = chromeShim(path.join(scratch, "chrome"), chromeBin);
  const chrome = shim ? chromeVersion(shim) : null; // the version as the launcher runs it (the shim forwards --version)
  const ffmpeg = ffmpegVersion();
  if (!chrome || !ffmpeg) return { ok: false, reasons: [reason("R12n", { message: !chrome ? (shim ? "the Chrome shim gave no --version" : "no chrome-headless-shell, or no POSIX shim (Windows)") : "ffmpeg -version gave no version" })], codes: ["R12"], stage: "setup" };
  const { key } = graphicKey({ html, media, fonts: meta.fonts, chrome, ffmpeg, fps, w, h, mode, frames: fr.L, inF: fr.inF, after: fr.after });
  const id = name; // spec v2: the render folder is build/graphics/<name>-<key16>/
  const ext = mode === "insert" ? "mp4" : "webm";
  const final = path.join(outDir, outputName(name, key, mode));
  const base = { key, L: fr.L, file: final, warnings: fr.warnings };
  if (fs.existsSync(final)) return { ok: true, cached: true, reasons: [], codes: [], ...base };

  // the safety net first (R12): no render unless the probe, through the same shim and launcher, fails to reach out
  const launcher = sandboxLauncher(process.env);
  const probe = probeNetwork({ launcher, shim, urls: opts.probeUrls || PROBE_URLS });
  probe.lines.forEach((l) => log(l));
  if (!probe.ok) return { ok: false, reasons: [probe.refusal], codes: ["R12"], stage: "probe", probe, ...base };

  const wrap = wrapGraphic({ buildDir, id, key, html, meta, mode, fps, L: fr.L, inF: fr.inF, D: fr.D, after: fr.after, W, H });
  const outs = [path.join(wrap.dir, "..", `${id}-${key.slice(0, 16)}.a.${ext}`), path.join(wrap.dir, "..", `${id}-${key.slice(0, 16)}.b.${ext}`)];
  const clean = () => outs.forEach((o) => fs.rmSync(o, { force: true }));
  clean();
  const budget = opts.budget ?? budgetFor(fr.L);
  const found = [];
  const renders = [];
  for (let n = 0; n < 2 && found.length === 0; n++) {
    log(`render ${n + 1}/2${n ? " (--workers 1)" : ""} ...`);
    const r = runRender({ dir: wrap.dir, out: outs[n], mode, fps, workers: n ? 1 : null, launcher, shim, logFile: path.join(wrap.dir, `render-${n ? "b" : "a"}.log`) });
    renders.push({ secs: r.secs, status: r.status });
    log(`render ${n + 1}/2: exit ${r.status}, ${r.secs}s`);
    found.push(...scanLog(r.log));
    const used = launchedChrome(r.log);
    if (used && used !== chrome) found.push({ code: "R13", text: reason("R13", { v: used, k: chrome }) });
    if (r.status !== 0 || !fs.existsSync(outs[n])) found.push({ code: "R10", text: reason("R10", { code: r.status, line: lastLine(r.log) }) });
    if (r.secs > budget) found.push({ code: "R7", text: reason("R7", { s: r.secs, L: fr.L, b: budget }) });
    if (fs.existsSync(outs[n]) && fs.statSync(outs[n]).size > LIMITS.fileBytes) found.push({ code: "R8", text: reason("R8", { bytes: fs.statSync(outs[n]).size }) });
  }
  if (found.length === 0) {
    const a = frameMd5(outs[0], mode), b = frameMd5(outs[1], mode);
    const d = compareFrames(a, b, fps);
    if (d) found.push({ code: "R6", text: d, frames: [a.length, b.length] });
    else if (a.length !== fr.L) found.push({ code: "R6", text: reason("R6n", { a: a.length, b: fr.L }) });
    if (!d && mode !== "insert" && maxAlpha(outs[0]) === 0) found.push({ code: "R9", text: reason("R9") });
  }
  if (found.length) { clean(); return { ok: false, reasons: found.map((f) => f.text), codes: found.map((f) => f.code), stage: "render", renders, probe, wrapper: wrap.file, ...base }; }
  fs.mkdirSync(outDir, { recursive: true });
  const part = final.replace(new RegExp(`\\.${ext}$`), `.part.${ext}`);
  fs.rmSync(part, { force: true });
  fs.copyFileSync(outs[0], part);
  fs.renameSync(part, final);
  clean();
  return { ok: true, cached: false, reasons: [], codes: [], renders, probe, wrapper: wrap.file, ...base };
}

// Prompt Motion graphic render (PM2): static check, wrapper page, two independent `hyperframes render`s inside a
// network sandbox, the R rules on both logs and outputs, the determinism check, and the atomic write of the cached
// file. Spec: references/reel-json.md "Prompt Motion graphic". Not called by build.mjs yet (PM3).
//
// Network isolation (the production container has no OS-level lockdown: no CAP_NET_ADMIN, no unshare, no egress
// firewall; so the isolation is at the BROWSER level and the same on macOS and Linux):
//   1. A Chrome launcher shim (HYPERFRAMES_BROWSER_PATH) that execs the pinned headless shell (GRAPHIC_CHROME_PATH, a
//      dedicated path for the graphic renderer's pinned headless shell, if set; see findChrome) with CHROME_FLAGS: every
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
import { spawnSync, spawn } from "node:child_process";
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
// PRODUCER_ENABLE_STREAMING_ENCODE=false: measured by PM5, a --workers 1 render switches to the streaming encoder and
// the decoded frames differ (134 of 135) from the batch encode of the same pixels; both renders use the batch encoder.
export const RENDER_ENV = { DO_NOT_TRACK: "1", HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_NO_AUTO_INSTALL: "1", PRODUCER_EXPERIMENTAL_FAST_CAPTURE: "false", PRODUCER_ENABLE_STREAMING_ENCODE: "false" };

const isWin = process.platform === "win32";
const npx = () => (isWin ? ["cmd", ["/c", "npx"]] : ["npx", []]);
const strip = (s) => String(s || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

// ---------- the optional launcher ----------
// -> { argv, label } or { error } (a malformed GRAPHIC_SANDBOX refuses with R12n, never throws)
export function sandboxLauncher(env = process.env) {
  const v = (env.GRAPHIC_SANDBOX || "").trim();
  if (!v || v === "none") return { argv: [], label: "no extra launcher" };
  let argv = null;
  try { argv = v.startsWith("[") ? JSON.parse(v) : v.split(/\s+/); } catch {}
  if (!Array.isArray(argv) || !argv.length || !argv.every((x) => typeof x === "string" && x)) return { error: `GRAPHIC_SANDBOX is not a command (a JSON array of strings, or words): ${v.slice(0, 80)}` };
  return { argv, label: `GRAPHIC_SANDBOX=${argv.join(" ")}` };
}
// the environment of every process of a graphic render (probe, Node half, hyperframes): never an inherited
// GRAPHIC_RENDER_ORIGINS (only the preload inside THIS render's hyperframes may set it)
export const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.GRAPHIC_RENDER_ORIGINS; delete e.GRAPHIC_SHIM_MARK; delete e.GRAPHIC_CHROME_PATH; return e; };

// ---------- the probe (R12) ----------
const PROBE_CHILD = path.join(HERE, "graphic-probe.mjs");
// the Node half: only a TypeError (refused) counts as blocked; a timeout means the probe could not decide
const NODE_PROBE = `Promise.all(process.argv.slice(1).map((u) => fetch(u, { signal: AbortSignal.timeout(3000) }).then(() => "REACHED " + u, (e) => (e && e.name === "TypeError" ? "FAILED " : "UNKNOWN ") + u + " " + (e && e.name)))).then((r) => console.log(r.join("|")));`;
// Chrome (the shim, inside the launcher) and the preloaded Node must both REFUSE every url (TypeError), and Chrome must
// not reach a listener the probe opens on a second localhost port. -> { ok, lines[], refusal? }
export function probeNetwork({ launcher, shim, urls = PROBE_URLS, spawn: run = spawnSync }) {
  const lines = [];
  if (launcher.error) return { ok: false, lines, refusal: SANDBOX_UNPROVEN(launcher.error) };
  if (!shim) return { ok: false, lines, refusal: SANDBOX_UNPROVEN("no Chrome launcher shim (chrome-headless-shell not found, or Windows)") };
  const r = run(process.execPath, [PROBE_CHILD, JSON.stringify({ bin: shim, launcher: launcher.argv, urls, loopback: true })], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", env: cleanEnv({ NODE_OPTIONS: "" }) });
  let res = null;
  try { res = JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch {}
  const chrome = res && Array.isArray(res.lines) ? res.lines : [];
  const na = [...launcher.argv, process.execPath, "-e", NODE_PROBE, ...urls];
  const n = run(na[0], na.slice(1), { encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", env: cleanEnv({ NODE_OPTIONS: `--require "${PRELOAD}"` }) });
  const node = String(n.stdout || "").trim().split("|").filter(Boolean);
  chrome.forEach((l) => lines.push(`probe chrome: ${l}`));
  node.forEach((l) => lines.push(`probe node: ${l}`));
  if (res && res.loopbackHits !== undefined) lines.push(`probe loopback listener: ${res.loopbackHits} connection(s)`);
  const reached = [...chrome, ...node].find((l) => l.startsWith("REACHED"));
  if (reached) return { ok: false, lines, refusal: SANDBOX_REFUSED(reached.split(" ")[1]) };
  if (res && res.loopbackHits > 0) return { ok: false, lines, refusal: SANDBOX_REFUSED(res.loopbackUrl) };
  if (!res || res.error || chrome.length !== urls.length + 1 || !chrome.every((l) => l.startsWith("FAILED") && / TypeError$/.test(l)) || res.loopbackHits !== 0)
    return { ok: false, lines, refusal: SANDBOX_UNPROVEN(`Chrome: ${res ? res.error || `answered '${chrome.join("|")}'` : String(r.stderr || "no output").trim().slice(-200)}`) };
  if (node.length !== urls.length || !node.every((l) => l.startsWith("FAILED"))) return { ok: false, lines, refusal: SANDBOX_UNPROVEN(`Node: answered '${String(n.stdout || n.stderr || "nothing").trim().slice(-200)}'`) };
  return { ok: true, lines };
}

// ---------- hyperframes + Chrome ----------
let hfBin = null;
// the hyperframes CLI entry of the pinned version, resolved once OUTSIDE the sandbox (npx needs the registry; inside the
// sandbox npm waits ~70 s for it), then run as `node <bin>` inside the launcher
export function resolveHyperframes() {
  if (hfBin) return hfBin;
  const [cmd, pre] = npx();
  const r = spawnSync(cmd, [...pre, "-y", "-p", RENDERER, "-c", isWin ? "where hyperframes" : "command -v hyperframes"], { encoding: "utf8", timeout: 300000, env: cleanEnv({ ...RENDER_ENV, NODE_OPTIONS: "" }) });
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
// hyperframes 0.8.81 pins chrome-headless-shell 152.0.7977.30 (CHROME_VERSION in its cli.js; 150.0.7871.124 on macOS 12)
// and never uses a cached build above its major ceiling; the same choice here: the pinned build if cached, else the
// highest cached build whose major is not above the pin's.
// Order: GRAPHIC_CHROME_PATH (a dedicated path for the graphic renderer's pinned headless shell, so graphics can use the
// pinned build while normal reels keep whatever HYPERFRAMES_BROWSER_PATH names; only this renderer reads it), then
// HYPERFRAMES_BROWSER_PATH, PRODUCER_HEADLESS_SHELL_PATH, then the cache search. A GRAPHIC_CHROME_PATH that is set but
// is not an executable file THROWS (no fallback to another browser): renderGraphic turns that into an R12n refusal.
export const PINNED_CHROME = "152.0.7977.30";
const verOf = (dir) => { const m = /(\d+(?:\.\d+){1,3})$/.exec(dir); return m ? m[1].split(".").map(Number) : null; };
const cmpVer = (a, b) => { for (let i = 0; i < 4; i++) { const d = (b[i] || 0) - (a[i] || 0); if (d) return d; } return 0; };
export function findChrome(env = process.env, home = os.homedir()) {
  const pinned = env.GRAPHIC_CHROME_PATH;
  if (pinned) {
    let ok = false;
    try { ok = fs.statSync(pinned).isFile(); fs.accessSync(pinned, fs.constants.X_OK); } catch { ok = false; }
    if (!ok) throw new Error(`GRAPHIC_CHROME_PATH=${pinned} is not an executable file`);
    return pinned;
  }
  const given = env.HYPERFRAMES_BROWSER_PATH || env.PRODUCER_HEADLESS_SHELL_PATH;
  if (given) return given;
  const ceiling = Number(PINNED_CHROME.split(".")[0]);
  for (const base of [path.join(home, ".cache", "hyperframes", "chrome", "chrome-headless-shell"), path.join(home, ".cache", "puppeteer", "chrome-headless-shell")]) {
    if (!fs.existsSync(base)) continue;
    const dirs = fs.readdirSync(base).map((d) => ({ d, v: verOf(d) })).filter((x) => x.v && x.v[0] <= ceiling).sort((a, b) => cmpVer(a.v, b.v));
    dirs.sort((a, b) => (b.v.join(".") === PINNED_CHROME) - (a.v.join(".") === PINNED_CHROME));
    for (const { d } of dirs) {
      const vd = path.join(base, d);
      if (!fs.statSync(vd).isDirectory()) continue;
      for (const sub of fs.readdirSync(vd)) {
        const exe = path.join(vd, sub, isWin ? "chrome-headless-shell.exe" : "chrome-headless-shell");
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}
// The launcher shim (POSIX only; Windows: none, so every graphic render is refused there, R12n). It execs the real
// headless shell with the caller's arguments FIRST and the lock flags LAST: Chrome keeps the last copy of a repeated
// switch, so nothing hyperframes or puppeteer passes can override them. Loopback is proxied too ("<-loopback>") except
// the origins in GRAPHIC_RENDER_ORIGINS that are exactly localhost:<port> or 127.0.0.1:<port> (the render server,
// recorded by the preload inside hyperframes); anything else there ("*", a host, a wildcard) is dropped. With
// GRAPHIC_SHIM_MARK set, the shim appends its PID (= Chrome's, after exec) to that file: proof the render's Chrome came
// through the shim, and the PIDs to kill when a render is stopped. Written atomically (temp + rename).
export function chromeShim(dir, chrome) {
  if (isWin || !chrome) return null;
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, "chrome-headless-shell");
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const tmp = `${shim}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `#!/bin/sh
BYPASS='<-loopback>'
OLDIFS=$IFS; IFS=';'
set -f
for o in $GRAPHIC_RENDER_ORIGINS; do
  case "$o" in
    localhost:*|127.0.0.1:*)
      p=\${o#*:}
      case "$p" in ''|*[!0-9]*) ;; *) if [ \${#p} -le 5 ]; then BYPASS="$BYPASS;$o"; fi ;; esac ;;
  esac
done
IFS=$OLDIFS
set +f
if [ -n "$GRAPHIC_SHIM_MARK" ]; then echo $$ >> "$GRAPHIC_SHIM_MARK"; fi
exec ${q(chrome)} "$@" ${CHROME_FLAGS.map(q).join(" ")} "--proxy-bypass-list=$BYPASS"
`, { mode: 0o755 });
  fs.renameSync(tmp, shim);
  return shim;
}

// ---------- versions for the key (v2) ----------
export const chromeVersion = (bin) => { const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", env: cleanEnv() }); const v = String(r.stdout || "").trim().split(/\s+/).pop(); return /^\d+(\.\d+)+$/.test(v || "") ? v : null; };
export const ffmpegBin = (env = process.env) => env.HYPERFRAMES_FFMPEG_PATH || env.FFMPEG_PATH || "ffmpeg";
export const ffmpegVersion = (bin = ffmpegBin()) => { const r = spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 30000 }); const m = /ffmpeg version (\S+)/.exec(String(r.stdout || "")); return m ? m[1] : null; };
export const launchedChrome = (log) => { const m = /Browser launched \(HeadlessChrome\/([^,\s)]+)/.exec(strip(log)); return m ? m[1] : null; };

// ---------- the log rules (R1-R5, R10, R11) ----------
// -> [{ code, text }] in log order
// HyperFrames' OWN blob worker (its drawElement capture calibration, seen in multi-worker MP4 renders without the
// fast-capture pin) trips the page CSP. Exactly this line is not a graphic's network attempt (a blob: worker on the
// render server's own origin, blocked by the CSP anyway), so it is skipped, and ONLY when the port is one the preload
// recorded for this render's server: any other CSP line, or this text on another origin, still refuses (R1).
export const HF_BLOB_WORKER = /^\[Browser:ERROR\] Creating a worker from 'blob:http:\/\/localhost:(\d{1,5})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' violates the following Content Security Policy directive: "script-src 'unsafe-inline'"\. Note that 'worker-src' was not explicitly set, so 'script-src' is used as a fallback\. The action has been blocked\.$/;
export function scanLog(log) {
  const out = [];
  const seen = new Set();
  const add = (code, text) => { if (!seen.has(text)) { seen.add(text); out.push({ code, text }); } };
  const lines = strip(log).split(/\r?\n/).map((l) => l.trim());
  const serverPorts = new Set(lines.map((l) => /^graphic-offline: render server localhost:(\d+)$/.exec(l)).filter(Boolean).map((m) => m[1]));
  for (const line of lines) {
    let m;
    if ((m = HF_BLOB_WORKER.exec(line)) && serverPorts.has(m[1])) continue;
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
      else if ((x = /^seek order: frame (\d+) \(t=([^)]*)s\)/.exec(r))) add("R6", reason("R6o", { k: x[1], t: x[2] }));
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
  const r = spawnSync(ffmpegBin(), args, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 600000, killSignal: "SIGKILL" });
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
  const r = spawnSync(ffmpegBin(), ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", "format=yuva420p,alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 600000, killSignal: "SIGKILL" });
  if (r.status !== 0) throw new Error(`ffmpeg alpha ${file}: ${String(r.stderr).trim().slice(-300)}`);
  return Math.max(0, ...[...r.stdout.matchAll(/YMAX=(\d+)/g)].map((m) => Number(m[1])));
}

// ---------- killing a hung render, safely ----------
// A PID from the shim's marker file is signalled only if it is > 1, still alive, and still Chrome (Linux: the
// basename of /proc/<pid>/exe; elsewhere: `ps -o comm= -p <pid>`), so a PID that was reused by another process, or a
// forged "1", is never touched. Its process group is killed only when that verified Chrome leads it (pgid == pid).
const CHROME_EXE = /^(chrome-headless-shell|chrome|chromium|chromium-browser|headless_shell|Google Chrome for Testing)$/;
export function procInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); } catch { return null; }
  if (process.platform === "linux") {
    try {
      const exe = path.basename(fs.readlinkSync(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, "");
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      return { exe, pgid };
    } catch { return null; }
  }
  const r = spawnSync("ps", ["-o", "pgid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(String(r.stdout || ""));
  return m ? { exe: path.basename(m[2]), pgid: Number(m[1]) } : null;
}
export const isChrome = (pid, info = procInfo) => { const i = info(pid); return !!(i && CHROME_EXE.test(i.exe)); };
// -> the signals sent, as ["pid" | "-pgid"] (for tests). kill and info are injectable.
export function killChromes(pids, { kill = process.kill, info = procInfo } = {}) {
  const sent = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    const i = info(pid);
    if (!i || !CHROME_EXE.test(i.exe)) continue;
    if (i.pgid === pid) { try { kill(-pid, "SIGKILL"); sent.push(`-${pid}`); } catch {} }
    try { kill(pid, "SIGKILL"); sent.push(String(pid)); } catch {}
  }
  return sent;
}

// ---------- one hyperframes render inside the launcher (async) ----------
// Its own process group (detached). Nothing is killed after a normal exit (HyperFrames has closed Chrome itself, and its
// PIDs may already belong to other processes). On a TIMEOUT: the render's own group (its leader is our live child),
// then the shim-marked PIDs that are still verified Chrome (puppeteer detaches Chrome into its own group). With a
// GRAPHIC_SANDBOX launcher the marked PIDs are skipped: a launcher may run the render in its own PID namespace, where
// those numbers name other processes out here (GRAPHIC_SANDBOX must not create a PID namespace if you want them killed).
// -> Promise<{ status, secs, log, timedOut, shimPids, killed }>
export function runRender({ dir, out, mode, fps, workers, launcher, shim, logFile, markFile, timeoutMs = 600000, bin, kill = process.kill, info = procInfo }) {
  const argv = [...launcher.argv, process.execPath, bin || resolveHyperframes(), "render", "--format", mode === "insert" ? "mp4" : "webm", "-f", String(fps), "-q", "looks", ...(workers ? ["--workers", String(workers)] : []), "-o", out, dir];
  const env = cleanEnv({ ...RENDER_ENV, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${PRELOAD}"`.trim() });
  if (shim) { env.HYPERFRAMES_BROWSER_PATH = shim; delete env.PRODUCER_HEADLESS_SHELL_PATH; }
  if (markFile) { fs.writeFileSync(markFile, ""); env.GRAPHIC_SHIM_MARK = markFile; }
  const t0 = process.hrtime.bigint();
  return new Promise((resolve) => {
    let log = "", timedOut = false, finished = false;
    const killed = [];
    const cp = spawn(argv[0], argv.slice(1), { cwd: dir, env, detached: !isWin, stdio: ["ignore", "pipe", "pipe"] });
    const shimPids = () => { try { return fs.readFileSync(markFile, "utf8").split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number); } catch { return []; } };
    const onTimeout = () => {
      timedOut = true;
      if (!finished) { try { if (!isWin && cp.pid > 1) { kill(-cp.pid, "SIGKILL"); killed.push(`-${cp.pid}`); } else cp.kill("SIGKILL"); } catch {} }
      if (!launcher.argv.length) killed.push(...killChromes(shimPids(), { kill, info }));
    };
    const timer = setTimeout(onTimeout, timeoutMs);
    cp.stdout.on("data", (d) => (log += d));
    cp.stderr.on("data", (d) => (log += d));
    const done = (status, extra = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const pids = shimPids();
      const secs = Number(process.hrtime.bigint() - t0) / 1e9;
      log += extra + (timedOut ? `\nkilled after ${Math.round(timeoutMs / 1000)} s (render timeout)` : "");
      if (logFile) fs.writeFileSync(logFile, strip(log));
      resolve({ status: timedOut ? -1 : status ?? -1, secs: +secs.toFixed(2), log, timedOut, shimPids: pids, killed });
    };
    cp.on("error", (e) => done(-1, `\n${e.message}`));
    cp.on("close", (code) => done(code));
  });
}

// ---------- renderGraphic ----------
// opts: { content (the file's bytes; or read from projectDir + html), html (the reel.json field), projectDir, mode, W, H,
//         fps, inS, after, frames, outDir, buildDir, budget (seconds, override), probeUrls, log(fn) }
// deps (tests inject these; defaults are the real ones): { findChrome, chromeShim, chromeVersion, ffmpegVersion,
//         probeNetwork, runRender, frameMd5, maxAlpha }
// -> Promise<{ ok, reasons[], codes[], file?, cached?, key, L, renders: [{secs, status}], probe }>
export async function renderGraphic(opts, deps = {}) {
  const D = { findChrome, chromeShim, chromeVersion, ffmpegVersion, probeNetwork, runRender, frameMd5, maxAlpha, ...deps };
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
  fs.mkdirSync(path.join(buildDir, "graphics"), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(buildDir, "graphics", ".sandbox-")); // per call: concurrent renders never share a shim
  try {
    let exe; // a set-but-broken GRAPHIC_CHROME_PATH throws: refuse here, never wrap another browser
    try { exe = D.findChrome(); } catch (e) { return { ok: false, reasons: [reason("R12n", { message: e.message })], codes: ["R12"], stage: "setup" }; }
    const shim = D.chromeShim(path.join(scratch, "chrome"), exe);
    const chrome = shim ? D.chromeVersion(shim) : null; // the version as the launcher runs it (the shim forwards --version)
    const ffmpeg = D.ffmpegVersion();
    if (!chrome || !ffmpeg) return { ok: false, reasons: [reason("R12n", { message: !chrome ? (shim ? "the Chrome shim gave no --version" : "no chrome-headless-shell, or no POSIX shim (Windows)") : "ffmpeg -version gave no version" })], codes: ["R12"], stage: "setup" };
    const { key } = graphicKey({ html, media, fonts: meta.fonts, chrome, ffmpeg, fps, w, h, mode, frames: fr.L, inF: fr.inF, after: fr.after });
    const id = name; // the render folder is build/graphics/<name>-<key16>/
    const ext = mode === "insert" ? "mp4" : "webm";
    const final = path.join(outDir, outputName(name, key, mode));
    const base = { key, L: fr.L, file: final, warnings: fr.warnings };
    if (fs.existsSync(final)) return { ok: true, cached: true, reasons: [], codes: [], ...base };

    // the safety net first (R12): no render unless the probe, through the same shim and launcher, is refused everywhere
    const launcher = sandboxLauncher(process.env);
    const probe = D.probeNetwork({ launcher, shim, urls: opts.probeUrls || PROBE_URLS });
    probe.lines.forEach((l) => log(l));
    if (!probe.ok) return { ok: false, reasons: [probe.refusal], codes: ["R12"], stage: "probe", probe, ...base, file: null };

    const wrap = wrapGraphic({ buildDir, id, key, html, meta, mode, fps, L: fr.L, inF: fr.inF, D: fr.D, after: fr.after, W, H });
    const outs = [path.join(wrap.dir, "..", `${id}-${key.slice(0, 16)}.a.${ext}`), path.join(wrap.dir, "..", `${id}-${key.slice(0, 16)}.b.${ext}`)];
    const clean = () => outs.forEach((o) => fs.rmSync(o, { force: true }));
    clean();
    const budget = opts.budget ?? budgetFor(fr.L);
    const found = [];
    const renders = [];
    for (let n = 0; n < 2 && found.length === 0; n++) {
      log(`render ${n + 1}/2${n ? " (--workers 1)" : ""} ...`);
      const markFile = path.join(scratch, `shim-${n}.pids`);
      const r = await D.runRender({ dir: wrap.dir, out: outs[n], mode, fps, workers: n ? 1 : null, launcher, shim, markFile, timeoutMs: Math.round((budget + 60) * 1000), logFile: path.join(wrap.dir, `render-${n ? "b" : "a"}.log`) });
      renders.push({ secs: r.secs, status: r.status });
      log(`render ${n + 1}/2: exit ${r.status}, ${r.secs}s`);
      found.push(...scanLog(r.log));
      const used = launchedChrome(r.log);
      let marked = "";
      try { marked = fs.readFileSync(markFile, "utf8").trim(); } catch {}
      if (!used || !marked) found.push({ code: "R13", text: reason("R13", { v: !used ? "(no 'Browser launched' line)" : `${used} (not launched through the shim)`, k: chrome }) });
      else if (used !== chrome) found.push({ code: "R13", text: reason("R13", { v: used, k: chrome }) });
      if (r.status !== 0 || !fs.existsSync(outs[n])) found.push({ code: "R10", text: reason("R10", { code: r.status, line: lastLine(r.log) }) });
      if (r.secs > budget) found.push({ code: "R7", text: reason("R7", { s: r.secs, L: fr.L, b: budget }) });
      if (fs.existsSync(outs[n]) && fs.statSync(outs[n]).size > LIMITS.fileBytes) found.push({ code: "R8", text: reason("R8", { bytes: fs.statSync(outs[n]).size }) });
    }
    if (found.length === 0) {
      const a = D.frameMd5(outs[0], mode), b = D.frameMd5(outs[1], mode);
      const d = compareFrames(a, b, fps);
      if (d) found.push({ code: "R6", text: d });
      else if (a.length !== fr.L) found.push({ code: "R6", text: reason("R6L", { a: a.length, L: fr.L }) });
      if (!d && mode !== "insert" && D.maxAlpha(outs[0]) === 0) found.push({ code: "R9", text: reason("R9") });
    }
    if (found.length) { clean(); return { ok: false, reasons: found.map((f) => f.text), codes: found.map((f) => f.code), stage: "render", renders, probe, wrapper: wrap.file, ...base, file: null }; }
    fs.mkdirSync(outDir, { recursive: true });
    const part = final.replace(new RegExp(`\\.${ext}$`), `.part.${ext}`);
    fs.rmSync(part, { force: true });
    fs.copyFileSync(outs[0], part);
    fs.renameSync(part, final);
    clean();
    return { ok: true, cached: false, reasons: [], codes: [], renders, probe, wrapper: wrap.file, ...base };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

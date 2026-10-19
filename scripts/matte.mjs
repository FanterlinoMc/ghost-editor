#!/usr/bin/env node
// The person cut-out (matte) cut in parallel time chunks, byte-identical to one `hyperframes remove-background` run.
//
//   MATTE_THREADS=4 MATTE_JOBS=2 node scripts/matte.mjs SRC.mp4 OUT.webm
//
// build.mjs calls this only when MATTE_JOBS > 1 or MATTE_THREADS is set; with neither it runs the tool directly, as before.
// MATTE_THREADS=T (opt-in): onnxruntime in each tool process runs T intra-op threads with spinning off, instead of
// sizing its pool from every visible core (see matte-ort-threads.cjs): the biggest win in a CPU-quota'd container.
//
// Why the result is byte-identical, not just close: `hyperframes remove-background` (0.8.81) decodes the source to
// rgb24, runs u2net_human_seg on every frame independently (no state carried between frames), and pipes RGB+mask
// into one ffmpeg VP9-alpha encoder. So this script:
//   1. decodes the source with the tool's own decoder command and writes the rgb24 frames, losslessly (FFV1, gbrp),
//      into N contiguous chunk files;
//   2. runs N tool processes in parallel, each writing a ProRes 4444 .mov (its alpha channel is coded losslessly);
//   3. decodes the source once more, takes each frame's mask back from the chunk .movs (through a lookup table
//      calibrated at run time, so an ffmpeg whose 8->10-bit alpha scaling differs is caught, not guessed), and pipes
//      exactly the bytes the tool would have piped into exactly the tool's encoder command.
// The encoder sees the same input as in a single run, so the .webm is the same. Frame counts are checked at every
// step and any mismatch is fatal: a matte that is one frame off would put the cut-out out of sync with the plate.
//
// Costs: temporary files under os.tmpdir() (about 3 MB per 1080x1920 frame for the chunks and 1.5 MB for the .movs,
// deleted as soon as they are used, and the whole folder at the end), and one extra serial VP9 encode at the end.
// MATTE_TMP overrides the temp folder (Railway: keep it off the small /data volume).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The tool as build.mjs runs it. npx is a .cmd shim on Windows that CreateProcess cannot launch directly.
export const TOOL = process.platform === "win32"
  ? ["cmd", ["/c", "npx", "hyperframes@0.8.81", "remove-background"]]
  : ["npx", ["hyperframes@0.8.81", "remove-background"]];

// hyperframes 0.8.81, src/background-removal/pipeline.ts: QUALITY_CRF.balanced (the default) and DEFAULT_VP9_CPU_USED.
const CRF = 18, CPU_USED = 4;

// The tool's encoder command (buildEncoderArgs, webm and mov), byte for byte, so that the final encode matches a
// single run. `prov` is the provenance metadata the tool stamps on its output ({renderer, version}).
export function encoderArgs(format, w, h, fps, out, prov) {
  const base = ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps || 30), "-i", "-"];
  const meta = ["-metadata", `hyperframes_renderer=${prov.renderer}`, "-metadata", `hyperframes_version=${prov.version}`];
  if (format === "webm") return [...base, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(CRF), "-deadline", "good", "-row-mt", "1",
    "-cpu-used", String(CPU_USED), "-auto-alt-ref", "0", "-pix_fmt", "yuva420p", "-colorspace", "bt709", "-color_primaries", "bt709",
    "-color_trc", "bt709", "-color_range", "tv", "-metadata:s:v:0", "alpha_mode=1", "-an", ...meta, out];
  return [...base, "-c:v", "prores_ks", "-profile:v", "4444", "-vendor", "apl0", "-pix_fmt", "yuva444p10le", "-an", ...meta, "-movflags", "+use_metadata_tags", out];
}

// The tool's decoder command: the frames every step below sees are exactly the ones a single run would see.
export const decoderArgs = (src) => ["-loglevel", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgb24", "-an", "-"];

// [start, count] of each chunk: contiguous, in order, sizes differing by at most one.
export function planChunks(total, jobs) {
  const n = Math.max(1, Math.min(jobs, total));
  const base = Math.floor(total / n), extra = total % n, out = [];
  for (let i = 0, s = 0; i < n; i++) { const c = base + (i < extra ? 1 : 0); out.push([s, c]); s += c; }
  return out;
}

// The tool's fps (extractMediaMetadata + parseFrameRate): avg_frame_rate, else r_frame_rate, rounded to 0.01.
const rate = (s) => { const [a, b = "1"] = String(s || "").split("/"); const v = Number(a) / Number(b); return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0; };
export function probe(src) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames:format=duration", "-of", "json", src]).toString());
  const s = j.streams?.[0];
  if (!s) throw new Error(`matte: no video stream in ${src}`);
  const fps = rate(s.avg_frame_rate) || rate(s.r_frame_rate);
  const nb = parseInt(s.nb_frames, 10);
  return { w: s.width, h: s.height, fps, rateArg: s.r_frame_rate && s.r_frame_rate !== "0/0" ? s.r_frame_rate : String(fps || 30),
    estFrames: nb > 0 ? nb : Math.round(parseFloat(j.format?.duration || 0) * (fps || 30)) };
}

// Pull fixed-size frames out of a readable stream.
async function* frames(stream, size) {
  let buf = Buffer.alloc(0);
  for await (const c of stream) {
    buf = buf.length ? Buffer.concat([buf, c]) : c;
    while (buf.length >= size) { yield buf.subarray(0, size); buf = buf.subarray(size); }
  }
  if (buf.length) throw new Error(`matte: stream ended mid-frame (${buf.length} of ${size} bytes)`);
}

const made = new Set();   // temp folder / .part file to remove if we are stopped by a signal (finally does not run then)
const live = new Set();   // every child still running, so a failure can stop the rest (by their own handles, never by name)
// tree: the child starts its own children (npx -> node -> ffmpeg), and killing npx alone left its node + ffmpeg running
// (measured on staging). stop() then kills the whole tree by PID: taskkill /T on Windows, else every descendant found
// through ps, deepest first. The children stay in the caller's process group on purpose: the studio cancels a build by
// SIGKILLing its group, which must keep reaching the tool. Never by name.
const descendants = (pid) => {
  try {
    const kids = new Map();
    for (const l of execFileSync("ps", ["-A", "-o", "pid=,ppid="]).toString().trim().split("\n")) {
      const [c, par] = l.trim().split(/\s+/).map(Number);
      kids.set(par, [...(kids.get(par) || []), c]);
    }
    const out = [], walk = (q) => (kids.get(q) || []).forEach((c) => { walk(c); out.push(c); });
    walk(pid);
    return out;
  } catch { return []; }
};
function run(cmd, args, { stdin = "ignore", stdout = "ignore", env, tree = false } = {}) {
  const p = spawn(cmd, args, { stdio: [stdin, stdout, "pipe"], windowsHide: true, ...(env ? { env } : {}) });
  p.stop = () => {
    if (tree && process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ } return; }
    for (const d of tree ? descendants(p.pid) : []) { try { process.kill(d, "SIGKILL"); } catch { /* gone */ } }
    try { p.kill("SIGKILL"); } catch { /* gone */ }
  };
  live.add(p); p.on("exit", () => live.delete(p));
  let err = "";
  p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
  p.done = new Promise((res, rej) => {
    p.on("error", rej);
    p.on("exit", (code, sig) => code === 0 ? res() : rej(new Error(`${path.basename(cmd)} ${args.slice(0, 6).join(" ")}... exited ${sig || code}: ${err.trim().slice(-600)}`)));
  });
  p.done.catch(() => {});   // a child killed after a failure elsewhere must not raise an unhandled rejection
  if (p.stdin) p.stdin.on("error", () => {});
  return p;
}
const write = (s, b) => s.write(b) ? null : new Promise((r) => s.once("drain", r));

// 8-bit alpha -> what a ProRes 4444 .mov from the tool holds (10-bit) -> back: a 256-entry check, run on this ffmpeg.
async function alphaLut(dir, w, h) {
  const n = w * h, rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) rgba[i * 4 + 3] = i & 255;
  const mov = path.join(dir, "calibrate.mov");
  const enc = run("ffmpeg", encoderArgs("mov", w, h, 30, mov, { renderer: "x", version: "x" }), { stdin: "pipe" });
  enc.stdin.end(rgba); await enc.done;
  const dec = run("ffmpeg", ["-loglevel", "error", "-i", mov, "-f", "rawvideo", "-pix_fmt", "yuva444p10le", "-"], { stdout: "pipe" });
  const lut = new Int16Array(1024).fill(-1);
  for await (const f of frames(dec.stdout, n * 8)) {
    for (let i = 0; i < n; i++) {
      const v = f.readUInt16LE(n * 6 + i * 2), a = i & 255;
      if (lut[v] !== -1 && lut[v] !== a) throw new Error(`matte: ProRes alpha does not round-trip on this ffmpeg (10-bit ${v} <- ${lut[v]} and ${a}); use MATTE_JOBS=1`);
      lut[v] = a;
    }
  }
  await dec.done;
  return lut;
}

// cutMatte(src, out, {jobs, tool, tmp, log}) -> {frames, chunks}. `tool` is [cmd, argsBeforeInput] (tests pass a stub).
// MATTE_THREADS=T: each tool process gets onnxruntime with T intra-op threads and no spinning (matte-ort-threads.cjs).
export function toolEnv(threads) {
  if (!(threads > 0)) return undefined;
  // forward slashes: NODE_OPTIONS reads a backslash inside quotes as an escape (Windows takes either)
  const pre = path.join(path.dirname(fileURLToPath(import.meta.url)), "matte-ort-threads.cjs").split(path.sep).join("/");
  return { ...process.env, MATTE_THREADS: String(threads), NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${pre}"`.trim() };
}

// Linux, chunked runs only: each tool process is pinned (taskset) to its own slice of the CPUs this process may use.
// Not for speed: ffmpeg sizes its thread pool from the visible cores (48 on Railway, under an 8-CPU quota), and the
// tool's ProRes encoder then holds ~145 frames in flight: measured 1.5 GB and climbing per process within 8 s, which
// put two parallel chunks over 6.5 GB. Pinned, ffmpeg sees only the slice. ORT (with MATTE_THREADS) is unaffected.
export function pinFor(k, jobs, { platform = process.platform, cpus = os.availableParallelism(), hasTaskset } = {}) {
  if (platform !== "linux") return [];
  if (hasTaskset === undefined) { try { execFileSync("taskset", ["-V"], { stdio: "ignore" }); hasTaskset = true; } catch { hasTaskset = false; } }
  if (!hasTaskset) return [];
  const size = Math.max(1, Math.floor(cpus / jobs)), a = (k * size) % cpus;
  return ["taskset", "-c", `${a}-${Math.min(cpus - 1, a + size - 1)}`];
}

// cutMatte(src, out, {jobs, threads, tool, tmp, log}) -> {frames, chunks}. jobs 1 = one tool run (with threads applied).
export async function cutMatte(src, out, { jobs = 2, threads = 0, tool = TOOL, tmp = process.env.MATTE_TMP || os.tmpdir(), log = () => {} } = {}) {
  const env = toolEnv(threads);
  if (jobs <= 1) {
    const t = Date.now();
    const part = out.replace(/\.webm$/i, "") + `.part-${process.pid}.webm`;   // a failed run leaves no cached half-matte
    made.add(part);
    try { await run(tool[0], [...tool[1], src, "-o", part], { env, tree: true }).done; fs.renameSync(part, out); }
    finally { fs.rmSync(part, { force: true }); }
    log(`matte: one remove-background process${threads > 0 ? `, ${threads} onnxruntime threads` : ""}, ${((Date.now() - t) / 1000).toFixed(1)} s`);
    return { frames: null, chunks: 1 };
  }
  const { w, h, fps, rateArg, estFrames } = probe(src);
  const plan = planChunks(Math.max(1, estFrames), jobs);
  const dir = fs.mkdtempSync(path.join(tmp, "matte-"));
  made.add(dir);
  const rgbSize = w * h * 3, movSize = w * h * 8, plane = w * h * 6;
  try {
    const t0 = Date.now(), secs = (t) => ((Date.now() - t) / 1000).toFixed(1) + " s";
    const lut = await alphaLut(dir, w, h);
    // 1. split: chunk k takes frames [start, start+count); the last one also takes anything past the estimate
    const chunkPath = (k) => path.join(dir, `chunk-${k}.avi`);
    const counts = plan.map(() => 0);
    let k = -1, enc = null, idx = 0;
    const dec = run("ffmpeg", decoderArgs(src), { stdout: "pipe" });
    for await (const f of frames(dec.stdout, rgbSize)) {
      const want = plan.findLastIndex(([s]) => idx >= s);
      if (want !== k) {
        if (enc) { enc.stdin.end(); await enc.done; }
        k = want;
        enc = run("ffmpeg", ["-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-r", rateArg, "-i", "-",
          "-c:v", "ffv1", "-pix_fmt", "gbrp", chunkPath(k)], { stdin: "pipe" });
      }
      await write(enc.stdin, f);
      counts[k]++; idx++;
    }
    if (enc) { enc.stdin.end(); await enc.done; }
    await dec.done;
    const used = counts.map((c, i) => [i, c]).filter(([, c]) => c > 0);
    log(`matte: ${idx} frames in ${used.length} chunks (${used.map(([, c]) => c).join(" + ")}), ${used.length} remove-background processes in parallel (split ${secs(t0)})`);
    const t1 = Date.now();
    // 2. the tool on every chunk at once
    await Promise.all(used.map(([i], k) => {
      const [cmd, ...pre] = [...pinFor(k, used.length), tool[0]];
      return run(cmd, [...pre, ...tool[1], chunkPath(i), "-o", path.join(dir, `chunk-${i}.mov`)], { env, tree: true }).done

      .then(() => fs.rmSync(chunkPath(i), { force: true }));
    }));
    log(`matte: chunks cut out in ${secs(t1)}`);
    const t2 = Date.now();
    const tags = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", path.join(dir, `chunk-${used[0][0]}.mov`)]).toString()).format?.tags || {};
    const prov = { renderer: tags.hyperframes_renderer || "hyperframes", version: tags.hyperframes_version || "0.8.81" };
    // 3. one encode: the source's own rgb24 frames + each chunk's mask, in order, into the tool's encoder
    const part = out.replace(/\.webm$/i, "") + `.part-${process.pid}.webm`;
    made.add(part);
    const venc = run("ffmpeg", encoderArgs("webm", w, h, fps, part, prov), { stdin: "pipe" });
    const rgb = run("ffmpeg", decoderArgs(src), { stdout: "pipe" });
    const rgbIt = frames(rgb.stdout, rgbSize)[Symbol.asyncIterator]();
    let n = 0;
    for (const [i, c] of used) {
      const mov = path.join(dir, `chunk-${i}.mov`);
      const ad = run("ffmpeg", ["-loglevel", "error", "-i", mov, "-f", "rawvideo", "-pix_fmt", "yuva444p10le", "-"], { stdout: "pipe" });
      let got = 0;
      for await (const a of frames(ad.stdout, movSize)) {
        const r = await rgbIt.next();
        if (r.done) throw new Error(`matte: chunk ${i} has more frames than the source`);
        const p = r.value, rgba = Buffer.allocUnsafe(w * h * 4);   // fresh each frame: the pipe may still hold the last one
        for (let q = 0, o = 0, s = 0; q < w * h; q++, o += 4, s += 3) {
          const m = lut[a.readUInt16LE(plane + q * 2)];
          if (m < 0) throw new Error(`matte: chunk ${i} frame ${got}: alpha value outside the calibrated set`);
          rgba[o] = p[s]; rgba[o + 1] = p[s + 1]; rgba[o + 2] = p[s + 2]; rgba[o + 3] = m;
        }
        await write(venc.stdin, rgba);
        got++; n++;
      }
      await ad.done;
      if (got !== c) throw new Error(`matte: chunk ${i} came back with ${got} frames, ${c} went in`);
      fs.rmSync(mov, { force: true });
    }
    if (!(await rgbIt.next()).done) throw new Error(`matte: the source has more frames than the chunks (${n})`);
    await rgb.done;
    venc.stdin.end(); await venc.done;
    fs.renameSync(part, out);
    log(`matte: masks recombined and encoded in ${secs(t2)} (total ${secs(t0)})`);
    return { frames: n, chunks: used.length };
  } finally {
    const left = [...live]; left.forEach((p) => p.stop());
    await Promise.allSettled(left.map((p) => p.done));   // Windows will not delete a file a dying child still holds
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out || !/\.webm$/i.test(out)) { console.error("usage: MATTE_JOBS=N node scripts/matte.mjs SRC OUT.webm"); process.exit(2); }
  const jobs = Math.max(1, parseInt(process.env.MATTE_JOBS || "1", 10) || 1);
  const threads = Math.max(0, parseInt(process.env.MATTE_THREADS || "0", 10) || 0);
  // stopped from outside (the build killed, Ctrl-C): take the tool processes down with us
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
    for (const p of live) p.stop();
    for (const f of made) fs.rmSync(f, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    process.exit(130);
  });
  cutMatte(path.resolve(src), path.resolve(out), { jobs, threads, log: (m) => console.log(m) })
    .then(({ frames: n, chunks }) => console.log(`matte: ${n} frames, ${chunks} chunks -> ${out}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

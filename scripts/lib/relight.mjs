// reel.json `relight` (opt-in; references/reel-json.md "Empire depth relight"): coloured side light on the speaker's REAL
// footage, shaped by a depth map made locally with Depth Anything V2 Small. Three cached steps per recording:
//   depth   assets/<rec>-depth.mp4               scripts/depth_map.py (onnxruntime; the model is downloaded by --fetch, never here)
//   relit   assets/<rec>-relit-<hash>.mp4        scripts/relight.py --look empire (numpy / OpenCV)
//   matte   assets/<rec>-matte-relit-<hash>.webm the cut-out's alpha over the relit colour (ffmpeg alphamerge), with matte/stage
// Every message thrown here is a build error (build.mjs passes it to die()).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RELIGHT_DEFAULTS = Object.freeze({ look: "empire", left: "#ff3a48", right: "#5a78ff", strength: 0.9, room: 0.3, roomDim: 0.15 });
const RANGES = { strength: [0, 2], room: [0, 1], roomDim: [0, 0.6] };

// true | {} | {look, left, right, strength, room, roomDim} -> the full params (defaults filled in), or throws
export function normalizeRelight(v) {
  if (v === true) v = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`relight must be true or an object (got ${JSON.stringify(v)})`);
  for (const k of Object.keys(v)) if (!(k in RELIGHT_DEFAULTS)) throw new Error(`relight: unknown key '${k}'; have: ${Object.keys(RELIGHT_DEFAULTS).join(", ")}`);
  const p = { ...RELIGHT_DEFAULTS, ...v };
  if (p.look !== "empire") throw new Error(`relight.look must be "empire" (got ${JSON.stringify(p.look)})`);
  for (const k of ["left", "right"]) if (typeof p[k] !== "string" || !/^#[0-9a-fA-F]{6}$/.test(p[k])) throw new Error(`relight.${k} must be a #rrggbb colour (got ${JSON.stringify(p[k])})`);
  for (const [k, [lo, hi]] of Object.entries(RANGES)) if (typeof p[k] !== "number" || !Number.isFinite(p[k]) || p[k] < lo || p[k] > hi) throw new Error(`relight.${k} must be a number ${lo}..${hi} (got ${JSON.stringify(p[k])})`);
  return p;
}

export const modelsDir = (env = process.env) => env.PHANTASIC_MODELS || path.join(os.homedir(), ".cache", "phantasic", "models");
export function depthModelPath(env = process.env) {
  const m = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "..", "library", "models.json"), "utf8"))["depth-anything-v2-small"];
  return path.join(modelsDir(env), m.file);
}

// the first interpreter that imports `mods`: PHANTASIC_PYTHON, the .venv next to the engine (as look.target), then the launchers
const pyCache = new Map();
export function findPython(mods, env = process.env) {
  const key = mods.join(",");
  if (pyCache.has(key)) return pyCache.get(key);
  const venv = path.join(SCRIPTS, "..", "..", ".venv");
  const cands = [env.PHANTASIC_PYTHON, path.join(venv, "Scripts", "python.exe"), path.join(venv, "bin", "python")]
    .filter((p) => p && (p === env.PHANTASIC_PYTHON || fs.existsSync(p)))
    .concat(process.platform === "win32" ? ["py", "python"] : ["python3", "python"]);
  const py = cands.find((c) => spawnSync(c, ["-c", `import ${key}`], { stdio: "ignore" }).status === 0) ?? null;
  pyCache.set(key, py);
  return py;
}

const baseOf = (s) => path.basename(s).replace(/\.[^.]+$/, "");
const md5 = (x) => createHash("md5").update(x).digest("hex").slice(0, 8);
const lastLine = (s) => String(s || "").trim().split("\n").filter(Boolean).at(-1) || "no output";
const run = (py, args, what) => {
  const r = spawnSync(py, args, { encoding: "utf8", stdio: ["ignore", "inherit", "pipe"], maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0) throw new Error(`relight: ${what}: ${lastLine(r.stderr || r.error?.message)}`);
  const timing = String(r.stderr || "").split("\n").filter((l) => /^(depth|relight empire):/.test(l));
  for (const l of timing) console.log("  " + l);
};

// recording `src` (as the takes name it) + the file the <video> tags would play (`media`, the sourceGrade'd copy or src)
// -> the relit file's project-relative path. Builds what is missing; returns at once when everything is cached.
export function ensureRelit(proj, src, media, params, { env = process.env, log = console.log } = {}) {
  const depthRel = `assets/${baseOf(src)}-depth.mp4`, depthAbs = path.resolve(proj, depthRel);
  if (!fs.existsSync(depthAbs)) {
    const model = depthModelPath(env);
    if (!fs.existsSync(model)) throw new Error(`relight: no depth map at ${depthRel} and no depth model at ${model}: run python3 scripts/depth_map.py --fetch, or place a depth video there`);
    const py = findPython(["onnxruntime", "numpy", "cv2"], env);
    if (!py) throw new Error("relight: no python with onnxruntime, numpy and OpenCV found for the depth step (set PHANTASIC_PYTHON)");
    log(`depth map of ${src} (Depth Anything V2 Small, local; cached in ${depthRel})...`);
    run(py, [path.join(SCRIPTS, "depth_map.py"), path.resolve(proj, src), depthAbs], `depth_map.py failed on ${src}`);
  }
  const script = path.join(SCRIPTS, "relight.py");
  const tag = md5([JSON.stringify(params), media, fs.statSync(path.resolve(proj, media)).size, fs.statSync(depthAbs).size, md5(fs.readFileSync(script))].join("|"));
  const rel = `assets/${baseOf(src)}-relit-${tag}.mp4`;
  if (!fs.existsSync(path.resolve(proj, rel))) {
    const py = findPython(["numpy", "cv2"], env);
    if (!py) throw new Error("relight: no python with numpy and OpenCV found (set PHANTASIC_PYTHON)");
    log(`relighting ${src} (relight ${params.look}; cached in ${rel})...`);
    run(py, [script, path.resolve(proj, media), depthAbs, path.resolve(proj, rel), "--look", params.look, "--params", JSON.stringify(params)], `relight.py failed on ${src}`);
  }
  return rel;
}

// libvpx runs nearly single-threaded unless told (-threads + -tile-columns): 10 s at 1080x1920 took ~95 s without, 16 s with 8.
// the cut-out's alpha over the relit colour, so the occluder shows the relit subject (else the head over the captions would be
// the un-lit footage). Written through <name>.part.webm and renamed, like the matte itself.
export function ensureRelitMatte(proj, src, matteRel, relitRel, { log = console.log } = {}) {
  const tag = md5([relitRel, fs.statSync(path.resolve(proj, matteRel)).size].join("|"));
  const rel = `assets/${baseOf(src)}-matte-relit-${tag}.webm`, abs = path.resolve(proj, rel);
  if (fs.existsSync(abs)) return rel;
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path.resolve(proj, relitRel)]).toString().trim().split("x");
  log(`relit cut-out of ${src} (cached in ${rel})...`);
  const part = abs.replace(/\.webm$/i, "") + ".part.webm";
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.resolve(proj, relitRel), "-c:v", "libvpx-vp9", "-i", path.resolve(proj, matteRel),
      "-filter_complex", `[1:v]alphaextract,scale=${w}:${h}[a];[0:v][a]alphamerge,format=yuva420p[v]`, "-map", "[v]", "-an",
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "18", "-b:v", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1",
      "-threads", String(Math.min(8, os.cpus().length)), "-tile-columns", "2", "-auto-alt-ref", "0", part], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 26 });
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw new Error(`relight: could not merge the relit footage into the cut-out of ${src}: ${lastLine(e.stderr)}`);
  }
  fs.renameSync(part, abs);
  return rel;
}

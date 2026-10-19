// The person cut-out (matte) with onnxruntime held to a thread count: one `hyperframes remove-background` run.
// MATTE_THREADS=T (opt-in, integer >= 1): the run gets scripts/matte-ort-threads.cjs preloaded, which holds onnxruntime
// to T threads with spinning off. The preload prints MARK when it takes effect; if it does not (another hyperframes or
// onnxruntime version), the matte is still valid, so the build warns loudly instead of dying.
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// forward slashes: NODE_OPTIONS reads a backslash inside quotes as an escape (Windows takes either)
export const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "matte-ort-threads.cjs").split(path.sep).join("/");
// (loading it here also arms its hook in the build process; inert there, the build never loads onnxruntime)
export const { MARK, matteThreads } = createRequire(import.meta.url)(PRELOAD);

// tool: [cmd, argsBefore] (the npx call to hyperframes@0.8.81 remove-background; tests pass a stub).
// Only for MATTE_THREADS >= 1: with it unset build.mjs keeps its own direct call. Returns whether the patch fired.
export function cutMatteThreaded(tool, src, out, { cwd, threads, preload = PRELOAD, warn = (m) => console.warn(m) }) {
  if (!(threads >= 1)) throw new Error("cutMatteThreaded: threads must be >= 1");
  const args = [...tool[1], src, "-o", out];
  const env = { ...process.env, MATTE_THREADS: String(threads), NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${preload}"`.trim() };
  const r = spawnSync(tool[0], args, { stdio: ["ignore", "ignore", "pipe"], cwd, env, maxBuffer: 1 << 28, encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`remove-background exited ${r.signal || r.status}: ${String(r.stderr || "").trim().slice(-600)}`);
  const fired = String(r.stderr || "").includes(MARK);
  if (!fired) warn(`WARNING: MATTE_THREADS=${threads} was set but the onnxruntime thread patch did not take effect: the matte is fine, the speed-up is lost (about 7x on an 8-CPU quota). Check the hyperframes / onnxruntime-node versions against scripts/matte-ort-threads.cjs.`);
  return fired;
}

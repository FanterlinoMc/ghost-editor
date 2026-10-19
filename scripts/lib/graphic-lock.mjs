// The Mac's shared-machine render lock for the graphic CLIs (not used by renderGraphic: production has no lock).
// With `--lock <path>` or GRAPHIC_RENDER_LOCK=<path>, the CLI re-runs itself under `lockf -k <path>` (macOS) or
// `flock <path>` (Linux), the same lock file other sessions' renders take, and exits with the child's status.
import { spawnSync } from "node:child_process";

const has = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).status === 0;
export function lockPathOf(argv = process.argv, env = process.env) {
  const i = argv.indexOf("--lock");
  return i >= 0 ? argv[i + 1] : env.GRAPHIC_RENDER_LOCK || null;
}
// -> the [tool, args] that would hold the lock, or null when no lock is asked for or it is already held
export function lockCommand(argv = process.argv, env = process.env, tools = { lockf: has("lockf"), flock: has("flock") }) {
  const p = lockPathOf(argv, env);
  if (!p || env.GRAPHIC_RENDER_LOCK_HELD === p) return null;
  const rest = [process.execPath, ...process.execArgv, ...argv.slice(1)];
  if (tools.lockf) return ["lockf", ["-k", p, ...rest]];
  if (tools.flock) return ["flock", [p, ...rest]];
  throw new Error(`a render lock was asked for (${p}) but neither lockf nor flock is installed`);
}
export function holdRenderLock(argv = process.argv, env = process.env) {
  const cmd = lockCommand(argv, env);
  if (!cmd) return;
  const r = spawnSync(cmd[0], cmd[1], { stdio: "inherit", env: { ...env, GRAPHIC_RENDER_LOCK_HELD: lockPathOf(argv, env) } });
  process.exit(r.status ?? 1);
}

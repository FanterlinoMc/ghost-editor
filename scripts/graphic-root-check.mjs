#!/usr/bin/env node
// The root drop, proven on a Linux host that runs the renderer as root (PM2; real Chrome, real renders, NOT in the gate):
//   GRAPHIC_CHROME_UID=<uid> GRAPHIC_CHROME_GID=<gid> GRAPHIC_CHROME_PATH=<abs chrome-headless-shell> \
//     node scripts/graphic-root-check.mjs [<graphic.html>] [--lock PATH]
// The uid/gid: any unprivileged user and group (e.g. 65534:65534), with read + execute on the headless shell's
// directory. A canary variable (standing in for API keys, database URLs) is put in this process's environment first.
//   1. refusal: graphic-determinism without GRAPHIC_CHROME_UID / GID fails with the R12n "running as root" text.
//   2. one Chrome through the shim: /proc/<pid>/status Uid and Gid lines are the ids (all four fields), no
//      supplementary groups, CapEff/CapPrm/CapInh 0, NoNewPrivs 1; its environ is PATH, HOME, TMPDIR, LANG only (no
//      canary); its cwd is its home (a fresh uid-owned dir under os.tmpdir()); the LAST --user-data-dir (ours, in that
//      home) is the one Chrome uses, puppeteer-style root 0700 one stays empty; nothing points into the root-only dir
//      holding the shim (standing in for a project dir the uid cannot enter); every child process has the same uid;
//      the marked PID is this Chrome. The same shim around /bin/cat cannot read a root-only (0600) file and can read a 0644 one.
//   3. graphic-determinism on a fixture: PASS, and every chrome-headless-shell under it (sampled from /proc during the
//      render) runs as the uid with no canary in its environ and no build-dir path in its argv (the build dir is a
//      root 0700 temp dir: the uid cannot enter it, as on a server whose project volume is o-rwx); the home is removed.
//      After the render: no process of the uid is left. Before anything: none may exist (the uid must be dedicated).
//   4. graphic-isolation-check: GRAPHIC ISOLATION: PASS (routes, and R12 through the same shim; the bare baseline is the
//      same drop without the lock flags).
//      Also: a setsid + double-forked process of the uid survives a kill that does nothing or cannot start, and that
//      is DETECTED (home kept); the real release kills it and removes the home. Phase 2 holds the uid's host lock.
//   3b. while this check holds the uid's host lock, graphic-determinism waits (no render, no Chrome of the uid).
// CapAmb must be 0; CapBnd is reported (not cleared: harmless for a non-root uid with no_new_privs).
// Every step is wrapped: a throw (e.g. the temp home cannot be made) is a FAIL line, never a crash.
// Run it WITHOUT an outer lockf/flock on the --lock file if you also pass --lock (that waits for itself; the CLI says
// so). The engine's host lock (graphic-chrome-<uid>.lock) is another file and never collides with it.
// Last line: GRAPHIC ROOT CHECK: PASS | FAIL (<first failure>). Exit 0 / 1. Kills only the Chrome it started (by PID, verified).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromeUser, chromeShim, chromeHome, releaseChromeHome, holdHostLock, hostLockPath, uidProcesses, findChrome, isChrome, ROOT_REFUSAL } from "./lib/graphic-render.mjs";
import { holdRenderLock } from "./lib/graphic-lock.mjs";

holdRenderLock();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const fixture = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--lock") || path.join(ROOT, "scripts", "fixtures", "graphics", "charts.html");
let fails = 0, firstFail = null;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) { fails++; firstFail ??= String(what).split("\n")[0].slice(0, 200); } return ok; };
let cleanup = () => {};
const finish = () => { try { cleanup(); } catch (e) { check(false, `cleanup threw: ${e.message}`); } console.log(`GRAPHIC ROOT CHECK: ${fails ? `FAIL (${firstFail}${fails > 1 ? `; ${fails} failures in all` : ""})` : "PASS"}`); process.exit(fails ? 1 : 0); };
// every step is wrapped: a throw is a FAIL line and the verdict, never a stack trace
const step = async (name, fn) => { try { return await fn(); } catch (e) { check(false, `${name} threw: ${e && e.message}`); return null; } };
process.on("uncaughtException", (e) => { check(false, `uncaught: ${e && e.message}`); finish(); });
process.on("unhandledRejection", (e) => { check(false, `unhandled: ${e && e.message}`); finish(); });
if (process.platform !== "linux" || process.getuid() !== 0) { check(false, "run as root on Linux"); finish(); }
const user = await step("chromeUser", () => chromeUser()) || { error: "chromeUser threw" };
if (!check(!user.error, `drop configured: ${user.error || `${user.uid}:${user.gid} via ${user.setpriv}`}`)) finish();
const CANARY = `canary-${process.pid}-${Date.now()}`;
process.env.GRAPHIC_ROOT_CHECK_SECRET = CANARY;
const ALLOWED = ["HOME", "LANG", "PATH", "TMPDIR"];

const proc = (pid, f) => { try { return fs.readFileSync(`/proc/${pid}/${f}`, "utf8"); } catch { return null; } };
const field = (status, k) => ((new RegExp(`^${k}:\\s*(.*)$`, "m").exec(status || "") || [])[1] || "").trim();
const environ = (pid) => (proc(pid, "environ") || "").split("\0").filter(Boolean);
const ppid = (pid) => { const s = proc(pid, "stat"); return s ? Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[1]) : null; };
const exe = (pid) => { try { return path.basename(fs.readlinkSync(`/proc/${pid}/exe`)); } catch { return null; } };
const pids = () => fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number);
const descendants = (root) => { const out = []; for (const p of pids()) { for (let q = p, n = 0; q > 1 && n < 64; q = ppid(q), n++) if (q === root) { if (p !== root) out.push(p); break; } } return out; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const uidProcs = () => uidProcesses(user.uid); // live (non-zombie) processes whose real uid is the dropped one
if (!check(uidProcs().length === 0, `no process of uid ${user.uid} before the check (it must be a DEDICATED uid): ${uidProcs().join(",")}`)) finish();

// 1. refusal without the ids
await step("refusal without the ids", async () => {
  const env = { ...process.env };
  delete env.GRAPHIC_CHROME_UID; delete env.GRAPHIC_CHROME_GID;
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "graphic-determinism.mjs"), fixture], { encoding: "utf8", env, timeout: 300000 });
  check(r.status === 1 && String(r.stdout + r.stderr).includes(ROOT_REFUSAL), `without GRAPHIC_CHROME_UID/GID: refused ("${ROOT_REFUSAL}")`);
});

// 2. one Chrome through the shim, inspected in /proc
// the shim lives in a root-only 0700 dir, standing in for a project dir the uid cannot enter
let work = null, chrome = null, lock = null, home = null, shim = null, profile = null, released = false;
const lockFile = hostLockPath(user.uid);
cleanup = () => {
  if (home && !released) { const r = releaseChromeHome(home, user); if (!r.ok) console.log(`GRAPHIC RENDER UNSAFE: ${r.error}`); released = true; }
  if (lock) { lock.release(); lock = null; }
  for (const d of [work, profile]) if (d) fs.rmSync(d, { recursive: true, force: true });
};
const setupOk = await step("setup (chrome, host lock, home, shim)", async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-root-check-"));
  chrome = findChrome();
  if (!chrome) throw new Error("no chrome-headless-shell (set GRAPHIC_CHROME_PATH)");
  lock = await holdHostLock(lockFile); // as renderGraphic: the uid's host lock around the whole home lifecycle
  home = chromeHome(user);
  shim = chromeShim(path.join(work, "shim"), chrome, { home, setpriv: user.setpriv });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-root-check-profile-")); // root 0700, like puppeteer's: overridden
  return true;
});
if (!setupOk) finish();
const mark = path.join(work, "mark");
await step("one Chrome through the shim", async () => {
const cp = spawn(shim, ["--headless", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: { ...process.env, GRAPHIC_SHIM_MARK: mark } });
let err = "";
cp.stderr.on("data", (d) => (err += d));
cp.stdio[3].on("error", () => {}); cp.stdio[4].on("data", () => {}); cp.stdio[4].on("error", () => {});
let pid = null;
for (let i = 0; i < 100 && !pid; i++) { await wait(100); const m = (fs.existsSync(mark) ? fs.readFileSync(mark, "utf8") : "").trim(); if (m && exe(Number(m)) === path.basename(chrome)) pid = Number(m); }
if (check(pid === cp.pid, `Chrome started through the shim, marked PID ${pid} = the spawned PID ${cp.pid} (exec chain)${pid ? "" : ": " + err.trim().slice(-300)}`)) {
  await wait(1500); // let it start its children
  const st = proc(pid, "status");
  check(field(st, "Uid") === Array(4).fill(user.uid).join("\t"), `Uid: ${field(st, "Uid")}`);
  check(field(st, "Gid") === Array(4).fill(user.gid).join("\t"), `Gid: ${field(st, "Gid")}`);
  check(field(st, "Groups") === "", `Groups: '${field(st, "Groups")}'`);
  for (const c of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) check(/^0+$/.test(field(st, c)), `${c}: ${field(st, c)}`);
  console.log(`info CapBnd: ${field(st, "CapBnd")} (the bounding set is not cleared; with uid != 0, no_new_privs and no file caps it grants nothing)`);
  check(field(st, "NoNewPrivs") === "1", `NoNewPrivs: ${field(st, "NoNewPrivs")}`);
  const env = environ(pid);
  check(env.map((e) => e.split("=")[0]).sort().join(",") === ALLOWED.join(","), `environ keys: ${env.map((e) => e.split("=")[0]).sort().join(",")}`);
  check(!env.some((e) => e.includes(CANARY)), "environ: no canary");
  let cwd = null; try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
  check(cwd === fs.realpathSync(home), `cwd: ${cwd}`);
  const argv = (proc(pid, "cmdline") || "").split("\0").filter(Boolean);
  const udd = argv.filter((a) => a.startsWith("--user-data-dir="));
  check(udd.length === 2 && udd[1] === `--user-data-dir=${home}/profile-${pid}`, `the last --user-data-dir is ours: ${udd.join(" ")}`);
  check(fs.existsSync(path.join(home, `profile-${pid}`)) && fs.readdirSync(profile).length === 0, "Chrome uses the LAST --user-data-dir (ours is populated, puppeteer-style root 0700 one is empty)");
  check(!argv.some((a) => a.includes(work)) && !environ(pid).some((e) => e.includes(work)) && !String(cwd).startsWith(work), "no argv, env or cwd inside the root-only dir that holds the shim");
  const kids = descendants(pid);
  const bad = kids.filter((k) => !new RegExp(`^${user.uid}\\s`).test(field(proc(k, "status"), "Uid")));
  check(kids.length > 0 && bad.length === 0, `${kids.length} child process(es), all uid ${user.uid}${bad.length ? `; NOT: ${bad.join(",")}` : ""}`);
}
try { cp.stdio[3].write(JSON.stringify({ id: 1, method: "Browser.close" }) + "\0"); } catch {}
await new Promise((r) => { const t = setTimeout(r, 5000); cp.on("exit", () => { clearTimeout(t); r(); }); });
if (pid && isChrome(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
});
await step("root-only file through the same drop", async () => {
  const secret = path.join(os.tmpdir(), `graphic-root-only-${process.pid}`), open = path.join(os.tmpdir(), `graphic-world-readable-${process.pid}`);
  fs.writeFileSync(secret, "ROOT-ONLY\n", { mode: 0o600 });
  fs.writeFileSync(open, "WORLD-READABLE\n", { mode: 0o644 });
  // a stand-in "Chrome" that reads its first two arguments (cat itself would stop at the shim's --flags)
  const rdir = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-root-check-reader-"));
  fs.chmodSync(rdir, 0o755);
  const reader = path.join(rdir, "reader.sh");
  fs.writeFileSync(reader, '#!/bin/sh\ncat -- "$1"; cat -- "$2"\n', { mode: 0o755 });
  const catShim = chromeShim(path.join(work, "cat"), reader, { home, setpriv: user.setpriv });
  const r = spawnSync(catShim, [secret, open], { encoding: "utf8", env: process.env, timeout: 30000 });
  check(!r.stdout.includes("ROOT-ONLY") && /Permission denied/.test(r.stderr) && r.stdout.includes("WORLD-READABLE"), `the same drop cannot read a root-only 0600 file, can read a 0644 one`);
  [secret, open].forEach((f) => fs.rmSync(f, { force: true }));
  fs.rmSync(rdir, { recursive: true, force: true });
});
// a process of the uid that escaped (setsid + double fork): a kill that cannot run is DETECTED (home kept, ok false),
// then the real release kills it and removes the home
await step("escaped process, failed kill detected, real release", async () => {
  const escaped = spawn(user.setpriv, [`--reuid=${user.uid}`, `--regid=${user.gid}`, "--clear-groups", "--", "/bin/sh", "-c", "setsid sh -c 'sleep 300 & exit 0' & exit 0"], { cwd: "/", stdio: "ignore" });
  await new Promise((r) => escaped.on("exit", r));
  await wait(500);
  const before = uidProcs().length;
  const f1 = releaseChromeHome(home, { ...user, setpriv: "/bin/false" });
  check(!f1.ok && fs.existsSync(home) && f1.left.length > 0, `a kill that does nothing (setpriv = /bin/false) is detected: ok ${f1.ok}, home kept ${fs.existsSync(home)}: ${f1.error}`);
  const f2 = releaseChromeHome(home, { ...user, setpriv: "/nonexistent/setpriv" });
  check(!f2.ok && fs.existsSync(home), `a kill that cannot start is detected: ${f2.error}`);
  const rel = releaseChromeHome(home, user);
  await wait(300);
  released = rel.ok;
  check(before > 0 && rel.ok && uidProcs().length === 0 && !fs.existsSync(path.dirname(home)), `release: ${before} escaped uid process(es) killed, ${uidProcs().length} left; home removed: ${!fs.existsSync(path.dirname(home))}${rel.ok ? "" : " " + rel.error}`);
  lock.release(); lock = null; lock = null;
});

// 3. a real render, sampled
await step("a real render (waits for the host lock, then sampled)", async () => {
  const homes = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("graphic-chrome-")).sort().join(",");
  const homesBefore = homes();
  const seen = new Map();
  // a second render waits for the uid's host lock: we hold it for 5 s while graphic-determinism starts
  lock = await holdHostLock(lockFile);
  const det = spawn(process.execPath, [path.join(ROOT, "scripts", "graphic-determinism.mjs"), fixture], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let out = "";
  det.stdout.on("data", (d) => (out += d)); det.stderr.on("data", (d) => (out += d));
  let done = false;
  det.on("exit", () => (done = true));
  await wait(5000);
  check(!done && /waiting for the host lock/.test(out) && !/render 1\/2/.test(out) && uidProcs().length === 0, `a concurrent render waits for the host lock ${lockFile} (no Chrome of the uid, no render started while it is held)`);
  lock.release();
  while (!done) {
    for (const p of descendants(det.pid)) if (!seen.has(p) && exe(p) === path.basename(chrome)) seen.set(p, { uid: field(proc(p, "status"), "Uid").split(/\s+/)[0], canary: environ(p).some((e) => e.includes(CANARY)), project: (proc(p, "cmdline") || "").includes("graphic-determinism-") });
    await wait(100);
  }
  const all = [...seen.values()];
  check(/GRAPHIC DETERMINISM: PASS/.test(out), `graphic-determinism ${path.basename(fixture)}: ${(/GRAPHIC DETERMINISM: \w+/.exec(out) || ["no verdict"])[0]}${/PASS/.test(out) ? "" : "\n" + out.trim().slice(-800)}`);
  check(all.length > 0 && all.every((x) => x.uid === String(user.uid) && !x.canary && !x.project), `${all.length} Chrome process(es) seen during the render, uids {${[...new Set(all.map((x) => x.uid))].join(",")}}, canary in environ: ${all.filter((x) => x.canary).length}, argv naming the (root-only 0700) build dir: ${all.filter((x) => x.project).length}`);
  check(homes() === homesBefore, "the render's Chrome home under os.tmpdir() was removed");
  check(uidProcs().length === 0, `no process of uid ${user.uid} left after the render: ${uidProcs().join(",") || "none"}`);
});

// 4. the isolation check (routes + R12 through the same shim)
await step("the isolation check", async () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "graphic-isolation-check.mjs")], { encoding: "utf8", env: process.env, timeout: 1800000 });
  const last = String(r.stdout).trim().split("\n").filter((l) => /^(probe through|routes through|GRAPHIC ISOLATION)/.test(l));
  last.forEach((l) => console.log("     " + l));
  check(r.status === 0 && /GRAPHIC ISOLATION: PASS/.test(r.stdout), "graphic-isolation-check: GRAPHIC ISOLATION: PASS");
});
finish();

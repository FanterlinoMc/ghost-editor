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
//   3c. a uid process left running before a render is killed by that render's sweep (or the render is refused).
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
import { chromeUser, chromeShim, chromeHome, releaseChromeHome, holdHostLock, hostLockPath, uidProcesses, NO_LOCK_DIR, LINGERING, findChrome, ROOT_REFUSAL } from "./lib/graphic-render.mjs";
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
// /proc/<pid>/exe, environ and cwd of a process of ANOTHER uid that is non-dumpable (every process after setuid is)
// need CAP_SYS_PTRACE, which a container's root usually lacks: unreadable (EACCES), not a sign of anything. status,
// stat and cmdline stay world-readable. So a Chrome is recognised by argv[0] (cmdline), else by comm (stat, 15 chars).
const argv0 = (pid) => ((proc(pid, "cmdline") || "").split("\0")[0] || null);
const comm = (pid) => { const s = proc(pid, "stat"); return s ? s.slice(s.indexOf("(") + 1, s.lastIndexOf(")")) : null; };
let CHROME_BASE = null; // set once findChrome ran
const isPinnedChrome = (pid) => { const a = argv0(pid); return a ? path.basename(a) === CHROME_BASE : comm(pid) === (CHROME_BASE || "").slice(0, 15); };
const readable = (pid, f) => { try { fs.readFileSync(`/proc/${pid}/${f}`); return true; } catch { return false; } };
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
  CHROME_BASE = path.basename(chrome);
  if (!lockFile) throw new Error(NO_LOCK_DIR);
  console.log(`info host lock: ${lockFile}`);
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
for (let i = 0; i < 100 && !pid; i++) { await wait(100); const m = (fs.existsSync(mark) ? fs.readFileSync(mark, "utf8") : "").trim(); if (m && isPinnedChrome(Number(m))) pid = Number(m); }
if (check(pid === cp.pid, `Chrome started through the shim, marked PID ${pid} = the spawned PID ${cp.pid} (exec chain)${pid ? "" : ": " + err.trim().slice(-300)}`)) {
  await wait(1500); // let it start its children
  const st = proc(pid, "status");
  check(field(st, "Uid") === Array(4).fill(user.uid).join("\t"), `Uid: ${field(st, "Uid")}`);
  check(field(st, "Gid") === Array(4).fill(user.gid).join("\t"), `Gid: ${field(st, "Gid")}`);
  check(field(st, "Groups") === "", `Groups: '${field(st, "Groups")}'`);
  for (const c of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) check(/^0+$/.test(field(st, c)), `${c}: ${field(st, c)}`);
  console.log(`info CapBnd: ${field(st, "CapBnd")} (the bounding set is not cleared; with uid != 0, no_new_privs and no file caps it grants nothing)`);
  check(field(st, "NoNewPrivs") === "1", `NoNewPrivs: ${field(st, "NoNewPrivs")}`);
  // environ / cwd: read directly when root may (CAP_SYS_PTRACE), else proven below through the same shim
  let cwd = null; try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
  if (readable(pid, "environ")) {
    const env = environ(pid);
    check(env.map((e) => e.split("=")[0]).sort().join(",") === ALLOWED.join(","), `environ keys: ${env.map((e) => e.split("=")[0]).sort().join(",")}`);
    check(!env.some((e) => e.includes(CANARY)), "environ: no canary");
    check(cwd === fs.realpathSync(home), `cwd: ${cwd}`);
  } else console.log(`info /proc/${pid}/environ, cwd, exe: unreadable to this root (no CAP_SYS_PTRACE; the dropped Chrome is non-dumpable), proven through the same shim below`);
  const argv = (proc(pid, "cmdline") || "").split("\0").filter(Boolean);
  const udd = argv.filter((a) => a.startsWith("--user-data-dir="));
  check(udd.length === 2 && udd[1] === `--user-data-dir=${home}/profile-${pid}`, `the last --user-data-dir is ours: ${udd.join(" ")}`);
  check(fs.existsSync(path.join(home, `profile-${pid}`)) && fs.readdirSync(profile).length === 0, "Chrome uses the LAST --user-data-dir (ours is populated, puppeteer-style root 0700 one is empty)");
  check(!argv.some((a) => a.includes(work)) && !environ(pid).some((e) => e.includes(work)) && !String(cwd).startsWith(work), "no argv (env, cwd where readable) inside the root-only dir that holds the shim");
  const kids = descendants(pid);
  const bad = kids.filter((k) => !new RegExp(`^${user.uid}\\s`).test(field(proc(k, "status"), "Uid")));
  check(kids.length > 0 && bad.length === 0, `${kids.length} child process(es), all uid ${user.uid}${bad.length ? `; NOT: ${bad.join(",")}` : ""}`);
}
try { cp.stdio[3].write(JSON.stringify({ id: 1, method: "Browser.close" }) + "\0"); } catch {}
await new Promise((r) => { const t = setTimeout(r, 5000); cp.on("exit", () => { clearTimeout(t); r(); }); });
if (pid && isPinnedChrome(pid) && field(proc(pid, "status"), "Uid").startsWith(String(user.uid))) { try { process.kill(pid, "SIGKILL"); } catch {} }
});
// what the shim execs, seen from inside: a stand-in "Chrome" through the SAME shim prints its ids, cwd and environment
// (independent of /proc access)
await step("ids, cwd and environment of what the shim execs", async () => {
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-root-check-standin-"));
  fs.chmodSync(sdir, 0o755);
  const standin = path.join(sdir, "standin.sh");
  fs.writeFileSync(standin, '#!/bin/sh\necho "UID=$(id -u) GID=$(id -g) GROUPS=$(id -G)"\necho "CWD=$(pwd -P)"\n/usr/bin/env | sed "s/^/ENV /"\n', { mode: 0o755 });
  try {
    const sshim = chromeShim(path.join(work, "standin"), standin, { home, setpriv: user.setpriv });
    const r = spawnSync(sshim, [], { encoding: "utf8", env: process.env, timeout: 30000 });
    const o = String(r.stdout);
    const keys = o.split("\n").filter((l) => l.startsWith("ENV ")).map((l) => l.slice(4).split("=")[0]).sort();
    check(o.includes(`UID=${user.uid} GID=${user.gid} GROUPS=${user.gid}\n`), `ids: ${(/UID=.*/.exec(o) || [r.stderr.trim().slice(-200)])[0]}`);
    check(o.includes(`CWD=${fs.realpathSync(home)}\n`), `cwd: ${(/CWD=.*/.exec(o) || ["?"])[0]}`);
    check(keys.join(",") === ALLOWED.join(",") && !o.includes(CANARY), `environment keys: ${keys.join(",")}; canary: ${o.includes(CANARY)}`);
  } finally { fs.rmSync(sdir, { recursive: true, force: true }); }
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
  // every 50 ms for the whole render: each descendant whose argv[0] is the pinned shell, its Uid line read at once
  let samples = 0;
  while (!done) {
    samples++;
    for (const p of descendants(det.pid)) {
      if (seen.has(p) || !isPinnedChrome(p)) continue;
      const uids = field(proc(p, "status"), "Uid").split(/\s+/);
      if (!uids[0]) continue; // gone between the two reads
      seen.set(p, { uid: uids[0], all: uids.every((u) => u === uids[0]), canary: readable(p, "environ") && environ(p).some((e) => e.includes(CANARY)), project: (proc(p, "cmdline") || "").includes("graphic-determinism-") });
    }
    await wait(50);
  }
  const all = [...seen.values()];
  check(/GRAPHIC DETERMINISM: PASS/.test(out), `graphic-determinism ${path.basename(fixture)}: ${(/GRAPHIC DETERMINISM: \w+/.exec(out) || ["no verdict"])[0]}${/PASS/.test(out) ? "" : "\n" + out.trim().slice(-800)}`);
  check(all.length > 0 && all.every((x) => x.uid === String(user.uid) && x.all && !x.canary && !x.project), `${all.length} Chrome process(es) seen during the render (${samples} samples, 50 ms), real uids {${[...new Set(all.map((x) => x.uid))].join(",")}}${all.every((x) => x.all) ? "" : " (a Uid line with mixed ids!)"}, canary in a readable environ: ${all.filter((x) => x.canary).length}, argv naming the (root-only 0700) build dir: ${all.filter((x) => x.project).length}`);
  check(homes() === homesBefore, "the render's Chrome home under os.tmpdir() was removed");
  check(uidProcs().length === 0, `no process of uid ${user.uid} left after the render: ${uidProcs().join(",") || "none"}`);
});

// 3c. a process of the uid left running (as by a render whose Node was SIGKILLed): the next render kills it first,
// or refuses
await step("a lingering uid process before a render", async () => {
  const esc = spawn(user.setpriv, [`--reuid=${user.uid}`, `--regid=${user.gid}`, "--clear-groups", "--", "/bin/sh", "-c", "setsid sh -c 'sleep 300 & exit 0' & exit 0"], { cwd: "/", stdio: "ignore" });
  await new Promise((r) => esc.on("exit", r));
  await wait(500);
  const lingering = uidProcs();
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "graphic-determinism.mjs"), fixture], { encoding: "utf8", env: process.env, timeout: 600000 });
  const out = String(r.stdout + r.stderr);
  const killed = /killed \d+ lingering process\(es\) of uid/.test(out) && /GRAPHIC DETERMINISM: PASS/.test(out);
  const refused = out.includes(LINGERING);
  check(lingering.length > 0 && (killed || refused) && lingering.every((p) => !uidProcs().includes(p) || refused), `${lingering.length} lingering uid process(es): ${killed ? "killed before the render, which PASSED" : refused ? "the render was REFUSED" : "neither killed nor refused:\n" + out.trim().slice(-600)}`);
});

// 4. the isolation check (routes + R12 through the same shim)
await step("the isolation check", async () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "graphic-isolation-check.mjs")], { encoding: "utf8", env: process.env, timeout: 1800000 });
  const last = String(r.stdout).trim().split("\n").filter((l) => /^(probe through|routes through|GRAPHIC ISOLATION)/.test(l));
  last.forEach((l) => console.log("     " + l));
  check(r.status === 0 && /GRAPHIC ISOLATION: PASS/.test(r.stdout), "graphic-isolation-check: GRAPHIC ISOLATION: PASS");
});
finish();

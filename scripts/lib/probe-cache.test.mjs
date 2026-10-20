// lib/probe-cache.mjs: the pixel probe's GSAP cache in a shared temp dir must never follow a planted link, never hang
// on a FIFO, never use a directory another user controls, and never exist at all as root.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { cacheDir, cacheRead, cacheWrite, MAX_BYTES } from "./probe-cache.mjs";

const posix = process.platform !== "win32";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "probe-cache-test-"));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const BYTES = Buffer.from("window.gsap = 'test bytes';"), SHA = sha(BYTES);
let n = 0;
const fresh = () => { const base = path.join(ROOT, `b${n++}`); fs.mkdirSync(base); return base; };
const victim = () => { const v = path.join(fresh(), "victim.txt"); fs.writeFileSync(v, "VICTIM"); return v; };

test("round trip in our own 0700 dir", () => {
  const dir = cacheDir({ env: {}, base: fresh() });
  assert.ok(dir);
  if (posix) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(cacheRead(dir, SHA), null);
  assert.equal(cacheWrite(dir, SHA, BYTES), true);
  assert.deepEqual(cacheRead(dir, SHA), BYTES);
  assert.deepEqual(fs.readdirSync(dir), [`pixel-probe-${SHA}.js`], "no temp file left");
});

test("as root there is no disk cache at all (nothing is even created)", () => {
  const base = fresh();
  assert.equal(cacheDir({ env: {}, uid: 0, base }), null);
  assert.deepEqual(fs.readdirSync(base), []);
  assert.equal(cacheWrite(null, SHA, BYTES), false);
  assert.equal(cacheRead(null, SHA), null);
});

test("a cache dir that is a symlink, group/other-writable, or not ours is not used", { skip: posix ? false : "POSIX only" }, () => {
  const base = fresh(), target = fresh();
  const link = path.join(base, `pixel-probe-cache-${process.getuid()}`);
  fs.symlinkSync(target, link);
  // the link's own mode 0700 where the OS allows it (macOS lchmod), so only the symlink check can refuse it
  try { fs.lchmodSync(link, 0o700); } catch {}
  fs.chmodSync(target, 0o700);
  assert.equal(cacheDir({ env: {}, base }), null, "symlinked dir");
  assert.deepEqual(fs.readdirSync(target), []);
  const open = path.join(fresh(), "c"); fs.mkdirSync(open); fs.chmodSync(open, 0o777);
  assert.equal(cacheDir({ env: { PIXEL_PROBE_CACHE: open } }), null, "world-writable dir");
  const mine = path.join(fresh(), "c"); fs.mkdirSync(mine, { mode: 0o700 });
  assert.equal(cacheDir({ env: { PIXEL_PROBE_CACHE: mine }, uid: process.getuid() + 1 }), null, "dir owned by someone else");
});

test("a symlink planted at the cache path is never followed: not read, and a write replaces the link, not its target", { skip: posix ? false : "POSIX only" }, () => {
  const dir = cacheDir({ env: {}, base: fresh() }), v = victim();
  fs.symlinkSync(v, path.join(dir, `pixel-probe-${SHA}.js`));
  assert.equal(cacheRead(dir, SHA), null);
  assert.equal(cacheWrite(dir, SHA, BYTES), true);
  assert.equal(fs.readFileSync(v, "utf8"), "VICTIM", "victim untouched");
  assert.ok(!fs.lstatSync(path.join(dir, `pixel-probe-${SHA}.js`)).isSymbolicLink());
  assert.deepEqual(cacheRead(dir, SHA), BYTES);
});

test("a symlink planted at the temp name is never written through (exclusive, no-follow create)", { skip: posix ? false : "POSIX only" }, () => {
  const dir = cacheDir({ env: {}, base: fresh() }), v = victim();
  fs.symlinkSync(v, path.join(dir, "planted.tmp"));
  assert.equal(cacheWrite(dir, SHA, BYTES, { tmpName: "planted.tmp" }), false);
  assert.equal(fs.readFileSync(v, "utf8"), "VICTIM", "victim untouched");
  const dangling = path.join(fresh(), "not-there.txt");
  fs.symlinkSync(dangling, path.join(dir, "dangling.tmp"));
  assert.equal(cacheWrite(dir, SHA, BYTES, { tmpName: "dangling.tmp" }), false);
  assert.ok(!fs.existsSync(dangling), "a dangling link's target is never created");
});

test("a FIFO at the cache path does not hang the read", { skip: posix ? false : "POSIX only" }, () => {
  const dir = cacheDir({ env: {}, base: fresh() });
  assert.equal(spawnSync("mkfifo", [path.join(dir, `pixel-probe-${SHA}.js`)]).status, 0);
  const t = Date.now();
  assert.equal(cacheRead(dir, SHA), null);
  assert.ok(Date.now() - t < 1000);
});

test("a file not ours or too big is not read", { skip: posix ? false : "POSIX only" }, () => {
  const dir = cacheDir({ env: {}, base: fresh() });
  fs.writeFileSync(path.join(dir, `pixel-probe-${SHA}.js`), BYTES);
  assert.equal(cacheRead(dir, SHA, { uid: process.getuid() + 1 }), null, "owner check");
  fs.writeFileSync(path.join(dir, `pixel-probe-${SHA}.js`), Buffer.alloc(MAX_BYTES + 1));
  assert.equal(cacheRead(dir, SHA), null, "size cap");
});

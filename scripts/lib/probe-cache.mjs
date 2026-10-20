// The pixel probe's cache of runtime-library bytes (GSAP), keyed by their pinned sha256. Written for a shared temp dir
// that other local users can write to, and for a probe that may run as root:
//   - as root there is NO disk cache (cacheDir -> null): the bytes live in memory for one run;
//   - otherwise the cache is a directory WE own, mode 0700, not a symlink (lstat), never group/other-writable:
//     $PIXEL_PROBE_CACHE, else <os.tmpdir()>/pixel-probe-cache-<uid>; one that fails a check is not used (no cache);
//   - a read opens with O_NOFOLLOW | O_NONBLOCK (a symlink fails, a FIFO never blocks), then fstat: a regular file we
//     own, at most MAX_BYTES; the caller checks the sha256;
//   - a write goes to a fresh random name in that dir with O_CREAT | O_EXCL | O_NOFOLLOW (never an existing path, never
//     through a symlink), mode 0600, then rename() over the final name (which replaces a planted link, never its target).
// On Windows (no uid, no O_NOFOLLOW) the ownership and mode checks are skipped; the exclusive create still applies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_BYTES = 4 << 20;
const C = fs.constants;
const NOFOLLOW = C.O_NOFOLLOW || 0, NONBLOCK = C.O_NONBLOCK || 0;
const posix = process.platform !== "win32";
const myUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/** The cache directory to use, created if missing, or null (root, or a directory that fails a check). */
export function cacheDir({ env = process.env, uid = myUid(), base = os.tmpdir() } = {}) {
  if (uid === 0) return null;
  const dir = env.PIXEL_PROBE_CACHE || path.join(base, `pixel-probe-cache-${uid ?? "u"}`);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") return null; }
  let st;
  try { st = fs.lstatSync(dir); } catch { return null; }
  if (!st.isDirectory() || st.isSymbolicLink()) return null;
  if (posix && (st.uid !== uid || (st.mode & 0o077) !== 0)) return null;
  return dir;
}

/** The cached bytes for sha, or null. The caller verifies the sha. */
export function cacheRead(dir, sha, { uid = myUid() } = {}) {
  if (!dir) return null;
  let fd;
  try { fd = fs.openSync(path.join(dir, `pixel-probe-${sha}.js`), C.O_RDONLY | NOFOLLOW | NONBLOCK); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES || (posix && st.uid !== uid)) return null;
    const b = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, b, off, st.size - off, off); if (n <= 0) break; off += n; }
    return off === st.size ? b : null;
  } catch { return null; } finally { fs.closeSync(fd); }
}

/** Store bytes under sha. Never throws; returns true when written. tmpName: tests only (a fixed name to plant on). */
export function cacheWrite(dir, sha, bytes, { tmpName = null } = {}) {
  if (!dir) return false;
  const tmp = path.join(dir, tmpName || `.pixel-probe-${crypto.randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try { fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, 0o600); } catch { return false; }
  try { fs.writeSync(fd, bytes); } catch { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); return false; }
  fs.closeSync(fd);
  try { fs.renameSync(tmp, path.join(dir, `pixel-probe-${sha}.js`)); return true; } catch { fs.rmSync(tmp, { force: true }); return false; }
}

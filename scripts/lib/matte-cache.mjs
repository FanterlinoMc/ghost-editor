// mac-62: the frame-keyed cut-out cache of a behind graphic (references/reel-json.md "Behind the speaker").
// A recording's cut-out is cut only for the frames a behind span shows (+ a margin), into
//   assets/matte-cache/<srcKey>/f<a>-<b>.webm      frames a .. b-1 of the recording at the reel's fps (half-open)
// and a later build reuses every frame already there: only the missing runs are cut. Pure helpers; build.mjs does
// the cutting (ffmpeg + hyperframes remove-background, its cutMatte) and the <video> markup.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MARGIN_FRAMES = 2;   // each side of a span: a frame of slack for the edit-to-recording rounding, and one more
const MIB = 1 << 20;

/** sha256 of the recording's size, the fps and its first and last MiB, first 16 hex: a replaced recording (or another
 *  fps, which renumbers the frames) never reuses a stale cut-out, and hashing a 2 GB file whole is not needed. */
export function srcKey(file, fps) {
  const st = fs.statSync(file), fd = fs.openSync(file, "r");
  try {
    const h = crypto.createHash("sha256").update(`${st.size}:${fps}:`);
    const head = Buffer.alloc(Math.min(MIB, st.size)); fs.readSync(fd, head, 0, head.length, 0); h.update(head);
    const tailN = Math.min(MIB, st.size), tail = Buffer.alloc(tailN); fs.readSync(fd, tail, 0, tailN, st.size - tailN); h.update(tail);
    return h.digest("hex").slice(0, 16);
  } finally { fs.closeSync(fd); }
}

/** The finished files in a cache dir -> [{ a, b, name }] sorted by a (".part" files of a killed cut are not finished). */
export function listCached(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => /^f(\d+)-(\d+)\.webm$/.exec(name)).filter((m) => m && +m[2] > +m[1])
    .map((m) => ({ a: +m[1], b: +m[2], name: m[0] })).sort((p, q) => p.a - q.a || q.b - p.b);
}

/** Merge half-open frame ranges [[a, b)]: overlapping or touching ones become one. */
export function mergeRanges(rs) {
  const out = [];
  for (const [a, b] of [...rs].filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0])) {
    const m = out.at(-1);
    if (m && a <= m[1]) m[1] = Math.max(m[1], b); else out.push([a, b]);
  }
  return out;
}

/** The runs of `need` (merged ranges) that no cached file covers -> [[a, b)] to cut. */
export function missingRanges(need, cached) {
  const cov = mergeRanges(cached.map((c) => [c.a, c.b]));
  const out = [];
  for (const [a0, b0] of mergeRanges(need)) {
    let a = a0;
    for (const [ca, cb] of cov) {
      if (cb <= a || ca >= b0) continue;
      if (ca > a) out.push([a, Math.min(ca, b0)]);
      a = Math.max(a, cb);
      if (a >= b0) break;
    }
    if (a < b0) out.push([a, b0]);
  }
  return out;
}

/** Frames [p0, p1) as consecutive pieces of cached files: [{ a, b, file }] (file = the cached entry), greedy: at each
 *  frame the file that covers it and reaches furthest. null when some frame is in no file. */
export function splitAcross(p0, p1, cached) {
  const out = [];
  for (let f = p0; f < p1;) {
    const c = cached.filter((x) => x.a <= f && x.b > f).sort((p, q) => q.b - p.b)[0];
    if (!c) return null;
    const b = Math.min(c.b, p1);
    out.push({ a: f, b, file: c });
    f = b;
  }
  return out;
}

/** Everything a build needs for its pieces: `need` = [[f0, f1)] recording frames shown (no margin). -> { cut, frames }
 *  where cut = the ranges to cut now (margin added, then minus the cache) and frames = { shown, cut, reused }. */
export function planCuts(need, cached, { margin = MARGIN_FRAMES, total = Infinity } = {}) {
  const want = mergeRanges(need.map(([a, b]) => [Math.max(0, a - margin), Math.min(total, b + margin)]));
  const cut = missingRanges(want, cached);
  const n = (rs) => rs.reduce((s, [a, b]) => s + (b - a), 0);
  return { cut, frames: { needed: n(want), cut: n(cut), reused: n(want) - n(cut) } };
}

export const cacheRel = (key, a, b) => `assets/matte-cache/${key}/f${a}-${b}.webm`;
export const cacheDir = (proj, key) => path.join(proj, "assets", "matte-cache", key);

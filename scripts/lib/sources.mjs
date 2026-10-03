// Per-source ingest paths (I-16 / MULTIANGLE Gap 3, the consumption half).
//
// A multi-source reel needs a transcript and a face track PER recording. Rather than add a schema
// field, the paths are derived by convention from `take.src`, so single-source reel.json files are
// untouched and the planner needs to learn nothing new:
//
//   assets/talk.mp4          -> build/words.whisper.json     build/face.json      (source 0)
//   assets/talk-1.mp4        -> build/words-1.whisper.json   build/face-1.json
//   assets/talk-1-16x9.mp4   -> build/words-1.whisper.json   build/face-1.json    (same source)
//
// Source 0 deliberately keeps the unsuffixed names, for the same reason prep.sh keeps writing
// `assets/talk.mp4` for the default format: every project and reel.json that already points there
// stays valid, and a single-source build is unchanged. Same move as I-16 Gap 1's optional
// `take.src` defaulting to `spec.source`.
//
// Words and face take a SOURCE index only, never a format token: word times and face coordinates
// are in source space, and I-19 already maps one `face.json` through `crop-<fmt>.json` rather than
// re-tracking per format. Only `assets/talk*` carries both dimensions.
import { FORMATS, locateTake } from "./safezone.mjs";
// Re-exported, not reimplemented: `locateTake` has to live in safezone.mjs (this module already
// imports FORMATS from there, and safezone.mjs's own placer needs take ownership too - importing
// it the other way round would be a cycle evaluated before either module finishes initialising,
// the exact "Cannot access 'faces' before initialization" class of failure the Gap 6 face-half
// repin already hit once). Every caller - build.mjs, safezone.mjs's placer, and this module's own
// re-export - therefore shares the one implementation.
export { locateTake };

// prep.sh spells the format with a dash, not a colon ("16:9" -> "16x9"), and derives it from this
// same map - so the two stay in step rather than holding separate copies of the four tokens.
const FORMAT_TOKENS = new Set(Object.keys(FORMATS).map((f) => f.replace(":", "x")));

/**
 * Which recording a source path belongs to: 0 for the unsuffixed default, N for `-N`.
 *
 * The format token has to come off FIRST or it reads as the index - `talk-1-16x9.mp4` would
 * otherwise parse as source "16x9" and fall back to 0, quietly loading the wrong transcript. No
 * format token is digits-only ("9x16", "4x5", "1x1", "16x9"), so once it is removed the remaining
 * `-N` is unambiguous.
 */
export function sourceIndex(src) {
  if (typeof src !== "string" || !src) return 0;
  const base = src.split("/").pop().replace(/\.[^.]+$/, "");
  const parts = base.split("-");
  if (parts.length > 1 && FORMAT_TOKENS.has(parts[parts.length - 1])) parts.pop();
  const last = parts[parts.length - 1];
  return parts.length > 1 && /^\d+$/.test(last) ? Number(last) : 0;
}

/** Conventional transcript path for a source. Project-relative, as `spec.words` is. */
export function wordsPathFor(src) {
  const i = sourceIndex(src);
  return i === 0 ? "build/words.whisper.json" : `build/words-${i}.whisper.json`;
}

/** Conventional face-track path for a source. Project-relative, as `spec.face` is. */
export function facePathFor(src) {
  const i = sourceIndex(src);
  return i === 0 ? "build/face.json" : `build/face-${i}.json`;
}

/**
 * Conventional crop-plan path for a source AND an output format (MULTIANGLE Gap 6). Unlike words
 * and face, which are source-space and format-independent, the crop plan maps one source's face
 * geometry into one format's canvas - prep.sh writes a `build/crop-<fmt>.json` per (source, format)
 * pair, mirroring the same before-the-format-token index convention: `crop-16x9.json` for source 0,
 * `crop-1-16x9.json` for source 1.
 */
export function cropPathFor(src, fmt) {
  const i = sourceIndex(src);
  const fmtTok = fmt.replace(":", "x");
  return i === 0 ? `build/crop-${fmtTok}.json` : `build/crop-${i}-${fmtTok}.json`;
}

/**
 * The median vertical centre of a face track's samples - the statistic `build.mjs` uses for both
 * `faceY` consumers (the baked `#pip` CSS origin, and, before Gap 6, the one value every source
 * shared for the kinetic-pip clip-path centre). `fallback` is returned for a missing or empty
 * track, matching `build.mjs`'s own `700` default.
 */
export function medianFaceY(face, fallback = 700) {
  if (!face || !face.samples) return fallback;
  const ys = face.samples.filter((x) => x[1] != null).map((x) => (x[1] + x[2]) / 2).sort((a, b) => a - b);
  return ys.length ? Math.round(ys[Math.floor(ys.length / 2)]) : fallback;
}

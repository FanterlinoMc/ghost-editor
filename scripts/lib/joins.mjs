// Take-join transitions: how long a blur or a whip lasts.
//
// build.mjs gave every join one fixed length (blur 0.18s out + 0.22s in, whip
// 0.12s + 0.16s). `takes[i].transitionDur` lets a reel set the TOTAL length of
// one join in seconds; the out and in halves keep the kind's own proportion, so
// a longer blur is the same blur, slower.
//
// Kept out of build.mjs so the rule can be asserted without a build
// (joins.test.mjs), the same reason words.mjs and sources.mjs exist.
//
// The property that matters most: with no transitionDur the result is exactly
// what build.mjs computed before this file existed, so every reel that does not
// use the field builds byte-identical.

/** [out, in] seconds for each kind, as build.mjs has always had them. */
export const JOIN_DEFAULTS = { blur: [0.18, 0.22], whip: [0.12, 0.16] };

/** A join shorter than this reads as a glitch; longer than this eats the takes either side. */
export const JOIN_DUR_MIN = 0.1;
export const JOIN_DUR_MAX = 1.5;

/** Why a transitionDur cannot be used, or null when it can. Undefined is "not set". */
export function joinDurProblem(dur) {
  if (dur === undefined) return null;
  if (typeof dur !== "number" || !Number.isFinite(dur)) return `must be a number of seconds, got ${JSON.stringify(dur)}`;
  if (dur < JOIN_DUR_MIN || dur > JOIN_DUR_MAX) return `must be between ${JOIN_DUR_MIN} and ${JOIN_DUR_MAX} seconds, got ${dur}`;
  return null;
}

/**
 * The out and in halves of one join. Each half is still capped at half the take
 * it plays over, exactly as before, so a long join on a short take is shortened
 * rather than running into the next cut.
 */
export function joinDurations(kind, dur, prevDur, nextDur) {
  const [out, inn] = JOIN_DEFAULTS[kind];
  if (dur === undefined) return { outDur: Math.min(out, prevDur / 2), inDur: Math.min(inn, nextDur / 2) };
  const f = dur / (out + inn);
  const r3 = (n) => Math.round(n * 1000) / 1000;
  return { outDur: Math.min(r3(out * f), prevDur / 2), inDur: Math.min(r3(inn * f), nextDur / 2) };
}

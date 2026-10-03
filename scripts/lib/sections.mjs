// Per-section boundaries and invalidation hashes (I-25 / ISSUES D3).
//
// The ask: split index.html into per-section compositions so editing one caption re-renders one
// section. This module answers the two questions that decide whether that done-when is even
// well-posed: WHERE does a reel split into independently-renderable sections, and WHAT, exactly,
// invalidates one.
//
// index.html itself is UNCHANGED by this module - it is additive. build.mjs calls this after the
// edit-time takes/pushes/beats are resolved and writes build/sections.json alongside the existing
// outputs, so a single-source reel's index.html/edit_truth.json/caption_layout.json stay
// byte-identical to before this file existed (nothing that already ran was touched).
//
// ---------------------------------------------------------------------------------------------
// The boundary. Takes as muted <video> ranges + matching <audio> (build.mjs:505-549) are the only
// edit-time construct with a genuine hard edge: a take START is a cut, and nothing has to be
// drawn continuously across it. So every take start after the first is a CANDIDATE section
// boundary.
//
// Candidates are not all real boundaries, though - "beats and scenes span takes" (the brief's own
// words). A candidate is rejected - its two neighbouring takes merge into one section - when
// something that must render continuously straddles it:
//   - a beat's [t0, t1] (the resolved on-screen span a card/scene/overlay occupies - build.mjs
//     accumulates these during the beat loop, see build.mjs's `beatSpans.push` beside the `dur`
//     computation at :726)
//   - a push's [a, b] (a zoom tween animating across the cut)
//   - a take-join TRANSITION's dissolve window (T - outDur to T + inDur) - I-17's blur/whip joins
//     are built to straddle the cut on purpose (build.mjs:532-536), so a transitioned join can
//     never be a section boundary by construction, not as an oversight.
//
// What this costs, stated rather than left implicit: a reel built from one long beat chain (a
// single scene running the whole reel, or every take joined by a transition) yields FEW
// boundaries - in the limit, one section covering the entire reel - so little or no incremental
// benefit. The boundary set is exactly as fine-grained as the plan's own beat/push/transition
// structure allows, never finer. A plan that wants cheap incremental re-renders has to cut
// cleanly, which is a planning concern (STYLE_RULES), not something this module can improve on.
//
// ---------------------------------------------------------------------------------------------
// Invalidation. A section's hash MUST be built from only that section's own inputs - the takes
// spanning it, the beats whose resolved `at` falls inside it, and the (already caption-fixed,
// already phrase-merged) words whose edit-time start falls inside it. Anything global folded into
// every section's hash (TOTAL, the full word list, the whole placer log) would make every caption
// edit invalidate every section, which silently fails the done-when while looking like it works -
// the diff would just show "all sections changed" and nobody would notice the gate was vacuous.
// `sections.test.mjs` pins this directly: editing one word must move exactly one section's hash.
//
// A reel-level setting (style, format, brand, platform) legitimately invalidates every section at
// once - that is correct, not a bug, so it is kept SEPARATE as `globalHash` rather than folded
// silently into each section's own hash with no way to tell the two causes apart.
import crypto from "node:crypto";

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Section boundaries over [0, total). `takes` need only `start` (edit-time seconds); `beatSpans`
 * need `t0`/`t1`; `pushes` need `a`/`b`; `joins` need `T`/`outDur`/`inDur` - the same shapes
 * build.mjs already has in memory (`pushesEdit`, `takeJoins`) with one addition, `beatSpans`,
 * which build.mjs collects during the beat loop for this purpose alone.
 *
 * Returns sections in order, contiguous and covering the whole reel: `[{index, start, end}, ...]`.
 */
export function computeSections(total, takes, { beatSpans = [], pushes = [], joins = [] } = {}) {
  const TOTAL = r3(total);
  if (!takes?.length) return [{ index: 0, start: 0, end: TOTAL }];
  const EPS = 1e-6;
  const spans = [
    ...beatSpans.map((b) => [b.t0, b.t1]),
    ...pushes.map((p) => [p.a, p.b]),
    ...joins.map((j) => [r3(j.T - j.outDur), r3(j.T + j.inDur)]),
  ];
  const spanned = (t) => spans.some(([a, b]) => a < t - EPS && b > t + EPS);
  const candidates = takes.slice(1).map((t) => r3(t.start)).filter((t) => t > EPS && t < TOTAL - EPS);
  const kept = candidates.filter((t) => !spanned(t));
  const boundaries = [...new Set([0, ...kept, TOTAL])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, i) => ({ index: i, start, end: boundaries[i + 1] }));
}

/** The section (by index) a given edit-time instant belongs to. Clamps rather than throwing, since
 *  an outro still/endcard can legitimately sit at exactly `total`. */
export function sectionOf(sections, t) {
  for (const s of sections) if (t >= s.start - 1e-6 && t < s.end - 1e-6) return s.index;
  return sections.length ? sections.at(-1).index : 0;
}

const sha1 = (value) => crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/**
 * One manifest entry per section: its span, the takes/beats/word-indices it owns, and a content
 * hash built ONLY from those - see the invalidation note above for why that restriction is the
 * entire point. `takes`/`beats`/`words` are the already-resolved, already-caption-fixed arrays
 * build.mjs has by the time it writes build/edit_truth.json; `beats` here is the SAME
 * `{type, kind, at, to, in, out}` shape edit_truth.json already dumps, passed straight through, so
 * this hash moves exactly when edit_truth.json's own beat dump would.
 */
export function buildSectionManifest(sections, { takes, beats, words }) {
  return sections.map((sec) => {
    const takeIdx = [];
    takes.forEach((t, i) => { if (t.start < sec.end - 1e-6 && t.start + t.dur > sec.start + 1e-6) takeIdx.push(i); });
    const beatIdx = [];
    beats.forEach((b, i) => { if (sectionOf(sections, b.at) === sec.index) beatIdx.push(i); });
    const wordIdx = [];
    words.forEach((w, i) => { if (sectionOf(sections, w.start) === sec.index) wordIdx.push(i); });
    const payload = {
      takes: takeIdx.map((i) => takes[i]),
      beats: beatIdx.map((i) => beats[i]),
      words: wordIdx.map((i) => words[i]),
    };
    return { index: sec.index, start: sec.start, end: sec.end, takes: takeIdx, beats: beatIdx, words: wordIdx, hash: sha1(payload) };
  });
}

/** A single hash for the settings that legitimately invalidate every section at once (style,
 *  format, brand, platform, ...) - kept separate from each section's own hash so a manifest diff
 *  can tell "one caption changed" apart from "the whole reel's look changed". */
export function globalHash(settings) {
  return sha1(settings);
}

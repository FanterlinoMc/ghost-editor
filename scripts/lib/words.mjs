// Word-to-take ownership (I-16 / MULTIANGLE Gap 3's consumption half).
//
// Extracted from build.mjs so the rule can be asserted directly. The A1 fixture gate cannot cover
// it: every fixture f01-f07 is single-source, so the source filter below is a no-op on all of them
// and accuracy.py stays green whether it is right or wrong - the same reason safezone.test.mjs
// exists. Worse than "uncovered", the gate is structurally blind here: `caption_layout.json`, the
// oracle it scores captions against, is written by build.mjs from THIS function, so any error here
// lands in the expected values too and scores as correct.

/** Overlap in seconds between a word and a take, in original-recording time. */
export const overlap = (w, k) => Math.min(w.end, k.b) - Math.max(w.start, k.a);

/**
 * Index of the take that owns each word, or -1 for none.
 *
 * Each word belongs to ONE take: the one it overlaps most. Whisper stretches words over pauses, so
 * a boundary word can touch two neighbouring takes, and the winner needs a real overlap - at least
 * 0.1s, or half the word, whichever is smaller - or the word is dropped rather than forced onto a
 * take it barely grazes.
 *
 * `wordsSrc` is the recording the transcript describes (`spec.source`). Only takes cut from that
 * recording can own a word, because the word's times ARE times in that recording. Omitting this
 * filter silently steals captions across a file boundary on a multi-source reel: a take from a
 * second recording, which may have no transcript at all, is handed whichever words happen to share
 * its numbers and renders them over its own footage. See ISSUES A30.
 *
 * `wordsSrc` is required and there is deliberately NO opt-out. An earlier draft let callers pass
 * null to skip the filter, which would have re-enabled A30 silently from any new call site - the
 * "some take(s) come from another source" warning lives in build.mjs, not here, so this function
 * cannot shout on its own. A nullish `wordsSrc` therefore matches no take and every take ends up
 * owning no words, which build.mjs already warns about once per take: loud and wrong beats quiet
 * and wrong.
 */
export function wordOwners(words, takes, wordsSrc) {
  return words.map((w) => {
    let best = -1, bo = 0;
    takes.forEach((k, i) => {
      if (k.src !== wordsSrc) return;
      const o = overlap(w, k);
      if (o > bo) { bo = o; best = i; }
    });
    return bo >= Math.min(0.1, 0.5 * (w.end - w.start)) ? best : -1;
  });
}

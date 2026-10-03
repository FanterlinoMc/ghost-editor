#!/usr/bin/env node
// Asserts the per-source path convention (lib/sources.mjs, MULTIANGLE Gap 3).
//
//   node scripts/lib/sources.test.mjs
//
// Pure string work, no file touched - and the fixture gate cannot cover it either, since every
// fixture is single-source and would exercise only the index-0 branch.
import { sourceIndex, wordsPathFor, facePathFor, cropPathFor, locateTake, medianFaceY } from "./sources.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`ok    ${label}`);
  else { failures++; console.log(`FAIL  ${label}${detail ? " - " + detail : ""}`); }
};
const eq = (label, got, want) => check(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// source 0 keeps every name it has today - this is the backward-compatibility contract
eq("talk.mp4 is source 0", sourceIndex("assets/talk.mp4"), 0);
eq("source 0 words are unsuffixed", wordsPathFor("assets/talk.mp4"), "build/words.whisper.json");
eq("source 0 face is unsuffixed", facePathFor("assets/talk.mp4"), "build/face.json");

// a format-only suffix is NOT a source index
for (const fmt of ["9x16", "4x5", "1x1", "16x9"]) {
  eq(`talk-${fmt}.mp4 is still source 0`, sourceIndex(`assets/talk-${fmt}.mp4`), 0);
  eq(`talk-${fmt}.mp4 keeps source 0's words`, wordsPathFor(`assets/talk-${fmt}.mp4`), "build/words.whisper.json");
}

// a real source index
eq("talk-1.mp4 is source 1", sourceIndex("assets/talk-1.mp4"), 1);
eq("talk-2.mp4 is source 2", sourceIndex("assets/talk-2.mp4"), 2);
eq("talk-10.mp4 is source 10", sourceIndex("assets/talk-10.mp4"), 10);
eq("source 1 words", wordsPathFor("assets/talk-1.mp4"), "build/words-1.whisper.json");
eq("source 1 face", facePathFor("assets/talk-1.mp4"), "build/face-1.json");

// BOTH dimensions: the format token must be stripped before the index is read, or `16x9` parses as
// the index and the build silently loads source 0's transcript for source 1's takes.
eq("talk-1-16x9.mp4 is source 1, not 0", sourceIndex("assets/talk-1-16x9.mp4"), 1);
eq("talk-2-4x5.mp4 is source 2", sourceIndex("assets/talk-2-4x5.mp4"), 2);
eq("talk-1-1x1.mp4 is source 1 (1x1 is a format, not an index)", sourceIndex("assets/talk-1-1x1.mp4"), 1);
eq("talk-1-16x9 words ignore the format", wordsPathFor("assets/talk-1-16x9.mp4"), "build/words-1.whisper.json");
eq("talk-1-16x9 face ignores the format", facePathFor("assets/talk-1-16x9.mp4"), "build/face-1.json");

// shapes that must not be mistaken for an index
eq("a bare path with no suffix is source 0", sourceIndex("assets/interview.mp4"), 0);
eq("a non-numeric suffix is not an index", sourceIndex("assets/talk-bcam.mp4"), 0);
eq("a directory digit is not an index", sourceIndex("takes/2/talk.mp4"), 0);
eq("no extension still parses", sourceIndex("assets/talk-3"), 3);
eq("empty/missing src is source 0", sourceIndex(undefined), 0);

// ---- MULTIANGLE Gap 6: per-source crop-plan path, before-the-format-token like words/face -------
eq("source 0's 16:9 crop plan is unsuffixed", cropPathFor("assets/talk.mp4", "16:9"), "build/crop-16x9.json");
eq("source 1's 16:9 crop plan is suffixed", cropPathFor("assets/talk-1.mp4", "16:9"), "build/crop-1-16x9.json");
eq("source 1's 1:1 crop plan", cropPathFor("assets/talk-1.mp4", "1:1"), "build/crop-1-1x1.json");
// the format token the FILE carries (e.g. talk-1-16x9.mp4) must not leak into the crop path - the
// crop plan is keyed by the OUTPUT format argument, not by whatever the source file is named.
eq("a source file that already carries a format token still keys off the requested format",
   cropPathFor("assets/talk-1-16x9.mp4", "4:5"), "build/crop-1-4x5.json");

// ---- MULTIANGLE Gap 6: locateTake agrees with build.mjs's own take/hold ownership ----------------
{
  const takes = [
    { start: 0, dur: 2, holdStart: 2, holdFrames: 30, src: "a" },     // 1s hold at 30fps
    { start: 3, dur: 2, holdStart: 5, holdFrames: 0, src: "b" },
  ];
  check("t inside take 0's main span", locateTake(takes, 0.5).src === "a");
  check("t inside take 0's hold", locateTake(takes, 2.5).src === "a");
  check("t inside take 1's main span", locateTake(takes, 3.5).src === "b");
  check("t past everything falls back to the last take", locateTake(takes, 99).src === "b");
  // holdFrames=3 is 0.1s at the default fps=30 (window [2, 2.1)), so t=2.5 misses the hold and
  // falls back to the last take - but the SAME 3 frames are 3s at fps=1 (window [2, 5)), which
  // t=2.5 is inside. The two fps values must disagree on this `t` for the parameter to be doing
  // anything at all.
  const shortHold = [{ start: 0, dur: 2, holdStart: 2, holdFrames: 3, src: "a" }, { start: 10, dur: 1, holdStart: 11, holdFrames: 0, src: "b" }];
  check("default fps (30): a 3-frame hold is 0.1s, so t=2.5 misses it and falls back to the last take",
        locateTake(shortHold, 2.5).src === "b");
  check("fps=1: the SAME 3-frame hold is 3s, so t=2.5 now lands inside take 0's hold",
        locateTake(shortHold, 2.5, 1).src === "a");
}

// ---- MULTIANGLE Gap 6: medianFaceY, the statistic both faceY consumers share --------------------
{
  // [t, top, bottom, ...] - median of (top+bottom)/2 across samples, null samples skipped
  const face = { samples: [[0, 100, 300], [1, 500, 700], [2, null, null], [3, 200, 400]] };
  // centres: 200, 600, 300 (null skipped) -> sorted [200, 300, 600] -> median 300
  eq("median of three valid samples (one null dropped)", medianFaceY(face), 300);
  eq("no face track at all falls back", medianFaceY(null), 700);
  eq("a custom fallback is honoured", medianFaceY(null, 42), 42);
  eq("an empty samples list falls back", medianFaceY({ samples: [] }), 700);
}

console.log(failures ? `\n${failures} failure(s)` : "\nsource path convention holds");
process.exit(failures ? 1 : 0);

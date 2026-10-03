#!/usr/bin/env node
// Asserts the per-source path convention (lib/sources.mjs, MULTIANGLE Gap 3).
//
//   node scripts/lib/sources.test.mjs
//
// Pure string work, no file touched - and the fixture gate cannot cover it either, since every
// fixture is single-source and would exercise only the index-0 branch.
import { sourceIndex, wordsPathFor, facePathFor } from "./sources.mjs";

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

console.log(failures ? `\n${failures} failure(s)` : "\nsource path convention holds");
process.exit(failures ? 1 : 0);

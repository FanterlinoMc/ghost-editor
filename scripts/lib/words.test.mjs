#!/usr/bin/env node
// Asserts word-to-take ownership (lib/words.mjs), including the multi-source caption theft that
// MULTIANGLE Gap 3's text never mentioned - see ISSUES A30.
//
//   node scripts/lib/words.test.mjs
//
// Why this exists: the A1 fixture gate cannot catch any of it. Every fixture is single-source, so
// the source filter is a no-op on all of them; and `caption_layout.json`, the oracle accuracy.py
// scores captions against, is written from this very function, so an error here appears in the
// expected values too and scores as correct. Oracle and renderer share the code.
//
// Pure in-memory fixtures: no file is read or written, no ffmpeg, no render.
import { wordOwners, overlap } from "./words.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`ok    ${label}`);
  else { failures++; console.log(`FAIL  ${label}${detail ? " - " + detail : ""}`); }
}

const A = "assets/talk.mp4", B = "assets/b.mp4";
const w = (start, end, word = "x") => ({ start, end, word });

// ---- the single-source behaviour, which must not change ---------------------------------------
{
  const takes = [{ a: 0, b: 4, src: A }, { a: 6, b: 10, src: A }];
  const words = [w(0.2, 0.9), w(6.5, 7.0), w(4.5, 5.0)];
  const owners = wordOwners(words, takes, A);
  check("a word inside take 0 is owned by take 0", owners[0] === 0, `got ${owners[0]}`);
  check("a word inside take 1 is owned by take 1", owners[1] === 1, `got ${owners[1]}`);
  check("a word in the gap between takes is owned by nobody", owners[2] === -1, `got ${owners[2]}`);
}
{
  // Whisper stretches a word across a take boundary; the bigger overlap wins.
  const takes = [{ a: 0, b: 4, src: A }, { a: 4, b: 8, src: A }];
  const owners = wordOwners([w(3.9, 4.8)], takes, A);
  check("a boundary word goes to the take it overlaps most", owners[0] === 1, `got ${owners[0]}`);
}
{
  // A word that only grazes a take is dropped, not forced onto it.
  const takes = [{ a: 0, b: 4, src: A }];
  const owners = wordOwners([w(3.98, 4.6)], takes, A);
  check("a word that merely grazes a take is dropped", owners[0] === -1, `got ${owners[0]}`);
}

// ---- A30: the regression that was shipping silently -------------------------------------------
{
  // Take 1 is cut from B, which has NO transcript, and sits exactly where A's transcript HAS
  // words. Measured before the fix: it was handed them and rendered them over B's footage.
  const takes = [{ a: 0, b: 4, src: A }, { a: 6, b: 10, src: B }];
  const words = [w(0.2, 0.9, "This"), w(6.5, 7.0, "Second"), w(8.0, 8.4, "take")];
  const owners = wordOwners(words, takes, A);
  check("A30: a take from another source cannot own words from this transcript",
        owners[1] === -1 && owners[2] === -1, `got ${owners[1]},${owners[2]}`);
  check("A30: the same-source take still owns its own word", owners[0] === 0, `got ${owners[0]}`);
  check("A30: no word is attributed to the foreign-source take at all",
        !owners.includes(1), `owners=${owners}`);
}
{
  // The dead-zone case: this is why an earlier 2-source build looked clean. The foreign take sat
  // at 2.0-6.0 where the transcript happens to have no words, so nothing was stolen and the bug
  // stayed hidden. Correct for the wrong reason - pinned so it is not read as evidence of safety.
  const takes = [{ a: 0, b: 4, src: A }, { a: 2, b: 6, src: B }];
  const owners = wordOwners([w(0.2, 0.9)], takes, A);
  check("A30: a foreign take in a transcript dead zone is also clean (the lucky case)",
        owners[0] === 0 && !owners.includes(1), `owners=${owners}`);
}
{
  // Opting out of the filter reproduces the OLD behaviour, so the test states what was wrong
  // rather than only what is right.
  const takes = [{ a: 0, b: 4, src: A }, { a: 6, b: 10, src: B }];
  const owners = wordOwners([w(6.5, 7.0, "Second")], takes, null);
  check("A30: with the filter off, the foreign take DOES steal the word (the old bug)",
        owners[0] === 1, `got ${owners[0]}`);
}

// ---- overlap() itself --------------------------------------------------------------------------
check("overlap is positive when a word sits inside a take", overlap(w(1, 2), { a: 0, b: 4 }) === 1);
check("overlap is negative when a word is outside a take", overlap(w(5, 6), { a: 0, b: 4 }) < 0);

console.log(failures ? `\n${failures} failure(s)` : "\nword ownership holds");
process.exit(failures ? 1 : 0);

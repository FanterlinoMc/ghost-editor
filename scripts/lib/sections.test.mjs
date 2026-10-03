#!/usr/bin/env node
// Asserts section boundaries and invalidation hashing (lib/sections.mjs, I-25 / ISSUES D3).
//
//   node scripts/lib/sections.test.mjs
//
// Why this exists: the A1 fixture gate builds index.html, not build/sections.json, so it cannot
// catch a boundary that is too coarse (every caption edit re-renders everything) or too fine (a
// beat/push/transition that spans a take join gets cut mid-span). Same reason safezone.test.mjs,
// words.test.mjs and sources.test.mjs exist - the fork's fourth JS test.
//
// Pure in-memory fixtures: no file is read or written, no ffmpeg, no render.
import { computeSections, sectionOf, buildSectionManifest, globalHash } from "./sections.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`ok    ${label}`);
  else { failures++; console.log(`FAIL  ${label}${detail ? " - " + detail : ""}`); }
}

const take = (start, dur) => ({ start, dur });

// ---- boundary: a take start is a candidate, nothing else is -----------------------------------
{
  const takes = [take(0, 4), take(4, 6), take(10, 3)];
  const sections = computeSections(13, takes, {});
  check("three takes with nothing spanning the joins yields three sections",
        sections.length === 3, `got ${sections.length}`);
  check("section boundaries land exactly on take starts",
        sections.map((s) => s.start).join(",") === "0,4,10", JSON.stringify(sections));
  check("sections are contiguous and cover the whole reel",
        sections[0].start === 0 && sections.at(-1).end === 13);
}
{
  const sections = computeSections(5, [take(0, 5)], {});
  check("a single take yields one section covering the reel",
        sections.length === 1 && sections[0].start === 0 && sections[0].end === 5, JSON.stringify(sections));
}
{
  const sections = computeSections(5, [], {});
  check("no takes at all still yields one section rather than throwing",
        sections.length === 1 && sections[0].end === 5);
}

// ---- a beat spanning a take join merges the two takes into one section ------------------------
{
  const takes = [take(0, 4), take(4, 6)];
  // a scene beat running 2.0-6.0 straddles the join at 4
  const sections = computeSections(10, takes, { beatSpans: [{ t0: 2.0, t1: 6.0 }] });
  check("a beat straddling a take join removes that boundary",
        sections.length === 1, JSON.stringify(sections));
}
{
  // the same beat, but it ends exactly AT the join (does not straddle it) - the boundary survives
  const takes = [take(0, 4), take(4, 6)];
  const sections = computeSections(10, takes, { beatSpans: [{ t0: 1.0, t1: 4.0 }] });
  check("a beat ending exactly at a join does not remove that boundary",
        sections.length === 2, JSON.stringify(sections));
}

// ---- a push across a join merges, same as a beat ----------------------------------------------
{
  const takes = [take(0, 4), take(4, 6)];
  const sections = computeSections(10, takes, { pushes: [{ a: 3.5, b: 4.5 }] });
  check("a push straddling a take join removes that boundary", sections.length === 1);
}

// ---- a take-join TRANSITION always removes its own boundary, by construction ------------------
{
  const takes = [take(0, 4), take(4, 6)];
  // I-17's blur/whip joins dissolve across T themselves (build.mjs:532-536) - outDur/inDur alone,
  // with no beat or push anywhere near the join, must still merge the two takes.
  const sections = computeSections(10, takes, { joins: [{ T: 4, outDur: 0.18, inDur: 0.22 }] });
  check("a take-join transition removes its own boundary with no beat or push involved",
        sections.length === 1, JSON.stringify(sections));
}
{
  // a hard cut (no transition entry for this join) keeps the boundary - transitions opt a join
  // OUT of being a boundary, a hard cut does not opt it back in by being absent from `joins`.
  const takes = [take(0, 4), take(4, 6), take(10, 3)];
  const sections = computeSections(13, takes, { joins: [{ T: 4, outDur: 0.18, inDur: 0.22 }] });
  check("only the transitioned join merges; the hard-cut join elsewhere stays a boundary",
        sections.length === 2 && sections[1].start === 10, JSON.stringify(sections));
}

// ---- sectionOf -----------------------------------------------------------------------------
{
  const sections = computeSections(10, [take(0, 4), take(4, 6)], {});
  check("sectionOf finds the section an instant falls in", sectionOf(sections, 5) === 1);
  check("sectionOf clamps a time at the very end to the last section", sectionOf(sections, 10) === 1);
  check("sectionOf finds the first section at t=0", sectionOf(sections, 0) === 0);
}

// ---- the invalidation property the whole feature depends on -----------------------------------
// This is the one the done-when ("editing one caption re-renders one section") actually tests:
// editing a word owned by section 1 must change section 1's hash and NO OTHER section's.
{
  const takes = [take(0, 4), take(4, 4), take(8, 4)];
  const sections = computeSections(12, takes, {});
  const beats = [{ type: "scene", kind: "sentence", at: 1, to: 3, in: "cut", out: "cut" }];
  const words = [
    { word: "Hello", start: 0.2, end: 0.6 },
    { word: "world", start: 4.5, end: 4.9 },
    { word: "again", start: 8.5, end: 8.9 },
  ];
  const before = buildSectionManifest(sections, { takes, beats, words });

  const wordsEdited = words.map((w, i) => (i === 1 ? { ...w, word: "WORLD" } : w));
  const after = buildSectionManifest(sections, { takes, beats, words: wordsEdited });

  const changed = before.map((b, i) => b.hash !== after[i].hash);
  check("editing one word changes exactly one section's hash",
        changed.filter(Boolean).length === 1 && changed[1] === true,
        `changed=${JSON.stringify(changed)}`);
  check("the untouched sections' hashes are byte-identical before/after",
        before[0].hash === after[0].hash && before[2].hash === after[2].hash);

  // the word that moved is correctly attributed to section 1, not folded into every section's hash
  check("section 1 owns exactly the word index that changed", after[1].words.includes(1));
  check("section 0 does not own section 1's word", !after[0].words.includes(1));
}
{
  // vacuity guard: a hash that (wrongly) depended on the WHOLE words array would also move on
  // every section when one word changes. Pin that the wrong implementation would have failed the
  // check above by constructing it directly and confirming all three move together.
  const takes = [take(0, 4), take(4, 4), take(8, 4)];
  const sections = computeSections(12, takes, {});
  const words = [{ word: "Hello", start: 0.2, end: 0.6 }, { word: "world", start: 4.5, end: 4.9 }, { word: "again", start: 8.5, end: 8.9 }];
  const wholeHash = (ws) => JSON.stringify(ws); // a stand-in "global" hash, deliberately naive
  const h1 = sections.map(() => wholeHash(words));
  const h2 = sections.map(() => wholeHash(words.map((w, i) => (i === 1 ? { ...w, word: "WORLD" } : w))));
  check("sanity: a hash built from the WHOLE word list moves on every section (the bug this guards against)",
        h1.every((h, i) => h !== h2[i]));
}

// ---- globalHash: a reel-level setting change is visible, and separate from section hashes -----
{
  const a = globalHash({ style: "clean", format: "9:16" });
  const b = globalHash({ style: "launch", format: "9:16" });
  check("globalHash differs when the style differs", a !== b);
  check("globalHash is stable for identical settings", globalHash({ style: "clean", format: "9:16" }) === a);
}

console.log(failures ? `\n${failures} failure(s)` : "\nsection boundaries and invalidation hold");
process.exit(failures ? 1 : 0);

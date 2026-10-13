// node scripts/lib/caption-span.test.mjs
import assert from "node:assert/strict";
import { takeEndAt } from "./caption-span.mjs";

// The staging reel: a 5 s clip, a 13.033 s clip and a 5 s photo, laid end to end.
const takes = [
  { start: 0, dur: 5, holdStart: 5, holdFrames: 0 },
  { start: 5, dur: 13.033, holdStart: 18.033, holdFrames: 0 },
  { start: 18.033, dur: 5, holdStart: 23.033, holdFrames: 0 },
];
assert.equal(takeEndAt(takes, 30, 17.05, 23.033), 18.033);
assert.equal(Math.min(18.32, takeEndAt(takes, 30, 17.05, 23.033)), 18.033, "17.05-18.32 no longer runs into the photo");
assert.equal(takeEndAt(takes, 30, 18.033, 23.033), 23.033, "a word in the next take belongs to that take");

// a hold after the take is part of the take
const held = [{ start: 0, dur: 4, holdStart: 4, holdFrames: 30 }, { start: 5, dur: 3, holdStart: 8, holdFrames: 0 }];
assert.equal(takeEndAt(held, 30, 3.9, 8), 5);

// outside every take (and with no takes at all) the fallback is used
assert.equal(takeEndAt(takes, 30, 99, 23.033), 23.033);
assert.equal(takeEndAt([], 30, 1, 7), 7);
console.log("caption-span.test.mjs ok");

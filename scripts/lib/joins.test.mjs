// node scripts/lib/joins.test.mjs
import assert from "node:assert/strict";
import { JOIN_DEFAULTS, joinDurProblem, joinDurations } from "./joins.mjs";

// Unset: the exact expressions build.mjs used before transitionDur existed.
assert.deepEqual(joinDurations("blur", undefined, 4, 4), { outDur: 0.18, inDur: 0.22 });
assert.deepEqual(joinDurations("whip", undefined, 4, 4), { outDur: 0.12, inDur: 0.16 });
assert.deepEqual(joinDurations("blur", undefined, 0.2, 0.3), { outDur: Math.min(0.18, 0.1), inDur: Math.min(0.22, 0.15) });

// Set: the total is split in the kind's own proportion.
assert.deepEqual(joinDurations("blur", 0.8, 4, 4), { outDur: 0.36, inDur: 0.44 });
assert.deepEqual(joinDurations("whip", 0.14, 4, 4), { outDur: 0.06, inDur: 0.08 });
// The kind's own total reproduces the default.
assert.deepEqual(joinDurations("blur", 0.4, 4, 4), { outDur: 0.18, inDur: 0.22 });
// Still capped at half of each neighbouring take.
assert.deepEqual(joinDurations("blur", 1.5, 0.5, 0.6), { outDur: 0.25, inDur: 0.3 });

assert.equal(joinDurProblem(undefined), null);
assert.equal(joinDurProblem(0.4), null);
for (const bad of [0, 0.05, 2, -1, "0.4", null, NaN]) assert.ok(joinDurProblem(bad), `should refuse ${String(bad)}`);
assert.deepEqual(Object.keys(JOIN_DEFAULTS).sort(), ["blur", "whip"]);
console.log("joins: ok");

// node --test scripts/lib/measured-match.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { measuredMatch } from "./measured-match.mjs";

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const file = (p95, extra = 6) => JSON.stringify({ total: extra, speech: 6, voiceP95: p95, roleDb: { ui: -14 }, events: [] }, null, 2);
const golden = sha(file(-17.731));

test("a voiceP95 a few thousandths of a dB off matches the golden hash", () => {
  assert.match(measuredMatch(file(-17.735), golden), /voiceP95 -17.735 vs golden -17.731/);
  assert.ok(measuredMatch(file(-17.731), golden));
  assert.ok(measuredMatch(file(-17.7), golden));
});
test("beyond the tolerance it does not match", () => {
  assert.equal(measuredMatch(file(-17.79), golden), null);
});
test("any other difference still fails, however close voiceP95 is", () => {
  assert.equal(measuredMatch(file(-17.735, 7), golden), null);
  assert.equal(measuredMatch(file(-17.731).replace('"ui": -14', '"ui": -13'), golden), null);
});
test("a file without voiceP95 never matches by tolerance", () => {
  assert.equal(measuredMatch('{"events": []}', sha('{"events": [1]}')), null);
});

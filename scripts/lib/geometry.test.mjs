// build/geometry.json (lib/geometry.mjs): the camera mapping comes from the placer itself, the skipped windows are
// said rather than guessed, graphic windows are whole frames, and the file frame is the one the <video> shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeometry, mergeWindows, frameAtOrAfter } from "./geometry.mjs";
import { makePlacer, PLATFORMS } from "./safezone.mjs";

const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 30 }, (_, i) => [i * 0.2, 300, 900, 340, 740, 480, 700]) };
const takes = [
  { a: 0, b: 2, start: 0, dur: 2, holdStart: 2, holdFrames: 6, src: "assets/talk.mp4" },
  { a: 3, b: 5, start: 2.2, dur: 2, holdStart: 4.2, holdFrames: 0, src: "assets/talk-1.mp4" },
];
const base = (over = {}) => {
  const placer = makePlacer({ face, takes, zoom: { base: 1.2, origin: "50% 29%", snapsEdit: [[1, 1.5]] }, TOTAL: 5.2, fps: 30 });
  return buildGeometry({ W: 1080, H: 1920, fps: 30, total: 5.2, speech: 4.2, format: "9:16", platform: "instagram", zones: PLATFORMS.instagram,
    screenFaceAt: placer.screenFaceAt, primarySrc: "assets/talk.mp4", takes, roomWins: [{ tA: 0.5, tB: 0.8 }], captions: [], captionStyle: "house",
    capsHidden: [[1.0, 1.5]], spans: [{ t0: 1.0, t1: 1.4, label: "graphic:g1" }, { t0: 3, t1: 4, label: "scene:x" }], ...over });
};

test("face per output frame through the placer's camera (base x snap around the origin), with its age", () => {
  const g = base();
  assert.equal(g.frames, 156); assert.equal(g.face.length, 156);
  // frame 0: zoom 1.2 around (540, 556.8): top 300 -> 556.8 + 1.2 * (300 - 556.8) = 248.64
  assert.deepEqual(g.face[0], [0, 249, 969, 300, 780, 465, 729, 0]);
  // frame 45 (t = 1.5): the snap to 1.5 on top: 1.8 x
  assert.deepEqual(g.face[45].slice(1, 3), [Math.round(556.8 + 1.8 * (300 - 556.8)), Math.round(556.8 + 1.8 * (900 - 556.8))]);
  assert.ok(g.face[3][7] > 0 && g.face[3][7] < 0.11, "age = seconds to the face sample used");
});

test("room windows and non-primary sources are skipped, with the reason (owner answer 2)", () => {
  const g = base();
  assert.deepEqual(g.faceSkip, [[0.5, 0.8, "room"], [2.2, 4.2, "source assets/talk-1.mp4"]]);
  assert.deepEqual(g.face[15], [15, null]);   // t = 0.5, room
  assert.deepEqual(g.face[66], [66, null]);   // t = 2.2, take 1 (talk-1)
  assert.notEqual(g.face[63][1], null);       // t = 2.1, take 0's hold: primary
});

test("hidden caption windows carry what hides them; joins, holds and the outro", () => {
  const g = base();
  assert.deepEqual(g.hiddenCaps, [[1, 1.5, "graphic:g1"]]);
  assert.deepEqual(g.joins, [{ t: 2.2, frame: 66, take: 1, src: "assets/talk-1.mp4", out: 2, in: 3, outSrc: "assets/talk.mp4" }]);
  assert.deepEqual(g.stillOk, [[2, 2.2, "hold:0"], [4.2, 5.2, "outro"]]);
  assert.deepEqual(g.darkOk, []);
});

test("graphic: whole-frame window [f0, f1) and the file frame each output frame shows (floor of media time)", () => {
  const gr = { id: "g1", kind: "beat", mode: "insert", by: "planner", file: "assets/graphics/g1-0123.mp4", fit: "cover", opacity: 1,
    box: { x: 0, y: 0, w: 1080, h: 1920 }, t0: 1.05, t1: 1.25, L: 6, inF: 0, D: 4, after: "hold", hideCaptions: true, selector: "#b0-in" };
  const g = base({ graphics: [gr] }).graphics[0];
  assert.equal(g.f0, 32); assert.equal(g.f1, 38);   // 1.05 s = frame 31.5: the show tween ends there, frame 32 is the first
  assert.deepEqual(g.srcFrames, [0, 1, 2, 3, 4, 5]);
  assert.equal(g.hard, true);
  // an insert held past its own length is still by design
  assert.deepEqual(base({ graphics: [gr] }).stillOk[0], [1.183, 1.25, "graphic:g1:hold"]);
});

test("helpers", () => {
  assert.equal(frameAtOrAfter(8.0, 30), 240); assert.equal(frameAtOrAfter(7.95, 30), 239);
  assert.deepEqual(mergeWindows([[2, 3, "b"], [0, 1, "a"], [1, 1.5, "c"]]), [[0, 1.5, "a,c"], [2, 3, "b"]]);
});

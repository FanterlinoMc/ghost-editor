#!/usr/bin/env node
// Asserts the "making room" maths (lib/room.mjs) and how the motion compiler reports `room`.
//
//   node scripts/lib/room.test.mjs
import { ROOM_SCALE, roomFrames, mergeRoomFrames, roomWindows, roomScaleAt, ROOM_RADIUS, ROOM_SHADOW, ROOM_FILL, roomCardCss, roomCardAt, roomCardBox, roomCardInset, roomPoint, roomBox, normalizeRoom, roomSpecJson } from "./room.mjs";
import { compileMotion } from "./motion-graphics.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`ok    ${label}`);
  else { failures++; console.log(`FAIL  ${label}${detail ? " - " + detail : ""}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (label, got, want, tol = 1e-9) => check(label, Math.abs(got - want) <= tol, `got ${got}, want ${want}`);

eq("ROOM_SCALE is 0.73", ROOM_SCALE, 0.73);

// the field: only "below" changes anything
eq("room undefined -> none, silently", normalizeRoom(undefined), { room: "none" });
eq("room none", normalizeRoom("none"), { room: "none" });
eq("room below", normalizeRoom("below"), { room: "below" });
check("room 'above' clamps to none with a warning", normalizeRoom("above").room === "none" && /not "none" or "below"/.test(normalizeRoom("above").warning));
check("room true clamps to none with a warning", normalizeRoom(true).room === "none" && !!normalizeRoom(true).warning);

// frames: round half UP (JS Math.round), both ends inclusive
eq("frames 12.4..15.1 @30", roomFrames(12.4, 15.1, 30), [372, 470]);
eq("round half up (1.5 frames -> 2)", roomFrames(0.05, 0.5, 30), [2, 32]);
eq("29.97 fps", roomFrames(10, 12, 29.97), [300, 376]);

// merging
eq("overlap merges", mergeRoomFrames([[10, 40], [30, 60]]), [[10, 60]]);
eq("touching merges", mergeRoomFrames([[10, 40], [40, 60]]), [[10, 60]]);
eq("one frame apart stays apart", mergeRoomFrames([[10, 40], [41, 60]]), [[10, 40], [41, 60]]);
eq("contained merges", mergeRoomFrames([[10, 100], [20, 30]]), [[10, 100]]);
eq("unsorted input", mergeRoomFrames([[100, 120], [10, 40], [30, 60]]), [[10, 60], [100, 120]]);
eq("empty", mergeRoomFrames([]), []);

// the scale curve: window frames [30, 120] @30 -> tA 1.0, tB 4.0
const w = roomWindows([[30, 120]], 30);
near("tA", w[0].tA, 1); near("tB", w[0].tB, 4);
eq("ease in spans 0.35 s from tA", w[0].easeIn.map((x) => +x.toFixed(6)), [1, 1.35]);
eq("ease out ends at tB", w[0].easeOut.map((x) => +x.toFixed(6)), [3.65, 4]);
near("before the window: 1", roomScaleAt(0.99, w), 1);
near("at tA: 1", roomScaleAt(1, w), 1);
near("half-way up the ease: midpoint", roomScaleAt(1.175, w), (1 + ROOM_SCALE) / 2);
near("end of ease in: 0.73", roomScaleAt(1.35, w), ROOM_SCALE);
near("held: 0.73", roomScaleAt(2.5, w), ROOM_SCALE);
near("start of ease out: 0.73", roomScaleAt(3.65, w), ROOM_SCALE);
near("half-way down the ease: midpoint", roomScaleAt(3.825, w), (1 + ROOM_SCALE) / 2);
near("at tB: 1", roomScaleAt(4, w), 1);
near("after: 1", roomScaleAt(4.01, w), 1);
check("a window shorter than two eases halves the ease", (() => { const s = roomWindows([[0, 15]], 30)[0]; return Math.abs(s.easeIn[1] - 0.25) < 1e-9 && s.easeOut[0] === s.easeIn[1]; })());

// the geometry: origin (540, 0); the camera is applied first
eq("origin is fixed by the transform", roomPoint([540, 0]), [540, 0]);
const [fx, fy] = roomPoint([540, 1317]);
near("face bottom y on the owner's reel (1317 -> 961.41)", fy, 961.41); near("x of the axis is fixed", fx, 540);
eq("footage box at rest", roomBox([0, 0, 1080, 1920]).map((x) => +x.toFixed(2)), [145.8, 0, 788.4, 1401.6]);
const camera = ([x, y], k = 1.28, ox = 540, oy = 0.29 * 1920) => [ox + k * (x - ox), oy + k * (y - oy)];   // any camera; the room is applied after it
const p = [300, 900], viaCamera = roomPoint(camera(p));
const scaled = camera(p).map((v, i) => (i === 0 ? 540 + ROOM_SCALE * (v - 540) : ROOM_SCALE * v));
eq("room(camera(p)) = camera first, then the room scale about (540, 0)", viaCamera.map((x) => +x.toFixed(9)), scaled.map((x) => +x.toFixed(9)));
near("camera scale and room scale multiply on lengths", roomBox([0, 0, 100, 100], ROOM_SCALE)[2], 73);

// the compiler reports room, and "below" implies hideCaptions
const ctx = { id: "b3", t0: 10, t1: 14, W: 1080, H: 1920, brand: {}, resolveImage: () => null };
const beat = (extra = {}) => ({ type: "motion", by: "designer", id: "m1", at: 1, to: 5, elements: [{ id: "t", shape: "text", x: 100, y: 1500, w: 800, h: 200, text: "Hello", font: "Inter", size: 120 }], tweens: [], ...extra });
const none = compileMotion(beat(), ctx), below = compileMotion(beat({ room: "below" }), ctx), bad = compileMotion(beat({ room: "sideways" }), ctx);
check("no room: room none, captions unchanged", none.ok && none.room === "none" && none.hideCaptions === false && !none.warnings.length);
check("below: room below and hideCaptions true", below.ok && below.room === "below" && below.hideCaptions === true);
check("below with hideCaptions:false still hides captions", compileMotion(beat({ room: "below", hideCaptions: false }), ctx).hideCaptions === true);
check("bad room: none, with a warning, beat still built", bad.ok && bad.room === "none" && bad.warnings.some((m) => /room/.test(m)));
check("room does not change the compiled graphic", none.html === below.html && JSON.stringify(none.lines) === JSON.stringify(below.lines));

// the card: rounded corners + shadow, as rendered 36 px and 0 24px 60px black 45%, following the scale's eased progress
eq("card constants", [ROOM_RADIUS, ROOM_SHADOW, ROOM_FILL], [36, { x: 0, y: 24, blur: 60, alpha: 0.45 }, "ink"]);
eq("card css at full room is the rendered value / 0.73", roomCardCss(1), { "--room-r": "49.315px", "--room-ix": "0.274px", "--room-ib": "0.822px", boxShadow: "0px 32.877px 82.192px rgba(0,0,0,0.45)" });
eq("card css at 0 is nothing", roomCardCss(0), { "--room-r": "0px", "--room-ix": "0px", "--room-ib": "0px", boxShadow: "0px 0px 0px rgba(0,0,0,0)" });
near("card radius 0 at scale 1", roomCardAt(0.99, w).radius, 0); near("card radius 36 at 0.73", roomCardAt(2.5, w).radius, 36);
near("card shadow alpha at 0.73", roomCardAt(2.5, w).shadowAlpha, 0.45); near("card shadow blur 0 outside", roomCardAt(4.5, w).shadowBlur, 0);
near("card is half-way at the scale's half-way point", roomCardAt(1.175, w).radius, 18);
near("rendered radius = css radius x scale", parseFloat(roomCardCss(1)["--room-r"]) * ROOM_SCALE, 36, 0.01);

// the JSON a mirror can read
const j = roomSpecJson();
check("spec json carries the constants", j.scale === 0.73 && j.easeSeconds === 0.35 && j.exitSeconds === 0.55 && j.origin[0] === 540 && j.origin[1] === 0);
// the card is snapped to whole canvas pixels at full room (no part-covered edge row/column): 145.8..934.2 x 0..1401.6 -> 146..934 x 0..1401
eq("card box is whole pixels", roomCardBox(), [146, 0, 788, 1401]);
{ const ins = roomCardInset(), s = ROOM_SCALE, ox = 540, edge = (v) => ox + s * (v - ox);
  near("snapped left edge lands on 146", edge(ins.x), 146, 1e-9); near("snapped right edge lands on 934", edge(1080 - ins.x), 934, 1e-9); near("snapped bottom lands on 1401", s * (1920 - ins.b), 1401, 1e-9);
  check("snap loses under a pixel of footage", ins.x * s < 0.21 && ins.b * s < 0.61 && ins.x >= 0 && ins.b >= 0); }
check("spec json carries the card box", roomSpecJson().cardBox.join() === "146,0,788,1401");
check("spec json carries the card", j.radius === 36 && j.shadow.y === 24 && j.shadow.blur === 60 && j.shadow.alpha === 0.45 && j.fill === "ink" && j.examples.cardAt.length === 7);

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall room checks passed");

// "Making room": a motion beat with `room: "below"` shrinks the whole footage stack to open a panel
// below the face. Contract: phantasic docs/MOTION-GRAPHICS-SPEC.md, section "Making room".
//
// THIS FILE IS THE ONE PLACE the numbers live. build.mjs imports it; the planner's validator
// (engine/planner/designer_validate.py) mirrors it, and `node scripts/lib/room.mjs` prints the constants
// plus worked examples as JSON for a golden-vector test on the Python side.
//
// The maths (canvas pixels, origin top-left, 1080 x 1920):
//
//   scale s(t)     1 outside every window; 0.73 (ROOM_SCALE) inside the held part of one.
//   origin         the canvas top centre, (W / 2, 0) = (540, 0).
//   mapping        room(q) = (540 + s * (q.x - 540), s * q.y)
//                  A box (x, y, w, h) maps to (540 + s * (x - 540), s * y, s * w, s * h).
//   composition    the room transform is OUTSIDE the camera (#room wraps #pip > #base > #snap > #push), so a
//                  face point p in the un-roomed frame lands at room(camera(p)): first the camera's own
//                  scale and translate (about its own origins, exactly as without a room), then the room scale
//                  about (540, 0). Scales multiply (camera 1.28 x room 0.73 = 0.934 on the face); the
//                  camera's translate is scaled too, because it happens before the room transform.
//                  At rest the footage covers x 145.8..934.2, y 0..1401.6.
//   window (frames) fa = floor(E(at) * fps + 0.5), fb = floor((E(to) + 0.55) * fps + 0.5)   [JS Math.round:
//                  round half UP, not Python's banker's round()], E() = output seconds of the beat's
//                  original-recording time, already rounded to the millisecond. Both ends inclusive.
//                  The camera hold uses the same [fa, fb].
//   times           tA = fa / fps, tB = fb / fps (emitted rounded to the millisecond: 0.033 for frame 1 at 30 fps;
//                  the difference is under 0.5 ms and has no effect on any frame).
//   ease            s goes 1 -> 0.73 over [tA, tA + 0.35] and 0.73 -> 1 over [tB - 0.35, tB], both power2.inOut. GSAP 3's power2 is CUBIC
//                  (power1 = quad, power3 = quart): e(p) = p < .5 ? 4 p^3 : 1 - (2 - 2 p)^3 / 2 ;  s = 1 - (1 - 0.73) * e(clamp(p, 0, 1)).
//   merging         windows (in frames) with next.fa <= current.fb are ONE window [min fa, max fb]: one shrink,
//                  one ease in, one ease out, no fight between tweens on #room.
//   captions        hidden over [tA, tB] of each merged window.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOM_SCALE = 0.73;
export const ROOM_EASE_S = 0.35;     // seconds of each ease
export const ROOM_EXIT_S = 0.55;     // the room window ends this long after the beat's `to`: the graphic exits over [to, to+0.2], then the footage grows back over [to+0.2, to+0.55]
export const ROOM_EASE_NAME = "power2.inOut";
export const ROOM_VALUES = ["none", "below"];

// The card: the shrunk footage is a rounded card with a soft shadow. Both numbers are AS RENDERED on the canvas at
// full room (scale 0.73). #room is scaled, so its CSS values are divided by ROOM_SCALE (a 36 px radius on a 0.73
// element is 26.3 px on the canvas). Both follow the scale's eased progress p = (1 - s) / (1 - ROOM_SCALE): 0 when s is
// 1, full at 0.73, same cubic ease, so nothing changes outside a window. The fill behind the card is the style's INK.
export const ROOM_RADIUS = 36;                                   // canvas px at full room
export const ROOM_SHADOW = { x: 0, y: 24, blur: 60, alpha: 0.45 };   // canvas px, black; CSS `0 24px 60px rgba(0,0,0,.45)` as rendered
export const ROOM_FILL = "ink";                                  // style colour token behind the card

// The card's edges are SNAPPED to whole canvas pixels at full room. Unsnapped, the footage covers x 145.8..934.2, y 0..1401.6, so the
// first/last pixel row and column are part-covered: they blend card with ink, and anything laid flush against the card (a text
// panel under it) adds its own part-covered row over the same pixel, which shows as a thin dark hairline along the seam and at the
// panel corners. The card is cut INWARD to the whole pixel (left ceil, right floor, bottom floor; top is the canvas edge), losing at
// most 0.6 px of footage, so every card edge lands on a pixel boundary. A panel that meets the card should start at or above
// cardBox's bottom (1401) and be whole-pixel itself. Spec JSON: cardBox, cardInset.
export function roomCardBox(W = 1080, H = 1920, s = ROOM_SCALE) {
  const ox = W / 2, x0 = Math.ceil(ox + s * (0 - ox) - 1e-9), x1 = Math.floor(ox + s * (W - ox) + 1e-9), y1 = Math.floor(s * H + 1e-9);
  return [x0, 0, x1 - x0, y1];   // x, y, w, h in canvas px
}
/** The inset of that box from the full footage rect, in #room's pre-scale px: { x: each side, b: bottom }. */
export function roomCardInset(W = 1080, H = 1920, s = ROOM_SCALE) {
  const [x, , , h] = roomCardBox(W, H, s), ox = W / 2;
  return { x: (x - (ox + s * (0 - ox))) / s, b: H - h / s };
}

/** "none" | "below" for any input; `warning` says what was wrong (undefined input is silently "none"). */
export function normalizeRoom(v) {
  if (v === undefined || v === null || v === "none") return { room: "none" };
  if (v === "below") return { room: "below" };
  return { room: "none", warning: `room ${JSON.stringify(v)} is not "none" or "below"; using "none"` };
}

export const roomOrigin = (W = 1080) => [W / 2, 0];
const jsRound = (x) => Math.floor(x + 0.5);

/** Frame window [fa, fb] (inclusive) of one beat; atOut/toOut are OUTPUT seconds (what E() returns). */
export const roomFrames = (atOut, toOut, fps) => [jsRound(atOut * fps), jsRound((toOut + ROOM_EXIT_S) * fps)];

/** Merge overlapping or touching frame windows. Input [[fa, fb], ...] in any order; output sorted, disjoint. */
export function mergeRoomFrames(wins) {
  const out = [];
  for (const [a, b] of [...wins].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b); else out.push([a, b]);
  }
  return out;
}

/** The merged windows as { fa, fb, tA, tB, easeIn:[t0,t1], easeOut:[t0,t1] } (times in seconds, unrounded). */
export function roomWindows(frameWins, fps) {
  return mergeRoomFrames(frameWins).map(([fa, fb]) => {
    const tA = fa / fps, tB = fb / fps, e = Math.min(ROOM_EASE_S, (tB - tA) / 2);
    return { fa, fb, tA, tB, easeIn: [tA, tA + e], easeOut: [tB - e, tB] };
  });
}

// GSAP 3 "power2.inOut" is the cubic in/out (checked against getComputedStyle mid-ease in motion-determinism.mjs)
const power2InOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - ((2 - 2 * p) ** 3) / 2);
const ramp = (t, [t0, t1]) => Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));

/** The room scale at output time t (seconds) for windows from roomWindows(). */
export function roomScaleAt(t, windows) {
  let s = 1;
  for (const w of windows) {
    if (t < w.tA || t > w.tB) continue;
    const p = t < w.easeOut[0] ? ramp(t, w.easeIn) : 1 - ramp(t, w.easeOut);
    s = 1 - (1 - ROOM_SCALE) * power2InOut(p);
  }
  return s;
}

const r3 = (x) => +x.toFixed(3);
/** The card's CSS on #room (pre-scale px) at progress p in 0..1: the `--room-r` variable that #room's border-radius reads, and box-shadow. */
export function roomCardCss(p = 1, W = 1080, H = 1920) {
  const k = 1 / ROOM_SCALE, ins = roomCardInset(W, H);
  // The radius rides a CSS variable (#room { border-radius: var(--room-r) }): GSAP 3.14 rounds a `border-radius` px value to a whole
  // pixel (even as a four-value string), which would step the corner through the ease; a custom property is interpolated as is.
  return { "--room-r": `${r3(ROOM_RADIUS * k * p)}px`, "--room-ix": `${r3(ins.x * p)}px`, "--room-ib": `${r3(ins.b * p)}px`, "--room-ix": `${r3(ins.x * p)}px`, "--room-ib": `${r3(ins.b * p)}px`, boxShadow: `${r3(ROOM_SHADOW.x * k * p)}px ${r3(ROOM_SHADOW.y * k * p)}px ${r3(ROOM_SHADOW.blur * k * p)}px rgba(0,0,0,${r3(ROOM_SHADOW.alpha * p)})` };
}
/** Eased progress 0..1 of the card (and of the shrink) at output time t. */
export const roomProgressAt = (t, windows) => (1 - roomScaleAt(t, windows)) / (1 - ROOM_SCALE);
/** The card AS RENDERED on the canvas at time t: corner radius px, shadow offset-y and blur px, alpha. */
export function roomCardAt(t, windows) {
  const p = roomProgressAt(t, windows);
  return { radius: ROOM_RADIUS * p, shadowY: ROOM_SHADOW.y * p, shadowBlur: ROOM_SHADOW.blur * p, shadowAlpha: ROOM_SHADOW.alpha * p };
}

/** room(q): a point already in camera-output canvas pixels -> final canvas pixels, for scale s. */
export function roomPoint([x, y], s = ROOM_SCALE, W = 1080) {
  const [ox, oy] = roomOrigin(W);
  return [ox + s * (x - ox), oy + s * (y - oy)];
}

/** A box [x, y, w, h] under room(). */
export function roomBox([x, y, w, h], s = ROOM_SCALE, W = 1080) {
  const [px, py] = roomPoint([x, y], s, W);
  return [px, py, w * s, h * s];
}

/** Everything a mirror needs, as plain JSON. */
export function roomSpecJson(W = 1080, H = 1920) {
  return {
    scale: ROOM_SCALE, origin: roomOrigin(W), easeSeconds: ROOM_EASE_S, exitSeconds: ROOM_EXIT_S, ease: ROOM_EASE_NAME,
    values: ROOM_VALUES, fill: ROOM_FILL, cardBox: roomCardBox(W, H), cardInset: roomCardInset(W, H), cardBox: roomCardBox(W, H), cardInset: roomCardInset(W, H), radius: ROOM_RADIUS, shadow: ROOM_SHADOW,
    cardCssFull: roomCardCss(1), cardCssNone: roomCardCss(0), frameRounding: "floor(x + 0.5)", canvas: [W, H],
    footageBoxAtRest: roomBox([0, 0, W, H], ROOM_SCALE, W),
    // golden vectors for a mirror's tests
    examples: {
      fps30Frames: roomFrames(12.4, 15.1, 30),
      merge: mergeRoomFrames([[10, 40], [30, 60], [60, 80], [100, 120]]),
      scaleAt: [0, 0.1, 0.175, 0.25, 0.35, 1, 3.6].map((d) => { const w = roomWindows([[30, 120]], 30); return [1 + d, roomScaleAt(1 + d, w)]; }),
      cardAt: [0, 0.1, 0.175, 0.25, 0.35, 1, 3.6].map((d) => { const w = roomWindows([[30, 120]], 30), c = roomCardAt(1 + d, w); return [1 + d, +c.radius.toFixed(4), +c.shadowY.toFixed(4), +c.shadowBlur.toFixed(4), +c.shadowAlpha.toFixed(5)]; }),
      point: { in: [540, 1317], out: roomPoint([540, 1317]) },
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(roomSpecJson(), null, 2));

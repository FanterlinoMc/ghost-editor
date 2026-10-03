#!/usr/bin/env node
// Asserts makePlacer's crop/pad coordinate mapping (A15 added the parameters; I-19's engine half
// wired build.mjs to them).
//
//   node scripts/lib/safezone.test.mjs
//
// Why this exists at all: the A1 fixture gate cannot cover it. Every fixture f01-f07 is 9:16 and
// none sets spec.format, so accuracy.py stays green whether this mapping is right or wrong - it
// never builds a non-9:16 canvas. The mapping is pure arithmetic, so it can be asserted directly
// instead, with no render and no ffmpeg.
//
// Pure in-memory fixtures: no file is read or written.
//
// The arithmetic under test, from screenFace(): with camScale == 1 (no zoom at all - zoom {} gives
// base 1, no snaps, no pushes) the camera term collapses and
//     canvasCoord = rawCoord * cropScale + cropOffset
// on both axes, which is exactly the contract prep.sh writes into build/crop-<fmt>.json.
import { makePlacer } from "./safezone.mjs";

let failures = 0;
const near = (got, want, eps = 0.01) => Math.abs(got - want) <= eps;

function check(label, cond, detail = "") {
  if (cond) console.log(`ok    ${label}`);
  else { failures++; console.log(`FAIL  ${label}${detail ? " - " + detail : ""}`); }
}

// one face sample: [t, top, bottom, left, right, eyes, mouth], in 1080x1920 source pixels
const RAW = { t: 0.5, top: 300, bottom: 900, left: 400, right: 700, eyes: 420, mouth: 820 };
const face = {
  w: 1080, h: 1920,
  samples: [[RAW.t, RAW.top, RAW.bottom, RAW.left, RAW.right, RAW.eyes, RAW.mouth]],
};
const takes = [{ start: 0, dur: 2, a: 0, b: 2, holdStart: 2, holdFrames: 0 }];

function spanFor({ W, H, platform, cropScale = 1, cropOffsetX = 0, cropOffsetY = 0 }) {
  const placer = makePlacer({
    face, takes, zoom: {}, TOTAL: 2, platform, ideal: Math.round(H * 1180 / 1920),
    H, W, cropScale, cropOffsetX, cropOffsetY,
  });
  return placer.span(0.4, 0.6);
}

// 1. The default is the identity transform. This is the regression guard that matters most: every
//    existing 9:16 project passes no crop parameters at all, and must be unaffected by A15.
{
  const s = spanFor({ W: 1080, H: 1920, platform: "instagram" });
  check("no crop parameters => identity: a face coordinate is unchanged",
        s.seen && near(s.top, RAW.top) && near(s.bottom, RAW.bottom)
        && near(s.left, RAW.left) && near(s.right, RAW.right),
        `top ${s.top} bottom ${s.bottom} left ${s.left} right ${s.right}`);
}

// 2. A real face-crop plan: the 1:1 plan prep.sh actually produced for the e2e source, verbatim -
//    {"W":1080,"H":1080,"srcW":1080,"srcH":1920,"mode":"face","scale":1,"offsetX":0,"offsetY":-187}
//    A pure vertical shift: 1:1 is the same width as the source, so only y moves.
{
  const s = spanFor({ W: 1080, H: 1080, platform: "feed", cropScale: 1, cropOffsetX: 0, cropOffsetY: -187 });
  check("mode=face 1:1 plan (scale 1, offsetY -187): y shifts by the offset, x untouched",
        near(s.top, RAW.top - 187) && near(s.bottom, RAW.bottom - 187)
        && near(s.left, RAW.left) && near(s.right, RAW.right),
        `top ${s.top} (want ${RAW.top - 187}), left ${s.left} (want ${RAW.left})`);
  check("mode=face 1:1 plan: the head lands inside the 1080-tall canvas, which is the point of A15",
        s.top >= 0 && s.bottom <= 1080, `top ${s.top} bottom ${s.bottom}`);
}

// 3. A pad plan, where scale is NOT 1: 16:9 against a portrait source letterboxes rather than
//    cropping, so every coordinate scales and then shifts. 1080x1920 contained into 1920x1080 is
//    scale 1080/1920 = 0.5625, leaving (1920 - 1080*0.5625)/2 = 656 of x padding either side.
{
  const scale = 0.5625, offX = Math.round((1920 - 1080 * scale) / 2), offY = 0;
  const s = spanFor({ W: 1920, H: 1080, platform: "widescreen", cropScale: scale, cropOffsetX: offX, cropOffsetY: offY });
  check("mode=pad 16:9 plan (scale 0.5625): both axes scale, then x shifts by the pad",
        near(s.top, RAW.top * scale + offY) && near(s.bottom, RAW.bottom * scale + offY)
        && near(s.left, RAW.left * scale + offX) && near(s.right, RAW.right * scale + offX),
        `top ${s.top} (want ${RAW.top * scale + offY}), left ${s.left} (want ${RAW.left * scale + offX})`);
  check("mode=pad 16:9 plan: the whole head fits the 1080-tall canvas",
        s.top >= 0 && s.bottom <= 1080, `top ${s.top} bottom ${s.bottom}`);
}

// 4. The failure A15 actually fixed, as arithmetic. Before A15, prep.sh's 1:1 was a CENTRED crop:
//    it took the middle 1080 rows of a 1080x1920 frame, i.e. y 420..1500, which is offsetY -420.
//    This fixture's head (source y 300..900) starts above that window, so it maps to -120 and the
//    top of the head is cut off - "1:1 and 16:9 clip the top of the head in every sample" (A15),
//    seen from the placement side rather than from face_track.py's.
//
//    A15's face-aware offset is -187 instead, chosen from the face's own vertical span, which puts
//    the same head at 113..713: fully inside the canvas. The two offsets differ by 233px of head.
//    Asserting both directions is the point - a mapping that is merely *applied* proves nothing
//    unless the unmapped case is shown to be broken.
{
  const centred = spanFor({ W: 1080, H: 1080, platform: "feed", cropScale: 1, cropOffsetY: -420 });
  check("the old CENTRED 1:1 crop (offsetY -420) clips the top of the head - A15's bug, as maths",
        centred.top < 0, `top ${centred.top} is on-canvas, so this no longer demonstrates the bug`);

  const aware = spanFor({ W: 1080, H: 1080, platform: "feed", cropScale: 1, cropOffsetY: -187 });
  check("A15's face-aware offset keeps the same head fully on canvas where centring did not",
        aware.top >= 0 && aware.bottom <= 1080 && aware.top > centred.top,
        `aware top ${aware.top} / bottom ${aware.bottom} vs centred top ${centred.top}`);
}


// ---- MULTIANGLE Gap 6: the placer consults the face of the source actually on screen ----------
//
// Two takes from two recordings, with deliberately different face geometry: source A's face is
// high and small, source B's is low and large. If the placer used one track for both - which is
// what it did before Gap 6 - the reported face for take 1 would be source A's, and the caption
// would be placed to dodge a face that is not in that footage (a B3-class defect).
{
  const takes = [
    { start: 0, dur: 2, holdStart: 0, holdFrames: 0, a: 0, b: 2, src: "assets/talk.mp4" },
    { start: 2, dur: 2, holdStart: 0, holdFrames: 0, a: 0, b: 2, src: "assets/talk-1.mp4" },
  ];
  // [t, top, bottom, left, right, eyes_y, mouth_y]
  const faceA = { w: 1080, h: 1920, samples: [[0, 200, 400, 440, 640, 260, 350], [2, 200, 400, 440, 640, 260, 350]] };
  const faceB = { w: 1080, h: 1920, samples: [[0, 900, 1500, 300, 780, 1050, 1350], [2, 900, 1500, 300, 780, 1050, 1350]] };
  const p = makePlacer({
    face: faceA,
    faces: { "assets/talk.mp4": faceA, "assets/talk-1.mp4": faceB },
    takes, zoom: {}, TOTAL: 4, H: 1920, W: 1080,
  });
  p.place(0.5, 1.5, 120);   // inside take 0 -> source A
  p.place(2.5, 3.5, 120);   // inside take 1 -> source B
  const [a, b] = p.log;
  check("Gap 6: a take from source A is placed against source A's face",
        a.face && near(a.face.top, 200, 2), `got ${JSON.stringify(a.face)}`);
  check("Gap 6: a take from source B is placed against source B's OWN face, not A's",
        b.face && near(b.face.top, 900, 2), `got ${JSON.stringify(b.face)}`);
  check("Gap 6: the two takes therefore get different caption rows",
        a.y !== b.y, `both at y=${a.y}`);

  // Without `faces`, every take falls back to the single track - the pre-Gap-6 behaviour, kept
  // asserted so the cases above cannot pass for an unrelated reason.
  const q = makePlacer({ face: faceA, takes, zoom: {}, TOTAL: 4, H: 1920, W: 1080 });
  q.place(0.5, 1.5, 120);
  q.place(2.5, 3.5, 120);
  check("Gap 6: with no per-source tracks, both takes still use the one face (old behaviour)",
        near(q.log[0].face.top, 200, 2) && near(q.log[1].face.top, 200, 2),
        `got ${JSON.stringify(q.log.map((l) => l.face && l.face.top))}`);
}

console.log(failures ? `\n${failures} failure(s)` : "\ncrop mapping and per-source faces hold");
process.exit(failures ? 1 : 0);

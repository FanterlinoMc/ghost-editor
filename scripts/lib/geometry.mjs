// build/geometry.json (references/pixel-check.md section 2.2): the build's own camera and placement truth, written
// for the pixel check so it never re-implements the placer's camera mapping (crop plan, zoom.base x snaps x pushes
// around zoom.origin) in Python. Pure: build.mjs hands it what it already resolved; nothing here reads a file.
// Additive: no other output of the build depends on it.
//
// Not modelled yet (owner answer 2, 2026-10-19), and said in the file rather than guessed: the room:"below" footage
// shrink, and any take from a source other than the primary one (MULTIANGLE Gap 6). Those output windows go in
// `faceSkip` with the reason; their face entries are null, and the pixel check reports the face rules there as
// "not checked".

const r3 = (x) => Math.round(x * 1000) / 1000;
const EPS = 1e-6;
// first output frame at or after time t (a tween that ENDS at t shows on this frame)
export const frameAtOrAfter = (t, fps) => Math.ceil(t * fps - EPS);

/** Merge [t0, t1, why] windows that touch (sorted, reasons joined). */
export function mergeWindows(wins) {
  const out = [];
  for (const [a, b, why] of [...wins].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = out.at(-1);
    if (last && a <= last[1] + EPS) { last[1] = Math.max(last[1], b); if (why && !last[2].split(",").includes(why)) last[2] += "," + why; }
    else out.push([a, b, why || ""]);
  }
  return out.map(([a, b, why]) => [r3(a), r3(b), why]);
}

/**
 * ctx: { W, H, fps, total, speech, format, platform, zones (safezone PLATFORMS[platform]),
 *        screenFaceAt (makePlacer's: t -> { src, age, face }), primarySrc,
 *        takes [{ start, dur, holdStart, holdFrames, src, a, b, ramp }] (edit seconds),
 *        roomWins [{ tA, tB }], captions [{ id, t0, t1, y, h, mode, scale, cx, text }] | null (style not described),
 *        captionStyle, capsHidden [[a, b]] (the merged #caps windows), spans [{ t0, t1, label }] (what can hide them),
 *        graphics [{ id, kind, mode, by, file, fit, opacity, box, t0, t1, L, hideCaptions, selector, inF, D, after, hard }],
 *        stills [[t0, t1, why]] (static-by-design windows besides outro and holds) }
 */
export function buildGeometry(ctx) {
  const { W, H, fps, total, speech, format, platform, zones, screenFaceAt, primarySrc, takes, roomWins = [], captions, captionStyle, capsHidden = [], spans = [], graphics = [], stills = [] } = ctx;
  const frames = Math.round(total * fps);

  // ---- face, per output frame ----
  const skip = [];
  for (const w of roomWins) skip.push([w.tA, w.tB, "room"]);
  for (const k of takes) if (k.src !== primarySrc) skip.push([k.start, k.holdStart + k.holdFrames / fps, `source ${k.src}`]);
  const faceSkip = mergeWindows(skip);
  const skipped = (t) => faceSkip.some(([a, b]) => t >= a - EPS && t < b - EPS);
  const face = [];
  for (let n = 0; n < frames; n++) {
    const t = n / fps;
    const f = skipped(t) ? null : screenFaceAt(Math.min(t, total - 0.01));
    if (!f || !f.face) { face.push([n, null]); continue; }
    const q = f.face;
    face.push([n, Math.round(q.top), Math.round(q.bottom), Math.round(q.left), Math.round(q.right), Math.round(q.eyes), Math.round(q.mouth), r3(f.age)]);
  }

  // ---- captions hidden: the merged #caps windows, each with what hides it ----
  const hiddenCaps = capsHidden.map(([a, b]) => {
    const why = spans.filter((s) => s.t0 < b && s.t1 > a).map((s) => s.label);
    return [r3(a), r3(b), [...new Set(why)].join(",")];
  });

  // ---- graphics: the window shows exactly frames [f0, f1); file frame j at output frame f0 + j ----
  const geoGraphics = graphics.map((g) => {
    const f0 = frameAtOrAfter(g.t0, fps), f1 = frameAtOrAfter(g.t1, fps);
    const srcFrames = [];
    // the <video> starts at t0 (data-media-start 0): output frame n shows the file frame whose time is at or before
    // n / fps - t0 (floor; measured on an insert that fades up from black at a t0 between two frames)
    for (let n = f0; n < f1; n++) srcFrames.push(Math.min(g.L - 1, Math.max(0, Math.floor((n / fps - g.t0) * fps + 1e-6))));
    return {
      id: g.id, kind: g.kind, mode: g.mode, by: g.by, file: g.file, fit: g.fit, opacity: g.opacity,
      box: { x: r3(g.box.x), y: r3(g.box.y), w: r3(g.box.w), h: r3(g.box.h) },
      t0: r3(g.t0), t1: r3(g.t1), f0, f1, srcFrames, hideCaptions: !!g.hideCaptions, selector: g.selector,
      // a hard show/hide (a beat, or a layer with enter/exit "none"): PX12 checks its first and last frames exactly
      hard: g.hard !== false,
    };
  });

  // ---- joins (take i starts on a cut from take i - 1) ----
  const joins = [];
  for (let i = 1; i < takes.length; i++) {
    const k = takes[i], p = takes[i - 1];
    joins.push({ t: r3(k.start), frame: Math.round(k.start * fps), take: i, src: k.src, out: r3(p.b), in: r3(k.a), outSrc: p.src,
      ...(k.ramp || p.ramp ? { ramp: true } : {}) });
  }

  // ---- windows where a frozen / black picture is by design ----
  const still = [];
  if (total > speech + EPS) still.push([speech, total, "outro"]);
  takes.forEach((k, i) => { if (k.holdFrames > 0) still.push([k.holdStart, k.holdStart + k.holdFrames / fps, `hold:${i}`]); });
  for (const g of graphics) if (g.mode === "insert" && g.after === "hold" && g.L > g.D - g.inF) still.push([g.t0 + (g.D - g.inF) / fps, g.t1, `graphic:${g.id}:hold`]);
  still.push(...stills);
  const stillOk = still.map(([a, b, why]) => [r3(a), r3(b), why]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  return {
    v: 1, W, H, fps, frames, total, speech: r3(speech), format, platform,
    zones: { top: zones.top, bottom: zones.bottom, right: zones.right, name: zones.name },
    face, faceSkip,
    captionStyle, captionsDescribed: captions !== null,
    captions: (captions || []).map((c) => ({ id: c.id, t0: r3(c.t0), t1: r3(c.t1), y: c.y, h: Math.round(c.h), mode: c.mode, scale: c.scale, cx: c.cx, text: c.text })),
    hiddenCaps,
    graphics: geoGraphics,
    joins,
    stillOk,
    darkOk: [],
  };
}

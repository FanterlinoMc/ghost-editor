// Caption placement: never on the face, always inside the platform's safe area,
// and near the ideal reading height when there is a choice.
//
// Inputs: build/face.json from face_track.py (original seconds, frame pixels),
// the takes (edit time <-> original time), and the camera: zoom.base x snaps x
// pushes, scaled around zoom.origin. The face is mapped to SCREEN pixels at every
// 0.1 s of a caption block's life and the block goes where it fits:
//   1. below the chin (the natural reading spot), as close to the ideal height
//      as the chin and the platform's bottom UI allow
//   2. above the head, under the platform's top bar
//   3. close-up fallback: just under the mouth, on a dark backing so it reads
//      over the beard or chest; never over the eyes or the mouth
// Positions only change between blocks, and small moves are held (hysteresis)
// so captions don't hop.

// Platform UI chrome at 1080x1920 (px covered by the app): measured guides for
// Reels / TikTok / Shorts. `right` is the action-button column (like, comment,
// share), which only matters for the lower half.
//
// I-19 adds 4:5, 1:1 and 16:9. Those three are not full-screen swipe players --
// there's no stories-style nav chrome baked into the frame -- so `platform`
// (which vertical app's bar to dodge) has no meaning for them; `feed` and
// `widescreen` below are the guide sets a caller should pass instead. The
// numbers are small edge margins, not app-UI cutouts, because there genuinely
// is no app UI drawn over these frames the way there is over a Reel.
export const PLATFORMS = {
  instagram: { top: 220, bottom: 420, right: 130, name: "Instagram Reels" },
  tiktok: { top: 160, bottom: 480, right: 150, name: "TikTok" },
  shorts: { top: 140, bottom: 380, right: 140, name: "YouTube Shorts" },
  all: { top: 220, bottom: 480, right: 150, name: "Reels + TikTok + Shorts" },
  // 4:5 (1080x1350) and 1:1 (1080x1080): IG/FB feed posts. No action-button
  // column (right: 0) -- that's drawn beside the post, not over it.
  feed: { top: 48, bottom: 48, right: 0, name: "Feed post (4:5 / 1:1)" },
  // 16:9 (1920x1080): YouTube/X landscape player. Controls + progress bar
  // sit at the very bottom; nothing meaningful at the top.
  widescreen: { top: 36, bottom: 96, right: 0, name: "Widescreen (16:9)" },
};

// Canonical W x H per format (I-19). scripts/prep.sh has to duplicate these by
// hand -- it's bash, this is Node, and shelling out to node from prep.sh just
// to read a constant is the exact kind of cross-runtime fragility prep.sh has
// already been burned by once (see its python3-JSON comment). Keep the two in
// sync by hand; this is the source of truth build.mjs should read from rather
// than hold its own copy of these four numbers.
export const FORMATS = {
  "9:16": { W: 1080, H: 1920 },
  "4:5": { W: 1080, H: 1350 },
  "1:1": { W: 1080, H: 1080 },
  "16:9": { W: 1920, H: 1080 },
};

/**
 * Which take owns an EDIT-timeline moment `t` - the main span first, then the hold (frozen last
 * frame), then falling back to the last take. The ownership rule `build.mjs`'s own take/hold loop
 * and this file's placer both need, so it lives here (the leaf module with no imports of its own)
 * and `sources.mjs` re-exports it rather than holding a second copy - this file cannot import FROM
 * sources.mjs without a cycle, since sources.mjs already imports FORMATS from here. `fps` defaults
 * to 30 to match this function's own prior hardcoded value; pass the real one when it might differ.
 */
export function locateTake(takes, t, fps = 30) {
  for (const k of takes) if (t >= k.start && t < k.start + k.dur) return k;
  for (const k of takes) if (t >= k.holdStart && t < k.holdStart + k.holdFrames / fps) return k;
  return takes.at(-1);
}

export function makePlacer({ face, faces = null, takes, zoom, TOTAL, platform = "instagram", ideal = 1180, gap = 36, H = 1920, W = 1080, cropScale = 1, cropOffsetX = 0, cropOffsetY = 0, crops = null, fps = 30 }) {
  // A15 / I-19: face.json's samples are always in the pixel space of the untouched (9:16)
  // frame that face_track.py actually ran on -- prep.sh's 4:5/1:1/16:9 crops don't re-run face
  // tracking, they just crop (and sometimes pad) that same frame differently per format. Map a
  // raw face.json coordinate into THIS format's canvas with canvasCoord = raw * cropScale +
  // cropOffset, matching exactly what prep.sh's scripts/prep.sh writes per format to
  // <project>/build/crop-<fmt>.json (offset <= 0 for a cropped-away margin, >= 0 for a
  // letterboxed-in one). Defaults are the identity transform, so every existing 9:16 caller
  // (which has no crop plan to read) is unaffected.
  const P = PLATFORMS[platform] || PLATFORMS.instagram;
  const safeTop = P.top, safeBottom = H - P.bottom;
  // Every guide pair above was measured against *some* canvas height. A
  // caller pairing the wrong platform key with the wrong H (e.g.
  // "instagram"'s 1920-tall guides against a 1:1 render) gets a cramped but
  // still-placeable window today (none of this file's own 24
  // format x platform combinations trip it), not a silently "fixed" one --
  // loud here, not patched, so a real misconfiguration surfaces instead of
  // shipping a caption placement nobody asked for.
  if (safeBottom - safeTop < H * 0.3) console.warn(`safezone: "${P.name}" guides leave only ${safeBottom - safeTop}px of a ${H}px-tall frame safe - check platform/H pairing`);
  const [ox, oy] = (zoom.origin || "50% 29%").split(/\s+/).map((v, i) => (parseFloat(v) / 100) * (i ? H : W));
  const base = zoom.base ?? 1;
  // camera scale at edit time t: base x current snap x push envelope
  const snaps = (zoom.snapsEdit || []).slice().sort((a, b) => a[0] - b[0]);
  const pushes = zoom.pushesEdit || [];
  const camScale = (t) => {
    let s = 1;
    for (const [at, z] of snaps) if (t >= at) s = z;
    let p = 1;
    for (const q of pushes) {
      if (t < q.a || t >= q.b + (q.down || 0)) continue;
      const rise = Math.min(1, (t - q.a) / Math.max(q.up, 1e-3));
      const fall = q.down > 0 && t > q.b ? 1 - (t - q.b) / q.down : 1;
      p *= 1 + (q.z - 1) * rise * Math.max(0, fall);
    }
    return base * s * p;
  };
  // MULTIANGLE Gap 6: which take owns this edit moment, and therefore WHICH RECORDING. Was
  // `toOrig()` returning only the mapped time; the take was already in hand and thrown away, and
  // with it the only way to know whose face is on screen. Ownership itself is `locateTake` (above
  // in this file) rather than a second copy of the same three branches - `orig` just needs one
  // more fact locateTake doesn't return: whether `t` landed in the take's MAIN span (map through
  // `a`/`start`) or its hold / the fallback-to-last-take case (hold on `b`). Re-checking that one
  // condition on the take locateTake already found reproduces the original three-branch result
  // exactly: a main-span hit recomputes the same way; a hold hit or the fallback both want `k.b`,
  // which is what the condition's false branch gives either way.
  const locate = (t) => {
    const k = locateTake(takes, t, fps);
    const orig = (t >= k.start && t < k.start + k.dur) ? k.a + (t - k.start) : k.b;
    return { k, orig };
  };
  const toOrig = (t) => locate(t).orig;
  // A face track per source. `faces` is keyed by `take.src`; `face` remains the single-source
  // input and the fallback for any source without its own track, so a reel that passes only
  // `face` behaves exactly as before. Samples are in the pixel space of the file face_track.py
  // ran on, so using one recording's track for another's takes places captions against a face
  // that is not in that footage - the B3-class defect this placer exists to prevent.
  const samplesFor = (src) => {
    const own = faces && src != null ? faces[src] : null;
    return (own && own.samples) || (face ? face.samples : []);
  };
  const faceAt = (orig, src) => {
    // nearest sample, holding the last known face across short misses
    let best = null, bd = 1e9;
    for (const s of samplesFor(src)) {
      if (s[1] == null) continue;
      const d = Math.abs(s[0] - orig);
      if (d < bd) { bd = d; best = s; }
      if (s[0] > orig + 1) break;
    }
    return bd < 1.5 ? best : null;
  };
  // MULTIANGLE Gap 6: a crop/pad plan per source, same fallback shape as `faces`/`face` above.
  // `crops` is keyed by `take.src`; the single `cropScale`/`cropOffsetX`/`cropOffsetY` remain the
  // default for a source with no plan of its own, which is also what every existing caller (none
  // of which passes `crops`) gets - so a single-source or 9:16 build is unaffected. Before this,
  // ALL sources were mapped through whichever plan `cropScale` etc. held, i.e. the first source's
  // - invisible on 9:16 (identity) and on every fixture, which is exactly why it needed care.
  const cropFor = (src) => (crops && src != null && crops[src]) || { scale: cropScale, offsetX: cropOffsetX, offsetY: cropOffsetY };
  const screenFace = (t) => {
    const { k, orig } = locate(t);
    const f = faceAt(orig, k.src);
    if (!f) return null;
    const s = camScale(t);
    const { scale: cs, offsetX: cox, offsetY: coy } = cropFor(k.src);
    // crop/pad mapping first (raw face.json pixel -> this format's canvas), then the existing
    // camera zoom transform around (ox, oy) on top, exactly as before when cropScale is 1 and
    // both offsets are 0.
    const Y = (y) => oy + s * (y * cs + coy - oy);
    const X = (x) => ox + s * (x * cs + cox - ox);
    return { top: Y(f[1]), bottom: Y(f[2]), left: X(f[3]), right: X(f[4]), eyes: Y(f[5] ?? f[1]), mouth: Y(f[6] ?? f[2]) };
  };
  const span = (t0, t1) => {
    const r = { top: 1e9, bottom: -1e9, left: 1e9, right: -1e9, mouth: -1e9, eyes: 1e9, seen: false };
    for (let t = t0; t <= t1 + 1e-6; t += 0.1) {
      const f = screenFace(Math.min(t, TOTAL - 0.01));
      if (!f) continue;
      r.seen = true;
      r.top = Math.min(r.top, f.top); r.bottom = Math.max(r.bottom, f.bottom);
      r.left = Math.min(r.left, f.left); r.right = Math.max(r.right, f.right);
      r.mouth = Math.max(r.mouth, f.mouth); r.eyes = Math.min(r.eyes, f.eyes);
    }
    return r;
  };
  // rectangles already on screen (cards), so captions can step around them
  const occupied = [];
  const clash = (t0, t1, y, h) => occupied.find((o) => t0 < o.t1 && t1 > o.t0 && y < o.y1 && y + h > o.y0);

  let prev = null;
  const log = [];
  const place = (t0, t1, h) => {
    const sp = span(t0, t1);
    const { top, bottom, mouth, eyes, seen } = sp;
    const maxY = safeBottom - h;
    // every zone this block could use, in reading-comfort order
    const opts = {}, scaleFor = {};
    if (!seen) opts["no-face"] = Math.min(ideal, maxY);
    else {
      if (bottom + gap <= maxY) opts.below = Math.max(bottom + gap, Math.min(ideal, maxY));
      if (top - gap - h >= safeTop) opts.above = top - gap - h;
      // a sliver above the head: shrink the block (down to 70%) rather than sit on the beard
      else if (top - gap - safeTop >= h * 0.7) { opts["above-compact"] = safeTop; scaleFor["above-compact"] = (top - gap - safeTop) / h; }
      // last resort: as LOW as the platform allows (chest/hands, least face covered)
      opts["lower-face"] = Math.max(safeTop, Math.min(maxY, Math.max(mouth + 60, maxY)));
    }
    // zone lock: stay in the previous block's zone while it still fits, so
    // captions don't jump between the top and the bottom of the frame
    let mode = prev && opts[prev.mode] !== undefined && prev.mode !== "lower-face" ? prev.mode
      : ["no-face", "below", "above", "above-compact", "lower-face"].find((m) => opts[m] !== undefined);
    let y = opts[mode];
    // step around a card on screen at the same time: just below it, else the other zone
    const c = clash(t0, t1, y, h);
    if (c) {
      const under = c.y1 + 24;
      if (under + h <= maxY && (!seen || under >= bottom + gap || under + h <= top - gap)) y = under;
      else {
        const alt = ["below", "above", "lower-face"].find((m) => m !== mode && opts[m] !== undefined && !clash(t0, t1, opts[m], h));
        if (alt) { mode = alt; y = opts[alt]; }
      }
    }
    // hysteresis: keep the previous height when the move would be small
    if (prev && prev.mode === mode && Math.abs(prev.y - y) < 70) {
      const ok = mode === "below" ? prev.y >= bottom + gap && prev.y <= maxY : mode === "above" ? prev.y + h <= top - gap && prev.y >= safeTop : true;
      if (ok) y = prev.y;
    }
    y = Math.round(y);
    const scale = +(scaleFor[mode] ?? 1).toFixed(3);
    prev = { y, mode };
    log.push({ t0: +t0.toFixed(2), t1: +t1.toFixed(2), y, h: Math.round(h), mode, scale, face: seen ? { top: Math.round(top), bottom: Math.round(bottom), eyes: Math.round(eyes), mouth: Math.round(mouth) } : null });
    return { y, mode, scale };
  };
  // a card (h tall, full band width) for [t0, t1]: below the chin near the
  // band height, else above the head; null when neither fits (a close-up):
  // the caller should make that beat a full-screen scene instead
  const card = (t0, t1, h, idealY = 990) => {
    const sp = span(t0, t1), maxY = safeBottom - h;
    let y = null, mode = null;
    if (!sp.seen) { y = Math.min(idealY, maxY); mode = "no-face"; }
    else if (sp.bottom + gap <= maxY) { y = Math.max(sp.bottom + gap, Math.min(idealY, maxY)); mode = "below"; }
    else if (sp.top - gap - h >= safeTop) { y = sp.top - gap - h; mode = "above"; }
    if (y !== null) occupied.push({ t0, t1, y0: y, y1: y + h });
    return y === null ? null : { y: Math.round(y), mode };
  };
  // the reaction slot (emoji / logo / meme): beside the head on the side with
  // room, else above it; null when the face fills the frame
  const slot = (t0, t1, w, h) => {
    const sp = span(t0, t1);
    if (!sp.seen) return { x: W - w - 60, y: safeTop + 20 };
    const midY = Math.max(safeTop + 10, Math.min(safeBottom - h, (sp.top + sp.bottom) / 2 - h / 2 - 120));
    if (W - P.right - sp.right >= w + 20) return { x: Math.round(Math.min(W - P.right - w - 10, sp.right + (W - P.right - sp.right - w) / 2)), y: Math.round(midY) };
    if (sp.left - 40 >= w + 20) return { x: Math.round((sp.left - w) / 2), y: Math.round(midY) };
    if (sp.top - gap - h >= safeTop) return { x: Math.round(W / 2 - w / 2), y: Math.round(sp.top - gap - h) };
    return null;
  };
  return { place, card, slot, span, log, platform: P, safeTop, safeBottom, sidePad: P.right };
}

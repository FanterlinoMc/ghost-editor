// Caption font guard: a caption group whose OWN transform is tweened (the Broadsheet "clipping" pop-in,
// ft("#cgN", { scale: 0.9 }, ...)) must be first read by GSAP after its webfont has loaded, or the render is not
// deterministic.
//
// Why: .cap-group is centred by CSS (left: 50%; transform: translateX(-50%)). When GSAP first touches the
// group's transform it reads the COMPUTED matrix, so the -50% arrives as pixels, and it guesses
// "this was -50%" only if Math.round(offsetWidth / 2) === Math.round(-x). The renderer seeks the timeline
// (and so GSAP parses every group, all baselines sit at t=0) as soon as the page is up, which can be
// BEFORE the caption font has loaded. The group is then laid out in the fallback font; if the guess
// misses (a sub-pixel rounding, a tilt's cos makes it likelier) the fallback half-width is baked in as a
// fixed px translate for the rest of the render. When the webfont arrives the box grows, but stays
// pinned at the old offset: measured on a Gloock reel, 473 -> 550 px wide, the box drawn 38.5 px right
// of centre. Whether the font beat the first seek is a race per Chrome worker, so the same index.html
// rendered differently run to run (7 of 10 renders differed, in 1-4 caption blocks each).
//
// The guard (emitted only when some tween targets a caption group itself, see needsCaptionFontGuard):
// before any tween is added it records each group's own inline transform properties; it asks
// document.fonts to load every font its text uses; once those loads settle it puts the recorded
// properties back on every group GSAP has already parsed, makes GSAP re-read it (now in the real font:
// exactly what a render whose font won the race read), and re-renders the timeline at its current time.
// The renderer waits for document.fonts.ready before its first capture, and these loads are part of
// that set, so the re-read lands before any frame is taken.

// a tween whose target is a caption group element itself (#cg3), not one of its words (#cg3w1)
const GROUP_TWEEN = /(?:\bft|\btl\.\w+)\("#cg\d+"/;
export const needsCaptionFontGuard = (tlLines) => tlLines.some((l) => GROUP_TWEEN.test(l));

// Runs in the page (emitted via toString); also called directly by the unit test with stubs.
export function captionFontGuard(tl, gsap, doc) {
  const PROPS = ["transform", "rotate", "scale", "translate"];  // the inline properties GSAP folds into its own transform
  const groups = Array.from(doc.querySelectorAll(".cap-group"));
  const kept = groups.map((el) => PROPS.map((p) => el.style[p] || ""));
  const fonts = new Map();
  for (const el of groups) for (const n of [el, ...el.querySelectorAll("*")]) {
    const cs = doc.defaultView.getComputedStyle(n);
    const f = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    fonts.set(f, (fonts.get(f) || "") + (n.textContent || ""));
  }
  const loads = Array.from(fonts, ([f, text]) => doc.fonts.load(f, text).catch(() => null));
  return Promise.all(loads).then(() => {
    let n = 0;
    groups.forEach((el, i) => {
      if (!el._gsap || !("x" in el._gsap)) return;  // not parsed yet: its first read will see the loaded font
      PROPS.forEach((p, j) => { el.style[p] = kept[i][j]; });
      gsap.getProperty(el, "x", undefined, true);    // uncache: re-read the transform from the DOM
      n++;
    });
    if (n) tl.render(tl.totalTime(), true, true);    // force: put the timeline's values back on the re-read groups
    return n;
  });
}

export const captionFontGuardJs = () => `(${captionFontGuard.toString()})(tl, gsap, document);`;

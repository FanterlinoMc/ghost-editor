// Where a caption group must stop: at the end of the take its last word is spoken in (the take's
// frozen hold after it included). Takes are laid end to end, so a group left to run on past that
// point is drawn over the NEXT clip: a phrase that ends 0.3 s after the last word spilled into a
// photo that started 0.03 s later. `takes` are build.mjs's takes (start, dur, holdStart, holdFrames
// in output seconds / frames); `t` is an output second.

/** The output second the take containing `t` ends (its hold included), or `fallback` when `t` is in none. */
export function takeEndAt(takes, fps, t, fallback) {
  for (const k of takes) {
    const end = k.holdStart + (k.holdFrames ?? 0) / fps;
    if (t >= k.start - 1e-6 && t < end - 1e-6) return end;
  }
  return fallback;
}

// The engine's one weak-word list (caption-weak.json), for JS: WEAK, SWEAR and NEVER_KEY (their union) as Sets.
// Python planners read the same file through scripts/caption_weak.py. loadWeak() THROWS on a missing key, an empty
// list or a non-word entry: an empty guard refuses nothing and reads as a pass everywhere else (CP3, 25 Oct).
import fs from "node:fs";
const WORD = /^[a-z]+(?:'[a-z]+)?$/;
export function loadWeak(file = new URL("./caption-weak.json", import.meta.url)) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = {};
  for (const key of ["weak", "swear"]) {
    const xs = data && data[key];
    if (!Array.isArray(xs) || xs.length === 0) throw new Error(`${file}: \`${key}\` must be a non-empty list (an empty guard refuses nothing)`);
    const bad = xs.filter((w) => typeof w !== "string" || !WORD.test(w));
    if (bad.length) throw new Error(`${file}: \`${key}\` has entries that are not lower-case bare words: ${bad.slice(0, 5)}`);
    out[key] = new Set(xs);
  }
  return out;
}
const { weak, swear } = loadWeak();
export const WEAK = weak;
export const SWEAR = swear;
export const NEVER_KEY = new Set([...weak, ...swear]);

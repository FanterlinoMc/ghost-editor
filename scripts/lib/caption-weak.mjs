// The engine's one weak-word list (caption-weak.json), for JS: WEAK, SWEAR and NEVER_KEY (their union) as Sets.
// Python planners read the same file through scripts/caption_weak.py.
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(new URL("./caption-weak.json", import.meta.url), "utf8"));
export const WEAK = new Set(data.weak);
export const SWEAR = new Set(data.swear);
export const NEVER_KEY = new Set([...data.weak, ...data.swear]);

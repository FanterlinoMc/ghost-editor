// mac-56: the emoji advance the caption model reserves (caption-metrics EMOJI_EM), per render host.
//
// The build is browserless and cannot know which host will render, so the model reserves EMOJI_EM = 1.5 em per emoji,
// the bound over every platform measured (Apple 1.0, Noto 1.248, Segoe 1.373). A host may opt into its own, tighter
// value with two deploy settings, both written from ONE measurement on that host (scripts/emoji-advance.mjs):
//   CAPTION_EMOJI_EM     the value to reserve, em
//   CAPTION_EMOJI_STAMP  the stamp file emoji-advance.mjs --write produced: { advance, font, sha256, chrome }
// The failure direction is clipped text, so the value is used ONLY when every guard holds, else 1.5 and a warning:
//   - it is a number, at least the stamp's measured advance;
//   - the stamp is readable, and the font file it names still exists with the same sha256 (a base-image font update
//     invalidates the number loudly instead of silently).
// Unset CAPTION_EMOJI_EM: 1.5 and no warning (every existing deployment builds exactly as before).
import fs from "node:fs";
import crypto from "node:crypto";
import { EMOJI_EM } from "./caption-metrics.mjs";

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** -> { em, source: "default" | "host", warning: string | null } */
export function resolveEmojiEm(env = process.env, { hash = sha256 } = {}) {
  const raw = env.CAPTION_EMOJI_EM;
  if (raw === undefined || String(raw).trim() === "") return { em: EMOJI_EM, source: "default", warning: null };
  const fall = (why) => ({ em: EMOJI_EM, source: "default", warning: `CAPTION_EMOJI_EM=${raw}: ${why}, so captions reserve ${EMOJI_EM} em per emoji (measure this host: node scripts/emoji-advance.mjs --write <stamp>)` });
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return fall("not a positive number");
  if (!env.CAPTION_EMOJI_STAMP) return fall("CAPTION_EMOJI_STAMP is not set");
  let stamp;
  try { stamp = JSON.parse(fs.readFileSync(env.CAPTION_EMOJI_STAMP, "utf8")); } catch (e) { return fall(`the stamp ${env.CAPTION_EMOJI_STAMP} cannot be read (${e.code || e.name})`); }
  if (!(Number.isFinite(stamp?.advance) && stamp.advance > 0) || typeof stamp.font !== "string" || typeof stamp.sha256 !== "string") return fall("the stamp has no advance, font and sha256");
  if (!fs.existsSync(stamp.font)) return fall(`the measured emoji font ${stamp.font} is gone`);
  if (hash(stamp.font) !== stamp.sha256) return fall(`the emoji font ${stamp.font} changed since it was measured`);
  if (v < stamp.advance) return fall(`below this host's measured advance ${stamp.advance} em`);
  return { em: v, source: "host", warning: null };
}

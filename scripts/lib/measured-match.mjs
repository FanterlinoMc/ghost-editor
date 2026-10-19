// Byte-identity for files that carry a MEASURED value (scripts/byte-identity.mjs).
// sfx_events.json carries voiceP95, a level measured from the test clip, whose AAC audio is encoded and then decoded and
// resampled by whichever ffmpeg the machine has. Different ffmpeg versions give slightly different samples, so the
// measurement moves by a few thousandths of a dB (macOS ffmpeg 7.1.1: -17.735 on the noface reel, golden -17.731).
// Everything else in the file must stay byte-identical: the file matches when putting back SOME voiceP95 within
// VOICE_TOL_DB of the measured one reproduces the golden sha256 exactly. Owner decision 19 Oct 2026: a tolerance,
// no re-recorded hashes.
import crypto from "node:crypto";

export const VOICE_TOL_DB = 0.05;
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

// text: the file as built; goldenHash: its recorded sha256. Returns a short note when it matches within tolerance, else null.
export function measuredMatch(text, goldenHash, tolDb = VOICE_TOL_DB) {
  const m = text.match(/"voiceP95": (-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const got = Number(m[1]);
  for (let i = 0; i <= Math.round(tolDb * 1000); i++) {
    for (const v of i ? [got - i / 1000, got + i / 1000] : [got]) {
      const golden = Number(v.toFixed(3));
      if (sha(text.replace(m[0], `"voiceP95": ${JSON.stringify(golden)}`)) === goldenHash) return `voiceP95 ${got} vs golden ${golden}, tolerance ${tolDb} dB`;
    }
  }
  return null;
}

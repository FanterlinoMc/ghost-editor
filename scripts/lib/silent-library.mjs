// A library root with NO licensed media, for the gate: byte-identity.mjs and the build tests that assert the
// shipped state ("music ... not on disk", "sound(s) skipped") point PHANTASIC_LIB here, so a developer whose
// library/ has restored sounds or packs still gets the same result as CI. (keynote-3, a golden style, turns
// packs.editorsinventory on through keynote, so a restored library/packs would move the golden reels too.)
//
// library/sfx and library/music are rebuilt with their non-audio files only (manifest.json, timing.json, ...),
// library/packs is left out, and every other entry of library/ (art, memes, gm-objects, ...) is linked, not copied (a junction on Windows, which
// needs no admin rights). Made once per process in the OS temp folder and removed when the process exits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REAL_LIBRARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "library");
export const AUDIO_RE = /\.(wav|mp3|m4a|aac|ogg|flac|part)$/i;
let made = null;

export function silentLibrary(src = REAL_LIBRARY) {
  if (made) return made;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "silent-library-"));
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name), to = path.join(root, e.name);
    if (e.name === "packs") continue;
    if (e.isDirectory() && (e.name === "sfx" || e.name === "music")) {
      fs.mkdirSync(to);
      for (const f of fs.readdirSync(from, { withFileTypes: true })) if (f.isFile() && !AUDIO_RE.test(f.name)) fs.copyFileSync(path.join(from, f.name), path.join(to, f.name));
    } else if (e.isDirectory()) fs.symlinkSync(path.resolve(from), to, process.platform === "win32" ? "junction" : "dir");
    else fs.copyFileSync(from, to);
  }
  // unlink the links first: a recursive delete must never follow one into the real library
  process.on("exit", () => {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isSymbolicLink() || (process.platform === "win32" && fs.lstatSync(path.join(root, e.name)).isSymbolicLink())) fs.unlinkSync(path.join(root, e.name));
      fs.rmSync(root, { recursive: true, force: true });
    } catch { /* temp folder: best effort */ }
  });
  made = root;
  return root;
}

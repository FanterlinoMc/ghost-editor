# Where the library's sounds and packs may come from

This repository is public. It keeps manifests and metadata only; no audio file and no asset pack is ever
committed (`.gitignore` covers every audio extension in `library/sfx/` and `library/music/`, and all of
`library/packs/`). A deployment restores them from licensed sources outside git.

## The Mixkit entries are records only

`library/sfx/manifest.json` (48 entries, each with a `mixkit_id`) and `library/music/manifest.json`
(13 entries, each with a Mixkit `url`) describe the sounds the kit was first designed around. They stay
because styles, `timing.json` and the tests name these ids, but **their audio is not fetched, restored
or shipped by anything in this project.**

A licence check on 19 Oct 2026 concluded:

- **Mixkit music:** not OK for this use.
- **Mixkit sound effects:** unresolved. The licence forbids redistributing the files "in a tool or
  template" and scripted mass downloads, which needs a lawyer's reading before any use.

So do not run `scripts/sfx_fetch.py` or `scripts/library_restore.py`: both still download from Mixkit,
and both rewrite `manifest.json`. They are kept only until the engine retires them.

## What may ship

A sound is playable when its manifest entry's `file` exists in `library/sfx/` (or `library/music/`).
The licensed source for this project is an asset pack whose creator gave written permission to use and
include it, restored by the deployment into `library/packs/<pack>/` (overlays, transitions) and, for
sounds, processed into `library/sfx/` under the engine's ids. A sound mapped onto an existing id gets
its own measured `duration`, `peak_db` and `timing.json` row, never the Mixkit values.

`node scripts/sound_audit.mjs --coverage` lists which ids have a file on this machine;
`--audit` lists ids the styles name that no manifest has.

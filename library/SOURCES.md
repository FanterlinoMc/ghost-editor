# Where the library's sounds and packs may come from

This repository is public. It keeps manifests and metadata only; no audio file and no asset pack is ever
committed (`.gitignore` covers every audio extension in `library/sfx/` and `library/music/`, and all of
`library/packs/`). A deployment restores them from licensed sources outside git.

## The manifest entries are id records with no source

`library/sfx/manifest.json` and `library/music/manifest.json` keep the ids the styles, `timing.json`, the engine
and the tests name. Every entry's `source` is `"none (needs a licensed source)"`: no entry carries a download URL,
a licence or a provenance of its own, and **nothing in this project fetches, restores or ships their audio.**
An id the engine plays that has no file yet (for example the paper and pen sounds, `duration: null`) is listed by
`scripts/missing_assets.mjs` as a missing source; the build skips it with a warning (or plays the style's `sfxFallback`) until a licensed file is added.

Mixkit is not used, for anything (decided 19 Oct 2026: its music licence does not cover this use, and its sound
effects licence forbids redistribution in a tool or template). `scripts/no-mixkit-fetch.test.mjs` fails if a
download path or a Mixkit record comes back.

## What may ship

A sound is playable when its manifest entry's `file` exists in `library/sfx/` (or `library/music/`).
The licensed source for this project is an asset pack whose creator gave written permission to use and
include it, restored by the deployment into `library/packs/<pack>/` (overlays, transitions) and, for
sounds, processed into `library/sfx/` under the engine's ids. A sound mapped onto an existing id gets
its own measured `duration`, `peak_db` and `timing.json` row (`scripts/sfx_index.py`), and its `source` names the pack
as `"licensed pack: <name>"`, where `<name>` is the pack's name in lower-case letters, digits and hyphens only
(`[a-z0-9][a-z0-9-]*`: no URL, no rip id). `scripts/export_public.py` refuses to export a manifest entry whose `source` is anything
else than that or `"none (needs a licensed source)"`.

`node scripts/sound_audit.mjs --coverage` lists which ids have a file on this machine;
`--audit` lists ids the styles name that no manifest has.

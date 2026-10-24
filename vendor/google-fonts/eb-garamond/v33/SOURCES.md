# EB Garamond (v33), Google Fonts

| | |
|---|---|
| Files | `fonts.css` = the response of `https://fonts.googleapis.com/css2?family=EB%20Garamond:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700` (no `text=`), fetched 2026-10-24 with HyperFrames 0.8.81's user agent (`WOFF2_USER_AGENT`, Chrome 131), byte for byte; `files/` = the 14 woff2 files it names (7 subsets x roman / italic, variable weight), byte for byte |
| Why | HyperFrames 0.8.81's compiler maps a system family a page names (`Georgia` -> EB Garamond, `Arial` / `Helvetica` -> Inter, ...) onto its bundled faces (EB Garamond 400 / 700 roman, Inter 400 / 700 / 900, latin only) and asks this URL for the rest: italics, other weights, other scripts. Every shipped style makes the request (measured on all 96, 2026-10-24). When Google did not answer, a `Georgia` italic script keyword rendered in a different face and moved its line; `scripts/vendor-offline.cjs` now answers from here, and the result is frame-identical to a render that got Google's answer (90 of 90 frames, editorial + script keywords) |
| sha256 | in `vendor/manifest.json` (`googleFonts`), per file, checked by the preload on every request |
| Licence | SIL Open Font License 1.1, see `OFL.txt` (the same file as `templates/fonts/LICENSE-EBGaramond.txt`) |
| Upgrading | re-fetch the URL above with the same user agent, download every `fonts.gstatic.com` URL it names, update `vendor/manifest.json` (version, css, cssSha256, files) |

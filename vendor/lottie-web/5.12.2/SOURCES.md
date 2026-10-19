# lottie-web 5.12.2 (light player)

| | |
|---|---|
| File | `lottie_light.min.js` = `package/build/player/lottie_light.min.js` from the npm package, byte for byte |
| Fetched with | `npm pack lottie-web@5.12.2` (2026-10-19), into a temp dir, no install |
| Tarball | https://registry.npmjs.org/lottie-web/-/lottie-web-5.12.2.tgz, sha256 `8600b50a5cecc3d327f32e62f744812f4dbe9279469280117d7e64f59fb343c2`, npm integrity `sha512-uvhvYPC8kGPjXT3MyKMrL3JitEAmDMp30lVkuq/590Mw9ok6pWcFCwXJveo0t5uqYw1UREQHofD+jVpdjBv8wg==` |
| sha256 of `lottie_light.min.js` | `23cd2c01be3d4da8bb664645d03afaff40879c62dc5f8dfe075ab3aa35c108f3` (168 236 bytes) |
| Same bytes as | https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie_light.min.js (the URL `build.mjs` writes when a reel has a Lottie element; same sha256, checked 2026-10-19) |
| Licence | MIT (Bodymovin / Airbnb), see `LICENSE.md`, shipped beside the file |
| Why the light build | SVG renderer only and no expression engine (no `eval`, no `new Function`): the page never runs code from an animation file. `references/reel-json.md`, "Lottie element" |

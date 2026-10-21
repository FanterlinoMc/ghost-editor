# reel.json: the whole edit in one file

`build.mjs` turns this into `index.html` (HyperFrames). Every time is an
ORIGINAL-recording second, as printed by `transcribe.py`, except `"end"`
(the last frame) and `"outro+N"` (N seconds into the frozen outro). A time
that falls in cut material fails the build with the beat's name. `"hold:1+0.7"` is 0.7 s into the
hold after take 1. Any on-screen text with Cyrillic switches the card font from Geist to Inter.

```jsonc
{
  "title": "why nobody cares about your launch",
  "source": "assets/talk.mp4",          // prep.sh output (voice at -16 LUFS)
  "words": "build/words.whisper.json",  // transcribe.py output
  "fps": 30,
  "outro": 3,                           // seconds of frozen last frame under the end card
  "takes": [                            // edit order; a = first word - 0.10..0.15, b = last word + 0.20..0.30
    { "a": 6.58, "b": 10.40, "note": "hook, 2nd take" },
    { "a": 10.76, "b": 14.42, "hold": 0.8 },  // hold: frozen last frame, no voice, AFTER the take: air for a meme on a
    { "a": 15.0, "b": 18.6, "transition": "blur" }  // tightly cut recording. Address it as "hold:<take index>+<seconds>"
  ],                                          // transition (I-17): the join FROM the previous take blurs or whips instead
                                               // of a hard cut. "blur" | "whip"; omit for a cut (default). No SFX - never
                                               // on a take right after a `hold` (nothing to dissolve from; build.mjs dies).
  "zoom": {
    "origin": "50% 29%",                // the face; move it if the face sits elsewhere
    "snaps": [[10.76, 1.1], [16.30, 1.0]],   // instant reframes: every cut + most sentence starts, 1.0/1.1, 1.12 on a punchline
    "pushes": [{ "at": 19.8, "z": 1.1, "up": 0.4, "until": 22.4, "down": 0.2 }],  // slow push-ins, 4-6 per reel, no overlaps; until "end" holds through the outro
    "snapSfx": false                    // true = quiet whoosh on every snap; default off (dry cuts read more premium)
  },
  "captions": {
    "style": "house",                   // house: Arial bold 56, white, black outline, lower third. "pill": Geist 66 on a dark pill.
                                        // "box" (The Closer): whole phrase on a solid accent box. "condensed" (The Headline): tall
                                        // tracked caps. "sessions" (Alif / Editorial Collage): translucent word-boxes revealed one at a time.
                                        // "clipping" (Broadsheet, R1b): white serif on a black paper strip, like a pasted clipping;
                                        // "captions.tilt" (degrees) alternates each block's rotation.
                                        // "serif" (The Monk): small lowercase serif, no pop, no box.
                                        // "none": the recording already has burned-in captions (never stack two caption layers)
    "group": 3,                         // words per caption (also breaks on , . ? ! and on pauses > 0.6 s)
    "highlight": null,                  // e.g. "#FFD166" to colour the spoken word; null = scale-pop only
    "size": 56,
    "fixes": { "Jithub": "GitHub" }     // whisper word -> correct word, case-insensitive
  },
  "layout": { "cardY": 990, "capBottom": 450,     // card band top, caption bottom margin (IG UI covers the bottom 450)
              "slotY": 240,                        // reaction slot top (emoji / logo / meme next to the head)
              "compact": false },                  // smaller cards for a narrow band, e.g. under burned-in captions
  "mix": { "roleDb": { "ui": -14, "whoosh": -12, "impact": -8, "meme": -3 } },  // SFX peak vs voice p95 peak, dB
  "beats": [ /* see below */ ],
  "layers": [ /* optional, output seconds: PiP, B-roll, logos, text - see Layers */ ],
  "sfx": [{ "at": 24.4, "id": "record-scratch", "db": 0, "lead": 0 }]   // extra hand-placed sounds
}
```

## Blank projects and sources without speech

- `"origin": "blank"` (optional, the only value) marks a project started without a recording. With it,
  `"takes": []` builds a valid 1 s black page (so a preview has something to show) plus empty
  `build/*.json`; without it an empty reel still fails (`reel.json has no takes`). It does nothing once
  there are takes, and the planner carries it through a re-plan.
- Several recordings: set `src` on a take (`assets/talk-1.mp4`, ...; `prep.sh <file> <proj> 9:16 <N>`
  writes `assets/talk-N.mp4`). `prep.sh` accepts a video with sound, a video with NO audio (a silent AAC
  track is added), or a still image (a 30 s clip), and writes `assets/talk-N.json`:
  `{ "kind": "video" | "silent" | "image", "duration": s, "hasAudio": bool, "speechLikely": bool }`.
  `speechLikely` (mean volume >= -45 dB, max >= -25 dB, >= 25 % of the file above -35 dB) tells the
  caller whether transcribing is worth it.
- `words` may be left out, and a source may have no `build/words-N.whisper.json` or
  `build/face-N.json`: its takes get no captions, and it is framed as "no face" (the caption/card
  placer uses its no-face positions). A `words` path that is named but missing is still an error.
- **Beats in a multi-source reel.** A beat's `at`/`to` (and its inner line/item times) are seconds of ONE
  recording. Add an optional `"src": "assets/talk.mp4"` to the beat (same value as a take's `src`) to say
  which; it then resolves like `{src, t}`. A beat without `src` and a time that only one source covers
  resolves as before. A bare time that two or more sources cover (every source starts at 0 s) no longer
  drops the beat or fails the build: it resolves to the PRIMARY source (`spec.source`, the recording the
  transcript belongs to) if that covers it, else the first covering take in output order, and the build warns
  `... is in N sources ...: used <src>`. A `src` that is not a source of the reel drops the beat with a warning.
  Snaps, pushes and other non-beat times still need the explicit `{src, t}` when ambiguous.
- **`type: "motion"` beats are placed in any style when the beat is `"by": "user"` or the reel is
  `"origin": "blank"`**; otherwise a motion beat needs the style to set `designer: true`, and is dropped with
  a warning if not. In a multi-source or blank-origin reel the preview timeline is padded to the full output
  length (`tl.duration()` equals `data-duration`), so a player never stops at the last tween.

## Layers (`layers[]`, output seconds)

Everything else in reel.json is in SOURCE seconds and moves with its words when a take is cut. A **layer**
stays at a point of the FINISHED video: a picture-in-picture, B-roll over the voice, a logo, a sticker, a text
box, or a graphic on a clip with no speech. The planner never writes layers (`"by": "user"`); it carries them
through a re-plan untouched. A reel without `layers` builds byte-identically to one built before the field
existed (`scripts/byte-identity.mjs`).

```jsonc
"layers": [
  { "id": "pip", "kind": "video", "src": "assets/broll-2.mp4",
    "anchor": { "take": 3, "offset": 1.2 },     // OR  "pin": true, "at": 12.5
    "dur": 4.0, "in": 0.0,                       // seconds on screen; seek offset into the video
    "box": { "x": 640, "y": 120, "w": 380, "h": 676 }, "fit": "cover", "radius": 24, "shadow": true,
    "z": 2, "opacity": 1, "audio": "off",        // "off" | "duck" | "mix"
    "enter": "pop", "exit": "fade",              // enter: fade | slide-up | pop | none   exit: fade | none
    "overCaptions": false, "by": "user" }
]
```

- **Timing.** `pin: true` means `at` is absolute output seconds and nothing can move it. Otherwise
  `anchor: { take, offset }` places the layer `offset` seconds into take `take`'s stretch of the finished video
  (its hold included), resolved AFTER the take layout, so trimming an earlier take slides the layer with its take.
  A bare `at` with no anchor is read as pinned. Times are clamped to the reel's length (a warning); a layer
  shorter than 0.1 s once clamped is dropped (a warning). The build dies on a take index out of range, a missing
  `dur`, a bad `box` or a `src` that is not a file inside the project.
- **`kind`.**
  - `video` and `image`: a positioned `<video>` / `<img>` (`src` is a path inside the project, any folder;
    `fit` is `cover` or `contain`; `in` seeks into the video; a video longer than its file is shortened with
    a warning). `audio`: `off` (muted, the voice keeps playing), `mix` (the video's own sound plays with the
    voice), `duck` (as `mix`, and the main track's volume drops to 0.25 under the layer, 0.15 s ramps). A video
    with no audio stream ignores `mix`/`duck` with a warning.
  - `logo`: an image with defaults: `pin: true`, `at: 0`, `dur` to the end of the reel, `fit: contain`, and when
    `box` is left out a 200 px square at the top right (`{x: W-260, y: 96, w: 200, h: 200}`).
  - `text`: a styled box: `text` (up to 200 characters), `font` (one of the motion fonts; default the reel's
    UI font), `size` (default 64), `weight` (default 700), `color` (`#rrggbb[aa]` or `accent|ink|paper`),
    `align` (`left|center|right`), `bg` (an optional backing colour; the box then gets padding).
  - `motion`: `elements` and `tweens` in exactly the format of a motion beat (see below), compiled by the same
    `compileMotion`, but timed by the layer: tween times are seconds from the layer's start and the beat's 0.6 to
    8 s limit does NOT apply (a layer may run to the reel's length). Element coordinates are canvas coordinates;
    `box` is ignored. `room` is never honoured and a layer's own `exit` runs on the whole graphic.
    `hideCaptions: true` (`motion` and `text` layers) hides the captions while the layer is up, as it does on a
    beat; edit_truth.json's layer entry carries `hideCaptions: true` then.
  - `graphic`: a Prompt Motion HTML graphic pre-rendered to its own video (PM3); see "Prompt Motion graphic" below.
- **Where it sits.** Above the footage and the beats' `.layer` band (z 3), below the captions (z 8), unless
  `overCaptions: true` (then above them). Within one band, ordered by `z` (0 to 99), ties by array order.
- **Enter and exit** are explicit `fromTo` tweens with `force3D: false`, 0.3 s (a third of the layer if it is
  shorter). `fade` and `none` also carry `y: 0` so the box's transform never depends on history.
- **The box may hang off the canvas** (a sticker over an edge) but the validator requires at least 20 % of it to
  show. A reel with NO takes at all (a blank project before its first clip) builds only the black 1 s page: its layers are
  ignored, with a warning, pinned or not. Layers need at least one take; once there is one, a layer on a clip
  with no speech is just a layer (anchored to that take, or pinned).
- **Handles for live editing** (the studio changes these in the preview iframe, then writes reel.json and
  rebuilds): `[data-layer-id="<id>"]` is the layer's wrapper (also `data-layer-kind`); `[data-layer-box="<id>"]`
  is the box inside it (inline `left/top/width/height`, the element to move and resize; for `motion` it is the
  whole canvas); `[data-layer-text="<id>"]` the text of a `text` layer; `[data-el-id="<element id>"]` each element
  of a `motion` layer (inside its wrapper). Beats' elements do NOT carry `data-el-id`.
- **`edit_truth.json`** gains `layers: [{ id, kind, start, end, z, pin, audio?, overCaptions? }]` (resolved output
  seconds, anchors applied) only when the reel has layers; nothing else in it changes.
- **Sections** (`build/sections.json`): a layer's span counts like a beat's, so a section boundary never falls
  inside a layer. In a section build only the layers that start inside the section are emitted. The resolved layer is part of the hash of the section it starts in (`sections.json` lists it under `layers`, only when the reel has any), so editing a layer re-renders that one section.
- The validator (`engine/planner/validate.py`, `layer_problems`) has a check for every `die()` above. A scoped
  re-cut keeps `layers` as written, so an `anchor.take` index is NOT renumbered if the re-cut changes how many
  takes there are.

## Beats

All beats take `at`, `to` (optional; default 2.5 s, meme 1.8 s) and `sfx`
(optional): omit for the default, a kit id or list of ids to override,
`"none"` for silence. Card beats live in the band under the chin; `emoji`,
`logo` and `meme` share the reaction slot next to the head (one at a time,
the build warns on a double booking).

| type | fields | default sound | use when the speaker says |
|---|---|---|---|
| `big` | `text`, `sub`, `count` (count up a number) | whoosh-cine + impact (text slam) | a number, a duration, a claim they would put on a website |
| `chips` | `items: [{text \| icon \| src, label, bg, fg, invert, at}]` | pop per chip (round-robin) | a list of names or numbers, one chip per spoken word |
| `strike` | `text`, `strikeAt` | whoosh | "not X", a myth, a claim they dismiss |
| `quote` | `header`, `lines: [{text, at, big}]` | impact on the `big` line | what someone told them |
| `list` | `lines: [{text, at}]`, `stamp`, `stampAt`, `stampSfx` | pop per line, impact + buzzer on the stamp | a list they then dismiss |
| `emoji` | `emoji`, `x`, `y` | pop | a feeling (push in on the speaker at the same time) |
| `logo` | `icon` (simple-icons slug) or `src`, `bg`, `invert` | pop | a product or company that should land alone |
| `meme` | `id` (library), `audio` (false = mute the clip's own sound), `in` (start later in the clip), `w`, `x`, `y`, `tilt`, `db` | clip: its own audio; image: its `sfx` or vine-boom | a punchline, a reaction, a wait. ON or just after the punchline word, never before |
| `endcard` | `title`, `line`, `url` (usually `at: "outro+0"`) | whoosh | the close |
| `endcard` + `variant: "caps"` | `title` (`\|` = line break), `accent`, `font` (`"serif"` = italic Instrument Serif that keeps its case, `"mono"`), `size`, `y`, `bg` (`"black"` default, `"none"` = a soft band over the picture, `"smoke"`), `arrow`, `fade`, `color`, `instant` | tick-1 (no arrow) / ding-1 | a chapter card ("I.  Home") or a letter-spaced caps call to action. Opt-in port of Ahmed's Empire / Noir card; hides the captions while it is up |
| `nametag` | `name`, `title`, `subtitle`, `x`, `y`, `nameSize`, `titleSize`, `color`, `wipe`, `wipeDur` | whoosh (`sound.nametag: false` to silence) | a name + title card in the first few seconds (Alif). `spec.nametagStyle: "byline"` (Broadsheet) swaps it for a newspaper byline - "BY NAME" in spaced caps, an italic outlet/beat line, a brand-colour rule - same fields |
| `icon` | `name` (a Lucide icon slug, lucide.dev, fetched at build time), `x`, `y`, `ink` | ding-1 | a named concept the speaker made concrete ("working towards" -> `signpost`) |
| `slam` | `text`, `pre`, `post`, `size` (auto-fits the width) | burn-whoosh-fast | a type-only pattern break: the footage dims and blurs, one huge serif word (`text`) lands on the charged word as it is spoken, with an optional small line above (`pre`) or below (`post`). Captions hide during it. Once per video (Editorial Collage / R1b) |

`icon` (the `logo` beat) slugs come from simpleicons.org (fetched at build time, CC0). The `icon` **beat type** above fetches from lucide-static instead.

## Style, platform, look (top level)

- `style`: a preset from `styles/` (see `references/styles.md`); reel.json overrides it.
- `platform`: `instagram` (default), `tiktok`, `shorts` or `all`. It sets the safe area captions and cards stay inside.
- `sfxProfile`: `restrained` (structural hits only), `standard`, `rich` (adds a whoosh to every snap).
- `look`: `{grade: "<css filter>", grain: 0.07, vignette: 0.45}`, the film look over the speaker plate.
  - `look.fx: true` (opt-in, boolean; a style key, set in a style's JSON, not a global default): always write the `#fx` layer (the blur / brightness wrapper between `#push` and the footage), so a `popcard` beat's camera defocus/dim and a `leak` beat's bloom (both tween `#fx`'s filter) show. Without it `#fx` is written only when `look.refocus` is set or `captions.style` is `"duo"` with `captions.energyPunch`, and in every other reel those two tweens find no element and do nothing. **Strict:** only the boolean `true` turns it on; `false`, absent and any non-boolean (`"yes"`, `1`, ...) are ignored silently and change nothing (like `captions.smartBreaks` / `objectPops`). The validator should warn on a non-boolean `look.fx`. Set only in styles whose approved sample shows the defocus or the bloom: `pitch` (which already had `#fx` through `look.refocus`, so its output is unchanged). Through `extends` (deep merge) it reaches `library/ui-story-ad`, its variants and `gold-ledger`; the 13 of those that have no `#fx` otherwise (`look.refocus: false`, no duo energyPunch) opt out with `look.fx: false` (owner decision, 19 Oct): `library/ui-story-ad--11`, `--27`, `--37`, `--40`, `--41`, `--46`, `--54`, `--58`, `--61`, `--62`, `--65`, `--87`, `--91`. So `look.fx` currently changes the output of **no** shipped style; it is for future styles whose sample shows the effect. **Opt-out:** a child style (or a reel) sets `look.fx: false`; the deep merge overrides an inherited `true` and `#fx` is not written (unless `look.refocus` or duo `energyPunch` turns it on).
- `matte: true`: cut the speaker out once (`hyperframes remove-background`, cached as `assets/talk-matte.webm`, ~4 fps) for `behind` beats.
  - `matteWindows: true` (existing, opt-in, no `stage`): the cut-out is shown only while a `behind` or `ground` beat is up (`tl.set(".matte", {autoAlpha})` at each merged window, 0.02 s either side); the rest of the reel is the plate.
  - `matteClip: true` (opt-in, boolean; needs `matteWindows`, ignored under `stage`): the cut-out `<video>` elements cover only those windows instead of every whole take (`id="matte-<take>"`, then `matte-<take>-<n>` for a second window in the same take; a window across a take join gives one piece per take; `data-media-start` = the take's `a` + the offset into it). The renderer extracts an alpha video as PNG (measured ~1.4 MB a 1080x1920 frame, 14x the plate's JPEG). Measured on a 20.8 s single-take reel with a 3.6 s hook window: cut-out frames extracted 109 instead of 621; total frames extracted (plate + cut-out) 730 instead of 1241. A reel with a take `transition` (blur / whip tweens `#matte-<i>` whole) keeps the full-length cut-out and warns `matteClip: this reel has take transitions (blur/whip), so the cut-out stays on its full takes`.
    - **Window cut:** with `matteClip` on a single-recording reel with no take transition and no cached `assets/talk-matte.webm`, only the recording around the clipped cut-out pieces is cut out: each piece's recording span (`k.a + (start - k.start)`, the same mapping as its `data-media-start`) widened by 1 s each side (frame-aligned, clamped at 0, overlapping ones merged; any beat time form works, `"end"` included) is trimmed with ffmpeg (`build/matte-src@<startMs>-<endMs>.mp4`, x264 crf 10, removed after) and cut into `assets/talk-matte@<startMs>-<endMs>.webm` (cached **by name only**, like `talk-matte.webm`: a window file is not re-cut when the recording changes under the same name, so delete `assets/talk-matte*.webm` after replacing `talk.mp4`). Each clipped cut-out reads the window file that holds it, `data-media-start` = its offset into that file; a piece no window file holds falls back to the whole-recording matte (cut then). A cached `talk-matte.webm` is always used as is. Measured on the 20.8 s reel above: `remove-background` on 0-4.93 s (147 cut-out frames) of the recording instead of all 28.3 s (849 frames): the build with the cut took 30 s (timed inside the render lock) instead of 2 min 23.7 s (`MATTE_THREADS=8`, Mac mini M4). The window file is cut by frame index on a constant-rate timeline from 0 (`fps=<fps>:start_time=0,trim=start_frame=..:end_frame=..`), so its frame j is frame `round(a*fps)+j` of the whole-recording matte: measured on that reel, mean alpha difference 1.06 at offset 0 against 3.68 / 3.86 at -1 / +1 (frames 5-140 of a 0-4.9 s window) and 0.02 against 0.43 / 0.43 (a 10-15 s window). Multi-recording reels (`ground` / `stage` cut every recording with a face track) still cut whole recordings.
- `captions.phrases: {"a call for reach": "Coffer Reach"}` fixes multi-word whisper errors. Map a phrase to `""` to drop noise whisper heard as words (e.g. grunts during a montage).
- `captions.upper: true`: uppercase captions. `captions.keywordStyle: "serif"`: highlight words become a glowing serif italic (cinematic).
- `face`: the path to the face track, default `build/face.json` (run `scripts/face_track.py`). Without it, captions sit at a fixed height and the build warns.
- `cadence: {every, minGap, scales, emphasisScale, sfx, sfxEvery, sfxDb}`: automatic punch-in rhythm (The Closer, The Headline, The Keynote) - snaps land on take joins, emphasis words (`captions.highlight` or a trailing `!`) and a fixed cadence, alternating between `scales`, with a sound every `sfxEvery`-th one. Feeds the same `edit_truth.json` `snaps` as hand-authored ones.
- `openPush: {z, dur}`: a slow push-in over the opening `dur` seconds, skipped if a hand-authored push already starts that early.
- `captions.smartBreaks: true` turns ON smart caption breaking (don't strand a weak trailing word, fold one-word orphans into a neighbour, merge a phrase on screen under `captions.minRead` seconds with the next one). **Opt-in, off by default** (decision 6): it changes where every caption breaks, so switching it on for an existing style invalidates the measured caption rate and words-per-caption that style was tuned against in `CATALOG.md`. The five ported styles (`alif`, `closer`, `headline`, `keynote`, `monk`) set it `true` because they were authored against that behaviour. `captions.maxHold` caps how long a finished caption or editorial block stays up after its last word.
- Opt-in caption options ported from Ahmed's Monk 3.1 / Keynote 3.1 / Headline 2.1 (all off unless set, so no existing style's output changes): `captions.dedupe: true` shows a word repeated back to back once; `captions.minWords: N` makes the one-word-orphan fold apply to groups of up to N words (needs `smartBreaks`); `captions.breakOnCut: true` ends a caption group, and an editorial block, at every jump cut between takes; `captions.shadow: "strong"` and `captions.scrim: 0..1` (serif style) give a heavy text shadow and a soft radial scrim; `captions.backing: false` puts a heavy text shadow, not a grey box, on captions that fall under the mouth; editorial tuning `captions.prevWeight` / `prevAlpha` (the settled previous line), `scriptDur` (script write-on seconds), `alarmTail` (seconds the black-and-white alarm holds after the word). `outroFade: true` fades the held last frame to black over the outro instead of freezing it.
- `captions.keywords: {word: "script"|"bold"|"alarm"}` (editorial captions only): per-word treatments - `script` writes the word on in a gold hand-written serif, `bold` pops a huge accent word, `alarm` turns the word red while the frame drains to greyscale for its duration. `captions.keywordSfx: false` silences all three.
- `sound: {lines, objects, objectDb, heroDb, pen, penDb, paperIn, paperDb, zoom, zoomDb, nametag, leaks, leakSfx, leakDb}`: the sound layer gate for `paper`/`collage` scenes, the `nametag` beat, light leaks and the cadence zoom swish. Every key defaults **on**; a style opts a layer OUT (e.g. `alif.json` sets `lines: false` and reads object sounds from `OBJECT_SFX` instead).
- `packs: {"<pack>": true}`: turns on `library/packs/<pack>/<kind>/*.mp4` for light leaks, the 8mm film gate (`scenes.<kind>.gate: "8mm"` or a beat's own `gate`), film burns and `openFlash.clip`. No pack ships in this fork yet - every caller degrades to an asset-free fallback (a CSS-gradient flash) except `openFlash.clip`, which names one file and `die()`s if it is missing.
- `leaks: {every, color, at}`: a warm light-leak flash, auto-placed on take joins every `every` seconds or at explicit `at` times.
- `burns: {at, onScenes}`: a quick film-burn flash at explicit times or on every `image`/`window`/`tv` scene. Pack-only; a no-op without one.
- `openFlash: {at, dur, color, clip, media, texture, textureFilter, sfx, db}`: a hook flash on the opening frame. `sceneFlash: {kinds, which, count, dur, ...}` repeats it into/out of the first (or chosen) cutaway scene.
- `listMarks: {x, y, hold, labelSize, size, color}` (or `true` for defaults): when the speaker enumerates ("number one", "secondly", "step two"), a numbered card lands beside them - the numbered pop-up for enumerations.
- `banner: {text, from, to, y, size}`: a headline pinned to the top of the frame for the given window (or the whole reel).
- `watermark: {text, x, y, size, font, opacity}`: a faint corner mark for the whole reel. `look.tint: {color, blend, opacity}`: a colour wash over the picture. `look.exposure`/`look.contrast`: a brightness/contrast filter on the speaker plate.
- `music.drops: "auto" | [times] | {at, auto}`: mutes the music bed for ~0.5s before a payoff line (`"auto"`: the last scene, or `music.payoffAt` if set, or the first call-to-action word in the last quarter) and brings it back up on it. `music.payoffAt` also anchors `music.payoff !== false && music.drops`'s riser-into-silence-into-hit (`riserSfx`/`riserDb`, `hitSfx`/`hitDb`). `music.reveal: true | <seconds>` pre-renders the bed muffled (low-passed at `revealHz`, default 650 Hz) through the hook, opening to full over `revealRamp` (default 0.45 s) at the given time or an auto-detected turn ("but...", "here's exactly how...") between 2.2-9 s. (R1b)
- `extends: "<base-style>"` (style files only): deep-merges this style's own keys on top of the named base style, loaded first. `brandKit: "<id>"` (a style file or reel.json): layers `brands/<id>.json` - accent/accentDark, an optional watermark and flash tint, and an optional `person` that auto-generates a `nametag` beat (`until: "hook"`: on screen until the first `scene` beat, or 2.4 s). See `references/styles.md`'s "Style layering" section. (R1b)
- `toolLogos: {size, hold, x, y, pageX, pageY, sfx, db}` (or `true` for defaults): when the speaker names a product (ChatGPT, Claude, n8n, DeepSeek, Gemini, Zapier, Notion, HubSpot, Slack), its Simple Icons logo lands as a coloured app-icon tile - upper-right over footage, bottom-right on a page. (R1b)
- `objectPops: {x, y, w, hold, gap, labelSize}` (or `true` for defaults): between pages, when the speaker names a concrete thing (day-to-day -> calendar, money -> coins, emails -> mail, team, growth -> chart, clients -> handshake, goals -> target, launch -> rocket, win -> trophy, tasks -> checklist, phone, computer -> laptop, idea -> lightbulb, thinking -> brain, audit -> magnifier, workflow -> gears), its `library/engravings/png/<concept>.png` pops up on a small paper card with the spoken word as a label. Needs `library/engravings/`. (R1b)

New beat:

| type | fields | default sound | use for |
|---|---|---|---|
| `behind` | `text`, `at`, `to`, `size` (auto-fits the width), `y` (auto: head height), `color` | impact | the 2-4 biggest words, BEHIND the speaker (needs `matte`) |

## Premium kit: Noir (all opt-in, ported from Ahmed's premium-noir)

A reel that sets none of these builds exactly as before (`scripts/byte-identity.mjs`). `styles/premium-noir.json` sets all of them; the colour variants (`premium-noir-ice|jade|red|rose|silver`) extend it and change only `captions.gold`. Pixel values below are **9:16 pixels** and scale by `H / 1920` on other formats.

- `captions.style: "noir"`: cinema subtitles. Sentence-case Instrument Serif, the whole line at once, at a fixed height (`captions.fixedY`, default 1690) instead of the face-aware placer - it still writes its blocks to `build/caption_layout.json` (`mode: "noir"`). ONE word per line is the emphasis word (`<span class="w emph">`, gold italic; `captions.gold` sets the colour): a `captions.emph` word if the line has one, else the longest word of 5+ letters (`captions.autoEmph: false` turns the fallback off). Default `captions.group` is 6. The emphasis hook (`EMPH_STYLES`, `emphIndexOf` in build.mjs) is shared: another caption style that marks a hero word adds itself there.
- `letterbox: {h}`: two black bars (`h` px each, default 300) above the picture, grain and vignette (z 7), under the captions (z 8) and under layers-over / the watermark (z 9).
- `look.preset`: a grade from `presets/grades.json` (`noir-film`, `noir-gold`, `belmar-teal`, `luxe-warm`, `editorial-clean`, `empire-noir`): an SVG tone-curve filter (`<filter id="pk-grade-<preset>">`, written into the page) applied to `#base` with a trailing CSS `contrast()`. `look.grain`, `look.vignette` and `look.tint` set on the style or reel win over the preset's own; `look.grade` is appended. B-roll scene media (`image`/`video` scenes without their own `grade`) takes the same grade. An unknown preset fails the build with the list. `sections.json`'s `globalHash` includes the resolved preset, so editing `grades.json` invalidates every section.
- `punch: {frames, blur, ease, joins}`: punch-ins (cadence and hand-authored snaps) ease over `frames` frames (default 7) with `ease` (default `power3.out`) instead of cutting. `blur` > 0 (default 5) also blurs `#tx`, a wrapper that exists only then; Noir sets `frames: 20, blur: 0, ease: "sine.inOut"`, so it has no wrapper. A snap on a take join stays a hard cut unless `joins: true`. `edit_truth.json` snaps gain `dur` and `ease` **only for eased snaps**.
- `cadence.faceAnchor: {headroom}`: every punch-in scales around the speaker's face - x = the face centre, y = the top of the head minus `headroom` (default 24) - measured over that snap's hold, using the face track and crop plan of **the take's own source**. A source with no face track gets a plain punch around `zoom.origin`. `edit_truth.json` snaps gain `origin: [x, y]` **only for anchored snaps**. The caption placer (`safezone.mjs`) is not told about the origin and keeps modelling the face around `zoom.origin`; Noir's own captions are fixed-height so it only matters for cards and slots.
- `music.optional: true` (fork-only): if the named `music.id` is in the manifest but its file is not on disk, the build warns and goes on without a bed. Without it a missing file is still a fatal error (A10). `premium-noir` sets it because `silent-descent` is not shipped.

The rest of Ahmed's premium kit (speed ramps, `sfxDesign`, `drop`, `transitions`, the scorers, `PHANTASIC_PREVIEW_SCALE`) is under "Premium line" below. Not ported: the vendored GSAP (the page still loads GSAP from the CDN).

## Premium line (Empire, Signature, Prestige, Noir, kit demo; all opt-in, phase D; hand port of phantasic `engine/core` on origin/main + `template-premium-iman`)

A reel that sets none of this builds byte-identical (`scripts/byte-identity.mjs`). Tests: `scripts/build-ahmed-premium.test.mjs` (a small reel per style, the matte stubbed, no paid call).

### Styles (`styles/`)

| id | name | what it is | base |
|---|---|---|---|
| `premium-iman` | Empire | the speaker's **real** room (no set, no plate, no props: owner decision 10 Oct 2026), lit from the sides by the depth relight (`relight`, red left / blue right, the room a little darker) under a neutral contrast grade; ONE glowing caps phrase at a time typed on **behind** the head (the cut-out is only an invisible occluder: `matte` + `captions.behind`, see "Type captions behind the head without a stage"), red verdict words slammed in, then a music drop into a beat-locked ladder of stills and white flashes, caps CTA card. 9:16 only | its own file (uses `captions.style: "type"`, `matte`, `relight`, `drop`, `sfxDesign`) |
| `premium-signature` | Signature | the "$80 edit" on phone footage: word-cluster captions (tiny lead-ins, ONE huge serif-italic hero), a new picture every 0.6-1.6 s, hook burst, a sound on every move, warm grade. **Self-contained**: it carries phantasic main's newer `monologue.json` merged in, because the fork's `monologue` is the older cut (`look.refocus`, no `look.target`) | main's `monologue` + `premium-signature` |
| `premium-belmar` | Prestige | small lux caps with one bloomed word, `belmar-teal` grade, whip transitions, then the DROP: riser, 3 f silence, boom, a luxury B-roll ladder with flashes, tracked-caps card | its own file |
| `premium-noir` (+ `-ice/-jade/-red/-rose/-silver`) | Noir | parity with main: the fork's file differs from Ahmed's only by `music.optional: true` (checked key by key) | already in the fork |
| `premium-kit-demo` | kit demo (not a product look) | exercises every key below at once, to eyeball the kit | its own file |

`music.optional: true` is set on the Signature and Empire beds (`silent-descent`, `head-bang`): neither is shipped, so the build warns and goes on without music. `sound.completeMix` lives in `premium-iman.json`; the engine default stays off, so Podcast Glow and every other style render as before. Until 19 Oct 2026 Empire drew a neon set (`stage.bg: "neon"`, `stage.room: 300`); a reel that still wants that look sets `stage` itself (`stage` implies `matte`, and with `stage` the type goes between the set and the speaker as before). Because Empire now sets `relight`, an Empire build uses the depth model or a depth video ("Empire depth relight"); when they (or the python modules) are missing, the style's relight degrades to an unrelit build with a warning (see there), and a reel can set `"relight": false` to skip it outright.

### Keys

- **`take.ramp`** (`"rush" | "surge" | "hit" | "slowmo"` or `{curve: [[u, speed], ...], preset, interp: "blend" | "mci" | "dup"}`): a NON-SPEECH action take plays on an eased speed curve. The picture is pre-rendered by ffmpeg into `assets/ramp-take<i>-<hash>.mp4` (cached), muted, no captions; its length on the timeline is `(b - a) / mean speed` (rush: 3 s of source = 1.23 s). `E()` maps a source second inside it through the warp. Works per recording (`take.src`, and the `sourceGrade`'d file). Not with `stage` / `matte`. A ramp can't be the last take or carry a `hold`.
- **`scene.ramp`** (image / window scene with a video `src` or `self`): same curves, the scene keeps its `at`/`to`; `media` (or `self`) is where the source starts. Stills ignore it.
- **`transitions: {kind: "whip" | "zoom" | "mix", every: 1, frames: 8, strength: 1}`**: a whip (directional blur) or zoom-through on every `every`-th jump cut between takes (ramp-take boundaries always), on the `#tx` wrapper (which now also exists when this is set). A join that has its own `take.transition` (I-17, blur / whip between two recordings) keeps that one and is skipped here; so are joins next to a hold, next to a punch-in (0.3 s) and joins across a section boundary. Scenes: `in` / `out` accept `"whip"` and `"zoom"` (style default `scenes: {image: {in: "whip"}}` or `sceneIn` / `sceneOut`).
- **`sfxDesign: {density: "low" | "med" | "high", rules, hitDb, riserDb, tailDb, softDb, tickDb, swishDb, whipDb, rampDb, hitLen, popGap, voiceGapDb}`** (also `sfx: {density}` as an OBJECT; `sfx` as an array is still the manual hit list): riser > hit > tail on major hard cuts (into B-roll / a ramp take), a swish on whips, a speed-up whoosh at the ramp peak, a soft whoosh on text-in, a swish on punch-ins, ticks on word pops (highlight words and `!` always pop); every sound is placed by its measured peak (`library/sfx/timing.json`), and every non-impact sound over speech is capped `voiceGapDb` (-8) under the voice. **A sound that is not on disk is skipped with the usual warning at the end of the build, never a die.** The shipped library has no audio, so today the pass places nothing; with files in `library/sfx` (or `PHANTASIC_LIB`) it does. Exact fields, families and fallback: "Prestige sound design" below.
- **`drop: {hold | at, shots: [{self: <source s>} | {src, media, ramp}...], ladder: [frames], bpm + beats, gap: 3, flashEvery: 3, flash: 0.6, lift: 3, overlap, riser, boom, tail, cutSfx, in}`** (sound fields and levels: "Prestige sound design" below): talk -> riser -> 3 f silence -> boom -> a cut ladder of image scenes (`_drop` beats; they appear in `edit_truth.json` `beats`), a white flash on every `flashEvery`-th cut, the SFX inside the drop lifted `lift` dB. `hold: i` puts it on take i's hold (give that take a `hold` >= ladder + gap); `at` is a source second inside a plain take (a warning fires when speech falls in the silence). `bpm` + `beats` express the ladder in beats, rounded on the running total. A style may carry drop defaults; the drop runs only when the reel sets `hold` / `at` / `shots`.
- **`music.alignDrop`** (track second) puts the bed's own drop on the drop's first cut; **`music.dropLift`** dB lifts the bed from there; **`music.lifts: [{a, b, db, ramp}]`** are generic lifts. `music.optional` is the fork key from the Noir section.
- **Type captions behind the head without a stage** (opt-in: only when `captions.style: "type"`, `captions.behind: true`, `matte` on and NO `stage`; Empire since 19 Oct 2026). The plate stays the speaker's own footage and the cut-out (`assets/talk-matte.webm`, relit with the plate when `relight` is set, so it matches it pixel for pixel) is only an **occluder**: a card that goes behind is written INSIDE the camera wrappers, between the takes and the cut-out (`#push > ... #capsb > .tc`, after the takes and any `behind` / `ground` beat, before `.matte`), so the head covers part of it and it rides the punch-ins with the speaker. Which cards go behind, per card, from the head-top track of the card's own take (`build/headtop.json`, the same track `stage` reads, cut-out alpha at 5 fps; the highest head top over the card's window +-0.2 s): with `room = crown - captions.safeTop (200)` and `need = lines x lineH - overlap x lineH`, a card that needs more than the room is shrunk (down to `captions.minSize`, as under a stage); if it then fits, its block is hung so the last line dips `captions.overlap` x its height under the crown (`y = crown + overlap x lineH - lines x lineH`) and it is logged `mode: "behind"` in `caption_layout.json`; **`captions.maxHidden`** (number 0..1, opt-in, this mode only; Empire sets 0.45; any other value fails the build with `captions.maxHidden must be a number 0..1 (got <x>)`): the tuck is capped so at most this fraction of the card's height sits under the crown, i.e. the card uses `overlap = min(captions.overlap, maxHidden x lines)` (the crown is the highest head top over the card's window, so the top `1 - maxHidden` of the block, every letter's top included, is always above the head); unset = `captions.overlap` as is. If it still does not fit (a tight close-up whose crown is near the top of the frame), or the take's recording has no cut-out or no head top, the card is placed **in front** by the face-aware placer exactly as without `behind`. **Holds:** a take's hold is a still with no cut-out over it, so a behind card that runs into a hold ends where the hold starts (`data-duration` cut there), and a card that starts inside a hold is placed in front. **Take joins** with a `blur` / `whip` transition: `#capsb` gets the same tween as the takes and the cut-out (out: `autoAlpha` 0 + `blur(28px)` / whip `blur(40px)` `xPercent -8` over the out half; in: back from `blur` / whip `xPercent 8`), with a `tl.set("#capsb", {autoAlpha: 1, filter: "blur(0px)", xPercent: 0}, 0)` baseline, written only when the reel has such a join. Behind cards keep their ids, timing, typing, slam and sounds; they are graded with the footage (`#base`'s `look.grade`), which is why Empire uses a neutral contrast grade. The `#capsb` layer (CSS `position: absolute; left: 0; right: 0; top: 0; height: 0`) is written only in this mode. With `matteWindows` the cut-out shows only during `behind` / `ground` beats, so the build warns `captions.behind: matteWindows shows the cut-out only during behind / ground beats, so type cards behind the head are not covered outside them`. Off 9:16 the build warns `captions.behind is tuned for 9:16 (the head-top track and the type sizes); <format> may look off`. Nothing else changes: with a `stage` the type still goes between the set and the speaker, and a reel without `captions.behind` (or without `matte`) builds byte-identically. `edit_truth.json`: shape unchanged. Test: `scripts/build-iman-real-room.test.mjs`.
- **Captions**: `captions.wordReveal` (type: whole words land on their spoken start, no half-typed word), `captions.cursor: false`, type cards shrink to fit above the crown when `stage` + `captions.behind` (so the head covers part of the last line), and with `stage` + `behind` the caption layer sits between the set and the speaker (`#pip > #caps` under `#pip > #base`); `captions.popSafe` (long words pop less) and `captions.wordGap` (box style's word margin, default `0.14em`). Beat `endcard` with `bg: "none"` sits above B-roll scenes. Not ported: `captions.chestFirst` and `captions.prefer` for the placer (they live in `safezone.mjs`, which has no such option here); the kit demo drops `chestFirst`.
- **Scenes**: `pos` (CSS object-position for the crop), `cutSfx` / `cutDb` (a burst member gets its own small sound instead of the major-cut chain), `inSfx` / `inSfxDb` (the scene's own entry sound on any transition), concept scene `tickSfx` / `tickDb` (a tick per typeface swap).
- **`sound.completeMix: true`**: build the SFX audio tags at write time, so sounds added after the early mix (type-card hits, cluster hero whooshes, flashes) play, and an event with a `.fade` (the riser cut at the boom) gets a volume lane. It is Ahmed's `sound.complete`, under a new name on purpose: a dozen fork styles carry `sound.complete` as data and reading it would change their mix. Switching them over is a separate decision.
- **`PHANTASIC_PREVIEW_SCALE=0.5`** renders the same page inside a 540x960 stage (iteration only). **`PHANTASIC_LIB`** points the build at another library root.
- `look.preset` grades `belmar-teal`, `noir-film`, `empire-noir` already existed; `presets/grades.json` is identical to Ahmed's.

### Prestige sound design (`sfxDesign` + the drop's sounds; mac-4)

Both are opt-in, and the lists and the group fallback below change nothing for a reel that does not use them: every existing reel builds byte-identically (`scripts/build-prestige-sound.test.mjs` checks premium-belmar reels with no drop and with a placed drop against the base engine). The style files are unchanged; note that `build/sections.json`'s `globalHash` covers all of `spec.drop`, so editing a style's `drop` block changes that hash for every reel of the style, drop or not. The sound files are never in this repository: a deployment syncs the licensed pack's sounds into `library/sfx/<file>` under the engine ids below (see `library/SOURCES.md`). Any id whose manifest entry or file is missing is **skipped with the end-of-build warning `N sound(s) skipped, M id(s) unavailable: ...`, never a die**; with no sound on disk at all the reel builds silent (no `<audio id="sfx-N">` tag, `build/sfx_events.json` `events: []`).

**`sfxDesign`** (object; `sfx: {...}` as an object is the same thing; `premium-belmar` sets `{density: "low"}`):

| field | type | default | what it does |
|---|---|---|---|
| `density` | `"low"` \| `"med"` \| `"high"` | `"med"` | picks the rule row below. Anything else: die `sfxDesign.density must be low, med or high (got X)` |
| `rules` | object | `{}` | overrides single fields of the density row: `riser` (`"major"` \| `"transitions"` \| `false`), `hit` (`"major"` \| `"transitions"` \| `"all"`), `tail` (bool), `text` (`"scenes"` \| `"all"` \| `false`), `punch` (int: a swish on every Nth punch-in, `0` = none), `pop` (bool), `ramp` (bool), `gap` (s: minimum spacing of the non-forced sounds) |
| `riserDb`, `hitDb`, `tailDb`, `softDb`, `tickDb`, `swishDb`, `whipDb`, `rampDb` | number (dB) | `0`, `2`, `-4`, `0`, `-8`, `-2`, `0`, `0` | added to the id's role level: `vol = min(1, 10^((voiceP95 + mix.roleDb[role] + db + 1) / 20))` |
| `hitLen` | number (s) | `0.9` | a hit on a major cut is cut (0.06 s fade) this long after its peak |
| `popGap` | number (s) | low `1.7`, med `0.8`, high `0.3` | spacing of word-pop ticks; highlight words and words ending in `!` pop after `0.25` s |
| `voiceGapDb` | number (dB) | `-8` | every non-impact, non-meme sound that overlaps a word is capped this far under the voice p95 (all of the reel's sfx, not only the pass's own) |

Density rows: `low` = riser + hit on major cuts, no tail, soft whoosh on scene pages only, no punch swish, ticks on, gap 0.6 s; `med` = + tail, hits on transitions, soft whoosh on every text-in, a swish on every 2nd punch-in, gap 0.35 s; `high` = risers on transitions too, a hit on every transition, a swish on plain jump cuts and every punch-in, gap 0.2 s. A major cut is a cut into an image / window scene that is not a drop shot and has no `cutSfx`, or into a ramp take. Every sound is placed so its measured peak (`library/sfx/timing.json` `peak_t`; absent = 0) lands on the event; one starting before 0 s or after the reel's end is not placed. Each event in `sfx_events.json` carries `design: <family>` and `why: "design: ..."`.

**Families (the engine ids `sfxDesign` plays), in round-robin order.** If the id whose turn it is is not playable, the next member of the same family that is on disk plays instead; if none is, the turn's id is the one reported as skipped.

| family | ids | role (manifest) | Prestige (`low`) uses it for |
|---|---|---|---|
| `riser` | `riser-1`, `cinematic-rumble-riser` | whoosh | into each major cut (cut 0.04 s after the cut, 0.06 s fade) |
| `hit` | `cinematic-deep-boom`, `impact-1` | impact | on each major cut |
| `tail` | `whoosh-cine` | whoosh | (med / high only) 0.12 s after the hit |
| `soft` | `pop-whoosh-light`, `whoosh-cine` | ui, whoosh | a scene page coming in |
| `tick` | `click-1`, `pop-1`, `tick-1` | ui | word pops (about one per caption block) |
| `swish` | `zoom-sweep-small`, `zoom-sweep-short` | ui | (med / high only) punch-ins, jump cuts |
| `whip` | `burn-whoosh-fast`, `tech-digital-whoosh` | whoosh | each whip / zoom transition (`transitions`, scene `in: "whip"`) |
| `ramp` | `burn-whoosh-tunnel` | whoosh | the speed peak of a ramp take |

**How the fallback resolves.** The group fallback (`sfxDesign`) and the list fallback (`drop`) choose the id **before** `addSfx` runs, by checking the manifest entry and its file in `library/sfx`. So with a partial library they take precedence over `spec.sfxFallback` (which only sees the id already chosen) and never go through `pick()`'s family names (`pop`, `whoosh`, `impact`); a `"pack:<name>"` id inside a drop list is never "on disk" to this check, so a list made only of pack ids resolves to its first entry (which `addSfx` then plays from the pack, or reports skipped). With every id present or every id missing the result is the same as before.

**The drop's sounds** (fields of `drop`, read only when the drop is placed: `hold`, `at` or `shots`). Each sound field is a **sound id, a non-empty list of ids (the first one on disk plays; none on disk = the first is reported as skipped), or `false` / `"none"` (no sound)**. Anything else: die `drop.<field> must be a sound id, a non-empty list of sound ids, false or "none" (got X)`. **Changed:** an empty string `""` used to mean no sound (silently); it now dies with this message. Use `false` or `"none"`.

| field | type | default | what it does |
|---|---|---|---|
| `riser` | id \| [ids] \| false | `"cinematic-rumble-riser"` | placed so its peak lands `gap` frames before the boom, then cut there with a 0.03 s fade (`why: "drop riser (tops out before the gap)"`); not placed when it would start before 0 s |
| `riserDb` | number (dB) | `2` | |
| `boom` | id \| [ids] \| false | `"cinematic-deep-boom"` | on the first ladder shot (`why: "drop boom"`) |
| `boomDb` | number (dB) | `0` | |
| `tail` | id \| [ids] \| false | `"whoosh-cine"` | 0.02 s after the boom (`why: "drop tail"`) |
| `tailDb` | number (dB) | `-2` | |
| `cutSfx` | id \| [ids] \| false | `"tech-camera-flash"` | on every flash cut (every `flashEvery`-th cut after the first; `why: "drop flash cut"`) |
| `cutDb` | number (dB) | `-2` | |
| `lift` | number (dB) | `3` | the drop's own sounds that start inside the drop window (boom, tail, flash cuts; not the riser) are raised this much (volume capped at 1) |
| `gap` | int (frames) | `3` | silence before the boom: a sound placed before the drop pass (beat sounds, manual `sfx`) still ringing at `boom - gap` is cut there with a 0.03 s fade; the design pass runs after and keeps its own spacing |

`premium-belmar` keeps the single default ids; a deployment or a reel sets the lists (for example `boom: ["cinematic-deep-boom", "impact-1"]`) when its library holds only part of these ids. Without `sound.completeMix` the drop's sounds and the design pass are still in the mix (both run before the early audio tags are written).

**Engine ids Prestige needs on disk** (for mapping the licensed pack; ids from `library/sfx/manifest.json`): drop `cinematic-rumble-riser`, `cinematic-deep-boom`, `whoosh-cine`, `tech-camera-flash` (the defaults; a reel or deployment can list stand-ins such as `riser-1`, `impact-1`, `click-1`); design pass at `low`: `riser-1` / `cinematic-rumble-riser`, `cinematic-deep-boom` / `impact-1`, `pop-whoosh-light` / `whoosh-cine`, `click-1` / `pop-1` / `tick-1`, `burn-whoosh-fast` / `tech-digital-whoosh`, `burn-whoosh-tunnel` (ramps only). `scripts/prestige_score.py` (after a render) also names `cinematic-cine-hit`, `pop-1` and `cinematic-heartbeat` by file name in `library/sfx` (`--sfx-dir`).

Test: `scripts/build-prestige-sound.test.mjs` builds a small Prestige reel against a stub library of generated tones (made in the test's temp folder, never committed) and against the silent library.

### `edit_truth.json` (additive, each key ONLY when set)

`takes[i].ramp` (the ramp as written; `dur` is already the ramped length, so `dur != b - a` for that take) and a top-level `txTransitions: [{t, kind}]` (the `#tx` whips and zoom-throughs of `transitions`; a join's own `take.transition` stays a take field). Drop ladder scenes are ordinary `beats` (`type: "scene"`, `kind: "image"`). Nothing else changed.

### What the build refuses (`die()`; planner validator checks)

take N has a ramp but contains speech; a ramped take can't be the last take or carry a hold; `take.ramp` with `spec.stage` / `spec.matte`; unknown ramp preset; `sfxDesign.density` not low / med / high; `transitions.kind` not whip / zoom / mix; `drop` without `shots`; `drop` without `hold` or `at`; `drop.riser` / `boom` / `tail` / `cutSfx` not an id, a non-empty list of ids, `false` or `"none"`; `drop.hold` naming a take that does not exist. (A ramp that would run past the end of its source is also checked, but a take's `b` is already checked against the file.)

### Python (`scripts/`, run with the venv python or `py`; needs only numpy and opencv-python; none calls a paid service; only `depth_map.py` runs a model, locally)

| script | call | in / out | notes |
|---|---|---|---|
| `score.py` | `score.py cues.json` | a cue sheet (voice takes, music, beds, cues, reverb send) -> `<video>-scored.mp4`, two-pass loudnorm to -14 LUFS | ~10-20 s per 60 s reel, CPU. A missing cue / bed / music wav is skipped with a warning; the voice and the picture are required |
| `autoscore.py` | `autoscore.py <project> <video.mp4> --pack DIR [--music f --music-start 7.25]` | `reel.json`, `build/words.aligned.json` (realign.py), `build/sfx_events.json` -> `build/cues.json` | Empire rules (typewriter keys, BIG / LIGHT verdict hits, interlude cards, beds). Needs the sound pack (`PHANTASIC_SFX_PACK`); refuses a ramped or multi-recording reel |
| `prestige_score.py` | `prestige_score.py <project> <video.mp4> [--music f --music-drop 7.30]` | `build/sfx_events.json` -> `build/cues.json` | places the track's own drop on the reel's boom; uses `library/sfx` names (`--sfx-dir` to change) |
| `noir_score.py` | `noir_score.py <project> <video.mp4> --pack DIR [--music f]` | `words.aligned.json` + reel -> `build/cues.json` | chapter-card swells, gold-word shimmer, final thud |
| `signature_plan.py` | `signature_plan.py reel plan.json` / `score plan.json video.mp4 --pack DIR` | an art-direction plan -> `<project>/reel.json` (style premium-signature, hero-word zoom snaps, cut scenes, leaks, mood) and -> `build/cues.json` | pure transform, well under a second. The plan's `cuts[].src` are pictures / clips that already exist in the project |
| `relight.py` | `relight.py src.mp4 depth.mp4 out.mp4 [--look neon\|warm\|empire] [--params JSON] [--frame]` | depth-based relight. `neon` / `warm` write `out.mp4` and `out-mask.mp4` (they black out or replace the room: CLI only); `empire` keeps the real room and writes `out.mp4` only (what `relight` in reel.json runs) | neon / warm: CPU numpy / OpenCV at 1080x1920, ~10-20 min per 60 s reel. **The depth map is an input**: `depth_map.py` makes one locally (Depth Anything V2 Small), or any depth video |
| `depth_map.py` | `depth_map.py src.mp4 out.mp4 [--size 364] [--threads N]` / `depth_map.py --fetch` | Depth Anything V2 Small (ONNX, Apache-2.0) over every frame -> 8-bit grey depth video, near = bright | needs onnxruntime (+ numpy, OpenCV). The model is downloaded by `--fetch` to `~/.cache/phantasic/models`, never into the repo; source URL and sha256 in `library/models.json` |
| `splice_matte.py` | `splice_matte.py orig-matte.webm relit.mp4 relit-mask.mp4 --takes takes.json out.webm` | splices the relit footage into the build's cut-out matte (person matte owns the edge, depth mask only removes far objects) | ~6-12 min per 60 s reel, CPU. Needs `libvpx-vp9` |
| `empire_finish.py` | `empire_finish.py <project> <takes.mp4> <depth.mp4> <takes.json> <out.mp4> [--pack DIR --music f]` | relight -> splice -> rebuild -> render -> autoscore -> score -> vcheck -> contact sheet | the OLD neon-set Empire only: a project whose reel.json sets no `stage` (the real-room Empire since 19 Oct 2026) is refused before anything is written (exit 3, `assets/talk-matte.webm` untouched). The zsh `empire_finish.sh` rewritten (`cmd /c npx` on Windows, `master.py --from-json`). Renders, so it is not run in the tests |

The planner side: `signature_plan.py` is the only one that writes a reel; call it with a plan (`project`, `takes` as `[a, b]` pairs, `heroes`, `serif`, `fixes`, `cuts`, `payoff`) and then `build.mjs`. The scorers run after a render and only read `build/sfx_events.json` (written by every build) and `build/words.aligned.json`.

### Not ported, and missing assets

Not ported: vendored GSAP (the page still loads it from the CDN), `captions.chestFirst` / `captions.prefer`, the `sound.complete` key (see `completeMix`), Ahmed's per-version reels under `engine/docs/templates` (they are history, not code). Not shipped, so the matching features degrade with a warning: the sound packs the scorers name (`e-*`, `s-*`, `old-*` wavs), the music beds (`head-bang`, `silent-descent`, Ahmed's `empire-house-a/b.mp3`), the library sfx audio, and the depth model for Empire (`relight`; `depth_map.py --fetch` downloads it, see "Empire depth relight"). The Signature look also needs per-video art (Ahmed generated it with an image model and an image-to-video model; nothing here does).

## Empire depth relight (`relight`, opt-in; Depth Anything V2 Small, run locally)

Coloured side light on the speaker's **real** footage, shaped by a depth map: the light wraps the face and body and falls off
with depth, so the subject is lit and the room behind is only touched. Nothing is replaced: no plate, no drawn set, no
compositing of the room (owner decision, 10 Oct 2026: keep the speaker's own background, side lights only). The light is a
smooth multiplicative field on the original pixels, so there is no cut edge and no halo at the hair. A reel without `relight`
builds byte-identically (`scripts/byte-identity.mjs`). Test: `scripts/build-relight.test.mjs` (stub depth map, the model never runs).

```json
"relight": { "look": "empire", "left": "#ff3a48", "right": "#5a78ff", "strength": 0.9, "room": 0.3, "roomDim": 0.15 }
```

`relight: true` is the same as `{}` (every default). Fields (all optional; any other key fails the build):

| field | type | default | what it does |
|---|---|---|---|
| `look` | `"empire"` | `"empire"` | the only look the build runs (relight.py's older `neon` / `warm` looks black out or replace the room, so they stay CLI-only) |
| `left` | `"#rrggbb"` | `"#ff3a48"` | colour of the light from the frame's left side |
| `right` | `"#rrggbb"` | `"#5a78ff"` | colour of the light from the frame's right side |
| `strength` | number 0..2 | `0.9` | gain of the coloured light on the subject (0 = no light, only `roomDim`) |
| `room` | number 0..1 | `0.3` | fraction of that light that reaches the far room (0 = subject only, 1 = no depth falloff) |
| `roomDim` | number 0..0.6 | `0.15` | how much the far room is darkened (depth-weighted; the subject is never darkened) |

What the build does, per recording that has a face track (the primary always; same rule as `stage`):

1. **Depth** (`assets/<recording>-depth-<tag>.mp4`, cached): an 8-bit grey video, near = bright, same frame count and rate
   as the recording, at the model's working size (short side 364, fixed). `<tag>` covers the recording's CONTENT (md5 of the
   file), the model input size, the model's sha256 and depth_map.py itself, so a re-recorded file or another model never reuses an old depth map.
   If it is missing the build runs `scripts/depth_map.py <recording> <out> --size 364` (Depth Anything V2 Small, ONNX,
   onnxruntime on the CPU). The model is **not** in this repo: `python3 scripts/depth_map.py --fetch` downloads it once into
   `PHANTASIC_MODELS` (default `~/.cache/phantasic/models`); depth_map.py checks the file's sha256 against
   `library/models.json` on fetch AND before every run. The build never downloads anything.
   **Hand-placed override:** `assets/<recording>-depth.mp4` (no tag), when present, is used instead, as is (a depth video made
   some other way). It is not re-checked against the recording's content, only its frame count (step 2).
2. **Relight** (`assets/<recording>-relit-<hash>.mp4`, cached): `scripts/relight.py <media> <depth> <out> --look empire
   --params '<json>'`. `<media>` is the `sourceGrade`d file when that is set, else the recording. The hash covers the params,
   the media file's name and content, the depth file's key (or the override's content) and relight.py itself. relight.py
   **refuses** a depth video whose frame count differs from the media's (never pads or drops frames). Only the `<video>` tags, hold and outro stills read
   the relit file (like `sourceGrade`); audio, words, faces and `edit_truth.json` keep the recording's own name.
3. **With `matte` / `stage`**: the cut-out must show the relit subject too, so its colour is replaced by the relit footage and
   its alpha kept (`assets/<recording>-matte-relit-<hash>.webm`, ffmpeg `alphamerge`, cached). The occluder then matches the
   plate pixel for pixel and only the caption layer between them shows that it is there.
   With a `matteClip` **window cut** (no whole-recording matte cached), each window cut-out `assets/talk-matte@<a>-<b>.webm` is
   relit on its own: the relit file is trimmed on the same frame indices as the window (`fps=<fps>:start_time=0,trim=...`), both
   inputs are re-timed by frame index (`setpts=N/(<fps>*TB)`: a real window cut-out's millisecond timestamps step 33 ms and
   drifted a frame against the exact 1/30 s trim from ~2.6 s on, measured on a 0-4.93 s window, when the merge paired by time),
   and the relit frames are merged under the window's alpha (`alphamerge=shortest=1:repeatlast=0`) into its own `assets/talk-matte-relit-<hash>.webm`
   (the hash also keys the window); the clipped cut-out reads that file at the same offset as the un-lit window would. A window
   at the recording's end can come out one frame short of its trim (measured: 75 frames for a 76-frame trim of a source whose
   video starts at 0); the merge ends with the window cut-out frame for frame, so that is harmless (`shortest=1` alone also
   dropped the last frame when both inputs end together, hence `repeatlast=0`). Checked frame by frame (colour and alpha) on sources whose video starts at 0 and
   at 0.033 s (prep.sh, phone files: frame 0 is repeated on decode by the window cut and relight.py alike). A piece no window
   holds falls back to the whole-recording matte, relit the same way as above.

Environment (all optional, nothing else): `PHANTASIC_PYTHON` (the interpreter to use; when set it MUST import the modules, else
the build fails naming it; unset: `.venv`, then `python3` / `python` / `py`, the first that imports numpy and cv2, plus
onnxruntime when the depth step has to run), `PHANTASIC_MODELS` (model folder), `DEPTH_THREADS` (onnxruntime intra-op threads
for the depth step, default min(4, CPU count); a speed knob, not part of the depth key: other thread counts can move the
float sums in the last bits, which does not matter after the 8-bit quantisation). Depth runs on onnxruntime's CPU provider
only (CoreML on the M4 measured slower, 0.49 vs 0.21 s/frame); relight.py uses min(4, CPU count) OpenCV threads.

`sections.json`'s `globalHash` includes `relight` (the resolved params) only when it is set. `edit_truth.json`: shape unchanged.

**Relight from a style degrades** (a style sets `relight`, the reel's own reel.json does not): when the build cannot run it because a tool is missing, i.e. the `no depth map at ... and no depth model at ...`, `PHANTASIC_PYTHON=... cannot import ...`, `no python with numpy and OpenCV found` or `no python with onnxruntime, numpy and OpenCV found` cases below, every recording keeps its own media (a source already relit is reverted), the cut-out is not relit, `relight` is left out of `sections.json`'s `globalHash` (the page is the `"relight": false` page), and the build warns at the end: `relight (from the style) skipped, the reel is built unrelit: <the message without "relight: "> (set "relight": false in reel.json to silence this)`. Every other relight error still dies, and a reel that sets `relight` itself dies on all of them as before.

What the build refuses (`die()`; the tool-missing ones only when the reel sets `relight` itself): `relight must be true or an object`; `relight: unknown key '<k>'`; `relight.look must be
"empire" (got <x>)`; `relight.left must be a #rrggbb colour (got <x>)` (and `.right`); `relight.strength must be a number 0..2
(got <x>)`; `relight.room must be a number 0..1 (got <x>)`; `relight.roomDim must be a number 0..0.6 (got <x>)`;
`relight: no depth map at <assets/..-depth-<tag>.mp4> and no depth model at <path>: run python3 scripts/depth_map.py --fetch, or
place a depth video at assets/<recording>-depth.mp4`; `relight: PHANTASIC_PYTHON=<path> cannot import <modules>: <last line>`; `relight: no python with numpy and OpenCV found (set PHANTASIC_PYTHON)`; `relight: no python with onnxruntime,
numpy and OpenCV found for the depth step (set PHANTASIC_PYTHON)`; `relight: depth_map.py failed on <recording>: <last line>`;
`relight: relight.py failed on <recording>: <last line>` (including `relight.py: depth video <d> has a different frame count
than <media> (...): make it again from this recording`); `relight: depth_map.py failed on <recording>: depth_map.py: <model> does
not match the sha256 in library/models.json (...)`; `relight: could not merge the relit footage into the cut-out of
<recording>: <last line>`.

Cost, measured 19 Oct 2026 on the Mac mini (Apple M4, 4 performance + 6 efficiency cores, 16 GB; other sessions running, load
average 7-13) on a 10 s 1080x1920 30 fps clip (301 decoded frames), each step alone under the render lock. All three run once per
recording and are cached. A cached rebuild still reads each recording (and, with `matte`, its cut-out) once to md5 it for
the cache keys (hashed once per build, however often it is used). That cost grows with file size: 0.011 s for this 9 MB
clip on the M4; a long phone clip of several hundred MB adds a fraction of a second to a second, on top of the < 1 s build.

| step | time per 10 s | per frame | notes |
|---|---|---|---|
| depth (`depth_map.py`, CPU, 4 threads, model input 364x644) | 55-67 s | 0.18-0.22 s | 10 threads: 0.71 s/frame (the efficiency cores stall the pool); 518 short side: 0.50 s/frame; CoreML (dropped): 0.49 s/frame |
| relight (`relight.py --look empire`) | 16-20 s | 0.055-0.065 s | numpy / OpenCV, 4 threads; the gain field at half size |
| relit cut-out (VP9 + alpha, only with `matte` / `stage`) | 13-15 s | 0.05 s | libvpx with 8 threads + 2 tile columns (single-threaded it took ~95 s) |

The render itself (`hyperframes render`, same reel with `matte` + 2 `behind` beats) took 36 s and 27 s with `relight` (two runs)
and 30 s without (one run) on the loaded machine: the page plays the same number of videos either way, so treat the 6 s as noise until re-measured.

To estimate a Linux CPU box: run `depth_map.py` on any 10 s clip there with `DEPTH_THREADS` set to its CPU quota (it prints
s/frame), and `relight.py --look empire` likewise; both costs are linear in frames.

## Premium kit: Podcast Glow (all opt-in, ported from Ahmed's podcast-glow)

Style `podcast-glow` sets them; `podcast-glow-blue|green|pink|purple|red|white` extend it and change the accent, caption colour and tint. Pixel values are 9:16 pixels, scaled by the format.

- `captions.style: "glow"`: ONE word (a word under `captions.joinUnder`, 0.14 s, rides with the next) at a time in heavy caps, colour `captions.color` (default #FFD21E) with a glow (`captions.glow`, `glow2`), at `captions.fixedY` (default 1230), dodging under the chin when the face is there (`dodgeFace: false` turns that off). Fixed-height like noir: the blocks are logged in `caption_layout.json` as `mode: "glow"`.
- `headline` beat: `{small, big, pos: "low"|"top"|"left", smallAt: [times], bigAt, arrow: "left"|"right", behind, color, size, smallSize, y, dy, shade, sfx}`. A small white line over a HUGE condensed (Anton) word that blur-slams in on `bigAt`; captions hide while it is up. `pos: "low"` sits under the chin and shrinks, or moves to the top band with no arrow, when a close-up leaves no room. `behind: true` draws it between the plate and the cut-out (needs `matte` or `stage`); with `legibility.behind` set it goes through the same gate as a `behind` word (skipped under a `stage`, which rescales the subject). Default sound: whoosh-2 + impact-1 (+ pen-short on an arrow), each skipped with a warning when missing. Anton (`templates/fonts-extra/`) is copied and declared only when a reel has a headline beat; the headline css is likewise written only then.
- `stage`: the speaker is cut out (`hyperframes remove-background`, an ONNX person-segmentation model, cached as `assets/<recording>-matte.webm`; `talk-matte.webm` for the primary) and composited on a designed set; the plate is hidden. Keys: `scale`, `fixedScale` (a framed shot keeps its size), `offsetY`, `safeTop`/`room` (auto subject scale from the head-top track `build/headtop*.json`), `sideFade` (% of the width), `erode`, `feather`, `subjectGrade`, `wrap`/`wrapR`/`wrapB`/`wrapSpan` (red/blue light wraps), `video`/`videoGrade`/`videoOpacity` (a looped moving set), `grid`/`gridLine`/`gridSize`, `glow`/`glowY`, `plate`, `practicals`, `haze`, `red`, `blue`, `fg` props. `stage.windows [{at, to, set}]` (recording seconds) show the set only on those moments, each with its own look from `stage.sets {key: {...}}`; between windows the real footage plays. `stage` implies `matte`.
  - **Per recording:** a multi-source reel is allowed under `stage`: each take reads the cut-out of its own recording (`<name>-matte.webm`), the head-top track is read per recording, and a recording with no face track is not cut out and keeps its plate. Plain `spec.matte` with more than one source is still refused.
  - **The matte needs a model and is slow without a GPU:** `remove-background` uses `u2net_human_seg` (~170 MB, cached in `~/.cache/hyperframes/background-removal`) through onnxruntime-node; it picks CoreML on Apple Silicon, CUDA with `HYPERFRAMES_CUDA=1`, else CPU. On this Windows laptop's CPU a 10 s clip took 26 minutes. It runs on Linux (CPU), but the production container would need the model and a time budget; the matte is cached per recording, so the cost is once per source file.
  - **`MATTE_THREADS=T`** (env, opt-in, integer >= 1; anything else is ignored): `remove-background` runs with onnxruntime held to T intra-op threads and spinning off (`scripts/matte-ort-threads.cjs`, a `--require` preload, which prints `matte: onnxruntime T threads, spinning off`; if that line does not appear the build warns that the speed-up is lost, and keeps the matte). Measured on staging (10 s 1080x1920 clip, 8-CPU quota): 520 s -> 70 s with `MATTE_THREADS=8`, every frame and VP9 packet identical to the default run. Unset: the build runs the tool exactly as before. Test: `scripts/lib/matte.test.mjs`.
- `"pack:<name>"` in any sfx id: a wav from `PHANTASIC_SFX_PACK` (default `~/reels/premium/sfx-pack`), mixed as an impact. The fork ships no pack: a missing pack or file is a warning at the end of the build and the sound is skipped.
- `glow` (opt-in, object; style `podcast-glow` sets both, so every colour variant has them; no other style does):
  - `glow.hookGround`: `true` | `{gradient: [c1, c2], paper, gridColor, gridSize, grain, color, backdrop}` (any `ground` beat field except `at` / `to`). The reel's hook, i.e. its EARLIEST `headline` with `pos: "top"` and numeric `at` / `to`, gets the speaker cut out over a dark grid page for exactly the headline's window, as in the approved sample. The build adds a `ground` beat `{at, to, gradient: ["#141414", "#050505"], paper: "grid", gridColor: "rgba(255,255,255,.09)", gridSize: 64, grain: false}` (object fields override these) just before that headline, and then sets `matte: true` and, when the reel leaves them unset, `matteWindows: true` (the cut-out is shown only while the page is up; the rest of the reel is the real footage) and `matteClip: true` (only those frames of the cut-out are extracted at render time). Nothing is added, and no matte is cut, when the reel has no top headline, already has a `ground` beat overlapping the hook, or sets `stage` (a stage has its own set). Skipped with a warning (the reel still builds, the hook gets no ground) when a take has `ramp` (`glow.hookGround: the reel has a ramped take, so the hook at <at>s gets no grid ground (a cut-out cannot follow a speed curve)`) or the reel sets `"matte": false` (`glow.hookGround: the reel sets "matte": false, so the hook at <at>s gets no grid ground`). A reel that sets `"matte": true` itself gets the ground, and its `matteWindows` / `matteClip` are left as it set them (unset = off, the full-length cut-out as before). The ground's fields: the defaults, then the `glow.hookGround` object's fields, then `at`, `to`, `type: "ground"` (an array value is ignored). `glow_plan.py` no longer writes a ground: build.mjs adds it, so it follows the style's `extends` chain. On a single-recording reel with no take transition and no cached `assets/talk-matte.webm`, only the recording around the hook (+-1 s) is cut out, into `assets/talk-matte@<startMs>-<endMs>.webm` (see `matteClip`, Window cut); otherwise (several recordings, a take transition, or a reel that sets `matteClip` off) the whole recording is cut, cached as `assets/talk-matte.webm`. Set `MATTE_THREADS` on the machine that builds.
  - `glow.keepLow: true`: a `headline` with `pos: "low"` stays in the lower frame. Without it, a close-up that leaves less than the small line + 170 px under the chin (after punch-ins) sends the headline to the top band, over the forehead; with it the headline sits as low as the safe area allows (its bottom at `safeBottom + 40`, top never above y 980), over the chest, with the big word shrunk only if it would not fit, and no arrow (an arrow would hang under the safe area). It still goes to the top band, with a warning, when its top would be less than 60 px under the mouth line (the face track through the punch-ins: `headline "<BIG>" at <at>: glow.keepLow would cover the mouth, so it goes to the top band`) or when the lower frame cannot hold a big word of `min(its size, 170 px)` (`... glow.keepLow has no room for a big word >= 170px in the lower frame, ...`; on the shipped 9:16 platforms that room is 418-486 px, so this is a guard only). A low headline that has room under the chin is placed exactly as before.
  - Test: `scripts/build-glow.test.mjs` (`glow.hookGround` and `glow.keepLow` cases, the matte stubbed).
- `ground` beat: ported (R1 B1), see the beat table. Not ported: `stage.relight`, and the packs/B-roll he used in his reels.

## Premium kit: Chrome Motion (all opt-in, ported from Ahmed's gadzhi-motion)

Style `gadzhi-motion` (purple) sets them; `gadzhi-blue|green|red|yellow` extend nothing but swap `brand.accent` and `gm.theme`. Real footage with a baked grade, small lux captions, and a full-screen graphic only on 3-4 key beats.

- `sourceGrade: "<ffmpeg -vf chain>"`: a real colour grade baked into the footage once, cached as `assets/<recording>-graded-<hash>.mp4`. **Per recording:** every source is graded separately. `sourceExposure` (default 132, `false` = off) measures that recording's face-zone luma and lifts or lowers its mid-tones with a gamma (0.8-1.35) before the chain, so a dim recording and a bright one land on the same look; the hash includes the gamma. Only the `<video>` tags and the hold/outro stills read the graded file: audio, words, faces and `edit_truth.json` keep the original recording's name (`edit_truth.json` is unchanged). Absent unless set; the grade chain and exposure target are part of the sections `globalHash`. `sourceNeutral` (0..1, opt-in; the gadzhi styles set 0.65): cast neutralising. Each recording's mean chroma (U/V, one sample a second) is measured and that fraction subtracted before exposure and the grade, so a purple LED room comes out steel grey, not magenta (`gadzhi-*` only; `hormozi` does not set it). Higher values over-correct skin toward olive.
- `captions.style: "lux"`: small sentence caps at `captions.fixedY` (default 1540), revealed word by word (`captions.revealDur`, default 0.12 s), uppercase unless `captions.upper: false`, default group 4. ONE emphasis word per line is bloomed 1.5x and lands in a single frame (`captions.emph` words, else the longest word of 5+ letters; `autoEmph: false` = only `captions.emph`). Fixed-height like noir, logged as `mode: "lux"`.
- `scene` kinds `gm-object`, `gm-kinetic`, `gm-flow`, `gm-counter`, `gm-nodes` (`scripts/lib/gadzhi.mjs`; the css is written only when a reel has one). `b.theme` or `gm.theme`: `purple|blue|yellow|red|green`.
  - `gm-object`: `{object, text, textBelow, objY, objW, textY, textBelowY, gap, bigType}`. A 3D object floats in over a halo and floor shadow on grey paper; the words land on their spoken times. `object` is a name in `library/gm-objects` (chart, gears, lightbulb, puzzle, rocket, stopwatch, target) or a project path. `text` tokens: plain = small grey sans, `*x*` = big serif italic in the theme ink, `_x_` = mid serif italic, `^x` = big grey sans; `|` starts a new row; each token lands on the next spoken word that matches it. A row estimated wider than 980 px (a long word or a long line, in `text` or `textBelow`, in `gm-object` and `gm-kinetic` alike) is scaled to fit and centred on its own width, so it keeps at least 50 px clear of each side of the 1080 frame; a row that fits is written exactly as before.
  - `gm-kinetic`: the same type, bigger, no object.
  - `gm-flow`: `{title, items: [{icon, label, at, x, y}]}` glass icon tiles joined by drawn curves (16 built-in line icons).
  - `gm-counter`: `{icon, value, prefix, suffix, label, countAt, countDur, ground}` a glass card with a number counting up.
  - `gm-nodes`: `{nodes: [{n, at}], object, objY, objW, pill: {text, at, y}}` numbered chips with dotted lines into an object.
  - Scene sounds (whoosh-2, tick-1, pop-2, click-1, tech-ui-confirm) are all optional: a missing one is skipped with the usual warning.
  - Inputs a planner has to supply per scene: `at`/`to` (recording seconds inside one kept take), the spoken words that become `text` tokens, an `object` name (money/ROI/return/goal words map to `target` in Ahmed's director), and for flow/nodes/counter the item times (`items[].at`, `nodes[].at`, `countAt`) and labels/values taken from the transcript.
- Layout from the objects' measured edges: `library/gm-objects/bounds.json` (the alpha bounding box of each PNG, written by `scripts/gm_bounds.mjs`; re-run when an object is added). In `gm-object` the text block is measured and, if it would reach the object's top, the object moves down (and shrinks to end above `maxBottom`, default 1600); a layout that already clears is left as given. In `gm-nodes` the pill defaults to just below the object's bottom edge (a tall object shrinks until object and pill fit above 1740); `pill.y` still overrides.
- `library/gm-objects/*.png`: seven graphite and chrome objects, longest side 1400 px (about 5.4 MB): 3dicons v1, CC0, sources and preparation in `library/gm-objects/SOURCES.md`. `brain` was dropped on 19 Oct 2026 (no CC0 match); `puzzle` replaces it, and a saved reel that still names `brain` renders the puzzle. `PHANTASIC_GM_OBJECTS` points the build at another folder. `scripts/gm_whitekey.py in.png out.png` cuts a new object rendered on a seamless white background (asset preparation only, never run by the build; needs numpy, Pillow and scipy). Not ported: `stage.relight` (it needs the stage matte).

## Premium kit: Authority (all opt-in, ported from Ahmed's hormozi)

Style `hormozi` sets them; `hormozi-blue|green|orange|purple|teal` extend it and change only `brand.accent`. The accent (title box, list numbers, name-card edge) is the css variable `--hz-accent`, set from `brand.accent`. The hz css and the variable are written only when a reel has an `hz-*` beat.

- `captions.style: "hormozi"`: white sentence-case Montserrat 500, default group 3, one keyword per line in weight 800 (`captions.emph`, else the longest word of 5+ letters; `autoEmph: false` = only `captions.emph`), no pop. Fixed height: `captions.fixedY` (1150), and `captions.listY` (720) while a split-screen list is up; both are 9:16 pixels. Logged as `mode: "hormozi"`. It uses the shared emphasis hook (`EMPH_STYLES`) and `fixedYOf()`, a per-block function now (noir and lux keep their constant).
- `hz-title`: `{text, size, y}` a red rounded box with white heavy caps under the caption (`\n` splits lines).
- `hz-name`: `{name, title, avatar, avatarAt, avatarCrop: [x, y, side], src, y}` a white lower-third with a red top edge. With no `avatar`, a round face still is cut from the recording the beat is on (`src`, else the primary one) using THAT recording's face track, centred on eyes and mouth, clamped to that recording's frame: `assets/hz-avatar.jpg` (`hz-avatar-<n>.jpg` for another recording).
- `hz-list`: `{items: [{title, sub, n, at}], lift}` split screen: the footage lifts `lift` px (280), the bottom half goes black and the numbered list builds item by item; captions move to `listY`.
- `hz-note`: `{text, y}` a small grey parenthetical under the caption.
- Colour plumbing: `rgbaOf(hex, a)` and `glowOf("accent")` in build.mjs make glows follow `brand.accent`. The Podcast Glow captions and headline glow now use `captions.color ?? brand.accent` (so `podcast-glow-blue` glows blue, not yellow), and a `stage` or window `glow: "accent"` is the accent at 30%.
- Planner: `scripts/focus_director.py` plans these beats from a transcript - see `references/focus-director.md`.

## Premium kit: Explainer, Mono and Folio hardening (all opt-in, ported from Ahmed's mini2-explainer / mini2-mono / mini2-folio, 9 Oct 2026)

Style ids `keynote-4`, `explainer-2`, `mono-2`, `folio-2`. The base ids `keynote`, `mono`, `editorial-collage` (and `folio-*`) render exactly as before; the fork has no base `explainer`, so `explainer-2` is the whole style. Tests: `scripts/build-ahmed-mini2.test.mjs`.

Shared (Keynote round 1, `keynote-4` extends `keynote-3`):
- `cadence.faceAnchor.fit: true` (+ `maxFaceH`, default 0.4, `margin`, default 36): each punch-in is capped so the zoomed face box (ears included) stays inside the frame and under `maxFaceH` of the frame height; below 1.06 it is dropped. **Per source**: each take uses its own recording's face track and crop plan.
- `leaks.sentenceFallback`: a one-take clip has no joins, so the flash goes on sentence ends (punctuation, else the widest word gap). `leaks.faceSafe`: the flash is masked off the face of the recording on screen. `leaks.peak` (0-1), `leaks.x` / `leaks.y` (% position of the glow). Keynote 3 additions (opt-in, defaults keep the old flash): `leaks.shape: "edge"` (a warm orange burn from alternate frame edges instead of a centred glow), `leaks.blend` (default `screen`), `leaks.hold` (s the flash stays at peak, default 0), `leaks.fadeOut` (burn-out seconds, default 0.55), `leaks.maskScale` (face-hole size vs the face box, default 1.5; a close-up face needs about 0.9). Style `keynote-5` sets them.
- `captions.keywordAt: { word: [source seconds] }`: a keyword treatment fires only on the occurrence the planner picked. `captions.fitLine` (editorial captions only): an editorial caption line whose estimated width is over the fit width shrinks to fit (font size `floor(capSize * width / estimate)`, at least 40 px). Type: `true` = fit to 900 px | a number > 0 = fit to that many px (values below 400 are raised to 400) | `false` or absent = off. Any other value (a string, `0`, a negative number) is **off**; before mac/keynote-fit any truthy value (e.g. a string) meant 900. `keynote` sets `820`, the `.eblock`'s own width (1080 - 2 x 130), so a long script keyword stays inside its grey box and the frame; `keynote-3` sets `false` and `keynote-4` sets `true`, so neither changes. `captions.backingUntil` (all caption styles that use the close-up grey box: editorial `.ebacked` and the cap-group `.cap-backed`): a number, in edit seconds, no default (absent = off; a non-number is ignored). A caption block placed under the mouth (close-up fallback) keeps the grey box only if it starts before this time; later ones get the heavy text shadow of `backing: false`. A block "starts" 0.05 s before its first word, clamped at 0, the same in both paths. `backing: false` still wins (no box anywhere). `keynote` sets `2`: the approved sample shows the box on its opening lines only. `captions.editorialShadow: "strong"`: shadow on editorial caption words (the existing `captions.shadow: "strong"` only reaches the serif style).
- `music.fallback: "<id>"`: if the bed is not on disk, play this one; if that is missing too, build without music (with a warning). Nothing changes without the key.
- `master: { lufs, ratio, threshold, lra, postLimit }`: written to `build/master.json` for a caller to hand to `scripts/master.py` (`--lufs --ratio --threshold --lra --post-limit`). Apply it with `master.py in.mp4 out.mp4 --from-json build/master.json` (explicit flags win). `master.fadeOut` (s, opt-in) also writes `fadeEnd` (= where speech ends + 0.06 s) so the voice fades out with the speech (`master.py --fadeout --fadeend`); styles `headline-3`, `monk-4`. `master.py` without the new flags is unchanged and the default stays -14 LUFS. Ahmed's key was `tp`; renamed `postLimit` because the fork's `master.py --tp` already means the `--limiter` ceiling.
- `prep.sh` with `FACE_CROP=1` (9:16 only, landscape sources, needs python + OpenCV): `scripts/face_crop.py` crops around the speaker instead of the centre. Only its static result is used; a panning or letterboxed ("fit") result cannot be written into the crop plan, so those fall back to the centred crop with a message. Off by default (Ahmed's was on by default).
- `-strict unofficial` is now passed to the hold-still and outro-still grabs (ffmpeg 7.1 refuses mjpeg from tv-range YUV without it). No effect on `index.html`.

Explainer (`explainer-2`):
- beat `effect` `{lines: [{text, at, box}], y, color, fit}`: the hook title, small spaced caps / one boxed word / small spaced caps. `fit` shrinks the boxed word to fit 1080 px.
- scene kind `cutout` `{ground: paper|chalk|maroon|slate, art | engraving | word, tilt, barsY, barChars, maxBars, wordSize, wordX, wordH, wordTop}`: a painting or engraving on torn paper, or the key word set big (`word`), while the spoken words type into black bars. `barChars` breaks bars by length instead of every 3 words. Entry sound: `sound.cutout` (default `paper-page-turn`; `false` = none), `sound.cutoutDb`.
- `captions.pillKit: true` with `captions.size`, `light`, `radius`: the pill caption's size / white-pill-dark-ink / corner radius, and words inherit the pill's ink. `captions.reshowLate`: captions come back after a hard-cut page is gone instead of 0.05 s before it ends.
- The CSS of `effect` and `cutout` is written only when a reel has one.

Pitch (`pitch`):
- beat `titlebox` `{text, at, to, y (default 250), color (default brand.accent), size (default 66 px), typeFor (max type-on time, default 0.8 s; at most 45 ms per letter, so a short title types faster)}`; plays `typing-1` while it types: the hook title typed letter by letter into an accent box that slides in tilted from the left and settles centred (`left: 50%` + `xPercent: -50`), growing with the letters. Its `.tbox` / `.tbox-in` CSS is written only when a reel has one.

Mono (`mono-2`, `scripts/mono_plan.py` v5):
- `brand.footScrim` (0-1): a dark gradient behind the words on footage pages. `brand.iconSfx` / `b.iconSfx`: the icon pop sound. `brand.film` / `look.grade`: grayscale footage.
- stack beat: `punchOrigin` ("50% 30%": punch in around the face), `fit` (0.6-1: a close-up shown smaller from the top over a blurred copy), `cardH` / `cardW` / `cardRadius` (a portrait card), `filmFace: [x, y]` (frame the card / phone film on the face, source 1080x1920 px). Every `stack` field: "Page scene kinds" under Motion layer.

Folio (`folio-2`, `scripts/folio_plan.py`):
- `objectPops.faceAware: true` (+ `minScale`): the card goes in the reaction slot beside the head of the recording on screen (`placer.slot`), and is skipped when the face fills the frame.
- `endFade: <seconds>`: the picture dips to black at the end. `sfxFallback: { "<id>": "<other id>" | "none" }`: a sound whose file is missing plays the stand-in. `openFlash.clipOptional: true`: a missing burn clip no longer fails the build.

Planners (`explainer_plan.py`, `mono_plan.py`, `folio_plan.py`) are deterministic Python (no API key); they read `reel.json`, the transcript and `build/face.json` of the PRIMARY recording only, and write beats into `reel.json`. Not wired into the studio.

## Ahmed's style library (all opt-in, phase B2; hand port of phantasic origin/main `engine/core/styles` + the fix2 / mini2 branches)

Style ids: `library/<id>` (114 styles in `styles/library/`, e.g. `library/podcast-punch--19`; the name is `library/` plus an id, nothing else with a slash is accepted), `podcast`, `breakdown`, and the hardened looks `gold-ledger`, `northstar`, `red-poster`, `magazine-spread`, `monochrome-cinema-stark`, `name-reveal`. A library style extends a fork base (`clean`, `closer`, `cinematic`, `monologue`, `mono`, `pitch`, `editorial-collage`, `podcast`) or another library style.

Keys and fields the renderer reads for them (each emits nothing unless set):
- `look.rootBg`: the page colour behind the picture (default `#000`). `zoom.originY`: `#base` scales from `50% <originY>%`. `matteFilter`: a CSS filter on the cut-out layer. `watermark.spread: true`: the watermark words spread across the full width, one span each (Magazine Spread's header). `conceptCenter: true`: concept-scene engravings stay centred while they scale. A concept `engravings` name containing a `/` is the project's own picture (`assets/x.png`), not a library engraving.
- `popcard` / popcard beat: `object` (cut-out PNG, no photo frame), `objectFilter`, `glow`, `stage` (a full-frame page behind the card, any CSS background), `outFade` (seconds; the card leaves before the focus returns), `dim` (the defocus brightness, default 0.72), `labelSize`. Each is also a beat field except `objectFilter`/`glow`. The popcard's own CSS (`.popcard`, `.popcard-img`, `.popcard-lab`) is written only when a reel has a popcard, and the bars card's `.ui-bar` rule only when a popcard has `ui.type: "bars"`.
- beat `pills` `{at, to, y, w, items: [{text, glyph, at}]}` with style `pills: {w, h, gap, tab, color, size, y, sfx, sfxDb}`: the UI Story Ad #10 checklist (glyphs: check doc report chart people globe image book archive museum home shield heart clock star bolt mask tree).
- scene kind `title` `{at, to, lines: [string | {text, at, size}], size}`: the Breakdown hook title (navy card, condensed serif caps, the block shrinks ~15%). scene kind `chapter` `{at, to, num, tone: navy|paper|blue|cream, serif: [words], fit, fitWidth, sfx}`: a chapter card with a giant numeral and the spoken words one at a time; `fit: true` steps a long word down to `fitWidth` (default 960 px). Their CSS is written only when such a scene exists.
- scene kind `wordpage`: `bg: "black"` (white words on black), `ink` (word colour), `gold: [words]` + `goldColor`. scene kind `highlight`: `boxColor`, `boxInk`, `ink`. Full field lists: "Page scene kinds" under Motion layer.
- `boxline.dodgeFace` / `boxline.fitLabel` (style keys): the box and its name label never cover the face and stay inside the frame; beat field `prefer: "above"`. `captions.dodgeMouth` (duo captions with `fixedY`): px of clearance under the mouth. `captions.chestBand` (cluster captions; with `chinPad`, `chinMax`): on a close-up the caption goes under the chin or is dropped.

Carried as data, not read by the renderer yet (the style still builds; these only matter once the code lands): `sound.complete` (the fork styles that carry it are unchanged; the premium styles use `sound.completeMix`, see "Premium line"), `prep.speakerCrop` (a prep.sh option), `monochrome.*`, `podcastPunch.*`, `mono.hookRotation` (read by Ahmed's planners), and the hardened-look keys `zoom.fit.always/maxBase/blur/dim/sat/radius` (+ `capRoom`, `minBase`, `top`, `punch`), `safeTopMin`, `captions.underChin/floor/hardFloor/keepUnderUi/uiRoom/stillY/chinAlways/chinMid/noWeakEnd/properCase/minLead/shrinkHero/scriptLead/scriptHold`, `pills.floor/textWith`. The framed close-up guard (`zoom.fit`) needs `safezone.mjs` to know each take's own card size, which is not in the fork.

## Motion layer (scripts/lib/motion.mjs)

Top-level fields:

- `brand`: `{accent, accentDark, ink, capSize, font}`. A 60/30/10 kit: one accent, a darker accent for text on light scenes, ink for dark text. `font: "Montserrat"` is bundled with Latin and Cyrillic.
- `zoom.base`: a constant punch-in on the speaker, for example `1.8` with `origin` at the face. `pushes[].sfx` puts a whoosh on a push-in.
- `captions.style: "editorial"`:
  - Lowercase lines of `group` words.
  - The spoken word resolves out of blur in bold white. The previous line relaxes to a light weight.
  - A block is two lines, or a tag pill plus two lines.
  - `tags: ["for Gen Z", "Gen Z"]` renders those phrases as tilted accent pills. List longer phrases first.
  - `highlight: ["fundamental"]` wipes an accent box behind the word.
  - `y` is the top of the block (default 1150).
- `music`: `{id | src, db: -20, fadeIn, fadeOut, start}`. The bed is set `db` below the -16 LUFS voice, from the track's own measured loudness. The library is `library/music/manifest.json`.

`scene` beats are full-screen graphic scenes over the continuing voice. Captions hide during a scene unless `captions: true`.

- **Transitions:** `in` is `blur` (default), `expand`, `wipe`, `glitch`, `slide` or `cut`. A style can set `scenes.default_in`, or set `sceneIn`/`sceneOut` at the top level to change the style-wide default without touching every beat (R1b). `out` takes the same set. Each out mirrors its in and runs slightly faster, and `wipe` out closes the left edge so a wipe in/out pair travels one way rather than bouncing back. `slide` (Broadsheet, R1b): a sheet of paper slapped down from the right, a little rotated, settling flat; its out keeps travelling the same way, off to the left. **Out transitions add no sound** - the whoosh on expand and wipe is played once, on the way in. A scene that ends where an expand or wipe scene starts stays underneath for 0.45 s.
- **Sound:** default sounds are listed per kind below; expand and wipe also get a whoosh.

`takes[i].transition` (I-17) is a **different** transition from the one above: it is the join FROM
the previous take, video-to-video, not a scene coming over the speaker plate. `"blur"` (0.18s
dissolve-through-blur out, 0.22s in) or `"whip"` (a fast blurred pan: out slides left, in slides
in from the right, 0.12/0.16s) replace that one hard cut; omit for the default cut. Both are
SFX-free by construction - unlike the scene `expand`/`wipe` above, nothing here plays a sound, so
a take join never depends on `library/sfx/` having a file behind the id. `takes[0].transition` is
ignored (no earlier take to join from) and a transition right after a `hold` dies at build
(nothing to dissolve from - resolve the hold first, or drop the transition).

`takes[i].transitionDur` sets how long that join lasts, in seconds, 0.1 to 1.5. It is the TOTAL
length: the out and in halves keep the kind's own proportion, so `"blur"` with `0.8` is 0.36s out
and 0.44s in. Omit it for the lengths above. Each half is still capped at half the take it plays
over. A value outside the range, or one that is not a number, dies at build. It is ignored on a
take with no `transition`.

| kind | fields | what it looks like |
|---|---|---|
| `card` | `bg`, `y`, `lines:[{text, at, size, color}]`, `pill:{text, at, size, gap}`, `cursor:{clickAt, dx, dy}` | Centred text plus a tilted accent pill; a cursor flies in and clicks it (ring, press). Sounds: pop, then click |
| `stats` | `bg:"accent"`, `badges:[{value, sub, at, label:"follow **bold part**", labelAt}]`, `centerY`, `gap` | Glass ring badges land big (whoosh). On `labelAt` they shrink into a row with the label typed beside them, and earlier rows re-centre |
| `fly3d` | `bg`, `items:[{text, sub, at, x, y, z, size}]`, `cam:{from, to}`, `focus`, `ease` | Words in 3D space; a camera dolly moves through them, and blur and grey level follow the distance to focus. Seek-safe painter. Sounds: riser, whoosh per word |
| `image` | `src`, `zoom:[1, 1.1]`, `grade`, `captions: true` | A full-bleed still with a slow push. AI B-roll comes from `scripts/broll_gen.py` |
| `clip` | `src`, `in` (start later in the clip), `zoom:[1, 1.1]`, `grade`, `fit: cover|contain`, `audio: true`, `captions: true` | A full-bleed **video** you supply: a screen recording, B-roll, a second angle. Cut straight in, no tilt and no pop - use a `meme` beat for a tilted overlay from the library. **Muted unless `audio: true`**, because B-roll normally runs under the speaker's voice. `in` seeks into the clip, so one long capture can serve several beats. |
| `ui` | `title`, `label`, `prompt:{text, at, cps}`, `lines:[{text, at}]`, `y` | Dark app/terminal window: the prompt types in (typing sound), result lines tick in with checks. Product launches |
| `device` | `src` (an image) or `lines:[{text, at, me}]`, `label`, `y` | A phone frame rises and floats; an image or a mini chat whose bubbles pop in |
| `kinetic` | `text` (`*keyword*`, `_filler_`), `bg`, `size`, `zoom`, `pullback`, `pip`, `pipX`, `pipY` | Full-screen word-by-word type aligned to the spoken words; a camera glides from word to word, then pulls back. `pip: true` shrinks the speaker into a round window |
| `sentence` | `bg`, `lines:["...", "..."]`, `hero:{text, at, size, color}`, `sub:{text, at, cross, crossAt}` | Words ink in as they are spoken (matched to the transcript), then shrink up while a big accent hero lands (impact). The `cross` word gets a drawn X |
| `window` | `src` or `self` (source seconds - the speaker's own footage), `y`, `grade`, `zoom` | none | Like `image`, but framed in a rounded vintage window on black. `self` needs no library asset |
| `paper` | `lines:[{text, style: "serif"\|"box"\|"marker", at, size, rotate}]`, `y`, `align`, `engraving` | whoosh/pop per line (`sound.lines: false` to silence) | A grid-paper cutaway for one key statement: a serif line, an accent-box keyword, a handwritten note. **With `engraving` set** (a `library/engravings/png/<key>.png` concept), the beat is auto-converted to a laid-out `collage` scene instead (`pageToCollage()`, R1b): the lines become sized/positioned text items, the engraving is placed under them, and `spec.pageMap`/`pagePaper`/`pageScreen` (set by the style, e.g. Broadsheet's `pageMap` remaps `serif`/`box`/`marker` to `deck`/`headline`/`kicker`) reshape the result - see `references/styles.md` |
| `tv` | `items:[{src \| self, dur, media}]`, `flipSfx` | tick-1 per channel flip (2+ items only) | A montage of clips/stills on a vintage CRT, for "distraction", "noise", "everyone else". `{self: 0}` (the default) needs no library asset |
| `collage` | `paper: "grid"\|"plain"\|"newsprint"`, `screen`, `bulge`, `zoom`, `items:[{type: "text"\|"image"\|"sticker"\|"glasses", style: "serif"\|"caps"\|"dark"\|"box"\|"marker"\|"italic"\|"headline"\|"kicker"\|"deck", ...}]` | pop/whoosh per item, gated on `sound.lines`/`sound.objects` | The vintage engraving-and-sticker "old school" look. Usually reached via a `paper` beat's `engraving` field, not written by hand. `image`/`glasses` items read `library/engravings/`. `newsprint` paper (R1b, Broadsheet) and the `headline`/`kicker`/`deck` text styles are for the newspaper look; `grid`/`plain` and the other text styles are the original Alif/Keynote vintage-collage look |
| `wordpage` | `bg`, `paper`, `size`, `big`, `serif`, `ink`, `gold`, `goldColor` (full list below) | The spoken words one at a time on a flat accent, black or paper page |
| `highlight` | `lines:[{text, at, box, size}]`, `paper`, `size`, `y`, `ink`, `boxColor`, `boxInk` (below) | Lines ink in word by word as spoken; a `box` line grows an accent box under its words. Sound: click on a box line |
| `cardpage` | `items:[{at, art \| logo}]`, `paper`, `w`, `y`, `labelSize` (below) | A small framed picture swaps stop-motion style while the spoken words show under it. Sound: click per swap |
| `concept` | `word`, `size`, `fonts`, `step`, `bg`, `engravings`, `tickSfx`, `tickDb` (below) | One word cycling typefaces over engravings that swap on the beat |
| `stack` | `lines:[{text, role, say, at, size, color, enter, ring, pulse}]` or `lead`/`key`/`tail`, `bg: accent\|paper\|footage\|card\|phone`, icon, flip and footage fields (below) | Mono's lead / HUGE key / tail statement. Sound: click as the key lands, pop on the icon |

Ported from main's `engine/core` (BRANCH-AUDIT.md R1): `window`, `paper` and `tv`
need no library assets and are the three of the four actually exercised by
that port's own test build. `collage`'s `image`/`glasses` items and the
`paper`-with-`engraving` auto-conversion need `library/engravings/` (ported
in R1b, along with `objectPops`, above) - build-verified against a real
recording in R1b; see `references/styles.md`.

### Page scene kinds: `wordpage`, `highlight`, `cardpage`, `concept`, `stack`

Flat graphic pages ported from main's `engine/core` (the mono / pitch / monologue templates; `stack` is
Mono's three-tier statement). They take the common scene fields above (`at`, `to`, `in`, `out`,
`captions`, `inSfx` / `inSfxDb`). "Spoken words" means the transcript words that start inside the
scene (from 0.05 s before `at` up to `to`), shown one at a time in speech order. Times are source
seconds like every beat time. `look.cleanScenes: true` keeps the tint, vignette and grain off
`wordpage`, `highlight` and `cardpage` pages (not `concept` or `stack`).

**`wordpage`**: the spoken words one at a time, each resolving out of a blur, centred on a flat page.

| field | type | default | what it does |
|---|---|---|---|
| `bg` | `"accent"` \| `"black"` \| any other string | `"accent"` | `accent`: brand-accent page, white words. `black`: black page, white words (Monochrome Cinema). Anything else: a paper page (`paper`) with accent words |
| `paper` | CSS colour | `#F3F3F3` | page colour when `bg` is neither `accent` nor `black` |
| `size` | number (px) | `118` | word size |
| `big` | string[] | `[]` | words drawn 1.5x (the payoff of the line); matched case- and punctuation-insensitively, like every word list here |
| `serif` | string[] | `[]` | words set in the italic display serif, 1.2x |
| `ink` | CSS colour | white on accent/black, `brand.accent` on paper | colour of every word |
| `gold` | string[] | `[]` | words drawn in `goldColor` instead of `ink` (one coloured payoff word) |
| `goldColor` | CSS colour | `#F2C94C` | colour of the `gold` words |

No sound of its own (use `inSfx`).

**`highlight`**: a white page of lines that ink in word by word as spoken; a `box` line grows its accent box one word at a time under white type.

| field | type | default | what it does |
|---|---|---|---|
| `lines` | `[{text, at, box, size}]` | `[]` | the lines, top to bottom (below) |
| `paper` | CSS colour | `#F3F3F3` | page colour |
| `size` | number (px) | `104` | line size when a line has no `size` |
| `y` | number (px) | `800` | top of the block of lines |
| `ink` | CSS colour | `brand.accent` | colour of plain (non-box) words |
| `boxColor` | CSS colour | `brand.accent` | box behind the words of a `box` line |
| `boxInk` | CSS colour | (the stylesheet's white) | colour of the words on a `box` line (e.g. dark type on a marker-yellow box) |

`lines[]`:

| field | type | default | what it does |
|---|---|---|---|
| `text` | string | required | the line; split on spaces, each word is timed to the next matching spoken word (searching forward from the last match) |
| `at` | source seconds | **required** (a missing or out-of-take `at` fails the build: `E(...) for highlight line: not inside any take`) | fallback timing: a word not found in the speech appears at `at + 0.14 s x` its index |
| `box` | boolean | `false` | the line is a box line: its words wipe in left to right on `boxColor`; `click-1` (-6 dB) on its first word |
| `size` | number (px) | the beat's `size` | this line's size |

**`cardpage`**: a white page with one small framed picture in the middle that swaps stop-motion style, and the spoken words one at a time in the accent colour under it.

| field | type | default | what it does |
|---|---|---|---|
| `items` | `[{at, art \| logo}]` | `[]` | the pictures, in order; each shows from its `at` until the next one's (the last until the scene ends) |
| `paper` | CSS colour | `#F3F3F3` | page colour |
| `w` | number (px) | `380` | picture width; the stage is `w x 1.3` tall, a logo tile is `w x w` |
| `y` | number (px) | `560` | top of the picture stage; the word line sits 40 px under it |
| `labelSize` | number (px) | `86` | size of the spoken words |

`items[]`:

| field | type | default | what it does |
|---|---|---|---|
| `at` | source seconds | **required** (`E(...) for cardpage item` fails the build without it) | when this picture swaps in (a small scale/rotate settle), `click-1` (-8 dB) on each swap |
| `art` | string | | a `library/art/<key>.jpg` painting that fills the frame; a missing key dies (`art '<key>' not in library/art`) |
| `logo` | string | | a simple-icons slug on a white tile, fetched at build time (wins over `art`); an unknown slug dies |

The swap clicks are not silenced by the beat's `sfx`.

**`concept`**: one key word on a white-to-grey card, its typeface cycling every `step` seconds, over engravings that swap on the beat.

| field | type | default | what it does |
|---|---|---|---|
| `word` | string | `""` | the word |
| `size` | number (px) | `120` | word size |
| `fonts` | `[[family, style, weight], ...]` | Instrument Serif, Yellowtail, JetBrains Mono, Inter 800, EB Garamond italic, Gloock | the typefaces it cycles through, in order |
| `step` | seconds | `0.22` | how long each typeface shows; the scene holds `floor(duration / step)` faces (at least 1) |
| `bg` | CSS background | `linear-gradient(180deg, #ffffff 0%, #f1f1f1 45%, #bdbdbd 100%)` | the page |
| `engravings` | string[] | `[]` | `library/engravings/png/<name>.png` pictures, splitting the scene into equal parts, each one swapping in with a small scale settle. A name containing `/` is the project's own picture, used as written. A missing library engraving is not an error: the image is simply blank |
| `tickSfx` | sound id | none | a tick on every typeface swap after the first (Signature) |
| `tickDb` | dB | `-8` | volume of `tickSfx` |

Top-level `conceptCenter: true` keeps the engravings centred while they scale (see the style library section).

**`stack`** (Mono): a statement that grows top-down as it is spoken: small lead words type on, the KEY word lands huge out of a ghosted blur, a small italic tail lands under it. Written either as `lines` or as the short form `lead` / `key` / `tail` (one of each); `lines` wins when both are set.

| field | type | default | what it does |
|---|---|---|---|
| `lines` | `[{text, role, ...}]` | built from `lead`/`key`/`tail` | the stack, top to bottom (below) |
| `lead` | string | | short form: a role `s` line above the key |
| `key` | string | | short form: the role `k` line |
| `keySay` / `keySize` / `keyColor` / `ring` / `enter` | | | short form: the key line's `say` / `size` / `color` / `ring` / `enter` (below). The short form has no `at` or `pulse` |
| `tail` | string | | short form: a role `t` line under the key |
| `keyMax` | number (px) | `240` | cap on the automatic key size, `min(keyMax, 1640 / max(4, characters))` |
| `bg` | `"accent"` \| `"paper"` \| `"footage"` \| `"card"` \| `"phone"` | `"accent"` | the ground (below). Any other value renders as `accent` |
| `y` | number (px) | depends on `bg` (below) | top of the word column |
| `sfx` | sound id \| `false` \| `"none"` | `"click-1"` | the sound when a key line goes solid (-10 dB); `false`/`"none"` also silences the icon pop |
| `icon` | string | | a `library/engravings/png/<icon>.png` engraving drawn above the key as an ink-coloured mask; a missing file dies (`asset not found`) |
| `logo` | string | | a simple-icons slug drawn above the key instead (wins over `icon`) |
| `logoFill` | CSS colour | `#fff` | the logo's colour |
| `iconSize` | number (px) | `150` for a logo or on `phone`, else `230` | icon box size |
| `iconAt` | source seconds | 0.08 s after the first key | when the icon pops in |
| `iconSfx` | sound id | `brand.iconSfx`, else `pop-whoosh-light` | the icon pop (-4 dB) |
| `flips` | source seconds[] | `[]` | `accent` and `paper` grounds only: each time swaps the page accent <-> paper and the ink with it, as a hard cut |
| `push` | boolean | `false` | the whole stack scales in from 1.25x out of a blur at the start |
| `self` | source seconds | the beat's `at` | where the speaker's footage starts on `footage`, `card` and `phone` grounds |
| `filmFace` | `[x, y]` (source px, 1080x1920) | none (centred cover crop) | `card` / `phone`: frame the film on the face |
| `fit` | number 0.6-1 | none | `footage`: the close-up shown at this scale from the top edge over a blurred, darkened full-bleed copy, slowly growing 3% |
| `punch` | `true` \| number | none | `footage`: the camera punches in on the key (`true` = 1.22x, then drifts to 1.28x; a number `p` = `p`x then `p + 0.06`x, both times `zoom.base`) |
| `punchOrigin` | CSS transform-origin | `50% 38%` | `footage` with `punch`: the point it punches in around (the face) |
| `tilt` | degrees | `0` | `footage` with `punch`: rotation during the punch |
| `cardH` | number (px) | auto, 560-900 from the stack's height | `card`: the card's height |
| `cardW` | number (px) | none (full width, 70 px margins) | `card`: a fixed, centred card width |
| `cardRadius` | number (px) | `18` (only with `cardW`; else the stylesheet's 44) | `card`: corner radius |
| `handle` | string | `"yourname"` | `phone`: the account name in the fake reels UI |
| `leadY` | number (px) | `230` | `phone`: top of the lead lines (everything before the first key), above the phone |

`lines[]`:

| field | type | default | what it does |
|---|---|---|---|
| `text` | string | required | the line; each word joins the line as it is spoken (matched forward through the speech), so a line grows from its centre |
| `role` | `"s"` \| `"m"` \| `"k"` \| `"t"` | `"s"` (any non-`k` value other than `m`/`t` is a lead) | `s` small regular lead, `m` bold mid line (`brand.midSize`, 96), `k` HUGE key, `t` small italic tail (`brand.tailSize`, 46) |
| `size` | number (px) | leads: the stylesheet's `max(brand.leadSize ?? 54, brand.minLead ?? (brand.leadSerif ? 62 : 50))`, so 54 unless `brand.minLead` or `brand.leadSerif` raises the floor; automatic for a key (see `keyMax`) | this line's size |
| `say` | string | `text` | `k` only: the spoken words the key is timed to (when the key is shown differently from how it is said) |
| `at` | source seconds | the first `say` word's start | `k` only: when the key appears |
| `color` | CSS colour | the ink | `k` only: the key's colour |
| `enter` | `"letters"` \| `"rise"` | ghost (a pale blurred copy that goes solid as the last `say` word starts, 0.16-0.5 s after it appears) | `k` only: `letters` builds the key letter by letter out of a blur; `rise` lifts it from below, stretched |
| `ring` | boolean | `false` | `k` only: a hand-drawn ellipse draws round the key once it is solid |
| `pulse` | boolean | `false` | `k` only: a ring bursts out from behind the key and the key bumps 1.18x as it lands |

A non-key word not found in the speech falls back to the scene start (the first line) or 0.3 s after the first key above it (the scene start when there is none), plus 0.12 s per word.

Grounds:

- `accent` (default): the brand-accent page, white words, column `y` default `max(260, 900 - height / 2)`.
- `paper`: `brand.paper` (`#FEFEFE`), accent words, same `y` default.
- `footage`: a transparent page over the speaker's picture (`brand.film`, e.g. grayscale), white words with a shadow (`brand.footKey` for the key), column `y` default `max(760, min(1080, 1460 - height))`; `brand.footScrim` (0-1) adds a dark gradient behind the words.
- `card`: the speaker's footage in a rounded card on the accent page, words under it (`y` default `330 + cardH - 60`, where `cardH` is always the automatic card height: a known quirk, an explicit `cardH` resizes the card but does not move the words, so set `y` with it). On a light accent the words take a dark ink and the key's ghost stays at 60 %.
- `phone`: the footage in a phone with a reels UI on the accent page; the icon sits in a tile on the phone and the lines from the first key on start at `y` (default `1480`).

The word column never starts above the platform's safe top. Brand keys read by the stack's stylesheet: `brand.leadSize`, `brand.minLead`, `brand.leadSerif`, `brand.midSize`, `brand.tailSize`, `brand.keyFont`, `brand.footKey`, `brand.film`, `brand.paper`, `brand.leadColor`, `brand.iconSfx`, `brand.footScrim`.

Helpers:

- `scripts/autocut.py talk.mp4 --noise -30` prints `takes` for a single clean take. It cuts pauses from the audio, because whisper's word times hide them.
- Scene times may sit up to 1.2 s inside a removed pause; they snap to the next kept moment.
- Each whisper word belongs to the one take it overlaps most, so boundary words are never duplicated.

## Lottie element (`shape: "lottie"` in a motion beat or motion layer): spec (CP1), compiler not built yet

Status: **spec (CP1), compiler not built yet.** Nothing below is read by `build.mjs` today; a reel that
uses it gets the existing `unknown shape 'lottie', dropped` warning. Phase 2 (CP2) builds it exactly as
written here. The PC builds the validator and the picker against this section at the same time.

**Where it lives, and why.** A Lottie is a seventh `shape` in the element list of the `motion` vocabulary
(`docs/MOTION-GRAPHICS-SPEC.md` in phantasic; `compileMotion` in `scripts/lib/motion-graphics.mjs`), so
it works unchanged in a `type: "motion"` beat AND in a `kind: "motion"` entry of `layers[]`. Not a beat
type: a beat type is a fixed treatment with its own placement and sound, while a Lottie is a positioned
graphic that the designer combines with text, shapes and images in one composition and animates with
the same tweens (fade in, scale, move). Not a scene kind: scenes are full-screen takeovers, and most
Lottie use is a sticker-sized accent next to the speaker. Not a new `layers[]` kind: a motion layer
already carries elements, so a layer gets Lottie through the element for free, with the same timing
rules (beat: seconds from the beat's start, 0.6 to 8 s; layer: seconds from the layer's start, any
length). One shape covers the three places with one compiler path and one validator rule set, and it
keeps the motion contract: explicit geometry, no model-written code, every frame a pure function of
time. The A3 elements that follow (chart, icon, mockup, particles) take the same route.

```jsonc
// inside "elements" of a { "type": "motion", ... } beat or a { "kind": "motion", ... } layer
{ "id": "tick", "shape": "lottie",
  "src": "assets/lottie/check.json",     // OR a library id: "check-burst"
  "x": 690, "y": 260, "w": 300, "h": 300, // the box on the canvas, px, top-left origin
  "fit": "contain",                       // contain | cover | fill
  "start": 0.2,                           // s after the beat (layer) starts; frame `first` is shown until then
  "speed": 1,                             // 0.25..4, x the file's own frame rate
  "loop": false,                          // false: play once, then hold the last frame
  "frames": [0, 45],                      // optional [first, last) in the file's frames; default [ip, op)
  "z": 3, "opacity": 1, "rotate": 0 }
```

### Fields

| field | type | unit | default | required | rule (out of rule = what happens) |
|---|---|---|---|---|---|
| `id` | string | | | yes | `[a-z0-9-]{1,24}`, unique in the beat/layer (existing element rule: dropped) |
| `shape` | `"lottie"` | | | yes | literal |
| `src` | string | | | yes | either `assets/<path>.json` (project-relative, no `..`, the resolved file inside `<project>/assets/`, lowercase `.json` only; `.lottie` dotLottie zips are refused) or a library id `[a-z0-9-]{1,48}` listed in `library/lottie/manifest.json`. No URL, no absolute path. Source problem (below) |
| `x` `y` | number | px | | yes | -4000..6000 (existing element rule: dropped) |
| `w` `h` | number | px | | yes | > 0 (existing rule: dropped). At least 20 % of the box area must lie inside the canvas (W x H, 1080 x 1920 for 9:16): source problem |
| `fit` | string | | `"contain"` | no | `contain` (letterbox inside the box) / `cover` (fill the box, crop) / `fill` (stretch). Else warning, `contain` |
| `start` | number | s | `0` | no | 0 .. (span - 0.05), where span is the beat's `to - at` or the layer's `dur`. Before `start` the element shows frame `first`. Out of range: warning, clamped |
| `speed` | number | x | `1` | no | 0.25..4 (no reverse play). Out of range: warning, clamped; not a number: warning, 1 |
| `loop` | boolean | | `false` | no | `false`: plays `first` .. `last - 1` once, then holds `last - 1`. `true`: wraps back to `first`. Not a boolean: warning, `false` |
| `frames` | [int, int] | file frames | `[ip, op]` of the file | no | whole numbers, `ip <= first < last <= op` (`last` exclusive, like `op`). Else warning, `[ip, op]` |
| `z` `opacity` `rotate` | number | | 0 / 1 / 0 | no | existing element rules (0..9, 0..1, -180..180 deg) |

Tweens: a Lottie element takes the node keys an `image` takes, under the existing tween rules: `x y scale
scaleX scaleY rotate opacity blur reveal` (`blur` under the existing two-element / half-canvas limits).
`draw` and `count` are ignored with the existing warnings. Tweens move the box; the animation's own frames
are driven only by `start`, `speed`, `loop` and `frames`. Limit: **3 Lottie elements per beat or layer**
(they count toward the 12 elements); the rest are dropped with a warning.

### The file (checked by the build at compile time; the validator runs the same checks)

- Size at most **2 097 152 bytes** (2 MiB): it is inlined into `index.html`.
- Valid JSON whose top level has numbers `fr` (1..120), `ip`, `op` (`op > ip`, `op - ip <= 10000`),
  `w`, `h` (1..8192) and an array `layers`.
- **Vector only.** Every layer, at the top level and inside every precomp in `assets[].layers`, has
  `ty` 0 (precomp), 1 (solid), 3 (null) or 4 (shape). No image (2), text (5), audio (6), camera (13) or
  other types: image and font loads are asynchronous and would race the first frame.
- **No expressions**: no property object carrying a string `x` (After Effects expression). The bundled
  player is `lottie_light`, which does not evaluate them, so the file would render differently from
  what was authored.
- A library file must match the `sha256` in its manifest entry (a changed file would change the bytes
  of every reel that uses it).

### How it renders (deterministic, no autoplay, no network)

- **Player:** `lottie-web` pinned at **5.12.2**, file `build/player/lottie_light.min.js` (MIT, SVG renderer
  only, no expression engine). Bundled with the engine like GSAP (task mac-10: same vendor folder and the
  same copy-into-the-project step), never loaded from a CDN. The `<script>` and the data are written **only
  when the reel compiles at least one Lottie element**, so every existing reel builds byte-identically.
- **Data inlined**, not fetched: each distinct file is written once into the page as
  `<script type="application/json" id="lottie-<sha8>">` (minified) and passed as `animationData`, so the
  load is synchronous and there is no XHR or `file://` fetch.
- `lottie.loadAnimation({ container: #<uid>-a, renderer: "svg", loop: false, autoplay: false,
  animationData, rendererSettings: { preserveAspectRatio, progressiveLoad: false, hideOnTransparent: true } })`,
  then `anim.setSubframe(false)`. `preserveAspectRatio` is `xMidYMid meet` (contain), `xMidYMid slice`
  (cover) or `none` (fill).
- **The GSAP timeline is the only clock.** One proxy tween per element, `ease: "none"`, from the
  element's `start` to the end of the beat/layer, with a `modifiers` callback (not `onUpdate`: the
  renderer seeks with events suppressed, see the count-up comment in `motion-graphics.mjs`) that computes
  the frame from the elapsed time `e` (seconds since `start`, floored at 0) and calls
  `anim.goToAndStop(f - ip, true)`:
  - `n = last - first`, `p = Math.floor(e * fr * speed + 1e-6)` (`fr` = the file's own frame rate)
  - `loop: false`: `f = first + Math.min(p, n - 1)`;  `loop: true`: `f = first + (p % n)`
  - plus a `tl.set` at time 0 that shows frame `first`.

  Whole frames only, the same frame for the same time from any seek order, in any worker; nothing reads
  the previous frame, so a loop cannot drift. A 24 fps file in a 30 fps reel repeats frames as authored.
- **Determinism check (CP2):** `node scripts/motion-determinism.mjs --variant lottie` (a fixture beat with a
  looping and a play-once Lottie, a `start` > 0, `speed` 1.5 and a scale/opacity tween on the box) must
  pass the same reference / shuffled / reverse / cold / repeat comparison as `busy`, and the reel must build
  the same bytes twice.

### Library Lottie files

`library/lottie/manifest.json` (committed; the public fork carries the manifest only) maps an id to
`{ "file": "<id>.json", "title", "tags": [], "fr", "ip", "op", "w", "h", "loopable": bool, "bytes",
"sha256", "source", "licence", "licensed": bool }`. The `.json` files themselves are never committed
(`library/lottie/*.json` except `manifest.json` goes in `.gitignore`); a deployment restores them, as it
does sounds and music. The picker reads the manifest (`tags`, aspect `w/h`, length `(op - ip) / fr`,
`loopable`) and offers ids; the designer writes the id as `src`.

### Problems: what the build does, word for word (the validator mirrors each)

A **source problem** drops the element in a motion **beat** (hard rule 5: a bad graphic is dropped,
not fatal; `compileMotion` never dies) and **dies** in a motion **layer** (layers are placed by the user
and `layers.mjs` already dies on a `src` that is not a file in the project; a user's layer must not
vanish silently). Same reason text in both:

- beat (warning): `motion <beat id>: element <el id>: <reason>, dropped`
- layer (`die()`): `layer <layer id>: element <el id>: <reason>`

| # | `<reason>` (exact) |
|---|---|
| L1 | `lottie src '<src>' is not an assets/ .json path inside the project or a library/lottie id` |
| L2 | `lottie file <src> does not exist` |
| L3 | `lottie id '<src>' is not in library/lottie/manifest.json` |
| L4 | `lottie library file <src>.json is missing (restore the library)` |
| L5 | `lottie library file <src>.json does not match its manifest sha256` |
| L6 | `lottie file <src> is <bytes> bytes (max 2097152)` |
| L7 | `lottie file <src> is not valid JSON` |
| L8 | `lottie file <src> is not a Lottie animation (needs numbers fr, ip, op, w, h and a layers array)` |
| L9 | `lottie file <src> is out of range (fr 1..120, op > ip, op - ip <= 10000, w and h 1..8192)` |
| L10 | `lottie file <src> has a layer of type <ty> (only 0 precomp, 1 solid, 3 null and 4 shape are supported)` |
| L11 | `lottie file <src> uses expressions (not supported)` |
| L12 | `lottie box shows less than 20% inside the <W>x<H> canvas` |

**Warnings** (both places, never fatal; the element is kept with the value named):

| # | text (exact) |
|---|---|
| W1 | `motion <id>: element <el id>: lottie fit '<v>' is not contain, cover or fill, using contain` |
| W2 | `motion <id>: element <el id>: lottie start <v>s is outside 0..<max>s, clamped` |
| W3 | `motion <id>: element <el id>: lottie speed <v> is outside 0.25..4, clamped` (not a number: `... lottie speed '<v>' is not a number, using 1`) |
| W4 | `motion <id>: element <el id>: lottie loop must be true or false, using false` |
| W5 | `motion <id>: element <el id>: lottie frames must be [first, last] whole frames with <ip> <= first < last <= <op>, using [<ip>, <op>]` |
| W6 | `motion <id>: only the first 3 lottie elements are used` |
| W7 | `motion <id>: element <el id>: lottie box crosses the <platform name> UI zone` (any part of the box above `top`, below `H - bottom` or right of `W - right` of `safezone.mjs` `PLATFORMS[platform]`; the face and caption checks stay the validator's, as for every element) |

In a layer the `motion <id>` prefix is the layer's id, as for the existing motion-layer warnings.

`edit_truth.json`: shape unchanged (a Lottie is an element; beats and layers are recorded as before).
Sections: a section build inlines only the Lottie files its own beats and layers use.

Not in this version: colour replacement (tinting a file to the brand), named markers as segments,
reverse play, dotLottie (`.lottie`), image or text layers, expressions.

## Prompt Motion graphic (`kind: "graphic"` layer, `type: "graphic"` beat): spec (CP1), not built yet

Status: **spec (CP1) v3.2.5 (v3.2.5 records PM3's placement as built, `mac/graphic-place` @ 5b3aa1d; v3.2.4 records PM2's security hardening, `mac/graphic-render` @ 4cbdc73; v3.2.3 adds what the PM5 fixtures measured: the streaming-encoder pin, the blob-worker R1 exclusion, authoring for determinism; v3.2.2 resolves the twelve points PM2 hit while building; CP3 PASS at v3; v3.1 answered the PC's eight questions; v3.2 closes four crafted-file bypasses the PC found; v3.2.1 notes the G31 trade-off); PM3 (in the reel) built on `mac/graphic-place`, see "Placement as built (PM3)".**
`build.mjs` and `layers.mjs` place a graphic layer (`kind: "graphic"`) and a `graphic` beat as written here, through PM2's
`renderGraphic` (sandbox + render). The PC mirrors every **static** rule
(G1 to G28) and every placement rule in the validator word for word, at the same time.

A user types a prompt ("a counter from 10k to 80k with sparks"); Claude writes ONE self-contained HTML file;
the engine renders that file on its own, deterministically, to a video; the video drops into the reel as an
overlay with alpha or as a full-frame insert. Categories: Product UI, Phone, Charts, Diagrams, Kinetic type,
Shapes, Particles, Characters, Photos, Music (visualisers), Code. Every one of them is plain HTML, CSS, SVG and
canvas 2d whose every style is computed from `t` inside `window.seek(t)`.

### Design decisions

**1. How a graphic gets into a reel: pre-rendered to its own video, composited as a video layer.** The HTML is
rendered alone (`hyperframes@0.8.81 render` of an engine-written wrapper page, below) to an alpha WebM (overlay)
or an MP4 (insert), cached as `assets/graphics/<name>-<key16>.<webm|mp4>`, and the reel shows that file in a
`<video>` exactly like a `video` layer. Isolation: the graphic's CSS selectors, globals and DOM never meet the
reel page's (a sub-composition, `data-composition-src`, inlines its `<template>` into the reel's DOM, so a
graphic's `.title {}` or `window.x` would collide with the reel's, and its script would run inside every reel
and section render). Sandbox: the network lock (Chrome launched with no route except loopback, checked by a
fail-closed probe before every render, plus a CSP meta) and the checks for page errors apply to the
graphic's own render, not to a reel page that legitimately loads media. Cache: the key is a pure content hash
(the HTML, its media, the renderer, the placement's frame count), so an unchanged graphic is never re-rendered
when the reel around it changes, and the studio preview IS the file that goes into the reel. An `<iframe>` was
also rejected: the renderer would have to forward each seek across a frame boundary asynchronously, and the
capture path through an iframe is unverified. The cost: the reel render extracts the overlay's frames as PNG
(alpha), so an overlay box smaller than the canvas is cheaper.

**2. Where it lives in reel.json: a `layers[]` kind and a beat type, one element, the same fields.** The
studio writes the user's choice as a **layer** (`kind: "graphic"`, `"by": "user"`): output seconds, pinned or
anchored to a take, the existing layer machinery (timing, clamping, z bands, `overCaptions`, `hideCaptions`,
sections, `edit_truth.json`) unchanged, and the `<video>` it renders is the existing `video` layer's markup.
A planner/designer-placed graphic is a **beat** (`type: "graphic"`): source seconds, so it moves with its words
when a take is cut. Both carry the same graphic fields (`html`, `mode`, `box`, `fit`, `after`, ...) and both
cover `mode: "overlay"` and `mode: "insert"`; an insert is a mode, not a separate kind, because the render path
is the same and only the box (the whole canvas) and the background differ. As for Lottie, a problem **dies** in
a layer (user-placed: it must not vanish silently) and **drops the beat with a warning** in a beat (hard rule 5:
a bad graphic is dropped, never fatal), with the same reason text in both.

**3. The seek contract: `window.seek(t)`, driven by HyperFrames' `hf-seek` event.** HyperFrames 0.8.81's
runtime dispatches `window` event `hf-seek` with `detail.time` (seconds, the frame time `j / fps`) on every frame
it captures; it does not call a global `seek` itself. The engine's wrapper page listens to `hf-seek`, maps the
reel frame to the graphic frame (`in`, `after`) and calls the graphic's `window.seek(t)`. The wrapper's root
carries `data-no-timeline`: without it the render waits 45 s for a GSAP timeline that never registers and warns
`sub_timeline_readiness_timeout` (measured). Randomness comes only from `window.rng(seed)`, a mulberry32 the
wrapper defines before the graphic's scripts (the prompt templates carry the same snippet, so a graphic opened
in a plain browser looks the same).

### The file: `assets/graphics/<name>.html`

A complete HTML document with one `<head>` and one `<body>`, UTF-8, at most 2 097 152 bytes. Inline `<style>`
and inline classic `<script>` only. What it must define, as literal assignments (the validator reads them
without running the file):

```html
<script>
  window.duration = 3.5;                 // REQUIRED: seconds, a number literal 0.5..30
  window.size = { w: 1080, h: 1080 };    // optional: design size in px, even integers; default the reel canvas (W x H)
  // the engine's seeded random (the wrapper defines the same function first; copy it as is)
  window.rng = window.rng || function (seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0; var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  var r = window.rng(42), sparks = [];   // draw every random number ONCE, at load
  for (var i = 0; i < 40; i++) sparks.push({ x: r() * 1080, v: 0.5 + r() });
  window.seek = function (t) {           // REQUIRED: every style computed from t alone
    var p = Math.min(1, t / 1.2), n = Math.round(10000 + 70000 * (1 - Math.pow(1 - p, 3)));
    document.getElementById("count").textContent = n.toLocaleString("en-US");
    /* ... position each spark from sparks[i] and t ... */
  };
</script>
```

**The seek contract, exactly:**

- `window.seek(t)`: `t` is seconds since the graphic's frame 0, always a whole frame `k / fps` (`fps` = the
  reel's fps; a preview is rendered at the reel's fps when the studio knows it, else 30). It is called synchronously, any number of times, in **any
  order** (each render worker is a separate Chrome loading the page fresh, and the determinism check renders
  twice), so the pixels for `t` must depend on `t` alone: no state carried from one call to the next, nothing
  read from the previous frame, no Promise returned. It must not throw.
- `t` covers `0 <= t < duration`. The wrapper never passes `t >= duration` (see `after`).
- Top-level code may build the DOM and draw random numbers at load, synchronously; it must not start anything
  that runs later (no timers, no events, no async).
- `window.duration` (required) and `window.size` (optional) are read statically (G22, G23) and again at render.
- `window.seek` must be assigned (`window.seek = function (t) {...}`): a top-level `function seek(t) {}` alone
  is refused by G21.
- `window.rng(seed)`: `seed` an integer; returns a function giving floats in `[0, 1)`, the same sequence for the
  same seed on every machine. A stream used inside `seek` must be re-created from its seed inside that call
  (or drawn at load), never advanced across calls.
- There is no `window.transparent`: overlay or insert is the placement's `mode`, not the file's. The same file
  can be placed either way; an insert gets an opaque black stage under it (below).
- Fonts: the engine's families (`Inter`, `Geist`, `Montserrat`, `Oswald`, `Unbounded`, `Gloock`,
  `Instrument Serif`, `EB Garamond`, `Playfair Display`, `Caveat Brush`, `Yellowtail`, `JetBrains Mono`:
  `DESIGNER_FONTS` in `motion-graphics.mjs`), generic families, or an `@font-face` whose `src` is a `data:` URI.
  The wrapper inlines the bundled `templates/fonts/*.woff2` the file names, as `data:` URIs.
- Images: a `data:image/...` URI, or `assets/graphics/media/<name>.<png|jpg|jpeg|webp>` in a markup attribute
  (the Photos category: the studio copies the user's photo there). The renderer inlines each such file as a
  `data:` URI before rendering, and its bytes enter the cache key.
  (v3.2.2) Inside a reel the path is relative to the project folder. The standalone CLI (a graphic rendered on
  its own, no reel) resolves it from `<the HTML file's folder>/assets/graphics/media/`.

### How it renders (PM2; deterministic, no network)

- **The network lock (render precondition; v2).** A CSP is not enough: measured in HyperFrames' pinned Chrome
  (HeadlessChrome/152.0.7977.30) with the v1 CSP, `location = url`, a static `<a href>` + `click()`, `open(url)`,
  an inserted meta refresh and `RTCPeerConnection` with a STUN url all reached a non-loopback listener on this
  Mac, and none of them logs a CSP line. The production container has no OS-level lockdown available (the PC
  measured: no CAP_NET_ADMIN / SYS_ADMIN, `unshare` denied, no iptables, no egress firewall). So the requirement
  is **browser-level isolation, the same on every platform**. **The requirement: the graphic page reaches
  NOTHING but HyperFrames' own render server** (`http://localhost:<port>`, the exact origin of that render):
  - **Every graphic render launches Chrome through a `HYPERFRAMES_BROWSER_PATH` shim** (the variable hyperframes
    0.8.81's BrowserManager reads) that execs the pinned `chrome-headless-shell` with, at least:
    `--proxy-server=http://127.0.0.1:9` (a dead proxy: every proxied HTTP(S)/WS request goes nowhere),
    `--proxy-bypass-list=<-loopback>;localhost:<port>` (`<-loopback>` removes Chrome's implicit loopback bypass,
    so loopback is proxied too, i.e. dead, except the ONE exact render origin; see "Closing loopback" below),
    `"--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost"` (no DNS lookups; this also closes the IP
    literals `127.0.0.1` and `[::1]`, which fail with `ERR_NAME_NOT_RESOLVED`: only the NAME `localhost` stays
    resolvable, and HyperFrames serves its page as `http://localhost:<port>` (0.8.81's `createFileServer` binds
    `127.0.0.1` and returns `url: http://localhost:${port}`), so renders work),
    `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` and
    `--webrtc-ip-handling-policy=disable_non_proxied_udp` (no STUN/UDP), and `--disable-quic`. The shim passes
    `--version` straight through to the binary (so the cache key's `chrome` and R13 read the same build).
    **Final flag list (PM2, measured; `CHROME_FLAGS` in `scripts/lib/graphic-render.mjs`):**
    `--proxy-server=http://127.0.0.1:9`, `"--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost"`,
    `--disable-quic`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`,
    `--webrtc-ip-handling-policy=disable_non_proxied_udp`, `--disable-background-networking`, `--no-pings`, and
    `--proxy-bypass-list=<-loopback>;localhost:<port>;127.0.0.1:<port>` where `<port>` is the render server's
    ephemeral port: the Node preload (`scripts/offline-preload.cjs`, in hyperframes' own process) records every
    port that process listens on into `GRAPHIC_RENDER_ORIGINS` before Chrome is launched, and the shim, which
    inherits that environment, builds the bypass list from it (no origin known: `<-loopback>` alone, so nothing
    on loopback loads and the render fails, R10). Measured through `hyperframes render` (scripts/graphic-isolation-check.mjs,
    navigation trap disabled so the shim alone is measured): 0 of 34 routes reached a listener on this Mac's LAN IP or
    on another `localhost` port; without the shim 14 of 34 did (navigations, `open()`, meta refresh, STUN, TURN over UDP and TCP).
  - Measured on this Mac with the flags above minus `--proxy-bypass-list` (puppeteer on the same Chrome, the
    page served from `http://localhost:<port>`, the target the Mac's own non-loopback IPv4 address, the v2 CSP
    below): **0 of 22** routes reached the listener, every page having run (fetch, `new Image`, image-set,
    innerHTML img, document.write script, srcdoc iframe, sendBeacon, eval via constructor, `@font-face` url, SVG
    `<image>`, `location =`, script `<a>` + click, `open()`, form POST, meta refresh, STUN, prefetch, preload,
    WebSocket, static `<a>` + click, dns-prefetch, CSS `@import`). Without the shim, 6 of 22 did (`location =`,
    both `<a>` clicks, `open()`, meta refresh: GET; STUN: UDP). The CP3 re-review measured 0 of 24 more under the
    shim (IP-literal http/https/ftp navigation, TURN over TCP and UDP, `turns:`, WebSocket to an IP,
    preconnect). Through `hyperframes render` itself: a page that navigates at t > 0.3 s and opens a STUN
    connection sent `2 GET /nav` + `3 UDP` without the shim and **nothing** with it; a normal page rendered
    under the shim gave the same 60 frame md5s as without it. (v2 said these pages were served from
    `127.0.0.1`; under the resolver rule such a page does not load, so that run is replaced by this one.)
  - **The probe (R12), fail closed, before EVERY graphic render and inside `scripts/graphic-determinism.mjs`
    (v3.2.2, as built in PM2, `scripts/lib/graphic-probe.mjs`):** the renderer launches the render's Chrome (the
    shim, inside the optional launcher) headless with `--remote-debugging-pipe` on `about:blank` (no CSP; a CSP
    would make the probe fail for the wrong reason) and, over that debugging pipe, fetches `http://1.1.1.1/` and
    `http://169.254.169.254/` (`fetch(url, {mode: "no-cors"})`, 3 s timeout each, real time). Both must FAIL; if
    either loads, the render is refused (R12) and nothing is rendered unlocked. A Node half does the same two
    fetches inside the preloaded render process and reports with the same R12 texts. When the probe cannot run
    (Chrome does not start, the pipe fails, the Chrome or ffmpeg version cannot be read for the cache key, or
    there is no shim) the render is refused with R12's "could not run" text. (`--dump-dom` was not used: with a
    reachable-but-silent host, measured on a blackholed address, the page's fetch hangs on the TCP connect,
    virtual time stops while a request is pending, and the dump never came within 60 s.) Measured on this Mac:
    plain Chrome REACHED `1.1.1.1`; Chrome under the flag shim failed both (TypeError); the parent Node process
    itself CONNECTED to `1.1.1.1:443` (so the probe is not vacuous here).
  - **Platforms (v3.2.2): graphic renders are POSIX-only** (macOS, Linux). Windows has no shim, so the probe
    refuses every graphic render there with R12's "could not run" text.
  - **The container image MUST ship the pinned Chrome (chrome-headless-shell for hyperframes 0.8.81).**
    HyperFrames' first-use download is a network fetch, blocked by the preload and reported as R1, so an image
    without Chrome refuses every graphic render.
  - **Node side:** HyperFrames' own compiler fetches remote URLs in Node (below); the offline preload
    `scripts/offline-preload.cjs` (v3.2.2) covers those.
  - **Optional extra defence, where the OS allows it (not the requirement):** `sandbox-exec` on macOS (measured
    here: a profile `(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip
    "localhost:*")) (allow network-outbound (remote unix-socket))` around the same Chrome also gave 0 of 22 and
    a passing render; Chrome then needs `--no-sandbox`, which hyperframes 0.8.81 already passes), `unshare -n`
    on a Linux host that permits it.
  - **Closing loopback (the requirement; PM2 builds and measures it).** Without `<-loopback>`, loopback is
    open: the CP3 re-review reached a service on `127.0.0.1` with `location = "http://localhost:9320/lh"` under
    the v2 shim (a blind GET; `form-action 'none'` keeps it GET-only). The fix is to proxy everything, loopback
    included, and bypass ONLY HyperFrames' exact render origin `localhost:<port>`, never `localhost` as a whole.
    Measured on this Mac (puppeteer, same Chrome): with `--proxy-bypass-list=<-loopback>;localhost:9310`, the
    page on `localhost:9310` loaded (200, its script ran) and its `location = "http://localhost:9320/lh"` reached
    nothing; with the v2 shim (no `<-loopback>`), the same page reached `/lh`. The catch: hyperframes 0.8.81
    starts its render file server on an EPHEMERAL port (`createFileServer2({ ..., port: 0 })` at every render
    call site; no option or env pins it), and the browser shim does not receive the page URL. PM2 finds a way
    and measures it, for example: the shim runs a tiny local proxy as `--proxy-server` (with `<-loopback>` and
    no bypass) that forwards only to the first origin requested (the render page) or only to a port the parent
    hyperframes process listens on, and refuses everything else. **PM5 / gate requirement (CP3 re-review):** a
    fixture aimed at a SECOND listener on `localhost` (another port than the render server's); the gate passes
    only when that listener sees zero connections during a real `hyperframes render` under the final shim
    (with a control run without the shim that proves the listener is reachable).
  - **Residual risk if the exact-origin bypass is not possible** (documented fallback, accepted by the PC):
    loopback stays open to the NAME `localhost` (IP literals are closed by the resolver rule). The PC measured
    the staging container (same image as production) from `/proc/net/tcp` and `tcp6`: exactly ONE listening
    socket, `[::]:8080`, the Next.js studio (next-server v16.3.6, under podman-init); no database, worker port or
    admin daemon on loopback; render jobs run inside the Next process. A cookieless request to `127.0.0.1:8080`
    gets 404 from the studio's token gate, except the Stripe webhook (POST, signature-verified, and the CSP's
    `form-action 'none'` plus the lock leave only GET) and, on production, the public marketing pages; owner and
    admin routes also check the session; HyperFrames renders in a headless profile with no shared cookie jar.
    So the residual is a cookieless blind GET to our own app, answered 404 or a public page. On the dev Mac,
    whatever listens on the Mac's `localhost` is reachable the same way. The static rules (G8, G25, G27) and the
    CSP refuse the obvious routes to it.
- The engine writes `build/graphics/<name>-<key16>/index.html`: a CSP meta (v2: `default-src 'none'; script-src
  'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src
  'none'; form-action 'none'; base-uri 'none'; frame-src 'none'`), the font `@font-face` rules, the `rng`
  definition and `window.motion` (v3.4, "Motion helpers" below), the graphic's `<head>` content, then `<div id="graphic-root" data-composition-id="graphic"
  data-width="<w>" data-height="<h>" data-start="0" data-duration="<L / fps>" data-no-timeline>` holding the
  graphic's `<body>` content, then the bridge: `window.addEventListener("hf-seek", e => { k =
  Math.round(e.detail.time * fps); window.seek(map(k) / fps) })`, catching and reporting
  (`console.error("GRAPHIC-REFUSED: ...")`) a throw, a missing `seek` or a Promise, and
  (v3.2.2) a navigation trap on the Navigation API: `navigation.addEventListener("navigate", e => {
  console.error("GRAPHIC-REFUSED: navigated"); if (e.cancelable) e.preventDefault(); })` (R11). Not
  `pagehide`/`beforeunload` (v2): measured in PM2, `pagehide` also fires when HyperFrames closes the page at the
  end of every NORMAL render, so a good graphic was refused. `navigate` fires only for navigations the page
  starts (`location =`, link clicks, form submits, refreshes). `open()` is not a navigation of the main page and
  does not fire it; the shim blocks the request it makes. Only the CONTENT of the graphic's `<body>` is kept:
  `<body>` attributes are dropped (consistent with G29, which refuses `onload` and every other handler anyway).
  For `mode: "insert"` the root's background is `#000` (opaque); for `overlay` it is `transparent`.
  Measured: the v2 CSP's `form-action 'none'` stops a script-built `<form>.submit()` POST.
- Measured (HyperFrames 0.8.81, this Mac): a CSP-blocked image and `fetch()` print
  `[Browser:ERROR] ... violates the following Content Security Policy directive ...` and are not loaded; `eval`
  is blocked by the same CSP; a `console.error` from the page prints `[Browser:ERROR] <text>`; an uncaught
  exception prints `[Browser:PAGEERROR] <message>`; and the render still **exits 0**. So the render wrapper reads
  the log and fails closed (deletes the output) on any of those lines.
- HyperFrames' own compiler (Node, before Chrome) downloads remote `<img src>` / `<script src>` URLs itself
  (measured: `[WARN] [Compiler] Remote image download failed`). The render runs with the offline preload
  `scripts/offline-preload.cjs` (v3.2.2; PM2's, GSAP-free, not `vendor-offline.cjs` / `VENDOR_OFFLINE`), loaded
  with `node --require` into HyperFrames' own process: every non-loopback `fetch`, `http(s)` request and socket
  is refused and logged `vendor: blocked <url>` (R1). It also records the ports that process listens on, for the
  shim's exact-origin loopback bypass.
- Frames: `L` = the placement's frame count (exact definition under Cache key). Wrapper frame `j` (`0 <= j < L`) shows graphic frame
  `k = in_f + j` (`in_f = round(in * fps)`, `D_f = round(duration * fps)`), mapped by `after`: `hold`: `min(k,
  D_f - 1)`; `loop`: `k mod D_f`; `cut`: `k` (the placement is shortened so `k < D_f`).
- Output, verified with `hyperframes@0.8.81 render --format webm` / `--format mp4` on this Mac:
  - **overlay**: WebM, VP9 (`libvpx-vp9`), tag `ALPHA_MODE=1`, alpha in the VP9 side channel. `ffprobe` shows
    `pix_fmt=yuv420p` (the native decoder sees the colour layer only); decoded with `-c:v libvpx-vp9` it is
    `yuva420p`. Chrome plays it with alpha in a `<video>` (the reel's `talk-matte.webm` cut-out is the same
    format). Measured: transparent pixels alpha 0, a box at opacity 0.75 alpha 192.
  - **insert**: MP4, H.264 High, `yuv420p`, no alpha. A transparent page renders WHITE in MP4 (measured
    `#fdfdfd`), hence the forced black root.
  - Render command (v3.2.2): the pinned HyperFrames is resolved ONCE, outside the sandbox
    (`npx -y -p hyperframes@0.8.81 -c "command -v hyperframes"`, realpath, its `package.json` must say
    `hyperframes@0.8.81`; inside the sandbox npm waits about 70 s for the registry), then each render runs
    `node <bin> render --format <webm|mp4> -f <fps> -q looks -o <out> <dir>` with the preload and the shim.
  - **Capture mode (v3.2.2): both renders run with `PRODUCER_EXPERIMENTAL_FAST_CAPTURE=false`** (screenshot
    capture). Measured in PM2: a one-worker render on macOS switches to drawElement capture (multi-worker
    renders fall back to screenshots), the two captures differ in pixels (frame 0 differed) and R6 failed.
  - **Encoder (v3.2.3): both renders also run with `PRODUCER_ENABLE_STREAMING_ENCODE=false`.** Measured in PM5:
    with `--workers 1` HyperFrames switches to a streaming encoder, and the decoded frames differ from the other
    render even when the captured pixels are identical.
- **Render hardening (v3.2.4; built in PM2, `mac/graphic-render` @ 4cbdc73).**
  1. **Flag order.** The shim execs Chrome with HyperFrames' arguments FIRST and the network flags LAST
     (`exec <chrome> "$@" <CHROME_FLAGS> "--proxy-bypass-list=$BYPASS"`): Chrome keeps the last copy of a
     switch, so nothing HyperFrames (or anything upstream) passes can override a lock flag.
  2. **Environment.** `GRAPHIC_RENDER_ORIGINS` and `GRAPHIC_SHIM_MARK` are stripped from the environment of every
     child the renderer starts (probe, versions, renders); only the preload inside THIS render's HyperFrames sets
     `GRAPHIC_RENDER_ORIGINS`. The shim keeps only entries matching `^(localhost|127\.0\.0\.1):[0-9]{1,5}$`
     (`;`-separated); anything else (`*`, a host, a wildcard) is dropped, and with none left the bypass list is
     `<-loopback>` alone (nothing on loopback loads, the render fails: R10).
  3. **Shim marker (R13).** The renderer sets `GRAPHIC_SHIM_MARK` to an empty file; the shim appends its PID
     (Chrome's, after `exec`) to it. After the render, an EMPTY marker (Chrome was not launched through the shim)
     or a missing `Browser launched (HeadlessChrome/<v>, ...` log line refuses the render with R13 (`<v>` is then
     `(no 'Browser launched' line)` or `<v> (not launched through the shim)`). The PIDs are also the ones killed
     when a render is stopped.
  4. **Probe.** Only a `TypeError` counts as blocked, in the Chrome half and the Node half; a timeout or any other
     error means the probe could not decide: R12's "could not run" text. The Chrome half also opens a listener on
     a SECOND `localhost` port (not the render server's) and fetches it: it must see 0 connections, else R12
     with that URL.
  5. **Integrity pre-script.** The bridge's first part runs BEFORE any graphic script (placed ahead of the
     graphic's `<head>` content). It keeps the page's own `console.error`, `EventTarget.prototype.addEventListener`,
     `Math.round` and `Math.min` in a closure, installs the `navigate` trap and the `hf-seek` listener first,
     and exposes the refusal function as a non-writable, non-configurable `window.__graphicRefuse` for the
     post-script (the load-time R3 / R5 checks). So a graphic cannot silence refusals by stubbing
     `console.error`, register a `navigate` listener ahead of the trap, or navigate before the trap exists. A
     browser without `window.navigation` refuses: `GRAPHIC-REFUSED: navigation trap unavailable (no
     window.navigation)`, reported as R2 (`graphic page error: navigation trap unavailable (no window.navigation)`).
  6. **Hangs.** Each render runs as its own process group (detached) with a timeout of the R7 budget + 60 s;
     on timeout the whole group and the shim-recorded Chrome PIDs (with their groups) are killed with SIGKILL, and
     the render is refused (R10, the log ends `killed after <s> s (render timeout)`). The probe children have
     60 s / 30 s timeouts, also SIGKILL.
  7. **The blob-worker exclusion (R1), exactly.** A log line is skipped only when it matches
     `^\[Browser:ERROR\] Creating a worker from 'blob:http:\/\/localhost:(\d{1,5})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' violates the following Content Security Policy directive: "script-src 'unsafe-inline'"\. Note that 'worker-src' was not explicitly set, so 'script-src' is used as a fallback\. The action has been blocked\.$`
     AND its port is one the preload recorded for this render's server (the log line
     `graphic-offline: render server localhost:<port>`). Any other CSP line, this text on another port, or a
     `127.0.0.1` origin, still refuses (R1). (This replaces v3.2.3's looser wording, which also named `127.0.0.1`.)

### Motion helpers (v3.4)

The wrapper defines `window.motion` before any graphic script (right after `window.rng`, in the same inline
`<script>`; no network, about 6.5 KB). It is the engine's own code (`scripts/lib/motion-helpers.mjs`, MIT; no
GSAP / Lottie), and it is **non-replaceable**: `window.motion` is a non-writable, non-configurable property, and
`motion` and `motion.ease` are frozen (an assignment is ignored, or a TypeError in strict code). The Math natives
it uses are captured before the graphic runs.

**Guarantee: every helper is a pure function of its arguments** (no state, no timers, no `Date`, no
`Math.random`, no DOM), so calling it from `seek(t)` with values derived from `t` keeps the frame a function of
`t` alone. Using it is optional: a graphic that never reads `window.motion` renders exactly as before.
The writer / planner prompt may tell the model to use it (the PC mirrors this section).

| Helper | Returns |
|---|---|
| `motion.ease.<name>(p)` | `linear`, `quadIn/Out/InOut`, `cubicIn/Out/InOut`, `expoIn/Out/InOut`, `backIn/Out/InOut`. `p` is clamped to `[0, 1]`; every ease maps 0 to 0 and 1 to 1; all but `back*` are non-decreasing (`back*` overshoots, about 10 %). |
| `motion.tween(t, t0, t1, from, to, ease?)` | `from` before `t0`, `to` after `t1`, eased between (clamped). `from` / `to`: numbers, or arrays of numbers of the same length (a new array). `ease`: a function, an ease name (`"cubicOut"`), or absent (linear). `t1 <= t0`: a step at `t0`. An unknown name throws. |
| `motion.keyframes(t, [[t, value, ease?], ...])` | piecewise tween, keyframes in increasing `t`; before the first, its value; after the last, its value. A keyframe's `ease` shapes the segment that **arrives** at it (linear if absent). Values: numbers or same-length arrays. |
| `motion.stagger(i, each, t, delay = 0)` | item `i`'s local time, `t - delay - i * each` (not clamped; feed it to `tween` / `spring`). |
| `motion.spring(t, { stiffness = 100, damping = 10, mass = 1, from = 0, to = 1, velocity = 0 })` | a damped harmonic oscillator in closed form (under-, critically and over-damped); `from` at `t <= 0`, settles to `to`. `velocity` is the initial d(value)/dt per second. `stiffness > 0`, `mass > 0`, `damping >= 0`, else it throws. Critical damping = `2 * sqrt(stiffness * mass)` (20 for the defaults). |
| `motion.countUp(t, t0, t1, from, to, { decimals = 0, prefix = "", suffix = "", separator = ",", point = ".", ease })` | the tweened value as a string: rounded with `toFixed(decimals)`, groups of three joined by `separator` (`""`: none), `point` before the decimals; locale-independent (never `toLocaleString`); a value that rounds to zero has no `-`. |
| `motion.pathPoint(d, p)` | `{ x, y, angle }` at fraction `p` (clamped) of the path's length. `d`: `M L H V C Q Z`, absolute or relative (no `S T A`: it throws). Each curve is sampled at 64 fixed steps and length is measured on that polyline (deterministic); a move (`M`) adds no length. `angle`: degrees, `atan2` of the sampled chord (within about 3 degrees of the true tangent on a curve). |

```js
var m = window.motion;
window.seek = function (t) {
  card.style.opacity = m.tween(t, 0, 0.8, 0, 1, m.ease.expoOut);
  big.textContent = m.countUp(t, 0.4, 2.4, 0, 1284500, { prefix: "$", ease: "cubicOut" });   // "$1,284,500"
  for (var i = 0; i < dots.length; i++)
    dots[i].style.top = 400 + m.spring(m.stagger(i, 0.12, t, 0.6), { stiffness: 180, damping: 12, from: 120, to: 0 }) + "px";
  bar.style.transform = "scaleX(" + m.keyframes(t, [[1, 0], [2, 0.6, "backOut"], [3.6, 1, "quadInOut"]]) + ")";
  var pt = m.pathPoint("M150 700 C330 420 560 900 760 560", m.tween(t, 1.2, 3.6, 0, 1, "cubicInOut"));
};
```

Example fixture: `scripts/fixtures/graphics/motion-helpers.html` (passes `graphic-determinism.mjs`).

### Authoring for determinism (v3.2.3; the writer prompt carries this list verbatim)

Measured while building the PM5 fixtures: the two renders split frames across Chrome workers differently, and a
worker that starts cold in the middle of a render can draw some things one level apart. R6 requires identical
frames, so a graphic:

- ends a transform at `none`, not `translateY(0px)` (or animates `top` / `left` instead);
- draws small moving glyphs or cursors that pass over rounded DOM corners on a `<canvas>`, not as inline SVG;
- does not slide full-screen panels inside a rounded `overflow: hidden` box (corner pixels differ by one level);
- also puts any font it uses only on a canvas in a hidden DOM line (e.g. `<div style="position:absolute;
  opacity:0">Aa</div>` in that family), so the font is loaded before the first frame;
- keeps display text at or under about 150 px (measured: 168 px and up in Unbounded or Montserrat differ by one
  level between workers);
- measures text widths inside `seek(t)`, not at load (a webfont may not be loaded yet at load time).

### Fields (layer: `{ "kind": "graphic", ... }` in `layers[]`; beat: `{ "type": "graphic", ... }` in `beats[]`)

```jsonc
// layer (output seconds; the studio writes this)
{ "id": "counter", "kind": "graphic", "html": "assets/graphics/counter.html",
  "mode": "overlay",                         // overlay | insert
  "anchor": { "take": 2, "offset": 0.4 },    // OR "pin": true, "at": 12.5  (the layer rules, unchanged)
  "dur": 3.5,                                // optional: default the file's window.duration minus in
  "in": 0, "after": "hold",                  // hold | loop | cut
  "box": { "x": 140, "y": 260, "w": 800, "h": 800 }, "fit": "contain",
  "z": 2, "opacity": 1, "enter": "none", "exit": "none",
  "overCaptions": false, "hideCaptions": false, "by": "user" }
// beat (source seconds; the planner/designer writes this)
{ "type": "graphic", "id": "counter", "html": "assets/graphics/counter.html", "at": 41.2, "to": 44.7,
  "mode": "overlay", "in": 0, "after": "hold", "box": { ... }, "fit": "contain", "opacity": 1, "hideCaptions": false }
```

| field | type | default | rule (out of rule = a G/P problem, or a warning GW) |
|---|---|---|---|
| `id` | string | | layer: the layer rule (`[a-z0-9-]{1,24}`, unique). Beat: optional, the same pattern |
| `kind` / `type` | `"graphic"` | | literal |
| `html` | string | | `assets/graphics/<name>.html`, `<name>` `[a-z0-9-]{1,48}`, lowercase `.html`, no `..`, no URL, no absolute path, the resolved file inside `<project>/assets/graphics/` (G1, G2) |
| `src` (beat) | string | the primary recording | the recording the beat's `at`/`to` belong to, exactly as on every beat (multi-source reels). Not the graphic file: v3.1 renamed the graphic file field to `html` so a graphic beat can name its recording. A graphic layer has no `src` (output seconds); a `src` on it is ignored (GW8) |
| `mode` | string | `"overlay"` | `overlay` (alpha WebM in `box`) or `insert` (opaque MP4 over the whole canvas). Else P1 |
| timing (layer) | | | exactly the layer rules: `pin` + `at`, or `anchor {take, offset}`; clamped to the reel; under 0.1 s once clamped: dropped (existing warnings and dies) |
| timing (beat) | `at`, `to` | `to` = `at` + the graphic's window | source seconds, the beat rules (`src` for multi-source); `to - at` 0.1..60 s (P2) |
| `dur` (layer) | number s | `duration - in` | > 0 (existing die); the placement's length. 0.1..60 s (P2) |
| `in` | number s | `0` | seek offset into the graphic: `0 <= in < duration`. Else GW1, clamped |
| `after` | string | `"hold"` | what plays when the placement is longer than `duration - in`: `hold` (the last frame), `loop` (back to frame 0; for loopable graphics), `cut` (the placement is shortened to `duration - in`, GW2). Else GW3, `hold` |
| `box` | `{x, y, w, h}` px | centred at the design size: `{x: (W-w)/2, y: (H-h)/2, w, h}` | overlay only: the layer box rule (numbers, `w, h > 0`); at least 20 % inside the canvas (P3). Ignored for an insert (GW4) |
| `fit` | string | `"contain"` | overlay only, when the box's aspect differs from `window.size`: `contain` / `cover` (the layer's `FITS`). Else P1-style layer die / beat drop (existing `fit must be one of cover|contain`) |
| `z`, `opacity`, `enter`, `exit`, `radius`, `shadow`, `overCaptions` | | `0`, `1`, `"none"`, `"none"`, none, none, `false` | layer: the existing layer rules. `enter`/`exit` default `none` here (the graphic animates itself). Beat: `opacity` only; z is the beats' `.layer` band |
| `hideCaptions` | boolean | `false` overlay, `true` insert | hides the captions while the graphic is up (the existing layer/beat behaviour; `edit_truth.json` carries it) |
| `audio` | | | graphics are silent: any value other than `"off"` is ignored with GW5 |
| `fps` | | | not a field: the render uses the reel's `fps`. A `fps` key is ignored (GW6) |
| `sfx` (beat) | | `"none"` | the beat rule; a graphic has no default sound |

**Size and duration limits.**

| | overlay | insert |
|---|---|---|
| design size (`window.size`) | even integers, `16 <= w <= W`, `16 <= h <= H` (1080 x 1920 on 9:16); default W x H | exactly W x H (or left out) |
| rendered size | the design size (scaled into `box` by `fit` at composite time) | W x H |
| graphic `window.duration` | 0.5..30 s | 0.5..30 s |
| placement length (`dur`, or `to - at`) | 0.1..60 s | 0.1..60 s |
| rendered file | at most 52 428 800 bytes (50 MiB) | at most 52 428 800 bytes |
| HTML file | at most 2 097 152 bytes | same |
| media files | at most 8, each at most 4 194 304 bytes | same |

**Captions, face, safe zones.** An overlay sits in the layer bands (under the captions, or over them with
`overCaptions`); a beat in the beats' `.layer` band. An insert covers the canvas above the footage and the beats,
under the captions band, and hides the captions by default. The build warns when an overlay box crosses the
platform UI zone (GW7, the Lottie W7 rule). The face check stays the validator's: an overlay box that covers
the tracked face for more than half of its window is a validator warning, never a build problem. Inserts get
no face or UI-zone check (they are full frame by design).

**Sections, edit_truth.** A graphic counts like a layer / beat for section boundaries; the cache key (below)
is part of the hash of the section it starts in. `edit_truth.json`: a graphic layer is recorded by the existing
`layerTruth` (`kind: "graphic"`), plus `mode`; a graphic beat as every beat. Nothing else changes.

### Placement as built (PM3, `scripts/lib/graphic-place.mjs`)

- **Async render, synchronous build.** `build.mjs` resolves every graphic layer (with the other layers) and every
  graphic beat (before the beat loop, like the motion-beat pre-pass), then awaits ONE top-level pre-pass
  (`prepareGraphics`) that renders each missing file through `renderGraphic`, one at a time, once per distinct
  placement (`html`, `mode`, `L`, `in`, `after`); an existing `assets/graphics/<name>-<key16>.<ext>` is used as is.
  Nothing is written before the pre-pass ends, so the page is the same bytes for the same reel and cached files. A reel
  with no graphic never reaches the pre-pass. The build does not take the Mac render lock itself: run a build that
  may render graphics under `lockf -k /tmp/phantasic-render.lock`, like any render.
- **Order of checks (layer).** The existing `id`, kind and timing dies, then G1..G36 (the file), P1, the `dur` die,
  P2 (on `dur` as asked, before clamping to the reel), clamping, `after: "cut"` (GW2), the box die, P3, the
  `enter` / `exit` / `fit` dies. Beat: G1..G36, P1, P2 (on `to - at` in source seconds), the time mapping (a
  failure drops the beat: `graphic <id or at>: <html>: <the E() message>, dropped`), P3, then `box must be { x, y, w,
  h } numbers with w, h > 0, got <json>` and `fit must be one of cover|contain, got <json>` (the layer texts, as a
  dropped beat). A render refusal: the first R text, as a layer die / dropped beat.
- **Markup.** A layer: the `video` layer's markup (`data-layer-kind="graphic"`, `data-media-start="0"`: `in` and
  `after` are baked into the file, which starts at the placement's frame 0; no `<audio>`); `enter`/`exit` default
  `none`, `fit` `contain` (an insert: box = the canvas, `fit` cover). A beat: an untimed `<div class="layer">` (an
  insert: `style="z-index:5"`, above the other beats and the under-captions layers, below grain and captions)
  holding `<div id="<id>-in" class="graphic" data-graphic="<name>" data-graphic-mode="<mode>">` in its box and the
  timed `<video>`. The 1 ms show tween ENDS at `t0` (measured: starting it at `t0` left the window's first frame
  empty) and the hide tween ends at `t1`, so the window shows exactly frames `[t0, t1)`.
- **Captions.** `hideCaptions` (default `true` for an insert) hides them from `t0 - 0.08` to `t1 + 0.05`, so the
  0.08 s fade has ended on the graphic's first frame and the re-show starts on its end (measured: a plain `[t0, t1]`
  window left the caption over the first and last frames of an insert).
- **edit_truth.json.** Layer: `layerTruth` + `mode`, and `hideCaptions: true` when resolved true. Beat: as every
  beat, except `to` is the resolved end (the default window, or shortened by `cut`). sections.json: a graphic layer's
  file and key are in its layer object; a graphic beat's key is added to its section's payload (`graphics`).
- **Check order, as one list (v3.2.5).** Layer: (1) the existing `id`, `kind` and timing dies; (2) G1..G36; (3) P1;
  (4) the `dur` die; (5) P2 on `dur` as written, BEFORE clamping to the reel; (6) clamping (existing warnings);
  (7) `after: "cut"` (GW2); (8) the `box` die; (9) P3; (10) the `enter` / `exit` / `fit` dies. Beat: (1) G1..G36;
  (2) P1; (3) P2 on the window in SOURCE seconds (`to - at` when both are seconds of the same recording, or the
  default window below); (4) the time mapping (`E()`); (5) P2 on the OUTPUT window `E(to) - E(at)` when the source
  window could not be read (`to: "end"`, `"hold:..."`, `at` and `to` in different recordings); P2 again on the output
  window (ALWAYS, after the source check: a beat across a cut can be long in source seconds and a few frames on
  screen), and P2 if the mapped window is under one frame; then `to` is snapped to whole frames (`t1 = t0 + L / fps`,
  so `data-duration` is the rendered length; a layer's end likewise); (6) `after: "cut"`; (7) the `box` problem;
  (8) P3; (9) the `fit` problem. The first failure is the one reported.
- **A beat's default `to` (v3.2.5).** Left out, `to` = `at` + the graphic's own length from `in`
  (`(D_f - in_f) / fps`), in SOURCE seconds. If that end falls past the end of the take that holds `at` (or in
  cut material), `E()` fails and the beat is DROPPED (current behaviour; whether to clamp to the take instead is
  pending a PC decision).
- **Drop texts for a beat (v3.2.5).** An unmappable time: `graphic <id or at>: <html>: <the E() message, first
  line>, dropped`. A bad box or fit reuses the layer texts in the dropped form: `graphic <id or at>: <html>: box must
  be { x, y, w, h } numbers with w, h > 0, got <json>, dropped` and `graphic <id or at>: <html>: fit must be one of
  cover|contain, got <json>, dropped`.
- **Unknown kind (v3.2.5).** `LAYER_KINDS` gains `graphic`, so the existing die reads `layers[<i>] (<id>): unknown
  kind <json>; have: video, image, logo, motion, text, graphic`.
- **sections.json (v3.2.5).** The per-section `graphics` key list is hashed into the section's hash ONLY when the reel has graphic beats
  (and then only on the sections that hold one); a reel without them keeps the manifest's old shape. Graphic layers
  carry their file and key inside their layer object.
- **Face (v3.2.5, proposed for the validator; the build does not check it).** A director- or planner-placed overlay
  beat must keep off the speaker's face. The validator samples the face track at 10 fps over the beat's window;
  if the overlay box intersects the face box in more than 50 % of the samples, the beat is dropped with
  **GW9** `graphic <id or at>: <html>: box covers the speaker's face for <p>% of its window, dropped` (`<p>` a
  whole percent). A user layer (`"by": "user"`) gets the same text without `, dropped`, as a warning. Inserts are
  exempt (full frame by design).
- **v3.3 (`mac/graphic-glyphs`).** G36 (an emoji or pictograph written in the file, static, rules.json
  `glyphs.G36`, JS/Python parity) and R14 (glyph coverage at render, "Glyph coverage" below); the bridge changed,
  so the cache key's `v` is 4: every graphic cached under `v: 3` renders again once.
- **v3.2.6.** The R6 row and the cache key's `"v": 3` line are PM2's wording (`mac/graphic-render` @ b6eca41),
  copied verbatim: the seek-order check's own R6 text (`R6o` in PM2's code) is `frame <k> (t=<t>s) depends on the
  seeks before it (not deterministic)`, `<k>` the graphic's own frame; the two-render texts are unchanged.
- **Render order (PM3 CP3).** Graphic layers render first, one at a time; the first refusal kills the reel before any
  beat is rendered. Then the beats. One render per distinct placement across both.
- **A graphic at 0 (PM3 CP3).** A placement starting at output 0 (section 0 in a section build) is visible from frame 0
  by its inline style (no `visibility:hidden`, `opacity` when under 1) and gets no show tween (a 1 ms tween cannot end
  at 0).
- **Tests (`GRAPHIC_TEST_DEPS`, PM3 CP3).** Tests only: names a module whose `deps` replace renderGraphic's external
  steps. Honoured ONLY when `NODE_TEST_CONTEXT` is set (Node sets it in `node --test` children); anywhere else it is
  ignored with `WARNING: GRAPHIC_TEST_DEPS is ignored outside node --test`. The module's realpath must lie inside the
  engine's `scripts/fixtures/` (else the build dies: `GRAPHIC_TEST_DEPS must name a module inside
  <...>/scripts/fixtures/ (got <value>)`). After its deps are spread, `chromeVersion` is forced to `0.0.0-stub`, so a
  test render is keyed under a Chrome that does not exist and a real Chrome launched under it is refused by R13:
  nothing is ever cached under a real key. `scripts/fixtures/graphic-stub-deps.mjs` writes a small ffmpeg clip.

### Cache key

`key` = the sha256 (hex) of the canonical JSON of the object below. Canonical = exactly Python's
`json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")` (every value is
ASCII: `html` and media paths are `[a-z0-9-]` by G1/G15). Every number is an integer.

```jsonc
{ "v": 5,                                  // bumped when the wrapper / bridge / CSP / lock changes (3: PM2's pre-script and seek-order check; 4 (v3.3): the R14 glyph check in the pre-script; 5 (v3.4): window.motion in the wrapper)
  "html": "<sha256 hex of the HTML file bytes>",
  "media": [["assets/graphics/media/a.jpg", "<sha256 hex>"]],    // sorted by path; [] when none
  "fonts": ["Inter"],                      // the bundled families inlined, sorted; [] when none
  "renderer": "hyperframes@0.8.81",
  "chrome": "152.0.7977.30",               // the browser build actually used: the last token of `<chrome> --version`
                                           // for the binary the launcher runs (measured: "Google Chrome for Testing 152.0.7977.30")
  "ffmpeg": "7.1.1",                       // the token after "ffmpeg version " in `<ffmpeg> -version`, where <ffmpeg> is
                                           // HYPERFRAMES_FFMPEG_PATH, else FFMPEG_PATH, else ffmpeg on PATH
  "quality": "looks",                      // the -q preset passed to hyperframes render
  "platform": "darwin-arm64",              // <os>-<arch> in Node's names: os darwin | linux | win32; arch arm64 | x64
                                           // (Python: sys.platform; platform.machine() arm64/aarch64 -> arm64, x86_64/AMD64 -> x64)
  "fps": 30, "w": 1080, "h": 1080,         // the reel fps; the RENDERED size (W x H for an insert)
  "mode": "overlay",                       // overlay | insert
  "frames": 105,                           // L
  "in": 0,                                 // in_f = round(in * fps), frames, not seconds
  "after": "hold" }
```

Only when the renderer runs as root (it drops Chrome to GRAPHIC_CHROME_UID with `--no-sandbox --disable-dev-shm-usage
--disable-gpu`, which changes pixels) the object also has `"launch": "root-drop --no-sandbox --disable-dev-shm-usage
--disable-gpu"`, so a root render and a plain one never share a file. A plain (non-root) render has no `launch`: its
key is unchanged.

A render whose log line `Browser launched (HeadlessChrome/<version>, ...` names another version than the key's
`chrome` is refused (R13): nothing is cached.

File: `assets/graphics/<name>-<first 16 hex of key>.webm` (overlay) or `.mp4` (insert), `<name>` being the
`<name>` of `assets/graphics/<name>.html`; its render folder is `build/graphics/<name>-<key16>/`. A file with
that name is used as is (no re-render); it is written only after the render passed every R rule and the
determinism check (written to `<name>-<key16>.part.<ext>` and renamed, as the matte is). The key never includes
the reel, the placement time or the box, so moving or resizing a graphic re-uses its file; changing `dur`, `in`
or `after` re-renders it. The studio preview renders with `frames = round(duration * fps)`, `in 0`, `after
"hold"`: it is the same file as a placement that keeps the default `dur` **only at the same fps** (fps is in
the key; the studio renders the preview at the reel's fps when it knows it, else 30).

**`L` (frames), exactly.** Layer: `L = round(dur * fps)` with `dur` the resolved layer length (after clamping,
and after `after: "cut"`). Beat: `L = round((out(to) - out(at)) * fps)`, where `out()` maps a source second to
the output timeline (build.mjs `E()`, the same mapping every beat uses), so a beat across a cut gets the output
length, not the source length.

### Determinism check

Two **independent** renders of the same wrapper page, both through the network-lock shim (two separate `hyperframes render` processes, cold, the
second with `--workers 1` so the frame-to-worker split differs), then each output is decoded and hashed per
frame: `ffmpeg -v error -c:v libvpx-vp9 -i <out.webm> -pix_fmt yuva420p -f framemd5 -` (overlay; the
`-c:v libvpx-vp9` before `-i` is what decodes the alpha) or `ffmpeg -v error -i <out.mp4> -pix_fmt yuv420p -f
framemd5 -` (insert). The `#` header lines are dropped; the remaining lines must be **exactly equal**, frame for
frame, with the same frame count `L`. No tolerance: a graphic has no footage, nothing is decoded from a source
video, so the only inputs are the HTML and `t`, and any difference is the graphic's fault (a clock, unseeded
randomness, state carried between seeks). The **file bytes are not compared**: measured, two renders of the
same page gave files that differ at byte 283 (container metadata) while all 60 decoded frame md5s were equal.
Live screenshots are not used either (on this Mac the default beginframe capture of `motion-determinism.mjs`
crashes Chrome and `--capture screenshot` has a ~5 % pixel race with an identical DOM); the check reads only the
rendered files. First data point (this spec): one 2 s 540x960 seek(t) page, two renders, `framemd5` equal on
60 of 60 frames. That it holds on this Mac for every category is to be proven in PM2 (one fixture per category,
PM5 harness).

### Frame preview CLI (`scripts/graphic-frames.mjs`, the planner's look-and-revise step)

```
node scripts/graphic-frames.mjs <graphic.html> --w W --h H --at 0.4,1.5,2.6 --out DIR [--mode overlay|insert] [--lock PATH]
```

Renders the graphic at exactly those times and writes `DIR/f-<t>.png` (`<t>` as `0.4`, `1.5`, `3`); stdout is ONE
JSON line: `{"frames":[{"t":0.4,"file":"DIR/f-0.4.png"},...],"refused":null}` (exit 0), or
`{"frames":[],"refused":"R1: graphic tried to load ... (no network): render refused"}` (exit 2: `<code>: <text>`, the
texts word for word from the table below), or `{"frames":[],"refused":null,"error":"..."}` (exit 1: usage or an
internal error). Progress goes to stderr. `--w/--h` are the reel canvas (default 1080x1920): an overlay renders at its
`window.size` as an **RGBA PNG with a transparent background**, an insert at W x H, flattened onto its `#000`
background (opaque, as its MP4 would be). A file at `<project>/assets/graphics/<name>.html` is checked as that
project's (G1, media), any other file alone, as `graphic-determinism.mjs` does.

- **Same sandbox as `renderGraphic`, same order** (`scripts/lib/graphic-frames.mjs` calls graphic-render.mjs's own
  functions, it re-implements none): the static rules first (a refused file never starts Chrome); root:
  `chromeUser` (R12n without GRAPHIC_CHROME_UID / GID or setpriv), the per-uid host lock, `sweepUid`, `chromeHome`;
  the launcher shim with the lock flags (and the setpriv drop as root); the R12 probe through that shim and
  GRAPHIC_SANDBOX; ONE `runRender` (offline preload, PID marker, timeout kill; `--format png-sequence`, the only
  change to graphic-render.mjs: runRender takes a `format`); then `releaseChromeHome` and the lock release on every
  path (a failed release: R12c, and no PNG is kept). The page is `wrapperHtml`'s (CSP, integrity pre-script,
  navigation trap, R14 glyph check after every seek, post-script); the log goes through `scanLog` (R1-R5, R6 seek
  order, R11, R14), plus R13 (launched through the shim, the probed version), R10 (exit, and exactly one PNG per
  time) and R7 (budget `20 + 0.15 N`). Not run (a preview, not the cache gate): the second render + framemd5, R8,
  R9 (a single frame may be blank). Nothing is cached.
- **Exact times in one render.** The wrapper is built on a 1 ms grid (fps 1000, `D = duration * 1000 + 1`, so
  `t = window.duration` is a frame) and hyperframes renders N frames at 1 fps. An engine script placed before the
  pre-script registers the first `hf-seek` listener and sets frame i's `detail.time` to the i-th time; the
  pre-script (unchanged) then calls `window.seek(t_i)`. Times are rounded to the millisecond, duplicates dropped.
- **Times outside 0..window.duration are refused, not clamped** (before Chrome starts, exit 2):
  `T1: time <t>s is outside 0..<duration>s (the graphic's window.duration): nothing rendered`. A clamped frame
  would show the planner something it did not ask for.
- **Speed** (Mac mini M4, 2026-10-20, pinned chrome-headless-shell 152.0.7977.30): 3 frames of a 400x200 box,
  2.1-2.2 s wall for the whole CLI (render 1.0 s); 3 frames of `fixtures/graphics/shapes.html` (1080x1080), 2.3 s
  (render 1.2 s). Two runs give byte-identical PNGs.
- **Staging (root).** In the staging container, as root, exactly as `renderGraphic` there (the uid must be
  dedicated and able to read + execute the headless shell's directory):
  ```
  GRAPHIC_CHROME_UID=65534 GRAPHIC_CHROME_GID=65534 \
  GRAPHIC_CHROME_PATH=<abs path of the cached chrome-headless-shell 152.0.7977.30> \
    node scripts/graphic-frames.mjs scripts/fixtures/graphics/shapes.html --w 1080 --h 1920 --at 0.4,1.5,2.6 --out /tmp/gf
  ```
  Without the two ids it prints `{"frames":[],"refused":"R12: network lock probe could not run: running as root: set GRAPHIC_CHROME_UID ..."}` and exits 2.
  Root mode is tested on the Mac with stubs (`scripts/graphic-frames.test.mjs`: host lock, sweep, home, shim with
  home + setpriv, probe as the user, render with the uid, release + unlock on success, probe refusal and a throw);
  the shim's own setpriv drop is `graphic.test.mjs`'s fake-`id` / fake-`setpriv` rig.
- Tests: `scripts/graphic-frames.test.mjs` (in the gate; the real renders skip without a POSIX shim, a cached
  Chrome or hyperframes): a moving red box -> 3 PNGs with the box at `x = 100 t`, transparent around it; the same
  times again -> identical bytes; a render-time image load -> R1, exit 2, no PNG; a static refusal and a T1 start
  nothing.

### Problems, word for word (v2; the validator mirrors G1 to G28 and P1 to P3)

- layer (`die()`): `layer <layer id>: graphic <html>: <reason>`
- beat (warning, the beat is dropped): `graphic <beat id or at>: <html>: <reason>, dropped`

**Order.** The checks run in the order of the table below (G1, G2, ... G36, then P1 to P3); the FIRST failing
check is the one reported (P1 to P3 too: one placement problem, the first, v3.2.2), and for a regex its LEFTMOST match in the first scope listed that matches is the
`<match>`. One problem per graphic.

**Scopes (what each regex scans).**

- `WHOLE`: the file text.
- `SCRIPT`, `STYLE`, `MARKUP` (v3.2) come from ONE left-to-right pass of the `rules.json` `scopes.tokens` regex
  (flag `i`), the way the browser's tokenizer reads raw-text elements:
  `<script(?![\w-])[^>]*>([\s\S]*?)(?:</script>|(?![\s\S]))|<style(?![\w-])[^>]*>([\s\S]*?)(?:</style>|(?![\s\S]))|<title(?![\w-])[^>]*>[\s\S]*?(?:</title>|(?![\s\S]))`.
  Matches never overlap (whichever element starts first owns the text up to its end tag); an element left open
  runs to the end of the file, as in the browser. G30 (no HTML comments), G32 (end tags exact) and G34 (no
  foreign `<script>`/`<style>`, no other raw-text elements) keep the browser from reading the file differently.
- `SCRIPT`: group 1 of every match, joined with `\n`.
- `STYLE`: group 2 of every match, then the value of every `\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')` (flag `i`) found
  in `MARKUP`, with `&quot;`/`&#34;` -> `"`, `&apos;`/`&#39;` -> `'`, `&amp;` -> `&` decoded; all joined with `\n`.
- `MARKUP`: the file with every match removed (a `<title>`'s text is dropped with it).
- G35 (v3.2): a match whose start lies inside another tag (in the text before it, the last `<` comes after the
  last `>`, e.g. `<img alt="<script>" ...>`) is refused, so a tag's attributes cannot hide markup.
- Before the scopes are cut, line endings are normalised: every `\r\n` and every lone `\r` becomes `\n`
  (`rules.json` `newlines`; both reference implementations). Then every character in
  `[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]` (written here as escapes; the
  characters themselves) is replaced by a space, so `\s` means the same in JavaScript and in Python `re.ASCII`.
- Comments are scanned (a forbidden word in a JS or CSS comment fails); text content of the page is not scanned
  by the JS and CSS rules (`<p>We fetch (data)</p>` passes), only by the markup rules. Two markup rules read
  prose too: G7's `url(` (a visible `url(http...` text is refused; rare) and G13's `<set` (HTML parses `<set of
  3>` as an element anyway).

**Regex dialect.** Each regex below is the exact source, JavaScript syntax; flags column `i` = case-insensitive,
`-` = case-sensitive. The Python mirror compiles the same source with `re.ASCII` (plus `re.IGNORECASE` for `i`)
and uses `search`. **`scripts/graphic-rules/rules.json` is the SINGLE source of truth for the regex sources**:
the listing below is informative, and if the two ever differ, `rules.json` wins. The PC validator loads
`rules.json` at run time rather than retyping the regexes. It is read by a node implementation
(`rules.mjs`) and a Python one (`rules.py`, `re.ASCII`); `node scripts/graphic-rules/parity.mjs` runs both on
`cases.json` (139 cases: the CP3 reviewer's 41 bypasses and 54 false positives, 29 font / literal-assignment
cases, 15 from the re-review) and prints `PARITY: PASS` only when node == Python == the recorded expectation
for every case (`$PYTHON` picks the interpreter). Measured: `139 cases, 139 agree`, `PARITY: PASS` (node 26,
Python 3.9.6). The harness covers the regex rules, G18 and G21-G23/G26; it is not in the gate.

```text
id   scope         flags source
G5   WHOLE         i  <script\b[^>]*[\s/](src|href|xlink:href|type)\s*=
G6   WHOLE         i  <link(?![\w-])
G7   STYLE         i  @import\b
G7   STYLE+MARKUP  -  url\(\s*(?![\s'"]|data:|#)|url\(\s*['"](?!data:|#)|image-set\(\s*['"](?!data:|#)
G8   SCRIPT        -  \bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bimport\s*\(|\bWorker\s*\(|\bSharedWorker\b|\bimportScripts\b|\bRTCPeerConnection\b|\bimport\s*\.\s*meta\b
G9   SCRIPT        -  \beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bFunction\s*\.\s*prototype\b|\.\s*constructor\s*\.\s*constructor\b|\.\s*constructor\s*\(
G10  SCRIPT        -  \b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)\b
G11  SCRIPT        -  \bnew\s+Date\b|\bDate\s*\(|\bDate\s*\.\s*(now|parse|UTC)\b|\bperformance\s*\.\s*(now|timeOrigin|mark|measure|getEntries)\b|\bdocument\s*\.\s*timeline\b|\.\s*timeStamp\b
G12  SCRIPT        -  \bMath\s*\.\s*random\b
G13  STYLE         i  @keyframes\b|(?<![\w-])animation(-name)?\s*:|(?<![\w-])transition(-property)?\s*:
G13  SCRIPT        -  \.\s*(animation|transition)\s*=|\.\s*animate\s*\(|\bgetAnimations\b
G13  MARKUP        i  <(animate|animateTransform|animateMotion|set)(?![\w-])
G14  MARKUP        i  <(video|audio|iframe|frame|frameset|object|embed|base|form|portal)(?![\w-])
G14  MARKUP        i  <meta\b[^>]*http-equiv\s*=\s*["']?refresh
G19  SCRIPT        -  \b(gsap|TweenMax|TweenLite|TimelineMax|TimelineLite|ScrollTrigger|anime|THREE|lottie|bodymovin|d3|p5|PIXI|Matter|Konva|BABYLON|Phaser|mojs|createjs|React|ReactDOM|Vue|Velocity|popmotion)\s*[.(]
G19  WHOLE         i  GreenSock
G20  SCRIPT        -  getContext\s*\(\s*['"](webgl2?|experimental-webgl|webgpu)['"]
G25  SCRIPT        -  \b(localStorage|sessionStorage|indexedDB|caches|navigator|location|crypto)\s*(\.\s*[A-Za-z_$]|\[)|\blocation\s*=(?!=)|\bdocument\s*\.\s*(cookie|referrer|domain|location|write|writeln|open)\b|\bwindow\s*\.\s*(open|parent|top|opener|location|frames)\b|\bglobalThis\s*[.\[]|\bwindow\s*\[|\bthis\s*\[|\bdefaultView\b|\bopen\s*\(|\.\s*href\s*=(?!=)|\.\s*click\s*\(|\bpostMessage\s*\(|\bReflect\s*\.
G27  MARKUP        i  <(a|area)(?![\w-])[^>]*[\s/](xlink:)?href\s*=\s*(?!["']?#)|[\s/]ping\s*=|[\s/]formaction\s*=
G28  SCRIPT        -  [\w$\])]\s*\[\s*(['"`])[^'"`]*\1\s*\+|[\w$\])]\s*\[\s*`[^`]*\$\{
G29  MARKUP        i  <[^>]*[\s/"']on[a-z]+\s*=
G30  WHOLE         -  <!--
G31  STYLE         -  \\[\s\S]?
G32  WHOLE         i  </(script|style|title)(?=[\s/])
G33  MARKUP        i  =\s*["']?\s*(java|vb)script\s*:|=\s*["']?\s*data\s*:\s*text/html
G33  STYLE         i  (java|vb)script\s*:
G34  WHOLE         i  <(math|noscript|xmp|noembed|noframes|plaintext|textarea|template)(?![\w-])|<svg(?![\w-])(?:(?!</svg\s*>)[\s\S])*?<(script|style)(?![\w-])
```

**Writing forbidden words as text.** A graphic that SHOWS such a word (the Code category) writes it in markup
with an HTML entity (`<code>&#115;etTimeout</code>`), or inside a JS string with a `\uXXXX` escape
(`"setTimeout(cb)"`, `"Launch Date (Q3)"`); the scan does not match either and the page displays
the same text. A function or method of your own must not be called `animate` (G13 `.animate(`), `open` or `click` (G25), and a
variable must not be called `location`; `this[...]` in any form (including ``this[`x${i}`]``) is refused by
G25, so the writer prompt must avoid it; visible text such as "animation:" or "transition:" (a UI or Code graphic showing CSS) goes in MARKUP, never in a
CSS `content:` string: G13 scans `<style>` and `style=` (measured: `content:"transition: on"` is refused, the same
words in `<p>` or `<pre>` pass, as does `anim&#97;tion:`; the entity form is the safe habit for any such word in
markup); CSS never contains a backslash (G31: write the character itself, e.g.
`content:"—"`, never `content:"\2014"`); and `anime`, `d3`, `THREE`,
... are reserved names (G19).

| # | check | `<reason>` (exact) |
|---|---|---|
| G1 | `html` matches `^assets/graphics/[a-z0-9-]{1,48}\.html$` and resolves inside `<project>/assets/graphics/` | `graphic html '<html>' is not assets/graphics/<name>.html inside the project` |
| G2 | the file exists | `graphic file <html> does not exist` |
| G3 | size <= 2097152 bytes | `graphic file <html> is <bytes> bytes (max 2097152)` |
| G4 | valid UTF-8; exactly one `<head\b` and one `<body\b` (flag `i`, `WHOLE`) | `graphic file <html> is not a UTF-8 HTML document with one <head> and one <body>` |
| G5 | listing G5 (v3.2: `src`, `href`, `xlink:href` or `type`, attribute after whitespace or `/`) | `graphic file <html> loads a script file or has a typed script (<script src / href / xlink:href / type>): only plain inline scripts are allowed` |
| G6 | listing G6 | `graphic file <html> has a <link> tag: put styles inline in <style>` |
| G7 | listing G7 (both lines) | `graphic file <html> uses @import, url(...) or image-set(...) with something other than a data: URI or a #fragment` |
| G8 | listing G8 | `graphic file <html> uses <match> (no network: fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon, import(), import.meta, workers, RTCPeerConnection)` |
| G9 | listing G9 | `graphic file <html> uses <match> (no eval, new Function or constructor tricks)` |
| G10 | listing G10 | `graphic file <html> uses <match> (no timers: seek(t) is the only clock)` |
| G11 | listing G11 | `graphic file <html> reads the clock (<match>): use the t passed to seek(t)` |
| G12 | listing G12 | `graphic file <html> calls Math.random: use window.rng(seed)` |
| G13 | listing G13 (three lines) | `graphic file <html> uses <match> (no CSS animations, transitions, Web Animations or SVG animation: compute every style in seek(t))` |
| G14 | listing G14 (two lines) | `graphic file <html> has a <match> element (no video, audio, iframe, object, embed, base, form or meta refresh)` |
| G15 | in `MARKUP`, inside any tag, every value of the attributes `src`, `srcset`, `poster`, `background` (v3.2), and of `href` / `xlink:href` on EVERY element except `<a>`/`<area>` (G27) (v3.2; was `<image`/`<use` only: `<feImage>`, `<pattern>` and others load hrefs too), an attribute name preceded by whitespace, `/` or a closing quote (flag `i`), is a `data:image/(png\|jpeg\|webp\|gif\|svg+xml)` URI, a `#fragment` (`<use>` only) or matches `^assets/graphics/media/[a-z0-9-]{1,48}\.(png\|jpe?g\|webp)$` | `graphic file <html> refers to '<value>' (images must be data: URIs or assets/graphics/media/ files)` |
| G16 | each `assets/graphics/media/...` file it names exists, and its realpath (symlinks resolved) lies inside `<project>/assets/graphics/media/` (as Lottie L1 does for `assets/`) | `graphic media <path> does not exist` / `graphic media <path> resolves outside assets/graphics/media/` |
| G17 | at most 8 media files, each <= 4194304 bytes | `graphic media <path> is <bytes> bytes (max 4194304)` / `graphic file <html> uses <n> media files (max 8)` |
| G18 | the font rule below | `graphic file <html> uses font family '<name>' (only the engine's fonts, a data: @font-face, var(--...), or a generic family)` |
| G19 | listing G19 (two lines) | `graphic file <html> uses a library (<match>): no GSAP or any other animation, 3D, chart or UI library; write plain seek(t) code` |
| G20 | listing G20 | `graphic file <html> asks for a WebGL/WebGPU context (only canvas 2d)` |
| G21 | `\bwindow\s*\.\s*seek\s*=` (`SCRIPT`) present. A top-level `function seek(t) {}` alone is refused here | `graphic file <html> does not define window.seek(t)` |
| G22 | in `SCRIPT`: `\bwindow\s*\.\s*duration\s*=(?!=)` occurs exactly once AND `\bwindow\s*\.\s*duration\s*=\s*(\d+(?:\.\d+)?)\s*(?:;\|$\|//)` (flag `m`; a trailing `//` comment is allowed) matches exactly once, value 0.5..30 (a leading digit is required: `.5` and `3.` fail) | `graphic file <html> does not set window.duration to a number literal from 0.5 to 30` |
| G23 | in `SCRIPT`: `\bwindow\s*\.\s*size\s*=(?!=)` occurs 0 times, or once AND `\bwindow\s*\.\s*size\s*=\s*\{\s*w\s*:\s*(\d+)\s*,\s*h\s*:\s*(\d+)\s*,?\s*\}` matches once (w before h, unquoted keys, a trailing comma allowed), both even, `16 <= w <= W`, `16 <= h <= H` | `graphic size must be window.size = { w: <even int>, h: <even int> } within 16..<W> x 16..<H>` |
| G24 | `mode: "insert"` and a `window.size` other than W x H | `an insert graphic must be <W>x<H> (window.size is <w>x<h>)` |
| G25 | listing G25 (v3: `defaultView`, `this[`, `.href =`, `.click(` added; the broad `self`/`top`/`parent`/`opener`/`frames` and `history` forms dropped) | `graphic file <html> uses <match> (no storage, navigation, window access or environment reads)` |
| G26 | `\bwindow\s*\.\s*rng\s*=(?!\s*window\s*\.\s*rng\s*\|\|)` (`SCRIPT`) matches | `graphic file <html> redefines window.rng (copy the engine snippet as is)` |
| G27 | listing G27 (v3.2: `xlink:href`, `formaction`, `/` as a separator) | `graphic file <html> has a link that leaves the page (<match>): <a>/<area> href must be a #fragment; no ping, no formaction` |
| G28 | listing G28 (v3: only on a member access, `x['a' + b]`, not an array literal) | `graphic file <html> builds a name from pieces (<match>): write property names out in full` |
| G29 | listing G29 (v3.2) | `graphic file <html> has an event-handler attribute (<match>): no on...= attributes; everything runs from seek(t)` |
| G30 | listing G30 (v3.2) | `graphic file <html> has an HTML comment (<!--): use /* */ inside <style> and <script> instead` |
| G31 | listing G31 (v3.2). ANY backslash in CSS is refused, legitimate ones too (`content:"\2014"`): write the character itself (`content:"—"`), never a CSS escape | `graphic file <html> has a backslash escape in CSS (<match>): write CSS without escapes` |
| G32 | listing G32 (v3.2) | `graphic file <html> has an end tag written as <match>: write </script>, </style> and </title> exactly` |
| G33 | listing G33 (v3.2, two lines) | `graphic file <html> uses a script URL (<match>)` |
| G34 | listing G34 (v3.2) | `graphic file <html> has <match> (no math, noscript, xmp, noembed, noframes, plaintext, textarea or template elements, and no <script> or <style> inside <svg>)` |
| G35 | the tokenizer check above (v3.2) | `graphic file <html> starts a <match> inside another tag (a < inside an attribute value)` |
| G36 | (v3.3) a code point of `WHOLE` (one code point at a time, after the newline / unicode-space normalisation) inside rules.json `glyphs.G36`, GENERATED by `scripts/graphic-rules/gen-glyphs.mjs` from the bundled fonts' cmaps (`--check` runs in the tests): the emoji / pictograph blocks U+2300-23FF, U+25A0-27BF, U+2B00-2BFF, U+FE0F, U+1F000-1FBFF, plus exactly the code points of U+2190-21FF (arrows) and U+2200-22FF (math operators) that no engine font and not the Arabic face covers (`→ ← ↗ ⇒ ≤ ≥ ≠ ≈ ∞ √` are in; `↑ ↓ − ∕` stay allowed); G36 ∩ coverage = ∅ is a test; numeric character references (rules.json `glyphs.ncr`: `&#<decimal>;` / `&#x<hex>;`, the `;` optional) are first decoded to the character they name when it is a scalar value (named references such as `&check;` are not); the first one found is `<hex>` (upper case, at least 4 digits) and `<char>`. Parity form: `G36:U+<hex>`. Text built by script is caught at render by R14 | `graphic file <html> has the character U+<hex> '<char>' (an emoji or symbol: no engine font has a glyph for it, it renders as a box)` |

**Why v3.2 bans rather than tokenizes.** A spec-exact HTML tokenizer (script-data escape states, foreign
content, comment edge cases like `<!-->` and `--!>`) would have to be written twice, in node and in Python, and
kept identical; Node has none built in and Python's `html.parser` does not follow the spec's script states. So
v3.2 refuses the constructs that make the browser read a file differently from the one-pass regex tokenizer:
HTML comments (G30, which also kills the `<!--<script>` double escape), inexact end tags (G32), foreign and
other raw-text elements (G34), raw-text elements starting inside a tag (G35); and the constructs that run code
or load without passing the SCRIPT rules: event-handler attributes (G29), CSS escapes (G31: `u\72l(`,
`\75 rl(`, `u\000072l(`, `@\69mport` all read as `url(` / `@import` in CSS), script URLs (G33), scripts with
`src`/`href`/`xlink:href`/`type` (G5). The browser network lock stays the security boundary; these keep the
static layer honest. `scripts/graphic-rules/cases.json` holds the PC's four probe files verbatim (`pc.*`, each
refused; plus `pc.cssEscapeControl`, `u:l(`, which is harmless and passes) and 31 sibling cases (`v32.*`).

**G15 to G17, exactly (v3.1).**

- G15 reads every attribute value **as written**: no HTML entity decoding (an encoded value like `&#104;ttp://...`
  does not match an allowed form, so it is refused anyway).
- A `srcset` is ONE value, compared whole: `data:image/png;base64,AA 1x` is allowed (it starts with an allowed
  data URI), `assets/graphics/media/a.png 2x` is refused (the media pattern is anchored with `$`).
- An allowed data URI matches `^data:image/(png|jpeg|webp|gif|svg\+xml)[;,]` (flag `i`); an allowed media path
  matches `^assets/graphics/media/[a-z0-9-]{1,48}\.(png|jpe?g|webp)$`; `#fragment` (`^#`) only on `<use>`.
- Media files are the DISTINCT media paths in order of first appearance. G16 checks each in that order (exists,
  then realpath). G17 checks each file's size in that order FIRST, then the count (> 8 refused).
- The count (> 8 distinct media paths) needs no file system and is checked even when the validator has no
  project files (it then skips G16 and the sizes, never the count).

**G18, the font rule, exactly.** Allowed families (compared case-insensitively): the engine's (`Inter`, `Geist`,
`Montserrat`, `Oswald`, `Unbounded`, `Gloock`, `Instrument Serif`, `EB Garamond`, `Playfair Display`,
`Caveat Brush`, `Yellowtail`, `JetBrains Mono`), the generics `serif`, `sans-serif`, `monospace`, `system-ui`,
`cursive`, `ui-sans-serif`, `ui-serif`, `ui-monospace`, `inherit`, `initial`, `unset`, every family the file
declares with `@font-face\s*\{[^}]*?(?<![\w-])font-family\s*:\s*([^;}]*)` (flag `i`, `STYLE`), and any item
starting with `var(` (flag `i`). Family lists are read from:

1. `STYLE`: `(?<![\w-])font-family\s*:\s*([^;}<]*)` (flag `i`), group 1;
2. `STYLE`: `(?<![\w-])font\s*:\s*([^;}<]*)` (flag `i`), group 1 after the size token;
3. `MARKUP`: `\sfont-family\s*=\s*(?:"([^"]*)"|'([^']*)')` (flag `i`; the SVG attribute), group 1 or 2;
4. `SCRIPT`: `\.\s*fontFamily\s*=\s*(['"`])(.*?)\1`, group 2;
5. `SCRIPT`: `\.\s*font\s*=\s*(['"`])(.*?)\1` (canvas `ctx.font` and `style.font`), group 2 after the size token.

**The size token:** if the value matches `^.*?(?:^|\s)\S*?(?:px|pt|em|rem|%|vh|vw|vmin|vmax|ch|ex)(?:\s*/\s*\S+)?\s+(.+)$`
(flags `i` and `s`), the family list is its group 1; otherwise the whole value. A list is split on `,`; each item
has the first `!important` (flag `i`) removed from the list, is trimmed, loses ONE pair of matching outer quotes
(`'...'` or `"..."`), is trimmed again; empty items are skipped. The first item not allowed is `<name>`.

**Placement problems (static, on the reel.json entry).**

| # | `<reason>` (exact) |
|---|---|
| P1 | `graphic mode '<v>' is not overlay or insert` |
| P2 | `graphic window <s>s is outside 0.1..60s` |
| P3 | `graphic box shows less than 20% inside the <W>x<H> canvas` |

(The layer's existing `id`, timing, `dur`, `box`, `fit`, `enter`, `exit` dies apply unchanged to a graphic layer.
P3 REPLACES the generic layer rule "at least 20 % of the box inside the canvas" for a graphic layer: the
validator and the build report P3 only, never both.)

**Refused at render (PM2: the build or the studio renders the graphic when its cache file is missing).** The
render wrapper reads the whole log of both renders; any of these deletes the output and is the problem.

| # | detected by | `<reason>` (exact) |
|---|---|---|
| R1 | a log line containing `violates the following Content Security Policy directive` (Chrome), `vendor: blocked <url>` (the Node preload), or (v3.2.2) a `[Browser:...]` line with `net::ERR_PROXY_CONNECTION_FAILED`, `net::ERR_NAME_NOT_RESOLVED`, `net::ERR_BLOCKED_BY_CLIENT` or `net::ERR_ACCESS_DENIED` (a request or navigation the shim blocked; `<url>` is the line's URL, else `(net::ERR_<name>)`); (v3.2.4) ONE exclusion: HyperFrames' own blob-worker CSP line, exactly as in "Render hardening" item 7, on this render's recorded server port only | `graphic tried to load <url> (no network): render refused` |
| R2 | a log line `[Browser:PAGEERROR] <message>` | `graphic page error: <message>` |
| R3 | `GRAPHIC-REFUSED: window.seek is not a function` (bridge, at load) | `window.seek is not a function after the page loaded` |
| R4 | `GRAPHIC-REFUSED: seek(<t>) threw: <message>` / `... returned a Promise` (bridge) | `seek(<t>) threw: <message>` / `seek(<t>) returned a Promise (it must be synchronous)` |
| R5 | `window.duration` / `window.size` at load differ from the static values | `window.duration / window.size changed at load (static <a>, at load <b>)` |
| R6 | the determinism check | `frame <i> (t=<t>s) differs between two renders (not deterministic)` / `the two renders have <a> and <b> frames` / (v3.2.2) both renders agree on a count `<a>` that is not the placement's `L`: `the two renders have <a> and <L> frames` / (v3.2.5) the in-page seek-order check (the bridge seeks 8 frames forward, backward and shuffled on the first `hf-seek` and compares the root's markup, the html/body styles and every canvas's pixels): `frame <k> (t=<t>s) depends on the seeks before it (not deterministic)` (`<k>` = the graphic's frame) |
| R7 | wall time of one render over `20 s + 0.15 s x L` (v3.2.2, measured in PM2 on the Mac mini, the slower `--workers 1` render: 60 frames 4.7 s, 300 frames 15.4 s at 1080x1080 / 13.8 s insert, 900 frames 40.0 s; the budget is 3.9x to 4.2x that, headroom for the CPU-only Linux container, not yet measured) | `render took <s>s for <L> frames (budget <b>s)` |
| R8 | rendered file over 52428800 bytes | `rendered file is <bytes> bytes (max 52428800)` |
| R9 | overlay: every decoded frame has alpha 0 everywhere | `every frame is fully transparent` |
| R10 | `hyperframes render` exits non-zero, or writes no file | `hyperframes render failed (exit <code>): <last log line>` |
| R11 (v2) | a log line containing `GRAPHIC-REFUSED: navigated` (v3.2.2: the bridge's Navigation API `navigate` trap, which also cancels the navigation) | `graphic navigated away from its page: render refused` |
| R12 (v2) | the network probe (above, v3.2.2: Chrome over its debugging pipe on `about:blank`, plus the Node half) loaded `http://1.1.1.1/` or `http://169.254.169.254/`; or (v3.2.4) the second-`localhost` listener saw a connection (`<url>` = its URL); or the probe could not run (only a `TypeError` counts as blocked: a timeout or other error, no shim, e.g. Windows; Chrome did not start; the Chrome or ffmpeg version could not be read); or (root, stage `release`) after the render a process of GRAPHIC_CHROME_UID survived the kill, or the kill could not run (the Chrome home is kept, no file is cached) | `network lock is not in place (<url> was reachable from the render browser): graphic renders refused` / `network lock probe could not run: <message>` / `graphic Chrome could not be cleaned up safely: <message>` |
| R14 (v3.3) | the bridge's glyph check (see "Glyph coverage" below): a drawn character no font in its stack has a glyph for: `GRAPHIC-REFUSED: glyph {"cp":"<hex>","font":"<font>","text":"<text>"}`. `<font>` = the element's computed `font-family` (DOM, `::before` / `::after`) or the canvas context's family list (`ctx.font` after its size); `<snippet>` = up to 30 UTF-16 units each side of the character, cut with `…` (never through a surrogate pair), whitespace runs collapsed to one space, trimmed | `character U+<hex> '<char>' in "<snippet>" isn't in <font> (no glyph; renders as a box)` |
| R13 (v2) | the render log's `Browser launched (HeadlessChrome/<v>, ...` differs from the key's `chrome`; (v3.2.4) or that line is missing (`<v>` = `(no 'Browser launched' line)`), or the shim marker file is empty (`<v>` = `<v> (not launched through the shim)`) | `the render used Chrome <v>, the cache key says <k>: nothing cached` |

**Glyph coverage (R14, v3.3).** A character that no available font has a glyph for falls through to the system's
fallback font; on the Linux render container that has no emoji font, so it renders as a box ("tofu"), while a Mac
draws it in Apple Color Emoji (the staging bug: a Charts DM counter whose message bubbles ended in an emoji). G36
catches emoji written in the file; R14 catches what the page actually draws, including text built by script.
- *Coverage* (`scripts/lib/font-coverage.mjs`, no dependency): the cmap (Unicode subtables, formats 0, 4, 6, 12, 13;
  glyph 0 is no glyph) of each bundled `templates/fonts/*.woff2` face (WOFF2: brotli, `node:zlib`), clipped to the
  face's `unicode-range` exactly as the wrapper's `@font-face` writes it. The **repertoire** = the union over every
  engine family (rules.json `fonts.engine`): measured, Basic Latin, Latin-1, Latin Extended, Cyrillic, the common
  punctuation (`– — ‘ ’ “ ” • … ‹ ›`), `€`, `™`, `↑ ↓`, `−`, and no emoji, arrows other than those two, check marks,
  stars or geometric shapes. A graphic's own `data:` `@font-face` (WOFF2, WOFF or TTF/OTF) adds its cmap (clipped by
  its `unicode-range`) for its family; one that cannot be read covers nothing. A font loaded from script
  (`new FontFace(...)`) is not read: its text needs the repertoire.
- *Limits* (a `data:` font is untrusted): input 16 MB, decompressed cmap 16 MB (`maxOutputLength`), 512 tables, 64
  cmap subtables, 131072 ranges, 2097152 per-code-point steps (format-4 glyph arrays, format 6); format-4 segments
  with `idRangeOffset` 0 become one range each (split only around the one code point whose glyph wraps to 0). Over
  any limit the font covers nothing (its characters fall back to the engine fonts' coverage); nothing throws.
- *Arabic* (v3.3): the bundled Noto Sans Arabic (`templates/fonts/noto-sans-arabic-arabic.woff2`, OFL 1.1,
  `LICENSE-NotoSansArabic.txt`) is inlined whenever the graphic uses an engine family, FIRST (before the other faces,
  so where its range overlaps theirs, U+200C-200E and U+2010-2011, theirs is tried first), with build.mjs's `arabic`
  unicode-range, once as `"Noto Sans Arabic"` and once under the name of each engine family the graphic uses: Arabic
  in `font-family: Inter, ...` text is shaped from the vendored font, never a system one, and the face loads only
  when an Arabic character is drawn. Those families' coverage includes the Arabic face's cmap; a stack with no engine
  family (generic only) does not, and its Arabic is refused (R14).
- *Rule*: a drawn character is fine if it is exempt (U+0000-0020, U+007F-00A0, U+00AD, U+1680, U+180E,
  U+2000-200F, U+2028-202F, U+205F-206F, U+3000, U+FEFF, the variation selectors U+FE00-FE0F and U+E0100-E01EF), or
  in the repertoire (an engine font, or the system fallback a generic family reaches, trusted only that far), or in
  the cmap of a declared `data:` family named in its stack. Anything else refuses the render (R14, the first one).
- *What is checked*: canvas `fillText` / `strokeText` (2d and OffscreenCanvas contexts; `<font>` = the context's
  `font` after its first size token outside quotes), wrapped non-writable by the
  pre-script before any graphic script, every call from load on except those made during the seek-order check;
  after each `hf-seek`'s `seek(t)`, every text node under `#graphic-root` (not in `script` / `style` / `title`) whose
  parent passes `checkVisibility({ visibilityProperty: true, opacityProperty: true })` and whose box (a Range over
  the node) is not empty and not wholly outside `#graphic-root`'s box, and every such element's `::before` /
  `::after` `content` strings. Clipping by an inner `overflow: hidden` box is not considered (such text is checked). A (font-family, text) pair is checked once per page. Form-control values,
  SVG `<image>` text and text inside images are not checked.
- *Cost* (measured on the Mac mini, 2026-10-19, `graphic-determinism.mjs`, both renders of 10 fixtures + 10 PM4
  samples against the base commit): 379.3 s vs 377.9 s, +0.4 % (within run-to-run noise); the coverage is computed
  once per process (~11 ms). The page's own clock is virtualised by HyperFrames, so the check cannot be timed inside it.
  With the Arabic face (inlined as base64, ~221 KB per alias: a one-family wrapper grows to ~586 KB) and the box
  check: 386.4 s vs 376.5 s, +2.6 % against the R14-only build, the same 21 files; every frame byte-identical
  (framemd5) to that build.

**Warnings (never fatal; layer and beat alike, prefixed `layer <id>:` / `graphic <id>:`).** The e79b4d3 texts,
confirmed; GW7's `<platform name>` and GW8 are v3.1.

| # | text (exact) |
|---|---|
| GW1 | `graphic in <v>s is outside 0..<duration>s, clamped` |
| GW2 | `graphic after cut: shortened from <a>s to <b>s (the graphic's length)` |
| GW3 | `graphic after '<v>' is not hold, loop or cut, using hold` |
| GW4 | `graphic box is ignored for an insert (full frame)` |
| GW5 | `graphic audio is ignored (graphics are silent)` |
| GW6 | `graphic fps is ignored (the reel's fps is used)` |
| GW7 | `graphic box crosses the <platform name> UI zone`: `<platform name>` is the DISPLAY name, `safezone.mjs` `PLATFORMS[platform].name` (e.g. `Instagram Reels`, `TikTok`, `YouTube Shorts`), not the key. Any part of the box above `top`, below `H - bottom` or right of `W - right` |
| GW8 | `graphic src is ignored on a layer (a layer is in output seconds; the graphic file is html)` |

Lottie's W7 (the "Lottie element" section) uses the same display name. The paused `origin/mac/lottie` code
already prints it (`lottie box crosses the ${sz.name} UI zone`; its test expects `... the Instagram Reels UI
zone`), so nothing there changes; this section's `<platform name>` means the display name in both places.

**What only the render-time checks catch.** The static scan is hygiene; these pass it and are caught only by
the network lock (no request leaves) and the determinism check R6 (a clock or randomness shows as differing
frames): dynamic loads (`new Image().src = url`, `el.innerHTML = '<img src=...>'`, `setAttributeNS(..., 'href',
url)`, an `iframe` built with `srcdoc`, a `link` element built with `rel=dns-prefetch`, a meta refresh inserted from a
string) - measured blocked by the lock; CSS animations set from script (`style.cssText = 'animation:...'`,
`style.setProperty('animation', ...)`, a `@keyframes` rule written into a `<style>` from a concatenated string);
`el['ani' + 'mate']` (G28 refuses the concatenation, a variable holding the name passes); `new
Intl.DateTimeFormat().format()` with no date (reads the clock); an event's `timeStamp` read through a variable;
locale-dependent output (`toLocaleString()` without a locale). R6 compares two renders on the same machine, so
a machine-dependent but stable result (fonts, locale) is caught only across machines, by the cache key's
`platform` / `chrome` / `ffmpeg`.

**PM5 requirement (from the CP3 review).** The PM5 harness carries one fixture per network route (the 22 above,
each in its own fixture: fetch, `new Image`, image-set, innerHTML img, document.write script, srcdoc iframe,
sendBeacon, constructor eval, `@font-face` url, SVG `<image>`, `location =`, script `<a>` + click, `open()`,
form POST, meta refresh, STUN, prefetch, preload, WebSocket, static `<a>` + click, dns-prefetch, CSS `@import`),
each written to pass the static scan where possible and aimed at a listener the test opens on the host's
non-loopback address; the gate test renders each through the shim and passes only if the listener sees **zero
requests and zero packets** (and the R12 probe passes first). One more fixture (v3) aims `location =`,
`open()` and a script `<a>` + click at a listener on `http://localhost:<another port>`: zero hits required once
"Closing loopback" is built (until then it documents the residual).

Not in this version: sound inside a graphic, audio-reactive visualisers (Music graphics draw from seeded data),
WebGL / three.js, GSAP or any library (owner's pause, licence question), variables passed in at render
(`--variables`; a template's fields are filled into the HTML by the writer instead), dotLottie inside a graphic.

## What the build enforces (warnings, printed after the SFX table)

- the same meme sound twice in one reel
- meme sounds < 8 s apart; > 3.5 meme sounds per minute
- > 14 whoosh/impact/meme hits per minute (a layered whoosh+impact counts once)
- a meme sound landing on speech (put it in a pause: extend the take's `b` to keep the air, or place it on the end of the punchline word)
- the reaction slot double-booked
- an em dash in on-screen text

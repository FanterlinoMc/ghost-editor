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
- `matte: true`: cut the speaker out once (`hyperframes remove-background`, cached as `assets/talk-matte.webm`, ~4 fps) for `behind` beats.
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
| `premium-iman` | Empire | dark `empire-noir` grade, ONE glowing caps phrase at a time typed on **behind** the speaker, red verdict words slammed in, the speaker cut out on a neon set (`stage`), then a music drop into a beat-locked ladder of stills and white flashes, caps CTA card. 9:16 only | its own file (uses `captions.style: "type"`, `stage`, `drop`, `sfxDesign`) |
| `premium-signature` | Signature | the "$80 edit" on phone footage: word-cluster captions (tiny lead-ins, ONE huge serif-italic hero), a new picture every 0.6-1.6 s, hook burst, a sound on every move, warm grade. **Self-contained**: it carries phantasic main's newer `monologue.json` merged in, because the fork's `monologue` is the older cut (`look.refocus`, no `look.target`) | main's `monologue` + `premium-signature` |
| `premium-belmar` | Prestige | small lux caps with one bloomed word, `belmar-teal` grade, whip transitions, then the DROP: riser, 3 f silence, boom, a luxury B-roll ladder with flashes, tracked-caps card | its own file |
| `premium-noir` (+ `-ice/-jade/-red/-rose/-silver`) | Noir | parity with main: the fork's file differs from Ahmed's only by `music.optional: true` (checked key by key) | already in the fork |
| `premium-kit-demo` | kit demo (not a product look) | exercises every key below at once, to eyeball the kit | its own file |

`music.optional: true` is set on the Signature and Empire beds (`silent-descent`, `head-bang`): neither is shipped, so the build warns and goes on without music. `stage.room: 300` (headroom for the type behind the head) and `sound.completeMix` live in `premium-iman.json`; the engine defaults stay `room: 150` and `completeMix` off, so Podcast Glow and every other style render as before.

### Keys

- **`take.ramp`** (`"rush" | "surge" | "hit" | "slowmo"` or `{curve: [[u, speed], ...], preset, interp: "blend" | "mci" | "dup"}`): a NON-SPEECH action take plays on an eased speed curve. The picture is pre-rendered by ffmpeg into `assets/ramp-take<i>-<hash>.mp4` (cached), muted, no captions; its length on the timeline is `(b - a) / mean speed` (rush: 3 s of source = 1.23 s). `E()` maps a source second inside it through the warp. Works per recording (`take.src`, and the `sourceGrade`'d file). Not with `stage` / `matte`. A ramp can't be the last take or carry a `hold`.
- **`scene.ramp`** (image / window scene with a video `src` or `self`): same curves, the scene keeps its `at`/`to`; `media` (or `self`) is where the source starts. Stills ignore it.
- **`transitions: {kind: "whip" | "zoom" | "mix", every: 1, frames: 8, strength: 1}`**: a whip (directional blur) or zoom-through on every `every`-th jump cut between takes (ramp-take boundaries always), on the `#tx` wrapper (which now also exists when this is set). A join that has its own `take.transition` (I-17, blur / whip between two recordings) keeps that one and is skipped here; so are joins next to a hold, next to a punch-in (0.3 s) and joins across a section boundary. Scenes: `in` / `out` accept `"whip"` and `"zoom"` (style default `scenes: {image: {in: "whip"}}` or `sceneIn` / `sceneOut`).
- **`sfxDesign: {density: "low" | "med" | "high", rules, hitDb, riserDb, tailDb, softDb, tickDb, swishDb, whipDb, rampDb, hitLen, popGap, voiceGapDb}`** (also `sfx: {density}` as an OBJECT; `sfx` as an array is still the manual hit list): riser > hit > tail on major hard cuts (into B-roll / a ramp take), a swish on whips, a speed-up whoosh at the ramp peak, a soft whoosh on text-in, a swish on punch-ins, ticks on word pops (highlight words and `!` always pop); every sound is placed by its measured peak (`library/sfx/timing.json`), and every non-impact sound over speech is capped `voiceGapDb` (-8) under the voice. **A sound that is not on disk is skipped with the usual warning at the end of the build, never a die.** The shipped library has no audio, so today the pass places nothing; with files in `library/sfx` (or `PHANTASIC_LIB`) it does.
- **`drop: {hold | at, shots: [{self: <source s>} | {src, media, ramp}...], ladder: [frames], bpm + beats, gap: 3, flashEvery: 3, flash: 0.6, lift: 3, overlap, riser, boom, tail, cutSfx, in}`**: talk -> riser -> 3 f silence -> boom -> a cut ladder of image scenes (`_drop` beats; they appear in `edit_truth.json` `beats`), a white flash on every `flashEvery`-th cut, the SFX inside the drop lifted `lift` dB. `hold: i` puts it on take i's hold (give that take a `hold` >= ladder + gap); `at` is a source second inside a plain take (a warning fires when speech falls in the silence). `bpm` + `beats` express the ladder in beats, rounded on the running total. A style may carry drop defaults; the drop runs only when the reel sets `hold` / `at` / `shots`.
- **`music.alignDrop`** (track second) puts the bed's own drop on the drop's first cut; **`music.dropLift`** dB lifts the bed from there; **`music.lifts: [{a, b, db, ramp}]`** are generic lifts. `music.optional` is the fork key from the Noir section.
- **Captions**: `captions.wordReveal` (type: whole words land on their spoken start, no half-typed word), `captions.cursor: false`, type cards shrink to fit above the crown when `stage` + `captions.behind` (so the head covers part of the last line), and with `stage` + `behind` the caption layer sits between the set and the speaker (`#pip > #caps` under `#pip > #base`); `captions.popSafe` (long words pop less) and `captions.wordGap` (box style's word margin, default `0.14em`). Beat `endcard` with `bg: "none"` sits above B-roll scenes. Not ported: `captions.chestFirst` and `captions.prefer` for the placer (they live in `safezone.mjs`, which has no such option here); the kit demo drops `chestFirst`.
- **Scenes**: `pos` (CSS object-position for the crop), `cutSfx` / `cutDb` (a burst member gets its own small sound instead of the major-cut chain), `inSfx` / `inSfxDb` (the scene's own entry sound on any transition), concept scene `tickSfx` / `tickDb` (a tick per typeface swap).
- **`sound.completeMix: true`**: build the SFX audio tags at write time, so sounds added after the early mix (type-card hits, cluster hero whooshes, flashes) play, and an event with a `.fade` (the riser cut at the boom) gets a volume lane. It is Ahmed's `sound.complete`, under a new name on purpose: a dozen fork styles carry `sound.complete` as data and reading it would change their mix. Switching them over is a separate decision.
- **`PHANTASIC_PREVIEW_SCALE=0.5`** renders the same page inside a 540x960 stage (iteration only). **`PHANTASIC_LIB`** points the build at another library root.
- `look.preset` grades `belmar-teal`, `noir-film`, `empire-noir` already existed; `presets/grades.json` is identical to Ahmed's.

### `edit_truth.json` (additive, each key ONLY when set)

`takes[i].ramp` (the ramp as written; `dur` is already the ramped length, so `dur != b - a` for that take) and a top-level `txTransitions: [{t, kind}]` (the `#tx` whips and zoom-throughs of `transitions`; a join's own `take.transition` stays a take field). Drop ladder scenes are ordinary `beats` (`type: "scene"`, `kind: "image"`). Nothing else changed.

### What the build refuses (`die()`; planner validator checks)

take N has a ramp but contains speech; a ramped take can't be the last take or carry a hold; `take.ramp` with `spec.stage` / `spec.matte`; unknown ramp preset; `sfxDesign.density` not low / med / high; `transitions.kind` not whip / zoom / mix; `drop` without `shots`; `drop` without `hold` or `at`; `drop.hold` naming a take that does not exist. (A ramp that would run past the end of its source is also checked, but a take's `b` is already checked against the file.)

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
| `empire_finish.py` | `empire_finish.py <project> <takes.mp4> <depth.mp4> <takes.json> <out.mp4> [--pack DIR --music f]` | relight -> splice -> rebuild -> render -> autoscore -> score -> vcheck -> contact sheet | the zsh `empire_finish.sh` rewritten (`cmd /c npx` on Windows, `master.py --from-json`). Renders, so it is not run in the tests |

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
   file), the model input size and the model's sha256, so a re-recorded file or another model never reuses an old depth map.
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

Environment (all optional, nothing else): `PHANTASIC_PYTHON` (the interpreter to use; when set it MUST import the modules, else
the build fails naming it; unset: `.venv`, then `python3` / `python` / `py`, the first that imports numpy and cv2, plus
onnxruntime when the depth step has to run), `PHANTASIC_MODELS` (model folder), `DEPTH_THREADS` (onnxruntime intra-op threads
for the depth step, default min(4, CPU count); a speed knob, not part of the depth key: other thread counts can move the
float sums in the last bits, which does not matter after the 8-bit quantisation). Depth runs on onnxruntime's CPU provider
only (CoreML on the M4 measured slower, 0.49 vs 0.21 s/frame); relight.py uses min(4, CPU count) OpenCV threads.

`sections.json`'s `globalHash` includes `relight` (the resolved params) only when it is set. `edit_truth.json`: shape unchanged.

What the build refuses (`die()`): `relight must be true or an object`; `relight: unknown key '<k>'`; `relight.look must be
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
recording and are cached; a rebuild with everything cached takes the same < 1 s as without `relight`.

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
- Not ported: Ahmed's `ground` beat (the hook's dark grid page behind a cut-out; `glow_plan.py` only writes it with `glow.hookGround: true`), `stage.relight`, and the packs/B-roll he used in his reels.

## Premium kit: Chrome Motion (all opt-in, ported from Ahmed's gadzhi-motion)

Style `gadzhi-motion` (purple) sets them; `gadzhi-blue|green|red|yellow` extend nothing but swap `brand.accent` and `gm.theme`. Real footage with a baked grade, small lux captions, and a full-screen graphic only on 3-4 key beats.

- `sourceGrade: "<ffmpeg -vf chain>"`: a real colour grade baked into the footage once, cached as `assets/<recording>-graded-<hash>.mp4`. **Per recording:** every source is graded separately. `sourceExposure` (default 132, `false` = off) measures that recording's face-zone luma and lifts or lowers its mid-tones with a gamma (0.8-1.35) before the chain, so a dim recording and a bright one land on the same look; the hash includes the gamma. Only the `<video>` tags and the hold/outro stills read the graded file: audio, words, faces and `edit_truth.json` keep the original recording's name (`edit_truth.json` is unchanged). Absent unless set; the grade chain and exposure target are part of the sections `globalHash`. `sourceNeutral` (0..1, opt-in; the gadzhi styles set 0.65): cast neutralising. Each recording's mean chroma (U/V, one sample a second) is measured and that fraction subtracted before exposure and the grade, so a purple LED room comes out steel grey, not magenta (`gadzhi-*` only; `hormozi` does not set it). Higher values over-correct skin toward olive.
- `captions.style: "lux"`: small sentence caps at `captions.fixedY` (default 1540), revealed word by word (`captions.revealDur`, default 0.12 s), uppercase unless `captions.upper: false`, default group 4. ONE emphasis word per line is bloomed 1.5x and lands in a single frame (`captions.emph` words, else the longest word of 5+ letters; `autoEmph: false` = only `captions.emph`). Fixed-height like noir, logged as `mode: "lux"`.
- `scene` kinds `gm-object`, `gm-kinetic`, `gm-flow`, `gm-counter`, `gm-nodes` (`scripts/lib/gadzhi.mjs`; the css is written only when a reel has one). `b.theme` or `gm.theme`: `purple|blue|yellow|red|green`.
  - `gm-object`: `{object, text, textBelow, objY, objW, textY, textBelowY, gap, bigType}`. A 3D object floats in over a halo and floor shadow on grey paper; the words land on their spoken times. `object` is a name in `library/gm-objects` (chart, gears, lightbulb, puzzle, rocket, stopwatch, target) or a project path. `text` tokens: plain = small grey sans, `*x*` = big serif italic in the theme ink, `_x_` = mid serif italic, `^x` = big grey sans; `|` starts a new row; each token lands on the next spoken word that matches it, and a long row is scaled to fit.
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
- `captions.keywordAt: { word: [source seconds] }`: a keyword treatment fires only on the occurrence the planner picked. `captions.fitLine`: an editorial caption line wider than 900 px shrinks to fit. `captions.editorialShadow: "strong"`: shadow on editorial caption words (the existing `captions.shadow: "strong"` only reaches the serif style).
- `music.fallback: "<id>"`: if the bed is not on disk, play this one; if that is missing too, build without music (with a warning). Nothing changes without the key.
- `master: { lufs, ratio, threshold, lra, postLimit }`: written to `build/master.json` for a caller to hand to `scripts/master.py` (`--lufs --ratio --threshold --lra --post-limit`). Apply it with `master.py in.mp4 out.mp4 --from-json build/master.json` (explicit flags win). `master.fadeOut` (s, opt-in) also writes `fadeEnd` (= where speech ends + 0.06 s) so the voice fades out with the speech (`master.py --fadeout --fadeend`); styles `headline-3`, `monk-4`. `master.py` without the new flags is unchanged and the default stays -14 LUFS. Ahmed's key was `tp`; renamed `postLimit` because the fork's `master.py --tp` already means the `--limiter` ceiling.
- `prep.sh` with `FACE_CROP=1` (9:16 only, landscape sources, needs python + OpenCV): `scripts/face_crop.py` crops around the speaker instead of the centre. Only its static result is used; a panning or letterboxed ("fit") result cannot be written into the crop plan, so those fall back to the centred crop with a message. Off by default (Ahmed's was on by default).
- `-strict unofficial` is now passed to the hold-still and outro-still grabs (ffmpeg 7.1 refuses mjpeg from tv-range YUV without it). No effect on `index.html`.

Explainer (`explainer-2`):
- beat `effect` `{lines: [{text, at, box}], y, color, fit}`: the hook title, small spaced caps / one boxed word / small spaced caps. `fit` shrinks the boxed word to fit 1080 px.
- scene kind `cutout` `{ground: paper|chalk|maroon|slate, art | engraving | word, tilt, barsY, barChars, maxBars, wordSize, wordX, wordH, wordTop}`: a painting or engraving on torn paper, or the key word set big (`word`), while the spoken words type into black bars. `barChars` breaks bars by length instead of every 3 words. Entry sound: `sound.cutout` (default `paper-page-turn`; `false` = none), `sound.cutoutDb`.
- `captions.pillKit: true` with `captions.size`, `light`, `radius`: the pill caption's size / white-pill-dark-ink / corner radius, and words inherit the pill's ink. `captions.reshowLate`: captions come back after a hard-cut page is gone instead of 0.05 s before it ends.
- The CSS of `effect` and `cutout` is written only when a reel has one.

Mono (`mono-2`, `scripts/mono_plan.py` v5):
- `brand.footScrim` (0-1): a dark gradient behind the words on footage pages. `brand.iconSfx` / `b.iconSfx`: the icon pop sound. `brand.film` / `look.grade`: grayscale footage.
- stack beat: `punchOrigin` ("50% 30%": punch in around the face), `fit` (0.6-1: a close-up shown smaller from the top over a blurred copy), `cardH` / `cardW` / `cardRadius` (a portrait card), `filmFace: [x, y]` (frame the card / phone film on the face, source 1080x1920 px).

Folio (`folio-2`, `scripts/folio_plan.py`):
- `objectPops.faceAware: true` (+ `minScale`): the card goes in the reaction slot beside the head of the recording on screen (`placer.slot`), and is skipped when the face fills the frame.
- `endFade: <seconds>`: the picture dips to black at the end. `sfxFallback: { "<id>": "<other id>" | "none" }`: a sound whose file is missing plays the stand-in. `openFlash.clipOptional: true`: a missing burn clip no longer fails the build.

Planners (`explainer_plan.py`, `mono_plan.py`, `folio_plan.py`) are deterministic Python (no API key); they read `reel.json`, the transcript and `build/face.json` of the PRIMARY recording only, and write beats into `reel.json`. Not wired into the studio.

## Ahmed's style library (all opt-in, phase B2; hand port of phantasic origin/main `engine/core/styles` + the fix2 / mini2 branches)

Style ids: `library/<id>` (114 styles in `styles/library/`, e.g. `library/podcast-punch--19`; the name is `library/` plus an id, nothing else with a slash is accepted), `podcast`, `breakdown`, and the hardened looks `gold-ledger`, `northstar`, `red-poster`, `magazine-spread`, `monochrome-cinema-stark`, `name-reveal`. A library style extends a fork base (`clean`, `closer`, `cinematic`, `monologue`, `mono`, `pitch`, `editorial-collage`, `podcast`) or another library style.

Keys and fields the renderer reads for them (each emits nothing unless set):
- `look.rootBg`: the page colour behind the picture (default `#000`). `zoom.originY`: `#base` scales from `50% <originY>%`. `matteFilter`: a CSS filter on the cut-out layer. `watermark.spread: true`: the watermark words spread across the full width, one span each (Magazine Spread's header). `conceptCenter: true`: concept-scene engravings stay centred while they scale. A concept `engravings` name containing a `/` is the project's own picture (`assets/x.png`), not a library engraving.
- `popcard` / popcard beat: `object` (cut-out PNG, no photo frame), `objectFilter`, `glow`, `stage` (a full-frame page behind the card, any CSS background), `outFade` (seconds; the card leaves before the focus returns), `dim` (the defocus brightness, default 0.72), `labelSize`. Each is also a beat field except `objectFilter`/`glow`.
- beat `pills` `{at, to, y, w, items: [{text, glyph, at}]}` with style `pills: {w, h, gap, tab, color, size, y, sfx, sfxDb}`: the UI Story Ad #10 checklist (glyphs: check doc report chart people globe image book archive museum home shield heart clock star bolt mask tree).
- scene kind `title` `{at, to, lines: [string | {text, at, size}], size}`: the Breakdown hook title (navy card, condensed serif caps, the block shrinks ~15%). scene kind `chapter` `{at, to, num, tone: navy|paper|blue|cream, serif: [words], fit, fitWidth, sfx}`: a chapter card with a giant numeral and the spoken words one at a time; `fit: true` steps a long word down to `fitWidth` (default 960 px). Their CSS is written only when such a scene exists.
- scene kind `wordpage`: `bg: "black"` (white words on black), `ink` (word colour), `gold: [words]` + `goldColor`. scene kind `highlight`: `boxColor`, `boxInk`, `ink`.
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

Ported from main's `engine/core` (BRANCH-AUDIT.md R1): `window`, `paper` and `tv`
need no library assets and are the three of the four actually exercised by
that port's own test build. `collage`'s `image`/`glasses` items and the
`paper`-with-`engraving` auto-conversion need `library/engravings/` (ported
in R1b, along with `objectPops`, above) - build-verified against a real
recording in R1b; see `references/styles.md`.

Helpers:

- `scripts/autocut.py talk.mp4 --noise -30` prints `takes` for a single clean take. It cuts pauses from the audio, because whisper's word times hide them.
- Scene times may sit up to 1.2 s inside a removed pause; they snap to the next kept moment.
- Each whisper word belongs to the one take it overlaps most, so boundary words are never duplicated.

## What the build enforces (warnings, printed after the SFX table)

- the same meme sound twice in one reel
- meme sounds < 8 s apart; > 3.5 meme sounds per minute
- > 14 whoosh/impact/meme hits per minute (a layered whoosh+impact counts once)
- a meme sound landing on speech (put it in a pause: extend the take's `b` to keep the air, or place it on the end of the punchline word)
- the reaction slot double-booked
- an em dash in on-screen text

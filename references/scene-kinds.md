# Scene-kind inventory (mac-64)

Every beat type and scene kind the engine at release `acb5bdd` renders, what each needs in reel.json, who can
write it today, and a rendered sample of each on one clip. For widening the director against evidence.
Reproduce: `node scripts/scene-kinds-samples.mjs <prepped project> <out>` (needs `assets/talk.mp4`,
`build/words.whisper.json`, `build/face.json`; renders under the render lock). The samples are NOT in this repo
(the footage is not ours to publish); on the Mac mini they are in `~/phantasic-samples/scene-kinds/out/<name>/`
(`reel.json`, `index.html`, `build/sample.mp4`, `strip.png` = output 1.3 / 2.6 / 4.1 s).

**Counts, from the code.** `build.mjs` `switch (b.type)`: **35 beat types** (`hz-title`, `hz-name`, `hz-list`, `hz-note`
counted separately; `endcard` has a second variant, `caps`, sampled on its own). `motion.mjs buildScene()`: **26 scene kinds**
(21 plus the five `gm-*` of Chrome Motion). The "18 kinds, director uses 6" in MAC-TASKS does not match either count, so
it is not repeated here.

**Who reaches what** (phantasic `engine/planner` on origin/main, read 2026-10-24). Scene kinds: the director's
`SCENE_KINDS` holds 19, Page adds `paper`/`collage`, the Chrome look adds the five `gm-*`, so **all 26 are reachable**.
Beat types: the director writes 12 of the 38 samples here
(icon, slam, nametag, scene, titlebox, popcard, mood and leak in every style; headline, endcard caps and hz-title / hz-list /
hz-note through their looks); `designer.py` writes `motion`, the det_scripts write boxline, like, label and pin.
**Nobody writes:** `big`, `chips`, `strike`, `quote`, `list`, `emoji`, `logo`, `meme`, `endcard`, `hz-name`, `behind`, `ground`, `effect`, `pills`, `uicard`, `photostack`, `headpage`, `cover`, `whiteflash`, `starflash`, `graphic`.

**Rendered:** 63 of 64. Clip: a 7 s span (source 29.0-36.0 s) of one seated talking-head
recording, a close-up (the face reaches y ~1100 of 1920), checked for halal brand safety (transcript of the span and
a frame every 5 s: modest dress, no logos, no swearing in the span used). Each sample is that span alone with one beat at
30.0-33.5 s, in `clean` unless the kind belongs to a style (column 2). The library ships no sound files, so every
sample is silent; the "sound skipped" warnings are left out of the notes.

## Findings that matter for the director

- **The reaction slot is lost on a close-up.** `emoji`, `icon`, `logo` and `meme` were all dropped (`no-room`) on this
  clip until pinned with `x`/`y`. The director's `icon` beats will drop the same way on close-ups; it should pin or skip.
- **`meme` cannot render**: `library/memes` ships no memes. **`leak` renders nothing visible** without a style pack
  (licensed, not shipped): it warns `no leak/burn clip`.
- **`behind` and `ground` cost a person matte**: the first build of a 7 s take spent ~3.5 min cutting out the speaker.
- **`gm-nodes` with `pill: "text"`** dies with `E(function at() ...)`: `pill` must be `{text, at}`; a string's `.at` is
  `String.prototype.at`. Worth a validator line in the planner.
- **`hz-list` items need `at`**; without it the build dies (`E(undefined) for hz list item`).
- **`graphic`**: an `insert` must be 1080x1920 (the engine's 1080x1080 fixtures must be overlays).
- **Seen on the strips, not in any log** (a build that passes is not a sample that reads):
  - `chips`: on the close-up the chip row starts off the left edge ("heffield").
  - `hz-list` with `text` items prints "undefined" (items are `{title, sub}`); the strip is from the fixed sample.
  - `scene-tv`: the third channel (a still, `src`) is black at 4.1 s; the two `self` channels show.
  - `scene-collage`: a `headline` item and a `box` item overlap ("English" over "STUDYING"); items need positions.
  - `leak`: nothing visible (no pack). `scene-fly3d`: the sampled frames are mostly the blurred near word.
  - `endcard` caps: the title is small on a black frame at this size; `size` is worth setting.

## Beat types

| kind | style | reel.json | assets | written by | sample | notes |
|---|---|---|---|---|---|---|
| `big` | clean | `text`, `sub`, `count` | none | **no** | rendered `big/strip.png` |  |
| `chips` | clean | `items:[{text|icon|src, label, bg, fg, invert, at}]` | none | **no** | rendered `chips/strip.png` |  |
| `strike` | clean | `text`, `strikeAt` | none | **no** | rendered `strike/strip.png` |  |
| `quote` | clean | `header`, `lines:[{text, at, big}]` | none | **no** | rendered `quote/strip.png` |  |
| `list` | clean | `lines:[{text, at}]`, `stamp`, `stampAt`, `stampSfx` | none | **no** | rendered `list/strip.png` |  |
| `emoji` | clean | `emoji`, `x`, `y` | none | **no** | rendered `emoji/strip.png` |  |
| `slam` | editorial-collage | `text`, `pre`, `post`, `size` | none | director (all styles) | rendered `slam/strip.png` |  |
| `nametag` | clean | `name`, `title`, `subtitle`, `x`, `y`, sizes, `color`, `wipe` | none | director (all styles) | rendered `nametag/strip.png` |  |
| `icon` | clean | `name` (Lucide slug), `x`, `y`, `ink` | vendored Lucide | director (all styles) | rendered `icon/strip.png` |  |
| `logo` | clean | `icon` (simple-icons slug) or `src`, `bg`, `invert`, `x`, `y` | vendored simple-icons | **no** | rendered `logo/strip.png` |  |
| `meme` | clean | `id` (library), `audio`, `in`, `w`, `x`, `y`, `tilt`, `db` | **library/memes: none shipped** | **no** | **build failed** - | DROPPED no-room: The meme at 0:01 was left out because the speaker's face fills the frame and there is no room beside it.; ERROR: meme 'vine-boom' not in library (library/memes/vine-boom/meta.json); add it with meme_add.py or run meme_find.py |
| `endcard` | clean | `title`, `line`, `url` | none | **no** | rendered `endcard/strip.png` |  |
| `endcard-caps` | clean | `variant:"caps"`, `title` (`|` breaks), `font`, `accent`, `size`, `y`, `bg`, `arrow` | none | director, Noir look (chapter) | rendered `endcard-caps/strip.png` |  |
| `headline` | podcast-glow | `big` (required), `small`, `bigAt`, `smallAt`, `pos: low|top|left`, `arrow`, `behind` | none | director, Glow look | rendered `headline/strip.png` |  |
| `hz-title` | hormozi | `text` | none | director, Authority look | rendered `hz-title/strip.png` |  |
| `hz-name` | hormozi | `name`, `title`, `avatar` / `avatarAt` / `avatarCrop` | none | **no** | rendered `hz-name/strip.png` |  |
| `hz-list` | hormozi | `items:[{title, sub, n, at}]` (`at` required; `text` renders "undefined") | none | director, Authority look | rendered `hz-list/strip.png` |  |
| `hz-note` | hormozi | `text` | none | director, Authority look | rendered `hz-note/strip.png` |  |
| `behind` | clean | `text`, `size`, `y`, `color`; reel `matte: true` | person matte (local cut-out, ~3.5 min for a 7 s take) | **no** | rendered `behind/strip.png` |  |
| `ground` | clean | `color` | `paper` | `gradient`, `text`, `lead`, `backdrop`, `grain`, `hideCaptions`; reel `matte: true` | person matte | **no** | rendered `ground/strip.png` |  |
| `effect` | explainer-2 | `lines:[{text, box, at}]`, `fit`, `y`, `color` | none | **no** | rendered `effect/strip.png` |  |
| `titlebox` | clean | `text`, `size`, `y`, `color`, `typeFor` | none | director, if the style's rules name it | rendered `titlebox/strip.png` |  |
| `popcard` | clean | `ui:{type, title}` or `art` / `src`, `label`, `w`, `h`, `y`, `object`, `stage`, `dim`, `blur` | `ui` card (no asset) or an image | director, if the style's rules name it | rendered `popcard/strip.png` |  |
| `pills` | clean | `items:[{text, glyph, at}]`, `w`, `y` | none | **no** | rendered `pills/strip.png` |  |
| `uicard` | clean | `src` | `art`, `pins:[{x, y, at}]`, `w`, `h`, `y`, `pad`, `fit` | a still | **no** | rendered `uicard/strip.png` |  |
| `photostack` | clean | `items:[{src|art, label, at}]`, `disc`, `w`, `h`, `y` | stills | **no** | rendered `photostack/strip.png` |  |
| `headpage` | clean | `src` | `art`, `glow`, `pin`, `avatars:[{src, at}]` | a still | **no** | rendered `headpage/strip.png` |  |
| `cover` | clean | `y0`, `y1`, `color`, `feather`, `opacity` | none | **no** | rendered `cover/strip.png` |  |
| `whiteflash` | clean | `color`, `peak`, `rise` | none | **no** | rendered `whiteflash/strip.png` |  |
| `starflash` | clean | `color`, `field:[c1, c2]`, `text`, `textColor`, `textSize`, `textY` | none | **no** | rendered `starflash/strip.png` |  |
| `boxline` | podcast | `text`, `quotes`, `label`, `x`, `y`, `w`, `tilt`, `prefer` | none | det_scripts/podcast_plan.py | rendered `boxline/strip.png` |  |
| `like` | clean | `x`, `y` | none | det_scripts/podcast_plan.py | rendered `like/strip.png` |  |
| `label` | breakdown | `text`, `color`, `y`, `typeFor` | none | det_scripts/breakdown_plan.py | rendered `label/strip.png` |  |
| `pin` | breakdown | `text`, `size`, `y` | none | det_scripts/breakdown_plan.py | rendered `pin/strip.png` |  |
| `leak` | clean | `bloom` | **a style pack (licensed, not shipped)** | director, if the style's rules name it | rendered `leak/strip.png` | leak at 30: no leak/burn clip (turn a pack on in the style's "packs") |
| `mood` | clean | (none) | none | director, if the style's rules name it | rendered `mood/strip.png` |  |
| `motion` | clean | `id`, `elements:[...]` (the motion spec), `by`; reel `designer: true` unless `by: "user"` | none | designer.py (not the director) | rendered `motion/strip.png` |  |
| `graphic` | clean | `html: assets/graphics/<name>.html`, `mode: overlay|insert`, `box`, `fit`, `in`, `after` | a local HTML file (engine fixture used here) | **no** | rendered `graphic/strip.png` | graphic g1: graphic box crosses the Instagram Reels UI zone |

## Scene kinds (`type: "scene"`, `kind`)

| kind | style | reel.json | assets | written by | sample | notes |
|---|---|---|---|---|---|---|
| `scene-card` | clean | `lines:[{text, at, size, color}]`, `pill:{text, at}`, `cursor:{clickAt}`, `bg`, `y` | none | director (SCENE_KINDS) | rendered `scene-card/strip.png` | page @30: "Born in" was said at 6.3s, not while the page is up (1.0-4.5s): it will lag the voice |
| `scene-stats` | clean | `badges:[{value, sub, at, label, labelAt}]`, `bg`, `centerY`, `gap` | none | director (SCENE_KINDS) | rendered `scene-stats/strip.png` |  |
| `scene-fly3d` | clean | `items:[{text, sub, at, x, y, z, size}]`, `cam`, `focus`, `ease` | none | director (SCENE_KINDS) | rendered `scene-fly3d/strip.png` |  |
| `scene-image` | clean | `src`, `zoom`, `grade` | a still (`src`; library/art ships none) | director (SCENE_KINDS) | rendered `scene-image/strip.png` |  |
| `scene-window` | clean | `src` or `self` (source seconds) | none | director (SCENE_KINDS) | rendered `scene-window/strip.png` |  |
| `scene-clip` | clean | `src` (video), `in`, `zoom`, `fit`, `audio` | a video file | director (SCENE_KINDS) | rendered `scene-clip/strip.png` |  |
| `scene-sentence` | clean | `lines:[...]`, `hero:{text, at, size}`, `sub:{text, cross}` | none | director (SCENE_KINDS) | rendered `scene-sentence/strip.png` |  |
| `scene-ui` | clean | `title`, `label`, `prompt:{text, at}`, `lines:[{text, at}]` | none | director (SCENE_KINDS) | rendered `scene-ui/strip.png` |  |
| `scene-device` | clean | `src` or `lines:[{text, at, me}]`, `label` | none | director (SCENE_KINDS) | rendered `scene-device/strip.png` |  |
| `scene-kinetic` | clean | `text` (`*key*`, `_filler_`), `size`, `zoom`, `pullback`, `pip` | none | director (SCENE_KINDS) | rendered `scene-kinetic/strip.png` |  |
| `scene-paper` | clean | `lines:[{text, style, at, size}]`, `y`, `align`, `engraving` | (engravings with `engraving`) | director (Page; with `engraving` it becomes a collage) | rendered `scene-paper/strip.png` |  |
| `scene-tv` | clean | `items:[{src|self, dur}]` | stills / the speaker's own footage | director (SCENE_KINDS) | rendered `scene-tv/strip.png` |  |
| `scene-collage` | clean | `paper`, `items:[{type, style, ...}]`, `screen`, `bulge`, `zoom` | none | director, through Page only | rendered `scene-collage/strip.png` |  |
| `scene-wordpage` | clean | `bg`, `paper`, `size`, `big`, `serif`, `ink`, `gold` | none | director (SCENE_KINDS) | rendered `scene-wordpage/strip.png` |  |
| `scene-highlight` | clean | `lines:[{text, at, box}]`, `paper`, `ink`, `boxColor` | none | director (SCENE_KINDS) | rendered `scene-highlight/strip.png` |  |
| `scene-cardpage` | clean | `items:[{at, art|logo}]`, `paper`, `w`, `y` | logos (vendored) or art | director (SCENE_KINDS) | rendered `scene-cardpage/strip.png` |  |
| `scene-concept` | clean | `word`, `fonts`, `step`, `engravings` | library/engravings | director (SCENE_KINDS) | rendered `scene-concept/strip.png` |  |
| `scene-stack` | mono | `lines:[...]` or `lead` / `key` / `tail`, `bg`, icon / flip / footage fields | none | director (SCENE_KINDS) | rendered `scene-stack/strip.png` |  |
| `scene-chapter` | breakdown | `num`, `fit`, `serif`, `tone` | none | director (SCENE_KINDS); also det_scripts/breakdown_plan.py | rendered `scene-chapter/strip.png` |  |
| `scene-title` | breakdown | `word`, `lines`, `barChars`, `maxBars` | none | director (SCENE_KINDS) | rendered `scene-title/strip.png` |  |
| `scene-cutout` | explainer-2 | `word` or `art` / `engraving`, `barsY`, `tilt` | art / engraving, or `word` | director (SCENE_KINDS) | rendered `scene-cutout/strip.png` |  |
| `scene-gm-object` | gadzhi-motion | `object` (gm-objects pack), `text` (token list) | library/gm-objects (CC0) | director, Chrome look | rendered `scene-gm-object/strip.png` |  |
| `scene-gm-kinetic` | gadzhi-motion | `text` (token list) | none | director, Chrome look | rendered `scene-gm-kinetic/strip.png` |  |
| `scene-gm-flow` | gadzhi-motion | `title`, `items:[{label, icon, at}]` | gm-objects icons | director, Chrome look | rendered `scene-gm-flow/strip.png` |  |
| `scene-gm-counter` | gadzhi-motion | `value`, `label`, `icon`, `countAt`, `prefix`, `suffix` | gm-objects icons | director, Chrome look | rendered `scene-gm-counter/strip.png` |  |
| `scene-gm-nodes` | gadzhi-motion | `object`, `nodes:[{n, at}]`, `pill:{text, at}` (an object: a string fails) | library/gm-objects (CC0) | director, Chrome look | rendered `scene-gm-nodes/strip.png` |  |

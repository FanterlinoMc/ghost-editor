# Styles

A style is a preset in `styles/<name>.json`: brand (fonts, accent), caption
style, sound density, music mood, film look and scene defaults. A reel names
one with `"style": "<name>"`, and anything in reel.json overrides the preset.
The preset sets the LOOK. The beats (what happens when) are still planned per
recording, using the grammar below. Every style was rendered from the same
recording (`examples/gallery/`) to check that they read as different.

| style | looks like | best for | beats that fit | sound | music |
|---|---|---|---|---|---|
| `clean` | bold mixed-case captions, active word in the accent, snap zooms, no scenes | business talking heads, advice, Hormozi-restrained | snaps at sentence starts, 1-2 pushes, at most 1-2 `big` cards | restrained | none (add one on the platform) |
| `editorial` | lowercase blur-in captions, light previous line, tilted pill tags, highlight wipes, full-screen scenes over the voice | data, insight, "new research shows" | `card` with cursor, `stats`, `fly3d`, `image`, `sentence` covering 30-50% of the runtime | standard | tense minimal electronic |
| `meme` | outline captions, emoji/memes beside the head, chips and big cards | entertainment, hot takes, reactions | `emoji`, `meme` (own library), `big`, `chips`, `strike`; reaction sounds on punchlines | rich | quirky |
| `cinematic` | film grade, grain, vignette, B&W B-roll stills, keywords in a glowing serif italic, dark sentence scenes | stories, founder journeys, emotional turns | `image` B-roll (AI stills via `broll_gen.py`), dark `sentence` heroes, 1 push per section | restrained (boom, riser) | ambient cinematic |
| `launch` | dark UI windows with typed prompts, phone frames with chats, glitch transitions, violet accent | product and AI launches, feature demos | `ui` (the pain or the prompt), `device` (the product answering), `sentence` hero for the name, cursor CTA card | standard | upbeat electronic |
| `kinetic` | full-screen word-by-word type on a solid colour, a camera gliding between words, speaker in a round picture-in-picture | hooks, quotes, manifestos, lists | `kinetic` scenes (`*keyword*`, `_filler_`), `pip: true`, 1-2 per reel | standard | percussive |
| `pop` | giant display words BEHIND the speaker (person cut-out), uppercase captions with hot colour boxes | personal brand, lifestyle, bold claims | `behind` beats on the 2-4 biggest words, colour-block CTA | standard | upbeat pop |
| `closer` | whole phrase in ALL CAPS on a solid yellow box, automatic punch-ins every ~2.4 s | high-energy sales, Hormozi-style shorts | no scenes; `cadence` does the framing, a whoosh every 3rd cut | restrained | none |
| `headline` | 1-2 word tall condensed ALL CAPS captions, punch-ins every ~1.4 s | news-style hooks, B-roll of whatever is named | `window`/`tv`/`image` B-roll for the named thing | standard | none |
| `keynote` | two framings alternating on `cadence`, lowercase editorial captions with a gold handwritten keyword, warm light leaks, an opening push | cinematic speaker edits with a problem/answer arc | `tv` (distraction/noise), `window` (doing something), `image` (a vivid moment), `icon` tiles, `nametag` | restrained | soft cinematic bed |
| `alif` | soft teal grade, translucent word-box captions filling in one at a time, name tag with a hand-drawn arrow, grid-paper cutaways | calm premium interviews ("Sessions" look) | `paper`/`collage` cutaways, `nametag`, `listMarks` for enumerations | restrained | none shipped (see below) |
| `monk` | one locked shot, small lowercase serif captions in muted gold, no pops, no effects | minimalist philosophy / one-idea shorts | none - the point is stillness | none | none |
| `editorial-collage` | vintage engraving collage pages (CRT screen fringe) on the speaker's own words, name tag from frame 1 to the hook page, one type "slam" per video, condensed serif captions in a phrase-sized box that fill in word by word | calm premium founder interviews, brand-neutral base template | `paper` scenes with `engraving` + `lines` (auto-converted to `collage`), `slam`, `nametag`, automatic tool logos / object pop-ups | restrained | none shipped (see below) |
| `ak-consulting-content` | `editorial-collage` + the `ak-consulting` brand kit (navy accent, watermark, auto name tag from the kit's `person`) | Ahmed Karrar's own reels | same as `editorial-collage`; the name tag is automatic (from `brands/ak-consulting.json`, no `nametag` beat needed) | restrained | none shipped (see below) |
| `broadsheet` | `editorial-collage`'s engine with a newsprint page (heavy display headline, brand-colour kicker, italic deck) slapped in from the right, white serif-on-black tilted "clipping" captions, byline name tag ("By \<name\>"), fast punch-ins | newsroom energy, fast-cut talking heads | `paper` scenes (auto-remapped serif/box/marker lines to deck/headline/kicker via `pageMap`), `slam`, byline `nametag` | restrained | none shipped (see below) |
| `premium-noir` | black-and-white cinema documentary: letterbox bars, serif subtitles in the lower bar with ONE gold italic word per line, noir-film grade (skin mono, gold kept), heavy grain, slow eased push-ins anchored on the face | stories, life lessons, calm serious talking heads; needs no B-roll | optional `endcard` chapter cards (`variant: "caps"`, `font: "serif"`); `captions.emph` picks the gold word | restrained | `silent-descent` piano, skipped with a warning when the file is not on disk |
| `premium-iman` | Empire (BETA): dark empire-noir grade, ONE glowing caps phrase at a time typed on behind the cut-out speaker (red verdict words slam in), a neon set, then a music drop into a beat-locked ladder of stills with white flashes and a caps CTA card; 9:16 only | short punchy business / mindset talks | `stage` (needs the cut-out matte), `drop` shots, `captions.reds`, popcard objects, `endcard` `variant: "caps"` | standard + sfxDesign | `head-bang`, skipped with a warning when the file is not on disk |
| `premium-signature` | Signature (BETA): word-cluster captions with one huge serif-italic hero word, a new picture every 0.6-1.6 s, hook burst, a sound on every move, warm grade | monologues on ordinary phone footage | meaning cutaways (`scene` `image` with `pos`, `cutSfx`), concept cards; `signature_plan.py` writes the reel from a plan | restrained + sfxDesign high | `silent-descent`, skipped with a warning when the file is not on disk |
| `premium-belmar` | Prestige (BETA): small lux caps with one bloomed word, belmar-teal grade, whip transitions, then a drop into a luxury B-roll montage and a tracked-caps card | luxury / lifestyle talks with a payoff line | `drop` shots, `endcard` `variant: "caps"` | restrained + sfxDesign low | none (the scorer takes the music) |
| `premium-kit-demo` | not a product look: every premium-kit key at once (ramps, whips, sfx design, grade preset) | looking at the kit | `take.ramp`, `scene.ramp`, `drop` | standard + sfxDesign med | none |
| `podcast-glow` | warm orange podcast grade, punch-ins between framings, ONE word at a time in heavy yellow glow caps, a HEADLINE about every 5 s (small white line over a huge condensed yellow word), the speaker optionally cut out onto a grid / video set on the best moments | podcast clips, talking heads that need rhythm | `headline` beats (`scripts/glow_plan.py` writes them), `stage.windows` | restrained | `deep-techno-ambience`, skipped with a warning when the file is not on disk |
| `gadzhi-motion` | Chrome Motion: the speaker's real footage with a baked cinematic grade and small lux captions; on 3-4 key beats a full-screen graphic (a chrome 3D object with mixed serif/sans type, glass icon flow, a counting card, numbered nodes) replaces him | explainers, ROI / numbers talks, AI and business shorts | `scene` kinds `gm-object`, `gm-kinetic`, `gm-flow`, `gm-counter`, `gm-nodes` | restrained | `deep-techno-ambience`, skipped with a warning when the file is not on disk |
| `hormozi` | Authority: clean white sentence-case captions with a heavy keyword, a red title box on the hook, a white name card with a face avatar, a split-screen numbered list when he counts points, hard wide/close punch cuts, natural baked grade | business and advice shorts, one speaker | `hz-title`, `hz-name`, `hz-list`, `hz-note` (`scripts/focus_director.py` plans them) | restrained | `deep-techno-ambience` at -30 dB, skipped with a warning when the file is not on disk |

`closer`, `headline`, `keynote`, `monk` and `alif` were ported from main's
`engine/core` (BRANCH-AUDIT.md R1) rather than rendered from
`examples/gallery/` here, so step 4 below (render to confirm the look) is
still open for all five - a follow-up, not part of that port. `alif.json`'s
`openFlash`/`packs`/`leaks` degrade to an asset-free CSS flash without
`library/packs/`, and its `music` is `null` (no cleared track) rather than
main's unlicensed track - see the style file's `_about`.

`editorial-collage`, `ak-consulting-content` and `broadsheet` were ported the
same way, in BRANCH-AUDIT.md R1b (main added them after R1's port landed), so
they carry the same open follow-up and the same `openFlash.clip`/`music: null`
treatment as `alif.json` - see each style file's `_about` for specifics.
Unlike the five R1 styles, all three were also build-tested against a real
recording during the port (not just `node --check`) - see R1b's commit
messages for what was verified.

## Style layering: `extends` and brand kits

A style can `"extends": "<base-style>"`: the base style loads first, then this
style's own keys deep-merge on top (only the keys this style sets are
overridden; everything else comes from the base). `broadsheet.json` extends
`editorial-collage.json` this way to reuse its whole beat/scene/sound
vocabulary while swapping the paper look, captions and transitions.

A style (or a reel.json) can also name a `"brandKit": "<id>"`
(`brands/<id>.json`): accent/accentDark colours, an optional `watermark`, an
optional `person` (auto-generates a `nametag` beat with `until: "hook"` - on
screen from the first frame until the first `scene` beat cuts in, or 2.4 s if
there is none), an optional `music` override, and a flash tint. If the kit
gives no explicit flash colour/filter, one is derived from the accent hue so
every brand gets its own burn rather than the shipped orange. `ak-consulting-
content.json` is `"extends": "editorial-collage", "brandKit": "ak-consulting"`
- both mechanisms at once: the base style's look, the brand's colours and
auto name tag.

## Picking a style

- The speaker's energy decides more than the topic. A calm explainer in `pop` feels wrong; a hype launch in `clean` feels flat.
- Ask for a reference edit when the user has one: `reference_study.py` and the closest style, then override.
- Don't mix two styles' signature moves in one reel (e.g. `kinetic` scenes inside `cinematic`). Keep the recognisable beats consistent.

## Keeping every reel fresh (same style, not the same reel)

- Rotate the accent and the music bed between reels (`brand.accent`, `music.id`); keep fonts and caption style (the brand).
- Change the scene order and kinds: a `stats` reel, then a `fly3d` reel.
- One new move per reel (a new scene kind, a transition), everything else proven.

## Saving a new style (from a reference study or a reel the user loved)

1. Copy the closest preset in `styles/` to `styles/<new-name>.json`.
2. Set `_about` (one line: the look and when to use it), `brand` (accent, accentDark, ink, fonts), `captions` (style, `upper`, `keywordStyle`), `sfxProfile`, `music` (an id or `auto` plus a mood tag in `library/music/manifest.json` `styles`), `look` and `scenes` defaults. Take all of these from the study or the reel.json that worked.
3. Add a row to the table above, and save the reel.json that defined it as `examples/gallery/<new-name>.reel.json`.
4. Render one existing example in the new style to confirm it reads as its own look.

### User styles (`user:<id>`)

A reel can use a style that is not in `styles/`: set `"style": "user:<id>"`. `build.mjs` loads it from `$USER_STYLES_DIR/<id>/style.json` (on staging `USER_STYLES_DIR=/data/templates`). If `USER_STYLES_DIR` is unset, a `user:` style stops the build with a clear message.

- A user style's `extends` may name only a **built-in** style from `styles/` (no `user:` chains). A cycle among built-ins is still refused.
- `brandKit` inside a user style is ignored with a warning (a reel's own `brandKit` is unaffected).
- Every style name, built-in or user, must match `^[a-z0-9][a-z0-9-]{0,63}$` (with the optional `user:` prefix); anything else stops the build with "bad style name". Brand kit names must match `[a-z0-9-]`. The one resolver is `scripts/lib/style-path.mjs` (tests: `node --test scripts/lib/style-path.test.mjs`).
- Built-in styles build byte-identically with or without this feature.
- Which keys a user style may set is the allowlist in the assistant-edits spec (B3); `build.mjs` does not enforce it, the planner's style validator does.

## Caption and overlay safety (all styles)

`scripts/face_track.py` must run before the build. The placer then:
- puts every caption block **below the chin** near the ideal reading height, else **above the head**, else shrinks it (down to 70%) to fit above the head, and only as a last resort puts it **as low as the platform allows** on a dark backing (never over the eyes or the mouth)
- keeps blocks in the same zone while it fits (no top/bottom jumping)
- keeps inside the platform's safe area (`"platform": "instagram" | "tiktok" | "shorts" | "all"`) and clear of the right-hand button column
- places cards (`big`, `chips`, `strike`, `quote`, `list`) beside the face too; a `big` with no room is promoted to a full-screen scene
- puts emoji/logo/meme on the side of the head with room, or skips them
- steps captions around cards on screen at the same time

**Emoji in Broadsheet captions: a per-host bound (mac-56).** The clipping caption model reserves 1.5 em per emoji, the
bound over every platform measured (Apple 1.0, Noto 1.248, Segoe 1.373), because a browserless build cannot know the
render host. A host may reserve its own, measured value instead, with two deploy settings written from one measurement:

    node scripts/emoji-advance.mjs --write /etc/phantasic/emoji-stamp.json   # on the render host; --font <ttf> without fontconfig
    CAPTION_EMOJI_EM=1.248  CAPTION_EMOJI_STAMP=/etc/phantasic/emoji-stamp.json

The value is used only when it is at least the stamp's measured advance and the emoji font file the stamp names still
has the stamped sha256. Otherwise the build reserves 1.5 and warns why; unset is 1.5 with no warning. **Re-measure after
any base-image or font change**: a changed font is refused loudly, never used silently. Measured: Noto Color Emoji's
widest of 1,205 emoji is 1.248 em; on 420 random emoji groups the model at 1.248 over-reserves 227 and under-counts
0, against 272 at 1.5. Code: `scripts/lib/emoji-em.mjs`; test: `scripts/emoji-em.test.mjs`.

`build/caption_layout.json` records every block's zone. `qa.py` prints the counts and fails on anything outside the safe area.

**The last-resort block grows upward (mac-47).** A block in that lowest position (`mode: "lower-face"`) is placed by its
BOTTOM edge (`top` at the band's bottom plus CSS `translate: 0 -100%`), at the bottom of the band the placer reserved for it. A block that wraps to more lines
than the band holds therefore grows up over the chest, never down into the platform's bottom UI. Before this, such a
block was placed by its top and spilled down: measured up to 123 px into the bottom zone (closer), 75 px (headline-2
and 3), 22 px (editorial, cinematic). The same holds for a block below the face (or with no face seen) whose band ends less than one more line above
the safe bottom (mac-53: clean on a close-up, 2 blocks drawn 48 px into the bottom zone, now 0). Every other position
is unchanged and still placed by its top, and blocks above the head are never moved; clipping
(Broadsheet) keeps its measured band (mac-45). `node scripts/caption-boxes.mjs <project> --check` measures the drawn
boxes (`drawnTop` / `drawnBottom`, after this anchoring) against the safe area.

`premium-noir` (and `premium-noir-ice|jade|red|rose|silver`, which extend it and change only the gold word's colour) was
hand-ported from Ahmed's Noir (phantasic `origin/template-hormozi`, `engine/core/styles/premium-noir.json`) with the
engine features it needs - see "Premium kit: Noir" in `references/reel-json.md`. It differs from his JSON in one key:
`music.optional: true`. His `noir_score.py` sound pass is ported too (`scripts/noir_score.py`); the vendored GSAP is not. The other premium looks (Empire, Signature, Prestige) and the kit are under "Premium line" in the same file.

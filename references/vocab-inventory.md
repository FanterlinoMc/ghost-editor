# What renders at the pin (mac-71, 25 Oct)

Every beat type and scene kind, rendered at engine **5a520b7** on one 7 s close-up (t-james, brand-safety checked), one item per sample, by `scripts/scene-kinds-samples.mjs`; `scripts/vocab-diff.py` measures each against a no-beat control (`none`). Silent: no sfx library on the Mac. **64 items (38 beat samples, 26 scene kinds): 48 usable, 12 usable with care, 4 not usable. Plus 5 misuse variants, all 5 not usable (each is dropped with a warning, prints "undefined", or crashes the build).**

- `build s` / `render s`: wall time on the M4 mini (render = HyperFrames, 7 s at 30 fps). A matte (behind, ground) is the only expensive build.
- `diff`: mean absolute grey difference from the no-beat control over the beat window (0 = drew nothing); `cover`: the largest share of the frame it changed.
- Rows ending `-auto`, `-text`, `-pillstr` are the shapes a model will plausibly write, to show what the engine does with them.

| group | item | style | build | render | build s | render s | diff | cover | verdict | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| beat | behind | clean | ok | ok | 203.3 | 18.1 | 5.1 | 0.039 | usable with care | works (text behind the head); matte costs ~3.4 min for 7 s |
| beat | big | clean | ok | ok | 0.1 | 10.3 | 7.6 | 0.096 | usable |  |
| beat | boxline | podcast | ok | ok | 0.1 | 11.3 | 37.6 | 0.366 | usable | podcast |
| beat | chips | clean | ok | ok | 0.1 | 10.4 | 4.5 | 0.056 | usable with care | runs off the LEFT edge on a close-up ("heffield"); give x or keep items short |
| beat | cover | clean | ok | ok | 0.1 | 10.3 | 20.3 | 0.213 | usable | subtle (a bottom gradient) |
| beat | effect | explainer-2 | ok | ok | 0.1 | 11.4 | 17.3 | 0.187 | usable | explainer-2 |
| beat | emoji | clean | ok | ok | 0.1 | 10.5 | 2.7 | 0.022 | usable | only with x/y on a close-up |
| beat | emoji-auto | clean | ok | ok | 0.1 | 10.5 | 0.0 | 0.0 | NOT usable | no x/y on a close-up: dropped ("no room beside the face"), draws nothing |
| beat | endcard | clean | ok | ok | 0.1 | 10.2 | 58.1 | 0.822 | usable |  |
| beat | endcard-caps | clean | ok | ok | 0.1 | 9.2 | 91.5 | 0.999 | usable with care | with these fields: black frame, tiny serif "I. / Home" and a green arrow; looks broken as a mid-reel beat (made for the outro) |
| beat | graphic | clean | ok | ok | 0.1 | 10.5 | 0.0 | 0.0 | NOT usable | DROPPED by P5 at this box (crosses the caption band); usable only with a box clear of captions or hideCaptions |
| beat | ground | clean | ok | ok | 205.7 | 17.7 | 33.1 | 0.39 | usable with care | works; matte costs ~3.4 min for 7 s |
| beat | headline | podcast-glow | ok | ok | 0.1 | 11.5 | 38.7 | 0.481 | usable | podcast-glow |
| beat | headpage | clean | ok | ok | 0.1 | 9.4 | 132.0 | 0.981 | usable with care | renders a green halo blob around a small image; looks broken with these fields |
| beat | hz-list | hormozi | ok | ok | 34.4 | 10.4 | 74.0 | 0.863 | usable | needs items {title, sub, at} |
| beat | hz-list-text | hormozi | ok | ok | 34.9 | 10.6 | 74.1 | 0.865 | NOT usable | items written with `text` render the word "undefined" on screen, no warning |
| beat | hz-name | hormozi | ok | ok | 34.8 | 10.9 | 50.0 | 0.575 | usable | hormozi |
| beat | hz-note | hormozi | ok | ok | 34.4 | 10.7 | 40.2 | 0.53 | usable with care | tiny text under the captions; barely readable |
| beat | hz-title | hormozi | ok | ok | 34.8 | 11.2 | 42.1 | 0.54 | usable | hormozi |
| beat | icon | clean | ok | ok | 0.1 | 10.7 | 1.5 | 0.023 | usable | only with x/y on a close-up |
| beat | icon-auto | clean | ok | ok | 0.1 | 10.4 | 0.0 | 0.0 | NOT usable | no x/y on a close-up: dropped, draws nothing |
| beat | label | breakdown | ok | ok | 0.1 | 11 | 40.8 | 0.429 | usable | breakdown |
| beat | leak | clean | ok | ok | 0.1 | 10.6 | 0.0 | 0.0 | NOT usable | draws nothing: no leak/burn pack is turned on ("turn a pack on in the style's packs") |
| beat | like | clean | ok | ok | 0.1 | 10.7 | 1.2 | 0.016 | usable | small Like -> Liked button |
| beat | list | clean | ok | ok | 0.1 | 10.4 | 10.7 | 0.101 | usable | stamp lands |
| beat | logo | clean | ok | ok | 0.1 | 10.7 | 3.7 | 0.038 | usable | only with x/y on a close-up |
| beat | logo-auto | clean | ok | ok | 0.1 | 10.7 | 0.0 | 0.0 | NOT usable | no x/y on a close-up: dropped, draws nothing |
| beat | meme | clean | FAIL | - | 0.1 | - | - | - | NOT usable | build FAILS: the library ships no memes ("meme 'vine-boom' not found") |
| beat | mood | clean | ok | ok | 0.1 | 10.5 | 6.1 | 0.0 | usable | a grade (black and white here), not an element |
| beat | motion | clean | ok | ok | 0.1 | 10.5 | 13.5 | 0.097 | usable | designer elements |
| beat | nametag | clean | ok | ok | 0.1 | 10.6 | 1.7 | 0.013 | usable with care | small; sits on the caption line here |
| beat | photostack | clean | ok | ok | 0.1 | 9.4 | 119.0 | 0.927 | usable |  |
| beat | pills | clean | ok | ok | 0.1 | 10.6 | 11.2 | 0.11 | usable |  |
| beat | pin | breakdown | ok | ok | 0.1 | 11.1 | 40.5 | 0.418 | usable | breakdown |
| beat | popcard | clean | ok | ok | 0.1 | 10.5 | 20.7 | 0.192 | usable with care | the card sits ON the face on a close-up (P4 does not move it) |
| beat | quote | clean | ok | ok | 0.1 | 10.5 | 9.0 | 0.096 | usable |  |
| beat | slam | editorial-collage | ok | ok | 0.1 | 11.4 | 51.7 | 0.817 | usable |  |
| beat | starflash | clean | ok | ok | 0.1 | 9.6 | 61.2 | 0.89 | usable |  |
| beat | strike | clean | ok | ok | 0.1 | 10.6 | 5.4 | 0.075 | usable |  |
| beat | titlebox | clean | ok | ok | 0.1 | 10.5 | 2.2 | 0.022 | usable |  |
| beat | uicard | clean | ok | ok | 0.1 | 10.5 | 22.6 | 0.192 | usable |  |
| beat | whiteflash | clean | ok | ok | 0.1 | 10.8 | 26.9 | 0.973 | usable | a transition, 1 frame-ish |
| scene | scene-card | clean | ok | ok | 0.1 | 9.5 | 127.7 | 0.995 | usable |  |
| scene | scene-cardpage | clean | ok | ok | 0.1 | 9.5 | 119.2 | 0.973 | usable |  |
| scene | scene-chapter | breakdown | ok | ok | 0.1 | 9.7 | 79.6 | 0.819 | usable with care | breakdown; `text` is ignored, it shows a spoken word ("English", not "Home") |
| scene | scene-clip | clean | ok | ok | 0.1 | 11 | 20.1 | 0.356 | usable | (the B-roll is cut from the same clip here) |
| scene | scene-collage | clean | ok | ok | 0.1 | 11.3 | 94.2 | 0.89 | NOT usable | the two text items overlap ("English" box covers "STUDYING" -> "EnglishNG"); no auto layout |
| scene | scene-concept | clean | ok | ok | 0.1 | 9.4 | 122.6 | 0.974 | usable |  |
| scene | scene-cutout | explainer-2 | ok | ok | 0.1 | 9.8 | 106.6 | 0.891 | usable | explainer-2 |
| scene | scene-device | clean | ok | ok | 0.1 | 9.6 | 116.2 | 0.957 | usable | small type |
| scene | scene-fly3d | clean | ok | ok | 0.1 | 9.4 | 128.4 | 0.995 | usable with care | items ghost over each other mid-flight; the last ~1 s is an empty white page |
| scene | scene-gm-counter | gadzhi-motion | ok | ok | 36.2 | 9.8 | 74.4 | 0.749 | usable | gadzhi-motion |
| scene | scene-gm-flow | gadzhi-motion | ok | ok | 36.4 | 9.7 | 90.2 | 0.877 | usable | gadzhi-motion |
| scene | scene-gm-kinetic | gadzhi-motion | ok | ok | 36.6 | 10.4 | 98.6 | 0.908 | usable with care | gadzhi-motion; plain grey type on grey, weak |
| scene | scene-gm-nodes | gadzhi-motion | ok | ok | 36.4 | 10 | 75.3 | 0.826 | usable | gadzhi-motion; pill must be {text, at} |
| scene | scene-gm-nodes-pillstr | gadzhi-motion | FAIL | - | 36.5 | - | - | - | NOT usable | pill as a string CRASHES the build: "E(function at() { [native code] }) for gm pill: not inside any take" |
| scene | scene-gm-object | gadzhi-motion | ok | ok | 37.7 | 10.6 | 84.6 | 0.907 | usable | gadzhi-motion |
| scene | scene-highlight | clean | ok | ok | 0.1 | 9.5 | 118.1 | 0.97 | usable |  |
| scene | scene-image | clean | ok | ok | 0.1 | 10.9 | 15.5 | 0.279 | usable | (the still is cut from the same clip, so it looks like the footage here) |
| scene | scene-kinetic | clean | ok | ok | 0.1 | 9.6 | 98.1 | 0.897 | usable |  |
| scene | scene-paper | clean | ok | ok | 0.1 | 9.6 | 108.6 | 0.92 | usable |  |
| scene | scene-sentence | clean | ok | ok | 0.1 | 9.3 | 128.2 | 0.994 | usable |  |
| scene | scene-stack | mono | ok | ok | 0.1 | 10.2 | 58.1 | 0.63 | usable | mono |
| scene | scene-stats | clean | ok | ok | 0.1 | 10 | 84.3 | 0.868 | usable |  |
| scene | scene-title | breakdown | ok | ok | 0.1 | 9.8 | 81.4 | 0.823 | usable | breakdown |
| scene | scene-tv | clean | ok | ok | 0.1 | 11 | 68.5 | 0.826 | usable with care | the still channel is BLACK (third item); video channels work |
| scene | scene-ui | clean | ok | ok | 0.1 | 9.6 | 117.2 | 0.987 | usable |  |
| scene | scene-window | clean | ok | ok | 0.1 | 10.5 | 75.7 | 0.858 | usable |  |
| scene | scene-wordpage | clean | ok | ok | 0.1 | 9.2 | 91.4 | 0.863 | usable | empty for the first ~0.3 s |

## Nominally supported, not usable as given

- **emoji-auto**: no x/y on a close-up: dropped ("no room beside the face"), draws nothing
- **graphic**: DROPPED by P5 at this box (crosses the caption band); usable only with a box clear of captions or hideCaptions
- **hz-list-text**: items written with `text` render the word "undefined" on screen, no warning
- **icon-auto**: no x/y on a close-up: dropped, draws nothing
- **leak**: draws nothing: no leak/burn pack is turned on ("turn a pack on in the style's packs")
- **logo-auto**: no x/y on a close-up: dropped, draws nothing
- **meme**: build FAILS: the library ships no memes ("meme 'vine-boom' not found")
- **scene-collage**: the two text items overlap ("English" box covers "STUDYING" -> "EnglishNG"); no auto layout
- **scene-gm-nodes-pillstr**: pill as a string CRASHES the build: "E(function at() { [native code] }) for gm pill: not inside any take"

## Usable with care

- **behind**: works (text behind the head); matte costs ~3.4 min for 7 s
- **chips**: runs off the LEFT edge on a close-up ("heffield"); give x or keep items short
- **endcard-caps**: with these fields: black frame, tiny serif "I. / Home" and a green arrow; looks broken as a mid-reel beat (made for the outro)
- **ground**: works; matte costs ~3.4 min for 7 s
- **headpage**: renders a green halo blob around a small image; looks broken with these fields
- **hz-note**: tiny text under the captions; barely readable
- **nametag**: small; sits on the caption line here
- **popcard**: the card sits ON the face on a close-up (P4 does not move it)
- **scene-chapter**: breakdown; `text` is ignored, it shows a spoken word ("English", not "Home")
- **scene-fly3d**: items ghost over each other mid-flight; the last ~1 s is an empty white page
- **scene-gm-kinetic**: gadzhi-motion; plain grey type on grey, weak
- **scene-tv**: the still channel is BLACK (third item); video channels work

# emoji-check: does the render machine draw emoji?

A tiny 8 s reel for checking that the render machine has an emoji font (on the Linux server:
`fonts-noto-color-emoji`). It covers the two places the engine draws an emoji as plain text, which fall back to
whatever system font has the glyph:

1. an `emoji` beat (build.mjs, `case "emoji"`: the emoji as text at 290 px): a rocket 🚀, 1.5 s to 4.0 s, at x 360 / y 260
2. a caption fix `captions.fixes {"fire": "🔥"}`: the spoken word "fire" (6.94 s to 7.20 s) is shown as 🔥 in the
   caption "deal is 🔥" (on screen 6.22 s to 7.22 s)

No media is committed. `make-project.sh` makes the clip with ffmpeg (testsrc2 colour bars + a 180 Hz tone, 8 s,
the same synthetic clip as `scripts/byte-identity.mjs`) and copies in the hand-written transcript
(`words.whisper.json`) and a static face box (`face.json`). No paid calls; the only downloads are
`hyperframes@0.8.81` (npx) and the fonts its compiler fetches (cached after the first render).

## Build and render (from the fork's root)

```bash
P=/tmp/emoji-check
bash scripts/fixtures/emoji-check/make-project.sh $P
node scripts/build.mjs $P                       # prints the caption "... this deal is 🔥 okay", no WARNINGS
cd $P && npx -y hyperframes@0.8.81 render -o build/reel.mp4 --quiet
# shared machine: prefix the render with the lock, e.g. on the Mac  lockf -k /tmp/phantasic-render.lock npx ...
#                                                  on Linux        flock /tmp/phantasic-render.lock npx ...
```

## What to inspect

The take starts at 0, so output time = transcript time.

```bash
ffmpeg -v error -ss 2.75 -i $P/build/reel.mp4 -frames:v 1 -y $P/emoji-beat.png      # the emoji beat, mid-beat
ffmpeg -v error -ss 7.10 -i $P/build/reel.mp4 -frames:v 1 -y $P/caption-fire.png     # the caption with 🔥
```

- `emoji-beat.png` (2.75 s): a large rocket, about 290 px, upper middle of the frame over the colour bars.
- `caption-fire.png` (7.10 s): the caption "deal is 🔥" in the lower third, the flame after "is".

GOOD: a colour rocket and a colour flame (Noto Color Emoji on Linux, Apple Color Emoji on a Mac).
TOFU (no emoji font): an empty rectangle (an outlined box, sometimes with the hex code inside) where the rocket
and the flame should be; the caption reads "deal is □". A monochrome outline glyph instead of a colour one means a
text-only emoji font was picked (e.g. DejaVu / Symbola), not the colour font.

Note: this fixture checks the engine's TEXT drawing (beats, captions). Claude-written Prompt Motion graphics are
separate: G36 and R14 refuse any emoji in a graphic whatever system fonts the machine has, since R14's repertoire is
only the engine fonts plus the graphic's own `data:` fonts.

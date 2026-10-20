# Pixel check (A5): spec, built (CP2: `mac/pixel-check`)

Built: `scripts/lib/geometry.mjs` + `build.mjs` (writes `build/geometry.json`), `scripts/pixel_probe.mjs` (the DOM probe),
`scripts/pixel_check.py` (the checker), `scripts/pixel-check.test.mjs` + `scripts/fixtures/pixel_fixture.py` (one
synthetic reel, clean and with one planted defect per rule), `scripts/lib/geometry.test.mjs`. Where the build had to
decide something this spec left open, the decision is written into the section it belongs to and marked **(built)**.

`scripts/pixel_check.py` looks at a FINISHED reel (the rendered MP4 plus the build's JSON) and reports what a
human reviewer would catch: a graphic over the speaker's face, a caption you cannot read, text cut off or under the
app's buttons, a black or frozen frame, a cut inside a word. It writes one machine-readable report,
`build/pixel_check.json`. It changes nothing: no render, no fix, no edit to the project.

The build already warns about some of these before the render (GW7 UI zone, GW9 face, the caption placer's safe
area). Those warnings are predictions from the plan. The pixel check is the after-render truth: it reads the frames
that will be posted.

## 1. Purpose and scope

**Checks.** Rules PX0 to PX16 (section 3): graphics vs the face, the face in frame, captions (over the face,
contrast, size, time on screen, drawn when they should be and hidden when they should not, centring), text off the
canvas or clipped by its box, text and graphics in the platform UI zones, graphics outside their windows, black
frames, frozen frames, cuts inside a word, audio clipping.

**Does not check.** Taste (pacing, B-roll choice, joke timing); loudness, true peak, SFX levels and silences (that
is `qa.py`, which stays the audio check; PX16 is only the cheap clipping count); halal brand safety of the footage;
spelling (the captions are the transcript); anything inside a graphic's own design except where its opaque pixels
land; render determinism across renders (that is `byte-identity.mjs` and `graphic-determinism.mjs`; the pixel check
is itself deterministic, so two reports differing on two renders of one build is a signal, see section 6).

**When it runs.** After the render and after `tailhold.py` (if the build wrote `build/tail.json`), on the file that
will be published. On staging, once per reel. It never runs inside `build.mjs` and never blocks a build.

**Cost budget.** At most 10 % of the reel's render wall time on the 8-CPU box, measured, not estimated: the
report's `timing` block carries each stage's milliseconds and, when the caller passes `--render-ms`, the percentage.
It decodes a fixed sample of frames at full resolution (section 2.4), plus one downscaled pass for black/freeze and
one audio decode. It never decodes every frame at full resolution. If a reel goes over budget the first knob is the
grid step (0.5 s to 1.0 s), never the event samples.

**(built) Measured** on the Mac mini (M4, 10 CPUs), process wall time including Python start, against the hyperframes
`rendered in` time of the same reel (15.5-16.0 s for these 13-18 s reels). CP2 (before the caption images): 1.18-1.50 s,
7.3-9.6 %. CP4 (with them, 2026-10-20): 1.54-1.56 s = 9.5-9.6 % with the box at load ~5 from other sessions, 1.6-2.1 s
= 10.5-13.6 % at load 5-7; the CP4 verifier measured 9.2-10.7 % at load 5-6. Over budget under load, so the grid
step is a CLI option (`--grid`, default 0.5 s, unchanged): the PC sets 1.0 on staging if the server's own measurement
exceeds 10 %. The
probe's layout samples (~0.45 s), the graphic files, the grey pass and the audio run in parallel; the decode starts when
the probe's samples are written while the probe draws the caption images (PX9) over 4 tabs; YuNet runs on 4 threads
beside the decode (one detector per thread, `cv2.setNumThreads(1)`).

**Usage.**

```
pixel_check.py <project> <render.mp4> [--out <project>/build/pixel_check.json] [--render-ms N] [--frames-dir DIR]
               [--probe auto|use] [--yunet MODEL.onnx]
pixel_check.py <project> --print-samples FILE        the sample list (2.4) as {"frames": [...]}
               [--grid S]                            seconds between grid samples, default 0.5
```

**(built)** `--grid S` (default 0.5) is the cost knob of section 1: the grid samples of 2.4 at `round(k * S * fps)`.
The event samples (captions, graphics, joins, hidden windows) never change. The default stays 0.5; the PC sets 1.0 on
staging only if the server's measured cost exceeds 10 %. The report records it in `sampling.grid_s`; a probe made for
another grid is a stale probe (PX0).

**(built)** `--probe auto` (default) runs `pixel_probe.mjs` itself for the sample list; `--probe use` reads an existing
`build/pixel_probe.json` (PX0 when it was made for another `geometry.json` or sample list). The face model is
`library/models/face_detection_yunet_2023mar.onnx` (`face_track.py`'s pinned file, sha256 checked; never downloaded
here), or `--yunet` / `$PIXEL_CHECK_YUNET`; without it PX2 is `skipped` with the reason.

**(built, CP3) Network and GSAP.** Nothing is vendored or shipped. The probe serves the project folder itself on
127.0.0.1 (media refused: layout does not need it) and aborts every other request, except the runtime libraries
`scripts/lib/runtime-libs.mjs` lists: GSAP at exactly the URL build.mjs writes (`GSAP_URL`, the same constant) and its
pinned sha256. Node gets those bytes BEFORE Chrome starts: from `$PIXEL_PROBE_VENDOR` (optional local override, a
folder with a `manifest.json`; must match the same sha), else the cache, else the CDN (8 s timeout), and answers
Chrome's request with them. **(built, CP3 security)** The cache (`scripts/lib/probe-cache.mjs`) never exists as root
(the bytes stay in memory for the run). Otherwise it is a directory WE own, mode 0700, not a symlink, never group- or
other-writable (`$PIXEL_PROBE_CACHE`, else `<tmpdir>/pixel-probe-cache-<uid>`); a directory that fails any check is
not used. Reads open with O_NOFOLLOW | O_NONBLOCK and fstat (a regular file we own, at most 4 MB), so a planted link is
never followed and a FIFO never hangs. Writes create a fresh random name with O_CREAT | O_EXCL | O_NOFOLLOW (mode
0600) and rename() it over the final name, which replaces a planted link, never its target. The sha is checked on
every read. A sha mismatch exits 3 (PX0, nothing
served). Not reachable, or a remote script the probe may not fetch, exits 4: "probe unavailable", and the checker
runs its pixel-only rules (PX4-PX6, PX8-PX10 `skipped` with the reason; PX1 / PX11 / PX12 use the geometry boxes;
`report.probe = { status: "unavailable", reason }`). A missing dependency fails before Chrome starts or at the load
event (~0.1 s), never after a long wait. Aborted URLs are listed in `pixel_probe.json` `refused`. A probe failure's
PX0 message is the probe's own message line, not a stack frame.

**(built, CP3) Chrome.** As the renderer launches it: `--no-sandbox` only on Linux (hyperframes passes it on Linux
only). As root (the server): the graphic render's uid drop from `lib/graphic-render.mjs`, unchanged (GRAPHIC_CHROME_UID
/ GID via setpriv, the per-uid host lock, the lingering-process sweep, a fresh uid-owned home, its network-lock flags,
every process of the uid killed afterwards), and first the R12 network probe through that shim (`probeNetwork`, as
before every graphic render): the dropped Chrome and Node must fail to reach the probe URLs before the probe opens a
user's page. Chrome never runs as root. As root with `GRAPHIC_SANDBOX` set the probe refuses (renderGraphic runs Node
and Chrome inside that launcher; puppeteer cannot start Chrome inside it, so R12 would prove a launch the probe does
not use). Chrome gets `cleanEnv()` plus the probe's own `GRAPHIC_RENDER_ORIGINS`. The main reel renderer itself runs Chrome as
root with `--no-sandbox` on Linux; the probe is stricter because it opens a user's page outside a render. The root path
is written to the graphic render's tested functions but has not run on the Linux server yet.

Exit 0 = `pass` or `warn`, 2 = `fail`, 3 = could not check (PX0 failed; the report is still written).
`--frames-dir` writes a PNG of each error's worst frame with the boxes drawn (for the reviewer; not part of the
report and not hashed).

## 2. Inputs

Prefer geometry the build already knows; measure pixels only to confirm it, or where only pixels can answer
(contrast, centring as drawn, black, freeze).

### 2.1 Files read

| File | Fields used | For |
|---|---|---|
| the render MP4 | video stream W, H, fps, frame count; audio PCM | everything |
| `build/edit_truth.json` | `total`, `speech`, `fps`, `takes[]` (`start`, `dur`, `holdStart`, `holdFrames`, `src`), `beats[]` (`type`, `at`, `to`), `layers[]` (`id`, `kind`, `start`, `end`, `mode`, `hideCaptions`) | windows, PX0 |
| `build/caption_layout.json` | `platform`, `safeTop`, `safeBottom`, `blocks[]` (`t0`, `t1`, `y`, `h`, `mode`, `scale`, `face`) | caption rules |
| `build/sections.json` | `total`, `fps`, `globalHash` | PX0 consistency, the report's input record |
| `build/sfx_events.json` | `total` | PX0 only (audio levels stay in `qa.py`) |
| `build/geometry.json` | new, section 2.2 | face on screen, graphic placements, hidden-caption windows, joins, exempt windows |
| `build/pixel_probe.json` | new, section 2.3 | element rects as laid out by Chrome at each sampled frame |
| `assets/graphics/<name>-<key16>.webm` / `.mp4` | the rendered graphic (overlay: VP9 with alpha; insert: mp4) | opaque pixels of a graphic (PX1, PX11, PX12) |
| `reel.json` + its `words` file(s) | `takes[]` `a`, `b`, `src`; whisper words `start`, `end`, `word` | PX15 |

`index.html` is not parsed with regexes: its layout reaches the check through the probe (2.3), and its timing
through `geometry.json` (2.2).

### 2.2 `build/geometry.json` (new build output, additive)

The camera mapping (crop plan, `zoom.base` x snaps x pushes around `zoom.origin`) lives in `lib/safezone.mjs`'s
placer. The check must not re-implement it in Python, so `build.mjs` writes what the placer already computes, after
`caption_layout.json`. Additive: `index.html`, `edit_truth.json`, `sections.json` and every other output stay
byte-identical (the gate's byte-identity sweep proves it).

```jsonc
{
  "v": 1, "W": 1080, "H": 1920, "fps": 30, "frames": 1110, "total": 37.0, "speech": 34.0,
  "format": "9:16", "platform": "instagram",
  "zones": { "top": 220, "bottom": 420, "right": 130, "name": "Instagram Reels" },   // safezone.mjs PLATFORMS[platform], verbatim
  // the speaker's face in SCREEN px at EVERY output frame, through the same mapping the placer uses
  // (crop-<fmt>.json scale/offset, camScale(t) around the zoom origin, per-source track); null = no face known.
  // age = seconds from the face-track sample used (the placer holds the nearest sample up to 1.5 s)
  "face": [[0, 402, 980, 300, 780, 610, 840, 0.0], [1, null], ...],   // [frame, top, bottom, left, right, eyesY, mouthY, age]
  "captions": [{ "id": "cg0", "t0": 0.12, "t1": 1.05, "y": 1180, "h": 140, "mode": "below", "scale": 1, "cx": 540, "text": "Nobody cares about" }],
  "hiddenCaps": [[12.32, 15.45]],          // the merged windows build.mjs tweens #caps to 0 over (graphics, motion/text layers, ramps)
  "graphics": [{
    "id": "g-stat", "kind": "beat", "mode": "overlay", "by": "planner",   // by: planner | director | user
    "file": "assets/graphics/stat-3f9c0a1b2c3d4e5f.webm", "fit": "contain", "opacity": 1,
    "box": { "x": 540, "y": 300, "w": 480, "h": 300 }, "t0": 12.4, "t1": 15.4, "f0": 372, "f1": 462,
    "srcFrames": [0, 1, 2, ...],           // the graphic's own frame shown at output frames f0..f1-1 (in, after: hold|loop applied)
    "hideCaptions": false, "selector": "#b7-in"
  }],
  "joins": [{ "t": 3.82, "frame": 115, "take": 1, "src": "assets/talk.mp4", "out": 10.40, "in": 10.76 }],   // out = previous take's b, in = this take's a (source s)
  "stillOk": [[34.0, 37.0, "outro"], [10.40, 11.20, "hold:1"]],   // windows where a frozen picture is by design
  "darkOk": []                              // windows where a black picture is by design (none by default)
}
```

`srcFrames` is written from the build's own `graphicFrames` result, so the check never re-derives `in` / `after`.

**(built)** As written by `lib/geometry.mjs`:
- `srcFrames[k]` is the index into the rendered FILE shown at output frame `f0 + k`. The file already has `in` / `after`
  baked in (graphic-render renders L frames from `in`), so it is `floor((n / fps - t0) * fps)` clamped to `[0, L-1]`:
  the frame at or before the `<video>`'s media time (measured: an insert that fades up from black at a `t0` between
  two frames lines up only with floor). `f0` / `f1` = the first frame at or after `t0` / `t1` (the show tween ENDS at t0).
- `hard`: true for a beat and a layer with enter / exit `none`; PX12 checks only hard edges.
- `hiddenCaps` entries are `[a, b, why]`: `why` lists the beats / layers / ramps whose spans overlap the window.
- `faceSkip`: `[[t0, t1, why]]`, the windows the placer does not model (owner answer 2: `room` shrink windows, and any
  take from a source other than the primary, `source <src>`); `face[n]` is `[n, null]` there and PX1-PX4 report
  them under `not_checked`.
- `captionStyle`, `captionsDescribed`: the caption list covers the generic caption path (house, clean, pill, box,
  condensed, serif, noir, lux, hormozi, sessions, clipping, ...); `type`, `podcast`, `cluster`, `duo`, `glow`,
  editorial and `none` are not described yet, and PX4-PX9 are `skipped` with that reason.
- `joins[]` also carry `outSrc` (the outgoing take's source) and `ramp: true` for a ramped take (no speech; PX15 skips).
- `stillOk`: outro, holds, an insert's hold tail (`after: hold` past its length), endcard / cover beats, full-canvas
  image / logo layers. `darkOk` is empty. (Which beats are still or dark by design: proposed default, pending owner.)

### 2.3 `build/pixel_probe.json` (new, `scripts/pixel_probe.mjs`)

A DOM probe: opens `index.html` in the same headless Chrome and puppeteer-core the renderer cached
(`lib/browser.mjs`), seeks the paused timeline the way the renderer does (as `motion-determinism.mjs --seek render`
does), and at each sampled frame (2.4) records, in canvas px:

- `caps`: the effective opacity of `#caps` (product of computed `opacity` up the tree; `visibility:hidden` = 0);
  per `.cap-group`: `id`, bounding rect, per word: rect, effective opacity, computed `color`, and the font size in
  canvas px (`font-size` x the element's rendered scale, `rect.height / offsetHeight`).
- `graphics`: per `.graphic` element and graphic layer: `id`, rect, effective opacity.
- `text`: per visible text node in the stage (effective opacity >= 0.5): the owning element's id or CSS path, the
  line rects (`Range.getClientRects()`), and the clip rect (the intersection of every ancestor with `overflow` other
  than `visible`).

**(built)** The probe takes the sample list (`--frames <file>`, written by the checker) and records it with
`geometry_sha256` and `html_sha256`, so a stale probe is a PX0. It also lists `covers`: elements (not the footage, not
the camera / caption containers) that cover >= 90 % of the canvas at effective opacity >= 0.99 with opaque paint (an
image, a non-footage video / canvas, a `url()` background, or an opaque background colour; a gradient such as the
vignette, and anything with a blend mode, is not a cover).

The probe is the page's layout, not the render. Races that happen only in the render (the mac-42 caption font race baked a px offset into the centred group in the render while a fresh page looked right) are why PX8 and PX9 confirm
on pixels.

### 2.4 Sampling (fixed, a pure function of `geometry.json`)

Frame indices (output frame n = time n / fps), union of:

- **grid**: `round(k * 0.5 * fps)` for k = 0, 1, ... while < `frames`.
- **captions**: per block, `f_a = ceil(t0*fps) + round(0.15*fps)` (after the pop-in), `round((t0+t1)/2*fps)`,
  `ceil(t1*fps) - 1`; each clamped into the block's `[ceil(t0*fps), ceil(t1*fps) - 1]`.
- **graphics**: per placement, `f0 - 1`, `f0`, `f1 - 1`, `f1`, and every `round(fps/10)`-th frame from `f0` to
  `f1 - 1` (10 samples per second inside the window).
- **joins**: per join frame f: `f - 1`, `f`, `f + 1`.
- **hidden captions**: per `hiddenCaps` window `[a, b]`: `ceil((a + 0.08)*fps)` (the fade is over), the middle
  frame, `floor((b - 0.05)*fps) - 1` (before the re-show starts).

Clamped to `[0, frames - 1]`, deduplicated, sorted. The same list drives the probe and the decode. Decode: one
`ffmpeg -filter_script` pass with a `select` over the list, `rgb24` at full resolution, `-vsync 0`. Black and freeze:
one separate pass at 270x480 grey over every frame (PX13, PX14). Audio: one decode to f32 48 kHz (PX16).

"Consecutive samples" below means two neighbours in this list no more than 0.5 s apart. A one-sample hit inside an
enter/exit tween is not a finding; two consecutive ones are.

### 2.5 Shared definitions

- **Face box** at frame n: `geometry.face[n]`, used only when `age <= 0.5` s. **Face core**: x in `[left, right]`,
  y in `[eyesY - 0.25*(mouthY - eyesY), mouthY + 0.25*(mouthY - eyesY)]` (eyes to mouth; the grown box adds hair,
  ears and chin).
- **Graphic opaque mask** at frame n: decode the graphic file's frame `srcFrames[n - f0]` with alpha, fit it into
  the probe's rect for that graphic (`contain` / `cover`, centred, clipped to the rect), multiply alpha by
  `opacity` and the probe's effective opacity; a pixel is opaque when the result is >= 0.5. **(built)** The probe's
effective opacity already includes the box's `opacity` (the show tween sets `autoAlpha: opacity`), so it is multiplied
once, not twice; with no probe rect (PX12 outside the window) the geometry box and `opacity` are used. An insert (mp4) is
  opaque everywhere.
- **Caption ink** at frame n, per visible word (effective opacity >= 0.99): pixels inside the word rect whose
  largest per-channel difference to the word's computed colour is <= 40.
- **Full-frame cover**: a sample where an insert graphic or a probe element with rect >= 90 % of the canvas and
  effective opacity >= 0.99 is visible. Face rules skip these samples.

## 3. Rules

Severity: **error** = flag for review (verdict `fail`), **warn** = shown, verdict `warn`. Values in messages: times
`<t>` to 3 decimals in output seconds, px as integers, ratios to 2 decimals. Each finding also carries `frame`.

| ID | Check | Severity |
|---|---|---|
| PX0 | inputs agree (size, fps, frame count, files present) | error (stops the check) |
| PX1 | a graphic covers the speaker's face | error / warn |
| PX2 | the face track agrees with the render | error / warn |
| PX3 | the face cropped out of frame | error / warn |
| PX4 | a caption over the eyes or mouth | error |
| PX5 | caption contrast | error / warn |
| PX6 | caption text size | error / warn |
| PX7 | caption time on screen | error / warn |
| PX8 | caption drawn when it should be, hidden when it should be | error |
| PX9 | caption off-centre | error / warn |
| PX10 | text off the canvas or clipped by its box | error |
| PX11 | text or graphic in the platform UI zone | error / warn |
| PX12 | a graphic outside its window | error |
| PX13 | black frames | error / warn |
| PX14 | frozen frames | error / warn |
| PX15 | a cut inside a word | error / warn |
| PX16 | audio clipping | error / warn |

**PX0 inputs.** The MP4's W x H equals `geometry.W x H` (= `FORMATS[format]`), its fps equals `fps`, its frame count
is `round(total*fps)` +-1, and `geometry.json`, `pixel_probe.json`, `edit_truth.json`, `caption_layout.json` exist
and agree on `total` and `fps` (+-0.001 s). Any miss: error, every other rule `skipped`, exit 3.
`PX0 render <w>x<h> @ <fps> fps, <n> frames does not match the build (<W>x<H> @ <FPS> fps, <N> frames)` /
`PX0 missing <file>` / `PX0 <file> says total <a>s, edit_truth.json says <b>s`.

**PX1 graphic covers the face.** Overlay graphics only (inserts are full frame by design). At every sample inside
`[f0, f1)` that is not a full-frame cover and has a face box: `over` = opaque-mask pixels inside the face box,
`core` = opaque-mask pixels inside the face core. Error: `core > 0` on any sample, or `over >= 2 %` of the face box
area. Warn: `over > 0`. A `by: "user"` placement is at most warn (as GW9). The finding reports the worst sample and
the share of the window's samples that hit (GW9 terms).
`PX1 graphic <id> covers the face at t=<t>s (<px> px overlap, <c> px on the eyes/mouth; <p>% of its window)`.

**PX2 face track agrees with the render.** PX1, PX3, PX4 trust `geometry.face`; this checks it. At grid samples that
are not full-frame covers and have a face box, run YuNet (the `face_track.py` model, same sha256, `cv2.setNumThreads(1)`)
on the frame downscaled to 540x960, grow the box the way `face_track.py` does, and compute IoU with the geometry box.
Eligible samples with IoU < 0.5 (or no detection): warn when >= 20 % of eligible samples; error when IoU < 0.3 on
>= 50 % (the face rules are then unreliable; their results carry `"confidence": "low"`).
`PX2 face track disagrees with the render on <k>/<n> samples (median IoU <iou>, worst at t=<t>s)`.

**PX3 face out of frame.** At grid samples with a face box (not full-frame covers): `vis` = the share of the
face box's area inside `[0, W] x [0, H]`. Error: `vis < 0.5` or `eyesY` outside `[0, H]` on two consecutive samples.
Warn: `vis < 0.85` on two consecutive samples.
`PX3 face <p>% in frame at t=<t>s (zoom crops it; <edge> edge)`, `<edge>` one of top, bottom, left, right.

**PX4 caption over the eyes or mouth.** At caption samples where `#caps` opacity >= 0.99: any visible word rect
intersecting the face core on two consecutive samples. Error (the placer promises never over the eyes or mouth;
`lower-face` mode sits under the mouth, so it passes).
`PX4 caption <id> "<text>" covers the eyes/mouth at t=<t>s (<px> px)`.

**PX5 caption contrast.** At the three caption samples of each block, on the decoded frame: `L_ink` = the median
relative luminance (WCAG 2.x, sRGB) of the ink; `L_bg` = the median of the halo, pixels 4 to 12 px from any ink
pixel inside the group rect grown by 12 px (an outline, shadow or caption box is part of the halo, as the eye sees
it). Ratio = `(max + 0.05) / (min + 0.05)`; the block's value is its worst sample. Caption text is >= 32 px, so the
bar is WCAG's large-text one. Error: < 3.0. Warn: < 4.5. Skipped (not failed) when the ink is under 2 % of the word
rects (PX8 owns that case).
**(built, CP4)** The probe gives the caption's own box (the nearest element from the words up to the group with a
background alpha >= 0.5: its colour, alpha, rect). Ink = pixels in the word rects within `min(40, half the ink-to-box
colour distance - 1)` of the ink colour, so a box close to the ink is never ink (CP4: ink #808080 on #6e6e6e read
1.00:1, now 1.29-1.31:1, truth 1.29). With an opaque box, `L_bg` = the median of the box's own pixels (inside its rect
shrunk 3 px, closer to the box colour than to the ink); without one (or a translucent one), the halo as above. PX8
uses the same ink tolerance.
`PX5 caption <id> "<text>" contrast <r>:1 at t=<t>s (min <thr>:1)`, `<thr>` 3.00 for the error, 4.50 for the warn.

**PX6 caption text size.** From the probe at each block's middle sample: the smallest visible word's font size in
canvas px. Error: < 32. Warn: < 42 (house is 56, the smallest default is 46; `above-compact` scales down to 0.7).
`PX6 caption <id> text <px> px at t=<t>s (min <thr>)`, `<thr>` 32 for the error, 42 for the warn.

**PX7 caption time on screen.** Per block: `v` = `t1 - t0` minus its overlap with `hiddenCaps`; `c` = letters
and digits in its text. Error: `0 < v < 0.10` s (a flash). Warn: `v < 0.30` s, or `c / v > 25` chars/s.
`PX7 caption <id> "<text>" on screen <v>s for <c> chars (<cps> chars/s, max 25)`.

**PX8 caption drawn / hidden.** (a) Drawn: at caption samples where the probe says the group is visible (`#caps`
and the word opacity >= 0.99), ink must cover >= 2 % of the visible word rects. Else error
`PX8 caption <id> "<text>" is not drawn at t=<t>s`. (b) Hidden: at the hidden-caption samples, for each block
whose window overlaps the hidden window, (insert windows) the mean absolute RGB difference between the render and
the insert file's frame inside the block's rect must be <= 10; (other windows) ink must cover < 2 % of the block's
word rects. Else error `PX8 caption <id> shows at t=<t>s inside a hidden window [<a>, <b>] (<why>)`, `<why>` the
graphic or layer id.

**PX9 caption off-centre.** At each block's middle sample: ink columns (>= 3 ink pixels in the column), split into
clusters at gaps > 25 px, end clusters narrower than 14 px dropped (stray specks, as the mac-42 measurement did);
`x_ink` = the midpoint of the first and last remaining column. `d = x_ink - cx` (`cx` from `geometry.captions`, the
intended centre). Warn: `|d| > 8`. Error: `|d| > 16`. (mac-42: good renders measured within +-4 px of 540, the
race +22 to +50.)
`PX9 caption <id> "<text>" is <d> px off centre at t=<t>s (<x_ink> vs <cx>)`.
**(built, CP4)** Not ink columns: light footage in the ink colour beside a caption (CP4: a pearl necklace) moved the
ink extent and reported centred captions at -62, -48 and -10 px. The probe now draws each block alone at its middle
sample (everything else hidden, transparent page: box, text and shadow exactly as Chrome draws them; PNGs in
`build/pixel_probe_caps/`, listed in `pixel_probe.json` `templates`, not hashed into it), and the checker matches that
image (masked by its alpha, normalised cross-correlation on grey) against the render within +-64 px horizontally and
+-8 px vertically: a race moves the drawn block, not the layout. `x_ink` = the probe's group centre + the best shift.
A best score under 0.5 means the drawn block could not be located: a `warn` finding ("could not be located ... not
checked"), never a silent pass (a race that re-wraps the text would look like this). A block PX8 found not drawn at
that sample is left to PX8. Checked on the mac-42 renders: the same 8
race blocks as `m42w-cp4/meas.py` (+21 to +39 px, within 1-7 px of it), none on the fixed render, none on the CP4
pearl reels. Cost: the screenshots are shared over 4 tabs (~0.4 s for 22 blocks).

**(built, CP4) Frozen or black frames.** A sample inside a `freezedetect` or `blackdetect` run (before the `stillOk`
exemptions) shows an older picture or none: PX5, PX8, PX9 and PX12 do not read it (`not_checked`, with the span);
PX13 / PX14 report the frames.

**PX10 text off the canvas or clipped.** At every probe sample, for every probe text line rect: outside
`[0, W] x [0, H]` by > 2 px, or outside its clip rect by > 2 px, on two consecutive samples. Error.
`PX10 text "<first 30 chars>" (<element>) runs <px> px off the <edge> at t=<t>s` /
`PX10 text "<first 30 chars>" (<element>) is clipped <px> px by its box at t=<t>s`.

**PX11 UI zone.** Zones from `geometry.zones` (= `safezone.mjs` `PLATFORMS[platform]`), the same test as GW7's
`crossesUi`: y < `top`, y > `H - bottom`, x > `W - right`. Instagram at 1080x1920: top band y 0-220, bottom band
y 1500-1920, right column x 950-1080. All: top 220, bottom 480, right 150. Two consecutive samples needed.
**(built, owner answer 3)** The right-hand column counts in the LOWER half only (y > H / 2), as `safezone.mjs` says the
platforms draw it. GW7 and the planner are unchanged (GW7 still applies the column at full height).
Error: a visible caption word rect in a zone (the placer's promise). Warn: any other probe text line in a zone; an
overlay graphic with >= 200 opaque-mask px in a zone (the box's transparent margin does not count, unlike GW7).
`PX11 caption <id> "<text>" is in the <zone name> UI zone at t=<t>s (<px> px)` /
`PX11 text "<first 30 chars>" (<element>) is in the <zone name> UI zone at t=<t>s` /
`PX11 graphic <id> draws <px> px in the <zone name> UI zone at t=<t>s`.

**PX12 graphic outside its window.** The window shows exactly frames `[f0, f1)`. Present at frame n = the mean
absolute RGB difference between the render and the graphic's own frame over its opaque mask is <= 12, with the mask
>= 1 % of the rect (at `f0 - 1` the expected frame is `srcFrames[0]`, at `f1` it is `srcFrames[f1 - f0 - 1]`).
Error when present at `f0 - 1` or `f1`, or absent at `f0` or `f1 - 1`. The probe's opacity is recorded alongside
(a page bug vs a render bug). **(built)** The difference is taken over the SOLID part of the mask (alpha x opacity
>= 0.95; a half-transparent pixel is a blend, not the graphic's colour), leaving out caption word rects (grown 6 px)
drawn over the graphic. An edge whose expected frame has < 1 % opaque pixels (a graphic that animates in from
nothing) cannot be told present from absent: it is listed under `not_checked`, not failed. Measured on real renders:
present 2.4-3.4, absent 27-38.
`PX12 graphic <id> is visible at t=<t>s, outside its window [<t0>, <t1>)` /
`PX12 graphic <id> is missing at t=<t>s (the <first|last> frame of its window)`.

**PX13 black frames.** The grey pass with `blackdetect=d=0:pix_th=0.10:pic_th=0.98`. Runs not entirely inside
`darkOk`. Error: a run >= 3 frames. Warn: 1 or 2 frames. **(built)** Also minus the frames of an insert whose own
file is black there (the same `blackdetect` on the file): an insert that fades up from black is its design (the m41c
inserts open on 1.43 s and 0.73 s of black).
`PX13 <k> black frame(s) at t=<t0>s-<t1>s`.

**PX14 frozen frames.** The grey pass with `freezedetect=n=-60dB:d=0.5`. Runs minus `stillOk` (holds, outro,
image layers, an insert's hold tail, and the static beat types the build lists). Error: >= 1.0 s left. Warn:
>= 0.5 s. **(built)** Also minus a stretch inside an insert whose own file is frozen there too.
`PX14 picture frozen <d>s at t=<t0>s-<t1>s`.

**PX15 cut inside a word.** For each join: the outgoing take's `b` against the words of its source, and the
incoming take's `a` against its own. A word with `start < cut < end`: `kept` and `lost` = the parts on each side.
Error: `min(kept, lost) >= 0.06` s. Warn: `>= 0.03` s (whisper's word edges are +-50 ms).
`PX15 cut at t=<t>s (take <i> <a|b> = <s>s) splits "<word>" (<kept>s kept, <lost>s cut)`.

**PX16 audio clipping.** The decoded audio, each channel: a run = >= 3 consecutive samples with |x| >= 0.999.
Error: >= 3 runs. Warn: 1 or 2 runs.
`PX16 audio clips <k> time(s), first at t=<t>s`.

## 4. Output: `build/pixel_check.json`

```jsonc
{
  "schema": "pixel-check/1",
  "verdict": "fail",                                   // fail = any error, warn = any warn, else pass
  "versions": { "checker": "1.0.0", "engine": "539f87a", "ffmpeg": "7.1", "opencv": "4.10.0",
                "yunet_sha256": "8f2383e4...", "chrome": "131.0.6778.204" },
  "input": { "render": "out.mp4", "render_sha256": "c0ffee...", "W": 1080, "H": 1920, "fps": 30, "frames": 1110,
             "total": 37.0, "format": "9:16", "platform": "instagram",
             "json_sha256": { "edit_truth.json": "...", "caption_layout.json": "...", "geometry.json": "...", "pixel_probe.json": "..." } },
  "sampling": { "grid_s": 0.5, "frames": 236, "list_sha256": "..." },
  "summary": { "errors": 2, "warnings": 1, "rules": { "PX0": "pass", "PX1": "error", "PX5": "warn", "PX9": "error" } },  // every rule id
  "rules": [
    { "id": "PX1", "name": "graphic covers the face", "status": "error", "checked": 31, "confidence": "high",
      "findings": [ { "severity": "error", "subject": "g-stat", "t": 13.1, "frame": 393, "t_from": 12.9, "t_to": 13.7,
                      "samples": 9, "value": 1840, "threshold": 0, "unit": "px",
                      "message": "PX1 graphic g-stat covers the face at t=13.100s (1840 px overlap, 312 px on the eyes/mouth; 29% of its window)" } ] },
    { "id": "PX5", "name": "caption contrast", "status": "warn", "checked": 66, "findings": [
      { "severity": "warn", "subject": "cg7", "t": 8.433, "frame": 253, "value": 3.71, "threshold": 4.5, "unit": "ratio",
        "message": "PX5 caption cg7 \"right into the sun\" contrast 3.71:1 at t=8.433s (min 4.50:1)" } ] },
    { "id": "PX9", "name": "caption off-centre", "status": "error", "checked": 22, "findings": [
      { "severity": "error", "subject": "cg5", "t": 5.95, "frame": 179, "value": 32, "threshold": 16, "unit": "px",
        "message": "PX9 caption cg5 \"the first ten\" is 32 px off centre at t=5.950s (572 vs 540)" } ] },
    { "id": "PX13", "name": "black frames", "status": "pass", "checked": 1110, "findings": [] }
    // ... one entry per rule, PX0..PX16, in id order; status pass | warn | error | skipped
  ],
  "report_sha256": "...",                              // sha256 of this object minus report_sha256 and timing, canonical JSON
  "timing": { "total_ms": 21400, "stages": { "probe": 6100, "decode": 7900, "grey_pass": 3300, "faces": 2100, "audio": 400, "rules": 1600 },
              "render_ms": 412000, "budget_pct": 5.2 }
}
```

**(built)** Top-level fields beyond the sketch above:
- `complete` (bool) and, when false, `incomplete_reason`. A report is incomplete when PX0 failed ("PX0: the inputs could
  not be checked", verdict `fail`, exit 3) or when the probe was unavailable ("probe unavailable: N caption/text rules
  not checked (<why>)", N = 6: PX4, PX5, PX6, PX8, PX9, PX10). An incomplete report is never `pass`: its verdict is at
  least `warn`, `summary.note` says "probe unavailable: N caption/text rules not checked", and the CLI prints
  `pixel check: INCOMPLETE: ...` first. The studio / PC must not read `complete: false` as a full pass.
- `probe`: `{ "status": "ok" }` or `{ "status": "unavailable", "reason": ... }` (absent on a PX0 stop).
- `sampling.grid_s`: the `--grid` step used.
- A rule's `not_checked`: why some of its samples or subjects were not checked (face-skip windows, frozen frames,
  untestable PX12 edges, ...).

One finding per (rule, subject, run of consecutive hits): `t` and `value` are the worst sample, `t_from` / `t_to`
the run, `samples` its length. A rule keeps at most 50 findings, then `"truncated": <n>`.

## 5. How the studio / PC uses it

- `pass`: publishable as far as this check knows. `warn`: publishable; the warnings go on the review card.
  `fail`: not published automatically; flagged for review with the `--frames-dir` images.
- **Auto-retry: one re-render, no re-plan**, for rules that point at a render race, not at the plan: PX8, PX9, PX12,
  PX13, PX14 (when not explained by `stillOk`). Same build, render again, re-check. A second fail is an engine bug:
  flag, with both reports.
- **Auto-fix by re-planning** (the planner gets the finding and changes the reel, then build, render, check; at most
  once per reel, never for a `by: "user"` element):

| Rule | Re-plan |
|---|---|
| PX1 | move or shrink the overlay box off the face core, or drop the beat (the GW9 path) |
| PX3 | lower the snap / push scale, or move `zoom.origin` toward the face |
| PX5 | turn the caption backing on for those blocks (`captions.backing`) |
| PX6, PX7 | regroup the captions (smaller `group`), so blocks are shorter and stay on screen longer |
| PX11 | move the overlay box inside the zones; a caption in a zone is an engine bug (flag) |
| PX15 | move the take's `a` / `b` into the nearest word gap |

- PX2, PX4, PX10, PX16 and PX0 are never auto-fixed: flag.

## 6. Determinism

The report minus `timing` and `report_sha256` is a pure function of (the MP4 bytes, the build JSON, the graphic
files, the tool versions):

- the frame list is computed from `geometry.json` only (2.4); no random sampling, no wall clock;
- decoding is bit-exact (H.264 / VP9 decoders), filters run with `-filter_threads 1`; OpenCV with
  `cv2.setNumThreads(1)`; the probe uses the renderer's seek mode;
- values are rounded before thresholds are applied (px integers, ratios to 2 decimals, seconds to 3);
- findings are sorted by (rule id, `t`, subject); JSON is written with sorted keys and fixed separators.

Tested: the same MP4 checked twice gives the same `report_sha256`; two renders whose `framemd5` match give the same
`report_sha256`. Two renders of one build whose reports differ is itself the signal that the render is not
deterministic.

## 7. Tests (each rule implementable and verifiable)

**(built)** `scripts/pixel-check.test.mjs` (node --test; in the gate) generates one synthetic reel per case with
`scripts/fixtures/pixel_fixture.py` into a temp dir (270x480, 30 fps, 4 s: a quarter-size canvas with the Instagram
zones scaled, h264 qp 0, pcm audio, a VP9-alpha overlay; nothing committed) and a hand-written probe for the
checker's own sample list (no Chrome). PX2's detections come from the fixture through `PIXEL_CHECK_TEST_DETECTIONS`,
honoured only under `node --test`. Each case asserts the rule, the severity, the frame of the worst sample, the exit
code, and that no other rule fired:

PX0 a render of 270x478 (exit 3, every other rule skipped), unreadable JSON, a stale probe. PX1 the graphic box moved
onto the face. PX2 the face track shifted 100 px (the spec's 300 px at quarter size). PX3 the face pushed off the left
edge. PX4 a caption block over the eyes. PX5 white captions on a white card. PX6 30 px text. PX7 32 letters in 0.6 s
(warn). PX8 (a) a block the page shows that the render never drew, (b) a caption drawn over an insert inside its
hidden window, plus the clean insert. PX9 the caption drawn 30 px right. PX10 a text layer at x = -50. PX11 a
caption in the top band; a graphic in the right column upper half (pass) and lower half (warn). PX12 the graphic
shown one frame early. PX13 3 black frames. PX14 1.1 s frozen inside a take. PX15 take 0's `b` inside a word. PX16 the
audio driven into clipping. The clean reel passes with every rule checked (`checked > 0`), and the same render checked
twice gives the same `report_sha256`. The probe itself is tested on a small page in the renderer's Chrome (skipped
when it is not cached). Mutation proofs (each rule's threshold or comparison broken in a copy of the checker; the
suite must fail): 18 of 18 caught (plus 8 of 8 on the probe cache's guards and PX9's unmatched-block warn: each
guard removed in a copy, `lib/probe-cache.test.mjs` / the suite fails; a FIFO read without O_NONBLOCK hangs it), including PX9 put back to the ink extent (the CP4 pearl bug), PX5's ink
tolerance put back to 40 levels, and the frozen-frame skip removed. CP3 / CP4 additions: the probe with real GSAP
through the fetch path (network; skipped with the reason when offline), a sha mismatch (exit 3, under 3 s, nothing
written), GSAP not reachable (exit 4, under 3 s), a remote script the probe may not fetch, a vendor copy with the wrong
sha, an unknown URL aborted and listed, the checker's pixel-only run when the probe is unavailable, the geometry
`error` field, and three regression fixtures: bright blobs beside a centred caption (no PX9), ink #808080 on a box
#6e6e6e (PX5 about 1.29:1), a frozen picture over a caption change (PX14 only).

`scripts/lib/geometry.test.mjs`: the face through the placer's camera (base x snap around the origin) and its age,
the skipped windows, the hidden-caption reasons, joins / holds / outro, whole-frame graphic windows and the floor frame
map. `byte-identity.mjs` hashes `build/geometry.json` for the run-to-run check but does not compare it with the
golden file (recorded before it existed); every file the golden lists must still match.

Real reels (2026-10-20, built with this branch at the release head a1cd731 incl. mac-45, GSAP fetched by the probe;
renders as they were unless said):
- broadsheet base render (mac-42 `r1base-1`): `fail`, PX9 on the same 8 blocks `meas.py` finds (+21 to +39 px, within
  1-7 px of it). The fixed render `r1br-1`: no PX9. `r1f9-1` (f9e87f7) did not race on that render (`meas.py`: 537-542
  px): no PX9.
- savoy overlays (m41b A, an older render): `fail`, the same 8 race blocks; PX1 / PX11 / PX12 clean.
- close-up inserts (m41c B1): the older render failed PX9 cg8 +51 px (`meas.py` 590.5) and PX11 cg7 (the lower-face
  clipping box drawn 90 px tall against 75 reserved: 15 px into the bottom band; mac-45 fixed exactly that). Rendered
  again at a1cd731: `warn` only (PX7), PX9 / PX11 clean; insert fade-from-black exempt. Same report hash twice.
- the m41 face-overlap reel (proj-g, `out.mp4`): PX1 pass. Its boxes end at y 620 and the face (grown box) starts at
  y ~640 in this render; a frame at t = 10 s shows the card above the head. It is not the overlapping version.
- CP4's pearl reels (a5-cp4 px6, px15): no PX9 (were -62, -48, -10 px); px14: PX14 only; px5: 1.29:1.

## 8. Open questions (PC / owner)

Answered by the lead (2026-10-19):

1. **`geometry.json`**: yes, `build.mjs` writes it, one source of camera truth, additive; every other output stays
   byte-identical (gate byte-identity + the style sweep). No Python port of the camera mapping.
2. **Room shrink and multi-source faces**: skipped for now. `geometry.faceSkip` lists the windows; PX1-PX4 report
   them under `not_checked` with the reason.
3. **Right UI column**: PX11 follows `safezone.mjs` as the platforms draw it, the right-hand column in the lower half
   only. GW7 and the planner are not changed.

Pending owner (the proposed defaults are what is built):

4. **Thresholds**: contrast 3.0 / 4.5, text 32 / 42 px, 25 chars/s, centre 8 / 16 px, face 2 % of the box / any
   eyes-mouth pixel, freeze 0.5 / 1.0 s. *Pending owner.* (Real reels: 25 chars/s warns on one block in each of the
   three reels; nothing else borderline.)
5. **Exempt windows** (`stillOk` / `darkOk`): endcard and cover beats, holds, outro, insert hold tails, full-canvas
   image layers; nothing dark. *Pending owner.*
6. **Verdict policy**: warn does not block; PX11 for an overlay graphic is a warn. *Pending owner.*
7. **Audio**: `qa.py` keeps loudness and silences; this report has only PX16. *Pending owner.*
8. **Where**: after `tailhold.py` on staging; who owns the retry counter (studio or PC). *Pending owner.*

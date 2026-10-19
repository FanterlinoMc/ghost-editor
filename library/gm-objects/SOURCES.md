# gm-objects: sources and licence

The 3D objects used by the Chrome Motion `gm-object` and `gm-nodes` scenes (`scripts/lib/gadzhi.mjs`).
Every file comes from **3dicons v1** by Vijay Verma (realvjy). The set is released under **CC0 1.0 Universal**.

## Licence

- https://3dicons.co/license.md (fetched 19 Oct 2026), quoted:

  > 3dicons v1 with CC0
  > Creative Commons Zero v1.0 Universal
  >
  > Use without any limitation for personal and commercial. All source file available to download for free.
  >
  > PERMISSIONS: \*Commercial use \*Modification \*Distribution \*Private use

- https://github.com/realvjy/3dicons: GitHub reports the repository licence as `CC0-1.0`
  (Creative Commons Zero v1.0 Universal).
- Licence text: https://creativecommons.org/publicdomain/zero/1.0/
- Every icon below is a free v1 icon. The site's icon details report `pro: false`, author `realvjy` and licence `CC0`.
  None of them is from the paid 3dicons Pro tier. In 3dicons, "premium" is a colour style of the free icons.

CC0 needs no attribution. We credit the author here anyway.

## Files

All seven files use the same variant: the **dynamic** angle in the **premium** style (graphite and gold), downloaded at 2400x2400 RGBA
from the site's public download button on 19 Oct 2026.

| file | 3dicons icon | note | delivered size |
|---|---|---|---|
| `chart.png` | https://3dicons.co/icons/4a4275-chart | a 3D pie chart; v1 has no bar or line chart | 1321x1400 |
| `gears.png` | https://3dicons.co/icons/7e47be-setting | a single gear ("setting") | 1400x1370 |
| `lightbulb.png` | https://3dicons.co/icons/ddbd61-bulb | | 1400x1374 |
| `puzzle.png` | https://3dicons.co/icons/a68576-puzzle | stands in for "think / value" (v1 has no brain) | 1400x1317 |
| `rocket.png` | https://3dicons.co/icons/744cc0-rocket | | 1375x1400 |
| `stopwatch.png` | https://3dicons.co/icons/8ef1fa-clock | an alarm clock ("clock"), kept under the engine name `stopwatch` | 1149x1400 |
| `target.png` | https://3dicons.co/icons/49b6f4-target | a target with a dart | 1400x1151 |

## Preparation

The same four steps were applied to every file:

1. **Crop** to the bounding box of alpha > 24. This is the threshold `scripts/gm_bounds.mjs` uses. The 2400px source has 10-30%
   transparent padding, and `gadzhi.mjs` sizes the whole image, so an uncropped file would draw smaller.
2. **Desaturate**: RGB converted to luminance (Pillow `convert("L")`), with alpha kept. This turns the premium gold into neutral
   graphite and chrome, which stays neutral in all five colour themes.
3. **Scale** so the longest side is 1400 px, with Lanczos resampling. Save as an optimised 8-bit RGBA PNG.
4. **Rename** to the engine's object names (table above).

Then regenerate `bounds.json` with `node scripts/gm_bounds.mjs`. Because the files are cropped, every entry is
`top 0, bottom 1, left 0, right 1`.

To add another object, take any free v1 icon from https://3dicons.co (the dynamic angle in the premium style), apply the same four steps
and re-run `gm_bounds.mjs`.

## History

Before 19 Oct 2026 this folder held seven AI renders that had no recorded source or licence: brain, chart, gears, lightbulb, rocket,
stopwatch and target. They were all replaced, and `brain` was dropped in favour of `puzzle`.

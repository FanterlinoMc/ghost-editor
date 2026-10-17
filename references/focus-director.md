# Focus director (standalone, not wired into the studio)

`scripts/focus_director.py` and `scripts/focus_review.py` are a hand port of Ahmed's `engine/director/focus_director.py` /
`focus_review.py`. They turn a transcript into the beats of **Authority** (`hormozi`) and **Chrome Motion** (`gadzhi-*`), so a
clip gets the edit without anyone placing graphics. They do not use, import or call the retired `engine/director/director.py`,
and contain no Mac paths.

```
python scripts/focus_director.py <project> --style hormozi|gadzhi-motion|gadzhi-blue|gadzhi-green|gadzhi-red|gadzhi-yellow
        [--name "Ada Test"] [--role "Founder"] [--cut] [--dry] [--review-file review.json]
```

## Inputs
- `<project>/reel.json`: `style` (or `--style`, which overwrites it), `takes` (if absent or with `--cut`, `scripts/smartcut.py <project>`
  is run and its `takes` used), `words` (default `build/words.whisper.json`, whisper segments or a plain word list; word
  confidence `p`, if present, is used to find made-up words).
- `--name` / `--role`: only for the Authority name card (`hz-name`); without `--name` no name card is planned.
- `--review-file`: an AI review (see below) produced elsewhere, same schema as `focus_review.Review`.
- Python packages: `pydantic` (always, imported by `focus_review.py`); `anthropic` only for a live review.
- Single recording only: it reads the primary transcript and takes. A multi-source reel would have to be planned per recording.

## Outputs
- Prints one JSON document to stdout: `{style, takes: <count>, beats: [...], captions?: {...}}`.
- Unless `--dry`, rewrites `<project>/reel.json`: `style`, `takes` (smartcut and misheard-word cuts applied), `beats` (beats with
  `"manual": true` are kept, everything else is replaced) and, for hormozi, `captions: {emph: [...], autoEmph: false}`.
- Every beat time is snapped inside a kept take.
- Authority plans: `hz-title` (the hook promise in <= ~6 words, caps), `hz-name` (if `--name`), `hz-list` (when the speaker counts
  points: "number one / first / step two", or 2+ points the AI review found within 8 s of each other).
- Chrome Motion plans 2-4 `scene` beats (`gm-object`, `gm-flow`, `gm-counter`, `gm-nodes`), at least 3 s apart, each 0.8-3.5 s,
  `captions: false`. Concept words choose the 3D object: money / cost / ROI / return / goal / result -> `target` (Ahmed's f1d4b0a),
  time -> `stopwatch`, AI / system / tools -> `gears`, growth -> `rocket`, idea / strategy -> `lightbulb`, think / value -> `brain`.
  A spoken number (`$6,000`, `80%`) becomes a `gm-counter` (it can lose to a higher-scoring beat under the 3 s spacing rule).
- `podcast-glow` is not planned here: use `scripts/glow_plan.py` (headlines); the cut-out set windows are not planned.

## The AI review (optional, costs money)
`focus_review.review()` asks Claude for: phrases Whisper got wrong (`cut`), the video's promise (`title`), the points he makes
(`points`), words to bold (`emphasis`) and, for Chrome Motion, the strongest moments (`moments`). Every answer is validated against
the transcript (anything not spoken is dropped) and the heuristic plan stands in.
- **API / key:** the Anthropic Messages API via the `anthropic` SDK (`messages.parse` with a pydantic `output_format`), needs
  `ANTHROPIC_API_KEY`. **Model:** `PHANTASIC_DIRECTOR_MODEL`, default `claude-opus-5-5`.
- **No key (and no `--review-file`): the review is skipped** with a note on stderr and the heuristics alone plan the reel. The
  tests run it that way, with the key removed from the environment. Nothing in this repo has run a live review.
- A wired version should run the review itself, save it as JSON and pass `--review-file`, so the planner owns the spend.

## Known limits
- `real_word()` reads `/usr/share/dict/words`; where it is absent (Windows, slim images) no word is judged a non-word and the
  misheard-word cut only uses the AI review.
- `breakdown_plan.sentences` / `chapter_marks` are inlined in `focus_director.py` (the fork has no `breakdown_plan.py`).

"""AI review for the focus director (hand port of phantasic engine/director/focus_review.py; needs pydantic and, only for a
live review, the anthropic SDK + ANTHROPIC_API_KEY; PHANTASIC_DIRECTOR_MODEL picks the model, default claude-opus-5-5): the parts heuristics can't judge.

Claude reads the transcript (with each word's confidence) and returns:
  cut       phrases Whisper got wrong (nonsense in context: "in just to the brain") -> removed from the takes
  title     the video's promise in <= 6 words, built only from words the speaker said (ROI for return on investment ok)
  points    the points he makes, numbered or not ("time saved, cycle time, revenue"): short title + optional grey line
  emphasis  the words worth bolding in captions
  moments   the 3-4 strongest beats for full-screen graphics (Gadzhi Motion) with what each should show
Every answer is checked against the transcript before use (validate()); anything that fails is dropped, and the
heuristic plan stands in. With no ANTHROPIC_API_KEY the review is skipped (or read from --review-file).
"""
import json, os, re
from pydantic import BaseModel, Field

MODEL = os.environ.get("PHANTASIC_DIRECTOR_MODEL", "claude-opus-5-5")


class Span(BaseModel):
    start: float
    end: float
    heard: str = Field(description="the words as transcribed")
    why: str


class Point(BaseModel):
    title: str = Field(description="<= 6 words, from what he says at that point; a question stays a question")
    sub: str = Field("", description="optional grey line <= 6 words")
    at: float = Field(description="source second where the point starts being said")


class Moment(BaseModel):
    kind: str = Field(description="gm-object | gm-flow | gm-counter | gm-nodes")
    at: float
    to: float
    object: str = Field("", description="brain | target | stopwatch | rocket | gears | lightbulb")
    text: str = Field("", description="gm-object: words above the object, spoken, '*word*' = big serif accent, '^word' = big sans")
    textBelow: str = ""
    labels: list[str] = Field(default_factory=list, description="gm-flow: 2-3 short spoken labels")
    value: float = 0
    prefix: str = ""
    suffix: str = ""
    label: str = ""
    pill: str = ""
    why: str = ""


class Review(BaseModel):
    cut: list[Span] = Field(default_factory=list)
    title: str = ""
    points: list[Point] = Field(default_factory=list)
    emphasis: list[str] = Field(default_factory=list)
    moments: list[Moment] = Field(default_factory=list)


SYSTEM = """You are the editor-director for short vertical talking-head reels. You never invent content: every word you
put on screen must be something the speaker actually says (the title may shorten 'return on investment' to 'ROI').
Be strict about misheard words: a phrase that makes no sense in context (e.g. 'knowing the numbers in just to the
brain') is a transcription error; return its exact time span in `cut` so it is removed. Only cut whole phrases or
sentences that are wrong; never cut correct speech. Points: the separate ideas he lists (numbered or not); 2-4 of them,
or none if he doesn't list. Moments (only if asked): the 3-4 strongest beats for a full-screen motion graphic, never
back to back, at least 3 s apart, each 1.5-3.5 s."""


def transcript(ws):
    return "\n".join(f"{w['start']:.2f}-{w['end']:.2f} {w['word']}" + (f"  (p={w['p']:.2f})" if w.get("p", 1) < 0.8 else "") for w in ws)


def ask(ws, style, want_moments=False):
    import anthropic
    msg = f"Style: {style}.\nTranscript (source seconds, word, low-confidence words marked):\n{transcript(ws)}\n\n" \
          f"Return cut, title, points, emphasis{', moments' if want_moments else ''}."
    r = anthropic.Anthropic().messages.parse(model=MODEL, max_tokens=8000, system=SYSTEM,
                                             messages=[{"role": "user", "content": msg}], output_format=Review)
    return r.parsed_output


def _spoken(ws):
    return {re.sub(r"[^\w%$']", "", w["word"].lower()) for w in ws}


def validate(rv: Review, ws):
    """drop anything not grounded in the transcript; return (review, rejections)."""
    said, rej = _spoken(ws) | {"roi", "ai"}, []
    t0, t1 = ws[0]["start"], ws[-1]["end"]
    ok = lambda s: all(re.sub(r"[^\w%$']", "", x.lower().strip("*^_")) in said for x in s.split() if re.sub(r"[^\w]", "", x))
    rv.cut = [c for c in rv.cut if t0 - 0.1 <= c.start < c.end <= t1 + 0.1 and c.end - c.start < 8 or rej.append(f"cut {c.start}-{c.end}")]
    if rv.title and not ok(rv.title):
        rej.append(f"title '{rv.title}' not spoken"); rv.title = ""
    rv.points = [p for p in rv.points if ok(p.title) and t0 <= p.at <= t1 or rej.append(f"point '{p.title}'")]
    for p in rv.points:
        if p.sub and not ok(p.sub):
            p.sub = ""
    rv.emphasis = [e for e in rv.emphasis if re.sub(r"[^\w%$']", "", e.lower()) in said]
    rv.moments = [m for m in rv.moments if t0 <= m.at < m.to <= t1 + 0.2 and ok(m.text) and ok(m.textBelow) and ok(m.pill) and all(ok(x) for x in m.labels) or rej.append(f"moment {m.kind}@{m.at}")]
    return rv, rej


def review(ws, style, review_file=None, want_moments=False):
    if review_file:
        rv = Review.model_validate_json(open(review_file).read())
    elif os.environ.get("ANTHROPIC_API_KEY"):
        rv = ask(ws, style, want_moments)
    else:
        return None, ["no ANTHROPIC_API_KEY: AI review skipped, heuristics only"]
    return validate(rv, ws)

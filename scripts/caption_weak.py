"""The engine's one weak-word list (scripts/lib/caption-weak.json), for Python planners. Stdlib only.

    from caption_weak import WEAK, SWEAR, NEVER_KEY
    WEAK       fillers, hedges, contractions, vague nouns: never a key, hero or big caption word
    SWEAR      swear words (a subset is also in WEAK): never drawn big, and a line holding one is never quoted
    NEVER_KEY  WEAK | SWEAR, the set a key-word guard should refuse

load() REFUSES (ValueError) a missing key, an empty list or a non-word entry: an empty guard refuses nothing, which
is the worst outcome and reads as a pass everywhere else (CP3, 25 Oct). Importing this module fails loudly then.
"""
import json
import re
from pathlib import Path

DEFAULT = Path(__file__).resolve().parent / "lib" / "caption-weak.json"
_WORD = re.compile(r"^[a-z]+(?:'[a-z]+)?$")


def load(path=DEFAULT):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    out = []
    for key in ("weak", "swear"):
        xs = data.get(key) if isinstance(data, dict) else None
        if not isinstance(xs, list) or not xs:
            raise ValueError(f"{path}: `{key}` must be a non-empty list (an empty guard refuses nothing)")
        bad = [w for w in xs if not isinstance(w, str) or not _WORD.match(w)]
        if bad:
            raise ValueError(f"{path}: `{key}` has entries that are not lower-case bare words: {bad[:5]}")
        out.append(frozenset(xs))
    return out[0], out[1]


WEAK, SWEAR = load()
NEVER_KEY = WEAK | SWEAR

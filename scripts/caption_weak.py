"""The engine's one weak-word list (scripts/lib/caption-weak.json), for Python planners. Stdlib only.

    from caption_weak import WEAK, SWEAR, NEVER_KEY
    WEAK       fillers, hedges, contractions, vague nouns: never a key, hero or big caption word
    SWEAR      swear words (a subset is also in WEAK): never drawn big, and a line holding one is never quoted
    NEVER_KEY  WEAK | SWEAR, the set a key-word guard should refuse
"""
import json
from pathlib import Path

_DATA = json.loads((Path(__file__).resolve().parent / "lib" / "caption-weak.json").read_text(encoding="utf-8"))
WEAK = frozenset(_DATA["weak"])
SWEAR = frozenset(_DATA["swear"])
NEVER_KEY = WEAK | SWEAR

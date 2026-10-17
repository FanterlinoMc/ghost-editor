#!/usr/bin/env python3
"""Explainer planner (engine/templates/explainer.md): writes the Explainer edit into reel.json.

    explainer_plan.py <project> [--dry]

  - hook title (`effect` beat) in the first ~6 s: the strongest real word boxed (a noun-ish content word that fits the
    box), up to 2 words of its phrase small above, a small lower line only when it finishes the phrase; placed above
    the eyes or below the mouth (face.json), never over them
  - cutout concept pages on clauses of 3-10 words (0.8-3 s):
      * an engraving page only when the clause says the engraving's object in its literal sense (a strict lexicon with
        idiom blocks: "all the time" is not an hourglass, "called" is not a phone, "deal with" is not a handshake);
        each object once per video
      * otherwise, where the reel would go flat (> ~7 s without a page), a word page: the clause's key word set big on
        the torn scrap (only dictionary words, or names said twice, so an ASR slip never goes big)
    pages >= 1.5 s apart, about one every 6 s, at most ~35% of the runtime; grounds rotate paper / chalk / maroon / slate
    the clause is typed into typewriter bars that wrap by length (<= 18 chars a bar, at most 3 bars)
Everything on screen is spoken. Precision over recall: no page beats a wrong page.
"""
import json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from mono_plan import load_words, bare, score, show, STOP


# `sentences` and `clauses` are copied from phantasic's breakdown_plan.py (the fork has no breakdown planner), unchanged.
def sentences(ws):
    out, cur = [], []
    for i, w in enumerate(ws):
        cur.append(w)
        nxt = ws[i + 1] if i + 1 < len(ws) else None
        if nxt is None or re.search(r"[.?!]$", w["word"]) or nxt["start"] - w["end"] > 0.6:
            out.append(cur); cur = []
    return out


def clauses(snt):
    """A sentence cut at commas and at 'and/but/because' joints into clauses of <= 9 words."""
    out, cur = [], []
    for w in snt:
        if cur and (bare(w["word"]).strip("'") in ("and", "but", "because", "cause", "so") or len(cur) >= 9 or w["take"] != cur[-1]["take"]):
            out.append(cur); cur = []
        cur.append(w)
        if re.search(r"[,;:]$", w["word"]):
            out.append(cur); cur = []
    if cur:
        out.append(cur)
    return out

GROUNDS = ["paper", "chalk", "maroon", "slate"]
HOOK_WINDOW = 7.0      # the hook title lands in the first seconds of speech
PAGE_GAP = 1.5         # min seconds between pages (and after the hook)
FLAT = 6.0             # a stretch this long with no page gets a word page
MAX_COVER = 0.35       # pages cover at most this share of the runtime
BAR_CHARS, MAX_BARS = 18, 3

# engraving lexicon: literal mentions only. (word regex, engraving)
LEX = [
    (r"(money|cash|coins?|dollars?|cents?|budget|price|prices|cost|costs|paid|pay|paying|salary|revenue|profit|profits|income|cheap|expensive|afford)", "coins"),
    (r"(rich|wealth|wealthy|fortune|millions|billions|millionaire|billionaire|savings|invest|investing|investment|investors?)", "moneybag"),
    (r"(brain|brains|mind|minds|think|thinking|memory|memories|psychology)", "brain"),
    (r"(idea|ideas|insight|insights|creative|creativity|invent|invented|invention|inventions|innovation|brainstorm)", "lightbulb"),
    (r"(team|teams|staff|crew|colleagues|coworkers|employees|people|community)", "team"),
    (r"(growth|grow|grows|growing|scale|scaling|statistics|stats|metrics|data|chart|charts|graph|percent|percentage|average)", "chart"),
    (r"(rocket|rockets|launch|launched|launching|liftoff|skyrocket|skyrocketed)", "rocket"),
    (r"(time|wait|waiting|patience|hourglass)", "hourglass"),
    (r"(clock|clocks|minutes|seconds|hour|hours|o'clock|deadline|deadlines|late)", "watch"),
    (r"(calendar|calendars|schedule|scheduled|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|weekly|appointment|appointments)", "calendar"),
    (r"(goal|goals|target|targets|aim|bullseye|objective|objectives)", "target"),
    (r"(system|systems|process|processes|automate|automated|automation|automations|machine|machines|mechanism|engine|workflow|workflows)", "gears"),
    (r"(ai|robot|robots|bot|bots|chatbot|chatgpt)", "robot"),
    (r"(email|emails|e-mail|mail|inbox|letter|letters|envelope)", "mail"),
    (r"(phone|phones|telephone|calls|calling|dial)", "phone"),
    (r"(win|wins|won|winner|winners|winning|champion|champions|championship|trophy|award|awards|prize|prizes)", "trophy"),
    (r"(deal|deals|agreement|agreements|partner|partners|partnership|contract|contracts|handshake|clients?|customers?)", "handshake"),
    (r"(search|searching|research|researcher|researchers|investigate|investigation|clue|clues|magnify|inspect|examine)", "magnifier"),
    (r"(checklist|checklists|list|lists|to-do|tasks|paperwork|forms|steps)", "checklist"),
    (r"(chess|strategy|strategies|strategic|tactics|checkmate)", "chess"),
    (r"(ladder|climb|climbing|career|promotion|promoted)", "ladder"),
    (r"(laptop|laptops|computer|computers|software|code|coding|website|websites|internet|online|app|apps|digital)", "laptop"),
    (r"(hand|hands|point|pointing|finger|fingers)", "hand"),
]
LEX = [(re.compile(rf"^{rx}$"), e) for rx, e in LEX]
# idioms and other senses that must NOT trigger the engraving (matched on the lowercased words around the hit)
BLOCK = {
    "hourglass": [r"\b(all|same|every|first|next|last|this|that|each|whole|one|any|some|other|at|by|in|on|full|part|any|no|long|good|great|hard|free|real) (the )?time\b",
                  r"\btime (to|for|when|i|we|you|he|she|they|it)\b", r"\bwait (a|for) (sec|second|minute)", r"\bcan't wait\b"],
    "watch": [r"\b(few|couple of) seconds\b", r"\bseconds? (later|ago)\b", r"\blate(r|st)?\b(?!.*\b(deadline|clock)\b)"],
    "coins": [r"\bpay attention\b", r"\bpays? off\b", r"\bpaid off\b", r"\bat (all|any) costs?\b", r"\bprice of\b"],
    "handshake": [r"\bdeal with\b", r"\bdealt\b", r"\bbig deal\b", r"\b(a|great|good) (great )?deal of\b", r"\bdeal(s|t)? with\b"],
    "phone": [r"\bcalled\b"],
    "hand": [r"\bon the other hand\b", r"\bhand in hand\b", r"\b(first|second)[- ]hand\b", r"\bhand(ed)? (it|them|over|out)\b", r"\bpoint (is|was|of|being|where|in time)\b", r"\b(the|my|that|this|a|good|whole) point\b", r"\bpoint out\b"],
    "trophy": [r"\bwin(s)? (over|back)\b"],
    "checklist": [r"\bsteps? (up|down|back|in|out|aside)\b", r"\bwait ?list\b"],
    "team": [r"\bpeople (say|think|tend|like|love|ask)\b"],
    "gears": [r"\bimmune system\b", r"\bsolar system\b", r"\bnervous system\b", r"\bsearch engine\b"],
    "brain": [r"\bi think\b", r"\b(you|we|they) think\b", r"\bthink (about|so|that|it|of)\b", r"\bmind (you|if)\b", r"\bnever mind\b", r"\bkeep in mind\b", r"\bmake up (my|your) mind\b"],
    "lightbulb": [r"\bno idea\b", r"\b(great|good) idea\b(?=.*\?)"],
    "target": [r"\baim (to|for)\b"],
    "rocket": [],
    "magnifier": [],
    "laptop": [r"\bcode (of|name)\b"],
    "chart": [r"\bgrow(s|ing)? up\b", r"\bon average\b"],
    "mail": [r"\bletters? of\b", r"\bletter (to the editor|grade)"],
    "calendar": [],
    "chess": [],
    "ladder": [],
    "moneybag": [r"\bmillions of (people|years|times)\b"],
    "robot": [],
}
BLOCK = {k: [re.compile(x) for x in v] for k, v in BLOCK.items()}

# never big on screen (hook key / word page): fillers, discourse words, generic or weak words
WEAK = set("""oh well actually basically literally probably definitely pretty something anything everything nothing
everywhere anywhere somewhere somebody anybody everybody someone anyone everyone people person today yesterday tomorrow guys guy stuff things thing
yeah yes okay right sorry thanks thank please kinda sorta gonna gotta really maybe perhaps already again still even
always never ever usually often sometimes certain certainly sure surely exactly quite rather little bit lots much many
he's she's it's they're we're i've i'd i'll you're you've you'd that's there's what's who's let's isn't aren't wasn't
weren't doesn't didn't won't wouldn't couldn't shouldn't haven't hasn't hadn't can't don't
whole other another others same different such these those within without through during before after while since
until upon onto toward towards between among against around across behind beyond under above below
first second third last next back away together forward start started starting stop stopped come came coming
take took taken taking give gave given giving put puts tell told telling ask asked asking seem seems seemed feel felt
look looks looked looking find found keep kept call called try tried trying become became happen happens happened
done doing gets getting goes going went seen saw seeing says said saying knew known knowing wanted wants wanting
thought thinking imagine imagined understand understood remember mean means meant made makes making able unable""".split())
# modern words the 1934 system dictionary lacks
MODERN = set("""internet online email emails website websites app apps podcast podcasts video videos youtube tiktok
instagram facebook twitter linkedin google iphone smartphone software startup startups biodiversity wikipedia
wikimedia vaccines vaccination vaccinations covid laptop laptops ai chatgpt selfie influencer influencers""".split())
_DICT = None
_WS = []
_LOWER = [False]
# too generic to stand alone big on a page
GENERIC = set("""example examples reason reasons part parts kind kinds type types fact facts case cases point points
situation situations question questions answer answers place places side sides course level levels number numbers
beautiful great good nice new old big small certain several multiple different various entire important special
real true sure simple easy hard best better worst main major minor whole basic general particular specific
including regarding according interested interesting highlighting yourself myself himself herself themselves ourselves itself""".split())


def real_word(b):
    """b is a bare lowercase word. True when the system dictionary (or the modern list) knows it or a simple stem."""
    global _DICT
    if _DICT is None:
        try:
            _DICT = set(l.strip().lower() for l in open("/usr/share/dict/words"))
        except OSError:
            _DICT = set()
    if not _DICT:
        return True  # no dictionary on this machine: don't block
    b = b.strip("'")
    if not b or re.search(r"\d", b) or b in _DICT or b in MODERN or b in STOP or b in WEAK:
        return True
    if "'" in b:  # contractions: i've, didn't, format's
        return real_word(b.split("'")[0]) if b.split("'")[0] else True
    if "-" in b:
        return all(real_word(x) for x in b.split("-") if x)
    for suf, rep in (("ies", "y"), ("es", ""), ("s", ""), ("ed", ""), ("ed", "e"), ("ing", ""), ("ing", "e"), ("ly", ""),
                     ("er", ""), ("ers", ""), ("est", ""), ("ness", ""), ("ment", ""), ("ments", ""), ("ity", "e"), ("ically", "ic")):
        if b.endswith(suf) and len(b) - len(suf) >= 3 and (b[: -len(suf)] + rep) in _DICT:
            return True
    if b.endswith("'s") and b[:-2] in _DICT:
        return True
    return False


def bigword_ok(w, counts):
    """May this word be shown BIG (boxed hook word / word page)? Precision: a real word, or a name said twice."""
    b = bare(w["word"]).strip("'")
    raw = re.sub(r"[^\w'-]", "", w["word"])
    if re.fullmatch(r"[A-Z]{2,5}", raw) and b not in STOP and b not in ("ok", "um", "uh"):
        return True  # an acronym (HPV, NASA): ASR spells these reliably
    if not b or b in STOP or b in WEAK or b in GENERIC or len(b) < 4 or "'" in b or b.isdigit() and len(b) < 3:
        return False
    # a capitalised word next to another capitalised word is a piece of a name ("Better Culture"): not alone
    i = w.get("i")
    if raw[:1].isupper() and i is not None and _WS:
        nb = [_WS[j]["word"] for j in (i - 1, i + 1) if 0 <= j < len(_WS)]
        if any(re.sub(r"[^\w]", "", x)[:1].isupper() and not re.search(r"[.?!]$", _WS[i - 1]["word"] if i else ".") for x in nb):
            return False
    if real_word(b):
        return True
    return (raw[:1].isupper() or _LOWER[0]) and counts.get(b, 0) >= 2


def key_score(w):
    """score() plus a nudge toward nouns (the hook is a topic, not a verb)."""
    b = bare(w["word"]).strip("'")
    s = score(w)
    if re.search(r"(tion|sion|ness|ity|ment|ism|ogy|ance|ence|ship|hood|ics|ure|age)s?$", b):
        s += 3
    if re.search(r"(ed|ing)$", b) and len(b) > 5:
        s -= 3
    if b.endswith("ly"):
        s -= 5
    i = w.get("i")
    if i and _WS:
        p = bare(_WS[i - 1]["word"]).strip("'")
        if p in ("the", "a", "an", "our", "your", "my", "their", "his", "her", "its", "this", "these", "those", "of"):
            s += 2  # a noun (or its adjective) follows a determiner
        if p in ("i", "we", "you", "they", "he", "she", "it", "somebody", "someone", "everybody", "everyone", "people", "to", "will", "would", "can", "could", "should", "must", "don't", "didn't"):
            s -= 3  # a verb follows a subject / modal
    return s


def wrap(cl):
    """the engine's bar wrap (barChars): words into bars of <= BAR_CHARS characters"""
    bars, n = [[]], 0
    for w in cl:
        L = len(w["word"].rstrip(",."))
        if bars[-1] and n + 1 + L > BAR_CHARS:
            bars.append([]); n = 0
        bars[-1].append(w); n += (1 if n else 0) + L
    return bars


def stem(b):
    b = bare(b).strip("'")
    for suf in ("ations", "ation", "ies", "es", "s"):
        if b.endswith(suf) and len(b) - len(suf) >= 4:
            return b[: -len(suf)]
    return b


def fits_box(text):
    return len(text) <= 13


def engraving_of(cl, i):
    """The engraving clause word i names literally, or None."""
    b = bare(cl[i]["word"]).strip("'")
    for rx, e in LEX:
        if rx.match(b):
            gi = cl[i].get("i")
            src, k = (_WS, gi) if gi is not None and _WS else (cl, i)
            ctx = " ".join(bare(w["word"]).strip("'") for w in src[max(0, k - 3): k + 4])
            if any(x.search(ctx) for x in BLOCK.get(e, [])):
                return None
            return e
    return None


def face_box(proj, spec, t0, t1):
    """(eyes_y min, mouth_y max) over [t0, t1] from build/face.json, or None."""
    f = proj / spec.get("face", "build/face.json")
    if not f.exists():
        return None
    ss = [s for s in json.loads(f.read_text())["samples"] if s[1] is not None and t0 - 0.3 <= s[0] <= t1 + 0.3]
    if not ss:
        return None
    return min(s[5] for s in ss), max(s[6] for s in ss), min(s[1] for s in ss)


def hook_y(proj, spec, t0, t1, n_lines):
    """Top of the hook block: the top third if it clears the eyes, else under the chin, never over eyes or mouth."""
    h = 190 + 80 * (n_lines - 1)
    fb = face_box(proj, spec, t0, t1)
    if not fb:
        return 240
    eyes, mouth, top = fb
    # punch-ins (up to ~1.14x about the zoom origin) move the face: keep a margin
    if 240 + h <= eyes - 120:
        return 240
    if 180 + h <= eyes - 120:
        return 180
    below = mouth + 150
    if below + h <= 1330:
        return below
    return None  # the face fills the frame: no room for a title that doesn't cover it


def pick_hook(ws, ss, counts, proj, spec):
    if not ws:
        return None
    t_start = ws[0]["start"]
    win = [i for i, w in enumerate(ws) if w["start"] < t_start + HOOK_WINDOW]
    cands = [i for i in win if bigword_ok(ws[i], counts) and fits_box(show(ws[i]["word"]).strip(",.!?;:"))]
    if not cands:
        return None
    # earlier is better (it is a hook), stronger is better
    ki = max(cands, key=lambda i: key_score(ws[i]) - 0.6 * (ws[i]["start"] - t_start))
    k = ws[ki]
    stops_before = lambda w: re.search(r"[.?!,;:]$", w["word"])
    before = []
    j = ki - 1
    while j >= 0 and len(before) < 2 and ws[j]["take"] == k["take"] and not stops_before(ws[j]) and k["start"] - ws[j]["end"] < 0.5:
        before.insert(0, ws[j]); j -= 1
    lead = {"and", "so", "but", "or", "oh", "um", "uh", "well", "like", "yeah", "then", "because", "cause", "just", "also", "i", "you", "it", "that", "they", "we", "he", "she"}
    lead |= {"of", "in", "on", "at", "to", "for", "with", "from", "by", "as", "is", "are", "was", "were", "be", "been", "has", "have", "had"}
    n0 = len(before)
    while before and bare(before[0]["word"]).strip("'") in lead:
        before.pop(0)
    if len(before) == 1:
        b1 = bare(before[0]["word"]).strip("'")
        # a lone word above the key must lead into it (THE / HALO, LOCAL / INJECTION), not be a verb ("enter / adulthood")
        if not (b1 in ("the", "our", "your", "my", "their", "this", "most", "new", "real", "big", "first", "best", "true", "free")
                or re.search(r"(al|ic|ive|ous|ful|ent|ant|ary|ern|ish|less)$", b1) or before[0]["word"][:1].isupper() and before[0]["word"].lower() != before[0]["word"]):
            before = []
    det = {"the", "a", "an", "our", "your", "my", "their", "his", "her", "this", "these", "those", "most", "more", "every", "no", "one", "two", "three", "new", "real", "big", "first", "best"}
    if before and all(bare(w["word"]).strip("'") in STOP for w in before) and not all(bare(w["word"]).strip("'") in det for w in before):
        before = []
    # a lone dangling word that isn't a lead-in to the key ("Locks at", "is a") reads as a fragment: drop it
    if before and bare(before[-1]["word"]) in ("at", "is", "are", "was", "were", "a", "an", "to", "be", "been", "has", "have", "had", "will", "would", "can", "could") and len(before) == 1:
        before = []
    if before and any(re.search(r"[^\w'-]", show(w["word"]).strip(",.!?;:")) for w in before):
        before = []
    if before and len(" ".join(w["word"] for w in before)) > 16:
        before = before[-1:]
    after = []
    j = ki + 1
    if not re.search(r"[.?!,;:]$", k["word"]):
        while j < len(ws) and len(after) < 3 and ws[j]["take"] == k["take"] and ws[j]["start"] - ws[j - 1]["end"] < 0.5:
            after.append(ws[j])
            if re.search(r"[.?!,;:]$", ws[j]["word"]) or (j + 1 < len(ws) and ws[j + 1]["start"] - ws[j]["end"] >= 0.35):
                break
            j += 1
        ends = after and (re.search(r"[.?!,;:]$", after[-1]["word"]) or j + 1 >= len(ws) or ws[j + 1]["start"] - ws[j]["end"] >= 0.35)
        # "WISDOM / OF THE CROWD" yes; "RECOMMENDATION / IS THAT" no: the lower line must finish the phrase on a real word
        if not ends or len(after) > 3 or bare(after[-1]["word"]) in STOP or bare(after[0]["word"]) in STOP - {"of", "and", "for", "in", "on"} or len(" ".join(w["word"] for w in after)) > 16:
            after = []
            nx = ws[ki + 1] if ki + 1 < len(ws) else None
            nb = bare(nx["word"]).strip("'") if nx else ""
            # "THE MOST / IMPORTANT / TIP": one more real word that completes the noun phrase
            if nx and nx["take"] == k["take"] and nb not in STOP and nb not in WEAK and "'" not in nb and not nb.endswith("ly") \
                    and real_word(nb) and len(nb) >= 3 and not re.search(r"(ed|ing)$", nb) and nx["start"] - k["end"] < 0.4:
                after = [nx]
    lines = []
    if before:
        lines.append({"text": " ".join(show(w["word"]).strip(",.!?;:") for w in before), "at": round(before[0]["start"] - 0.03, 3)})
    lines.append({"text": show(k["word"]).strip(",.!?;:"), "at": round(k["start"] - 0.03, 3), "box": True})
    if after:
        lines.append({"text": " ".join(show(w["word"]).strip(",.!?;:") for w in after), "at": round(after[0]["start"] - 0.03, 3)})
    for l, w0 in zip(lines, ([before[0]] if before else []) + [k] + ([after[0]] if after else [])):
        l["at"] = round(max(l["at"], spec["takes"][w0["take"]]["a"]), 3)  # never before its take starts
    t0 = lines[0]["at"]
    last = (after or [k])[-1]
    take = spec["takes"][k["take"]]
    t1 = min(max(last["end"] + 0.9, t0 + 1.8), t0 + 3.0, take["b"])
    y = hook_y(proj, spec, t0, t1, len(lines))
    while y is None and len(lines) > 1:  # no room for three lines clear of the face: drop the small ones
        lines = [l for l in lines if l.get("box")] if len(lines) == 2 or not lines[-1].get("box") and lines[0].get("box") else lines[:-1]
        if len(lines) == 2 and not lines[0].get("box"):
            lines = lines[:2]
        t0 = lines[0]["at"]
        y = hook_y(proj, spec, t0, t1, len(lines))
    if y is None:
        return None
    return {"type": "effect", "lines": lines, "at": round(t0, 3), "to": round(t1, 3), "y": y, "fit": True}


def plan(proj):
    spec = json.loads((proj / "reel.json").read_text())
    ws, takes = load_words(proj, spec)
    for i, w in enumerate(ws):
        w["i"] = i
    _WS[:] = ws
    counts = {}
    for w in ws:
        b = bare(w["word"]).strip("'"); counts[b] = counts.get(b, 0) + 1
    # some ASR output is all lowercase (no names capitalised): then a word said twice counts as a name
    lower_asr = sum(1 for w in ws if re.sub(r"[^\w]", "", w["word"])[:1].isupper()) < 0.02 * max(1, len(ws))
    _LOWER[0] = lower_asr
    # punctuated ASR marks phrase ends; unpunctuated ASR (no commas/full stops) can't be held to them
    punct = sum(1 for w in ws if re.search(r"[.?!,;:]$", w["word"])) >= 0.04 * max(1, len(ws))
    ss = sentences(ws)
    runtime = sum(k["b"] - k["a"] for k in takes)
    beats = []
    hook = pick_hook(ws, ss, counts, proj, spec)
    if hook:
        beats.append(hook)
    hook_end = hook["to"] if hook else -9

    # candidate clauses
    cands = []
    def fit(cl):
        """a clause too long for a page splits at its longest pause (unpunctuated transcripts run on)"""
        if len(cl) <= 10 and cl[-1]["end"] - cl[0]["start"] <= 3.0 and len(" ".join(w["word"] for w in cl)) <= BAR_CHARS * MAX_BARS:
            return [cl]
        if len(cl) < 6:
            return [cl]
        j = max(range(2, len(cl) - 2), key=lambda j: (cl[j]["start"] - cl[j - 1]["end"] + (0.15 if bare(cl[j]["word"]) in STOP and bare(cl[j - 1]["word"]) not in STOP else 0), -abs(j - len(cl) / 2)))
        return fit(cl[:j]) + fit(cl[j:])
    for snt in ss:
        for cl in [p for c in clauses(snt) for p in fit(c)]:
            keep_end = {"it", "them", "this", "that", "here", "there", "now"}
            while len(cl) > 3 and (bare(cl[-1]["word"]) in STOP - keep_end or re.search(r"'(ve|re|d|ll)$", bare(cl[-1]["word"]))) and not re.search(r"[.?!,]$", cl[-1]["word"]):
                cl = cl[:-1]  # trim a dangling tail ("the genre last of" -> "the genre last")
            if not (3 <= len(cl) <= 10) or cl[0]["take"] != cl[-1]["take"]:
                continue
            take = takes[cl[0]["take"]]
            nxt = ws[cl[-1]["i"] + 1]["start"] if cl[-1]["i"] + 1 < len(ws) else 1e9
            a, z = max(cl[0]["start"] - 0.05, take["a"]), min(cl[-1]["end"] + 0.15, take["b"], max(cl[-1]["end"], nxt - 0.02))
            if not (0.8 <= z - a <= 3.0):
                continue
            if len(" ".join(w["word"] for w in cl)) > BAR_CHARS * MAX_BARS:
                continue
            # an ASR slip typed big is the worst: every word must be a real word or a name said twice
            nb = bare(ws[cl[-1]["i"] + 1]["word"]) if cl[-1]["i"] + 1 < len(ws) else ""
            gap_after = ws[cl[-1]["i"] + 1]["start"] - cl[-1]["end"] if cl[-1]["i"] + 1 < len(ws) else 9
            gap_before = cl[0]["start"] - ws[cl[0]["i"] - 1]["end"] if cl[0]["i"] > 0 else 9
            # a clause cut out of running speech (no punctuation, no pause) mid-phrase: "with a golf | club", "us | revolutionized"
            clean = True
            if punct and not re.search(r"[.?!,;:]$", cl[-1]["word"]) and gap_after < 0.12 and nb not in STOP:
                clean = False
            if punct and cl[0]["i"] > 0 and not re.search(r"[.?!,;:]$", ws[cl[0]["i"] - 1]["word"]) and gap_before < 0.12 \
                    and bare(cl[0]["word"]) not in STOP and bare(ws[cl[0]["i"] - 1]["word"]) not in STOP:
                clean = False
            if not re.search(r"[.?!,;:]$", cl[-1]["word"]) and nb in ("is", "are", "was", "were", "has", "have", "had", "will", "would", "can", "could", "does", "do", "did", "of"):
                continue  # the clause's last word is the subject of what follows ("different people that vaccination | is ...")
            if bare(cl[-1]["word"]) in STOP - {"it", "them", "this", "that", "here", "there", "now"} and not re.search(r"[.?!,]$", cl[-1]["word"]):
                continue  # ends on a dangling function word ("lost his marbles or was")
            if any(not real_word(bare(w["word"])) and not ((lower_asr or re.sub(r"[^\w]", "", w["word"])[:1].isupper()) and counts.get(bare(w["word"]).strip("'"), 0) >= 2)
                   for w in cl if bare(w["word"]) and not re.search(r"\d", w["word"])):
                continue
            # the engine types every word that starts inside [a, z): it must be exactly this clause, and timings must be
            # real (whisper sometimes collapses a run of words onto one instant, which would type them all at once)
            inside = [w for w in ws if a - 0.05 <= w["start"] < z]
            if len(inside) != len(cl) or sum(1 for w in cl if w["end"] - w["start"] < 0.02 and w["start"] > a + 0.3) >= 2:
                continue
            if len(wrap(cl)) > MAX_BARS:
                continue
            engs = [engraving_of(cl, i) for i in range(len(cl))]
            keys = [w for w in cl if bigword_ok(w, counts) and len(bare(w["word"])) <= 14]
            cands.append({"a": round(a, 3), "z": round(z, 3), "cl": cl, "engs": [e for e in engs if e], "clean": clean,
                          "key": max(keys, key=key_score) if keys else None})

    pages = []

    def free(a, z, gap=PAGE_GAP):
        if a < hook_end + gap:
            return False
        return all(z + gap <= p["a"] or a >= p["z"] + gap for p in pages)

    used = set()
    for c in cands:  # 1) engraving pages wherever the object is literally said
        es = [e for e in c["engs"] if e not in used]
        if es and free(c["a"], c["z"]):
            used.add(es[-1]); pages.append({**c, "eng": es[-1]})
    # 2) word pages where the reel would go flat
    budget = MAX_COVER * runtime - sum(p["z"] - p["a"] for p in pages)
    t_first = ws[0]["start"] if ws else 0
    t_last = ws[-1]["end"] if ws else 0
    shown = set()
    while budget > 1.0:
        marks = sorted([hook_end if hook else t_first] + [p["a"] for p in pages] + [p["z"] for p in pages] + [t_last])
        gaps = sorted(((marks[i + 1] - marks[i], marks[i], marks[i + 1]) for i in range(0, len(marks) - 1)), reverse=True)
        added = False
        for g, ga, gz in gaps:
            if g < FLAT:
                break
            mid = (ga + gz) / 2
            opts = [c for c in cands if c["key"] and ga + 2.2 <= c["a"] and c["z"] <= gz - 2.2 and free(c["a"], c["z"], 2.2)
                    and stem(c["key"]["word"]) not in shown and key_score(c["key"]) >= 7.5]
            if not opts:
                continue
            # a clause cut mid-phrase out of running speech only when nothing whole is there
            c = max(opts, key=lambda c: key_score(c["key"]) - 0.4 * abs((c["a"] + c["z"]) / 2 - mid) + (6 if c["clean"] else 0))
            shown.add(stem(c["key"]["word"]))
            pages.append({**c, "eng": None}); budget -= c["z"] - c["a"]; added = True
            break
        if not added:
            break

    pages.sort(key=lambda p: p["a"])
    for gi, p in enumerate(pages):
        b = {"type": "scene", "kind": "cutout", "ground": GROUNDS[gi % len(GROUNDS)], "tilt": -3 if gi % 2 == 0 else 2.5,
             "at": p["a"], "to": p["z"], "barChars": BAR_CHARS, "maxBars": MAX_BARS}
        if p["eng"]:
            b["engraving"] = p["eng"]
        else:
            b["word"] = show(p["key"]["word"]).strip(",.!?;:\"'")
        b["_said"] = " ".join(w["word"] for w in p["cl"])
        beats.append(b)
    return spec, beats


def main():
    proj = Path(sys.argv[1]).resolve()
    spec, beats = plan(proj)
    for b in beats:
        txt = " / ".join(l["text"] for l in b.get("lines", [])) + (f'  (y {b.get("y")})' if b["type"] == "effect" else "")
        if b.get("kind") == "cutout":
            txt = f'{b["ground"]:<6} {("[" + b["engraving"] + "]") if b.get("engraving") else ("WORD " + b["word"])}  "{b["_said"]}"'
        print(f'{b["at"]:>7} -> {b["to"]!s:>7}  {b.get("kind", b["type"]):<8} {txt}')
    if "--dry" in sys.argv:
        return
    spec["beats"] = [b for b in spec.get("beats", []) if b.get("type") != "effect" and b.get("kind") != "cutout"] + beats
    (proj / "reel.json").write_text(json.dumps(spec, indent=2) + "\n")
    print(f"{len(beats)} beats -> {proj / 'reel.json'}")


if __name__ == "__main__":
    main()

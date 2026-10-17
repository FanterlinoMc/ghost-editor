#!/usr/bin/env python3
"""Mono planner: turn a reel's words + takes into a chain of `stack` pages (one per phrase), the way the
training #3 reference is cut. Writes the beats into reel.json (replacing any stack beats already there).

    mono_plan.py <project>            plan and write
    mono_plan.py <project> --dry      print the plan only

Rules (engine/templates/mono.md):
  - phrases break at punctuation, at pauses >= 0.35 s, at take joins, and at ~2.2 s / 9 words
  - every phrase becomes a page; pages butt against each other (no gaps, hard cuts)
  - the stack grows as it is spoken: small words (s) and 1-2 KEY words (k), the words after the last key (t, italic)
  - grounds rotate and never repeat back to back; a phrase that names a platform goes on the phone with its logo
  - accent/paper pages flip on the key and on the tail; concrete keys get an engraving icon
Every word on a page is a word spoken while the page is up.
"""
import json, re, sys
from pathlib import Path

STOP = set("""a an the and or but so to of in on at for with by from as is are was were be been being am i i'm im you
your we our they their he she it its this that these those there here do does did don't dont can can't will would
should could just really very like um uh yeah okay ok also then than now not no yes my me us them what which who
how when where why if because 'cause cause about into out up down over get got going gonna wanna want let's lets
have has had having more most some any all every thing things way lot making make made use using used getting
gets number one two three four five here was sure hope order kind able really collect need needs go goes went
said say says know think talking talk mean""".split())
# v5: words that are never a hero (contractions, auxiliaries, pronouns, vague verbs/adverbs/quantifiers). A key drawn
# huge must carry meaning on its own: "There's", "They've", "Doing" were picked in v4.
STOP |= set("""there's theres they've theyve that's thats it's what's whats who's here's heres where's i've ive you've
youve we've weve we're were you're youre they're theyre he's hes she's shes i'll you'll we'll they'll it'll i'd you'd
we'd they'd he'd she'd isn't aren't wasn't weren't don't doesn't didn't won't wouldn't can't couldn't shouldn't haven't
hasn't hadn't ain't let's him her his hers ours yours theirs myself yourself himself herself itself ourselves
themselves one's someone somebody something anything everything nothing anyone everyone anybody everybody stuff
doing done do does did being been gotten got get gets getting come comes came coming take takes took taking give
gives gave put puts putting see sees saw seen look looks looking tell tells told try tries tried trying keep keeps
kept seem seems seemed become becomes became find found start started went gone thank thanks
maybe actually basically literally probably definitely certainly obviously honestly totally pretty quite rather
even still much many well right back again only other others another same own through before after while until
since though although whether yet both each few such too around between under within without against during upon
onto toward towards across behind beyond along among per via ever already almost enough often sometimes usually
also anyway anyways whatever whenever wherever however therefore otherwise else instead perhaps indeed
sort kinda sorta lots bit bunch part piece side end times time's day's year's thing's people's
first second third last next new old good great big little small long short high low whole full real true
gonna gotta wanna hmm mm mhm ah oh huh hey yep nope might must may shall
called named telling saying asked several multiple particular possible different certain various likely cannot
involve involves involved include includes including mainly
went goes going says said tells""".split())
WEAK_SUFFIX = re.compile(r"(?:'s|'ve|'re|'ll|'d|n't|’s|’ve|’re|’ll|’d|n’t)$")
POWER = set("""money free never always best worst secret mistake fast faster growth scale win wins lose quality
quantity million billion profit revenue leads clients customers automation automations ai system results stop
truth simple easy hard business underrated overrated""".split())
ICONS = [
    (r"^(money|cash|revenue|profit|pay|paid|price|dollars?|income|sales?)$", "coins"),
    (r"^(idea|ideas|think|thinking|mind|brain|smart|learn)$", "brain"),
    (r"^(team|people|followers?|follows|audience|community|staff|hire|hiring)$", "team"),
    (r"^(growth|grow|scale|scaling|results?|numbers|data|metrics)$", "chart"),
    (r"^(fast|faster|quick|quickly|launch|speed|rocket)$", "rocket"),
    (r"^(time|hours?|minutes?|days?|wait|patience)$", "hourglass"),
    (r"^(goal|goals|target|focus|aim)$", "target"),
    (r"^(automate|automation|automations|system|systems|process|processes|workflow|workflows)$", "gears"),
    (r"^(ai|robot|robots|bot|bots|agent|agents)$", "robot"),
    (r"^(email|emails|inbox|mail)$", "mail"),
    (r"^(call|calls|phone|text|sms)$", "phone"),
    (r"^(win|wins|winning|best|champion|trophy)$", "trophy"),
    (r"^(deal|deals|clients?|customers?|partner|partners|trust)$", "handshake"),
    (r"^(search|find|research|look)$", "magnifier"),
    (r"^(plan|steps|list|checklist|tasks?)$", "checklist"),
    (r"^(calendar|schedule|week|month|monday)$", "calendar"),
    (r"^(chess|strategy|move|moves)$", "chess"),
    (r"^(ladder|climb|level|levels)$", "ladder"),
    (r"^(laptop|computer|software|code|app)$", "laptop"),
    (r"^(lightbulb|insight|creative)$", "lightbulb"),
]
LOGOS = {"youtube": ("youtube", "#FF0000"), "instagram": ("instagram", "#E4405F"), "tiktok": ("tiktok", "#ffffff"),
         "linkedin": ("linkedin", "#0A66C2"), "chatgpt": ("openai", "#ffffff"), "openai": ("openai", "#ffffff"),
         "claude": ("claude", "#D97757"), "google": ("google", "#ffffff"), "facebook": ("facebook", "#1877F2"),
         "twitter": ("x", "#ffffff"), "whatsapp": ("whatsapp", "#25D366"), "shopify": ("shopify", "#95BF47")}
KEY_MIN = 6           # v5: a best word scoring under this is not a hero; the phrase stays medium-bold
SAFE_TOP, SAFE_BOTTOM = 200, 1580   # reels safe area for the stack (bottom: caption/handle bar of the apps)
ROTATION = ["footage", "accent", "card", "footage", "phone", "paper", "footage", "accent"]
HOOK = 3.5            # seconds of opening burst: short pages, letter-built keys, punch-ins, pulses, flips on every word
HOOK_ROTATION = ["footage", "accent", "paper", "footage", "card", "accent"]


def mono_cfg(proj, spec: dict) -> dict:
    """The mono knobs, from the style card with the reel's own `mono` block layered over it.

    These were module constants until 2 Oct. The cap in particular was invisible and surprising:
    letter-built keys, pulses and flips only ever applied to the first HOOK seconds, so a reel
    looked energetic for 3.5 s and plain for the rest, with no way for a style to say otherwise.
    `burst: "all"` makes that reach the whole reel - measured on one 21 s reel as 17 built keys
    instead of 4.
    """
    cfg = {"hook": HOOK, "hookRotation": list(HOOK_ROTATION), "burst": "hook"}
    name = spec.get("style")
    # same id rule as scripts/lib/style-path.mjs; a "user:" style has no mono card (mono is not in the user allowlist)
    if isinstance(name, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name):
        card = Path(__file__).resolve().parent.parent / "styles" / f"{name}.json"
        if card.is_file():
            try:
                cfg.update(json.loads(card.read_text(encoding="utf-8")).get("mono") or {})
            except (ValueError, OSError):
                pass    # a broken style card is build.mjs's error to report, not the planner's
    cfg.update(spec.get("mono") or {})
    return cfg
FIX = {"ai": "AI", "i": "I", "i'm": "I'm", "i've": "I've", "i'll": "I'll", "i'd": "I'd", "ceo": "CEO", "chatgpt": "ChatGPT", "youtube": "YouTube", "tiktok": "TikTok",
       "linkedin": "LinkedIn", "instagram": "Instagram"}


try:
    DICT = {l.strip().lower() for l in open("/usr/share/dict/words")}
except OSError:
    DICT = set()


def known(b):
    """v5: is this a real dictionary word? A word whisper misheard (or a rare name it guessed: "McCoulton") must
    never be drawn huge. Plurals, -ed, -ing, -ly and hyphenated parts count."""
    if not DICT or b in DICT or b in LOGOS or b in FIX or re.search(r"\d", b):
        return True
    if "-" in b:
        return all(known(x) for x in b.split("-") if x)
    for suf, add in (("s", ""), ("es", ""), ("ies", "y"), ("ed", ""), ("ed", "e"), ("d", ""), ("ing", ""), ("ing", "e"),
                     ("ly", ""), ("er", ""), ("ers", ""), ("est", ""), ("ness", ""), ("ment", ""), ("ments", ""), ("'s", "")):
        if b.endswith(suf) and len(b) - len(suf) >= 3:
            st = b[: len(b) - len(suf)] + add
            if st in DICT or (suf in ("ed", "ing") and len(st) > 3 and st[-1] == st[-2] and st[:-1] in DICT):
                return True
    return False


def bare(w):
    return re.sub(r"[^\w']+", "", w.lower())


def show(w):
    b = bare(w)
    return w.replace(b, FIX[b]) if b in FIX and b in w.lower() else w


def load_words(proj, spec):
    d = json.loads((proj / spec.get("words", "build/words.whisper.json")).read_text())
    ws = [w for s in d["segments"] for w in s["words"]] if isinstance(d, dict) else d
    takes = spec["takes"]
    out = []
    for w in ws:
        mid = (w["start"] + w["end"]) / 2
        ti = next((i for i, k in enumerate(takes) if k["a"] - 0.02 <= mid <= k["b"] + 0.02), None)
        if ti is not None and w["word"].strip():
            out.append({"word": w["word"].strip(), "start": max(w["start"], takes[ti]["a"]), "end": min(w["end"], takes[ti]["b"]), "take": ti})
    return out, takes


def phrases(ws):
    out, cur = [], []
    for i, w in enumerate(ws):
        cur.append(w)
        nxt = ws[i + 1] if i + 1 < len(ws) else None
        dur = w["end"] - cur[0]["start"]
        brk = (nxt is None or re.search(r"[.?!,;:]$", w["word"]) or nxt["take"] != w["take"]
               or nxt["start"] - w["end"] >= 0.35 or dur >= 2.2 or len(cur) >= 9)
        if brk:
            out.append(cur); cur = []
    merged = []
    for p in out:  # too short to read alone: ride with the next phrase (same take only)
        if merged and (merged[-1][-1]["end"] - merged[-1][0]["start"] < 0.55 or len(merged[-1]) < 2) and merged[-1][-1]["take"] == p[0]["take"] and len(merged[-1]) + len(p) <= 10:
            merged[-1] = merged[-1] + p
        else:
            merged.append(p)
    return merged


def hook_split(ps, t_end):
    """Inside the hook, cut phrases into pages of <= 3 words (<= 0.9 s) so the opening moves fast."""
    out = []
    for p in ps:
        if p[0]["start"] >= t_end:
            out.append(p); continue
        cur = []
        for w in p:
            if cur and (len(cur) >= 3 or w["end"] - cur[0]["start"] > 0.9) and any(score(x) for x in cur):
                out.append(cur); cur = []
            cur.append(w)
        if cur:
            if out and out[-1][-1]["take"] == cur[0]["take"] and not any(score(x) for x in cur) and out[-1][0]["start"] < t_end:
                out[-1] = out[-1] + cur
            else:
                out.append(cur)
    return out


def score(w):
    b = bare(w["word"])
    if not b or b in STOP or (WEAK_SUFFIX.search(b) and b not in POWER) or not known(b):
        return 0
    if len(b) < 3 and not (re.search(r"\d", b) and len(b) >= 2) and b not in ("ai", "ok"):
        return 0  # a lone digit ("Sky 1", "halo 1") is part of a name, not a hero
    if b.endswith("ly") and b not in POWER:  # "Particularly", "Hopefully": adverbs are weak heroes
        return max(1, len(b) - 6)
    if len(b) < 4 and b not in POWER and b not in LOGOS and not re.search(r"\d", b):  # "man", "big": rarely a hero
        return 2
    return len(b) + (6 if b in POWER else 0) + (4 if re.search(r"\d", b) else 0) + (5 if b in LOGOS else 0) + (w["end"] - w["start"]) * 4


def lines_for(p, recent=()):
    # v5: a word that was the hero of one of the last two pages is a weaker hero again ("Combat" x4 in a row)
    sc = [max(0, score(w) - (5 if bare(w["word"]) in recent else 0)) if score(w) else 0 for w in p]
    content = [i for i in range(len(p)) if sc[i] > 0]
    if content:
        sc[content[-1]] += 3  # the punchline sits at the end of the phrase
    if max(sc) < KEY_MIN:  # nothing to punch: the phrase stays small (reference: "I don't", "And I")
        return mid_lines(p), []
    k1 = max(range(len(p)), key=lambda i: sc[i])
    keys = {k1}
    if len(p) >= 6:  # a second key in the other half (reference: "Don't want" ... "idea")
        other = [i for i in range(len(p)) if abs(i - k1) >= 3 and sc[i] >= 7]
        if other:
            keys.add(max(other, key=lambda i: sc[i]))
    last_k = max(keys)
    out, buf = [], []

    def flush(role):
        # 4+ filler words would sit small for too long: draw them medium-bold, three words a line
        if len(buf) >= 4:
            out.extend({"text": t, "role": "m"} for t in balanced(buf))
        elif buf:
            out.append({"text": " ".join(buf), "role": role})
        buf.clear()

    for i, w in enumerate(p):
        if i in keys:
            flush("s")
            word = show(w["word"]).rstrip(",;:.!?…\"'”’")
            out.append({"text": word[:1].upper() + word[1:], "role": "k", "say": bare(w["word"])})
        else:
            buf.append(show(w["word"]))
    flush("t" if last_k < len(p) - 1 else "s")
    return out, [p[k] for k in sorted(keys)]


def icon_for(keys):
    for w in keys:
        b = bare(w["word"])
        for rx, name in ICONS:
            if re.match(rx, b):
                return name
    return None


def nxt_is_last(n, ps):
    return n == len(ps) - 1


def balanced(tokens, per=3):
    """Even lines of <= per words: 4 -> 2+2, 5 -> 3+2, 7 -> 3+2+2 (no lonely last word)."""
    n = -(-len(tokens) // per)
    base, extra = divmod(len(tokens), n)
    out, i = [], 0
    for k in range(n):
        m = base + (1 if k < extra else 0)
        out.append(" ".join(tokens[i:i + m])); i += m
    return out


def mid_lines(words_):
    """A phrase with nothing to punch: medium-bold, three words a line (reference: 'I don't' / 'wanna be' pages)."""
    return [{"text": t, "role": "m"} for t in balanced([show(w["word"]) for w in words_])]


def merge_slivers(ps):
    """A page under 0.4 s cannot be read: it rides with the shorter neighbour in the same take."""
    ps = [list(p) for p in ps]
    i = 0
    while i < len(ps):
        p = ps[i]
        if p[-1]["end"] - p[0]["start"] >= 0.4 or len(ps) == 1:
            i += 1; continue
        prev_ok = i > 0 and ps[i - 1][-1]["take"] == p[0]["take"]
        next_ok = i + 1 < len(ps) and ps[i + 1][0]["take"] == p[-1]["take"]
        if prev_ok and (not next_ok or len(ps[i - 1]) <= len(ps[i + 1])):
            ps[i - 1] += p; del ps[i]
        elif next_ok:
            ps[i + 1] = p + ps[i + 1]; del ps[i]
        else:
            i += 1
    return ps


def merge_weak(ps):
    """v5: a page with nothing to punch and only 1-2 words ("there", "and I") reads as an empty page: it rides with a
    neighbour in the same take (the shorter one), if the joined page stays readable (<= 11 words, <= 3.4 s)."""
    ps = [list(p) for p in ps]
    changed = True
    while changed:
        changed = False
        for i, p in enumerate(ps):
            if len(ps) == 1 or len(p) > 2 or max(score(w) for w in p) >= KEY_MIN:
                continue
            def ok(j):
                return len(ps[j]) + len(p) <= 11 and max(ps[j][-1]["end"], p[-1]["end"]) - min(ps[j][0]["start"], p[0]["start"]) <= 4.6
            near = [j for j in (i - 1, i + 1) if 0 <= j < len(ps) and ok(j)]
            same = [j for j in near if (ps[j][-1]["take"] == p[0]["take"] if j < i else ps[j][0]["take"] == p[-1]["take"])]
            # a lone word in its own take (a jump cut on "me", "and"): ride across the join with the closer page;
            # such a page is never a card/phone (their film would play through the cut)
            cands = same or sorted(near, key=lambda j: abs((ps[j][-1]["end"] if j < i else ps[j][0]["start"]) - (p[0]["start"] if j < i else p[-1]["end"])))[:1]
            if not cands:
                continue
            j = min(cands, key=lambda j: len(ps[j]))
            ps[j] = (ps[j] + p) if j < i else (p + ps[j])
            del ps[i]
            changed = True
            break
    return ps


def load_style(name, _depth=0):
    """A style card with its `extends` chain applied (mono-2 extends mono: the sizes and zoom live on the base). Shallow-merges
    each top-level object, like build.mjs does for the keys this planner reads (brand, zoom). Unknown / broken card -> {}."""
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name) or _depth > 4:
        return {}
    sp = Path(__file__).resolve().parent.parent / "styles" / f"{name}.json"
    try:
        card = json.loads(sp.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    base = load_style(card.get("extends"), _depth + 1) if card.get("extends") else {}
    out = dict(base)
    for k, v in card.items():
        out[k] = {**base[k], **v} if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


class Face:
    """The speaker's face box (face.json, source px) mapped to the screen through #base (zoom.base around zoom.origin)."""

    def __init__(self, proj, spec):
        self.samples = []
        f = proj / spec.get("face", "build/face.json")
        if f.exists():
            last = None
            for smp in json.loads(f.read_text())["samples"]:
                if smp[1] is not None:
                    last = smp
                    self.samples.append(smp)
        style = load_style(spec.get("style", "mono"))
        z = {**style.get("zoom", {}), **spec.get("zoom", {})}
        self.brand = {**style.get("brand", {}), **spec.get("brand", {})}
        self.base = float(z.get("base", 1))
        org = str(z.get("origin", "50% 29%")).split()
        self.ox, self.oy = float(org[0].rstrip("%")) / 100 * 1080, float(org[1].rstrip("%")) / 100 * 1920
        self.origin = z.get("origin", "50% 29%")

    def window(self, a, b):
        ss = [x for x in self.samples if a - 0.1 <= x[0] <= b + 0.1]
        if not ss and self.samples:
            ss = [min(self.samples, key=lambda x: abs(x[0] - a))]
        return ss

    def bottom(self, a, b, scale=1.0, raw=False):
        """lowest screen y of the face (chin, hair box) while the page is up, at the given extra punch scale"""
        ss = self.window(a, b)
        if not ss:
            return None
        bots = sorted(x[2] for x in ss)
        bot = bots[min(len(bots) - 1, int(len(bots) * 0.9))]
        if raw:
            return bot
        k = self.base * scale
        return self.oy + (bot - self.oy) * k

    def height(self, a, b):
        ss = self.window(a, b)
        if not ss:
            return None
        hs = sorted(x[2] - x[1] for x in ss)
        return hs[len(hs) // 2]

    def centre(self, a, b):
        ss = self.window(a, b)
        if not ss:
            return None
        xs = sorted((x[3] + x[4]) / 2 for x in ss)
        # eyes/mouth midpoint (the grown box is clipped by the frame top in close-ups, its centre sits too low/high)
        ys = sorted((x[5] + x[6]) / 2 if len(x) > 6 else (x[1] + x[2]) / 2 for x in ss)
        return [round(xs[len(xs) // 2]), round(ys[len(ys) // 2])]


BRAND = {}   # the style's brand sizes (loaded by plan)


def est_height(ls, key_max=240, icon=False):
    """mirror of motion.mjs's stack height estimate (lead, mid 96, tail, key min(keyMax, 1640/len))"""
    h = 0
    for l in ls:
        if l["role"] == "k":
            h += min(key_max, round(1640 / max(4, len(l["text"])))) * 0.92
        elif l["role"] == "m":
            h += BRAND.get("midSize", 96) * 1.04
        elif l["role"] == "t":
            h += BRAND.get("tailSize", 46) * 1.4
        else:
            h += l.get("size", BRAND.get("leadSize", 56)) * 1.08
    return h + (240 if icon else 0)


def compact(ls):
    """medium-bold filler lines (3 words, 96 px) -> small lines (up to 5 words): about half the height"""
    out, buf = [], []
    for l in ls + [None]:
        if l is not None and l["role"] == "m":
            buf.extend(l["text"].split()); continue
        if buf:
            out.extend({"text": t, "role": "s"} for t in balanced(buf, 5)); buf = []
        if l is not None:
            out.append(l)
    return out


def place_on_footage(b, face, a, t_end):
    """v5: keep the words off the face. The stack goes under the chin (engine default top 760-1080 sat on the mouth in
    close-ups); if it does not fit above the apps' bottom bar the keys shrink (not under 150 px) and the icon goes;
    still no room -> None (the caller moves the page to a card)."""
    scale = 1.28 if b.get("punch") else 1.0
    bot = face.bottom(a, t_end, scale)
    icon = bool(b.get("icon"))
    est = est_height(b["lines"], 240, icon)
    default = max(760, min(1080, 1460 - est))
    if bot is None:
        return True
    top = max(default, bot + 36)
    if top + est <= SAFE_BOTTOM:
        b["y"] = round(top)
        return True
    if any(l["role"] == "m" for l in b["lines"]):
        b["lines"] = compact(b["lines"])
        est = est_height(b["lines"], 240, icon)
        if max(default, bot + 36) + est <= SAFE_BOTTOM:
            b["y"] = round(max(default, bot + 36))
            return True
    for km in (200, 170, 150):
        for ic in ((True, False) if icon else (False,)):
            e = est_height(b["lines"], km, ic)
            if bot + 36 + e <= SAFE_BOTTOM:
                b["keyMax"] = km
                if not ic:
                    b.pop("icon", None)
                b["y"] = round(bot + 36)
                return True
    # v5: an extreme close-up: the shot shrinks from the top edge (b.fit, over a blurred copy) so the chin clears the
    # stack; not below 0.72 (smaller reads as a mistake). Punch-ins are off on such a page.
    raw = face.bottom(a, t_end, 1.0, raw=True)
    e = est_height(b["lines"], 200, False)
    fit = (SAFE_BOTTOM - 36 - e) / raw if raw else 0
    if fit >= 0.72:
        b["fit"] = round(min(0.95, fit), 3)
        b["keyMax"] = 200
        b.pop("icon", None); b.pop("punch", None); b.pop("tilt", None); b.pop("punchOrigin", None)
        b["y"] = round(raw * b["fit"] + 36)
        return True
    return None


PAUSE_CUT = 1.0   # v5: a silence longer than this inside a take (applause, a long think) is cut out


def tighten_takes(proj, spec):
    """v5: dead air out. Split takes at silences > PAUSE_CUT, trim each take to its words (0.3 s before the first,
    0.5 s after the last), drop takes with no words. Pages already cut at take joins, so the jump hides in a page cut."""
    d = json.loads((proj / spec.get("words", "build/words.whisper.json")).read_text())
    ws = [w for s in d["segments"] for w in s["words"]] if isinstance(d, dict) else d
    ws = [w for w in ws if w["word"].strip()]
    out = []
    for k in spec["takes"]:
        inside = [w for w in ws if k["a"] - 0.02 <= (w["start"] + w["end"]) / 2 <= k["b"] + 0.02]
        if not inside:
            continue
        a = max(k["a"], inside[0]["start"] - 0.3)
        for w, nx in zip(inside, inside[1:] + [None]):
            if nx is None:
                out.append({**k, "a": round(a, 3), "b": round(min(k["b"], w["end"] + 0.5), 3)})
            elif nx["start"] - w["end"] > PAUSE_CUT:
                out.append({**k, "a": round(a, 3), "b": round(w["end"] + 0.3, 3)})
                a = nx["start"] - 0.25
    spec["takes"] = out or spec["takes"]


def plan(proj):
    spec = json.loads((proj / "reel.json").read_text())
    if not spec.get("keepTakes"):
        tighten_takes(proj, spec)
    ws, takes = load_words(proj, spec)
    ps = phrases(ws)
    cfg = mono_cfg(proj, spec)
    hook_end = (ws[0]["start"] if ws else 0) + float(cfg["hook"])
    ps = hook_split(ps, hook_end)
    ps = merge_slivers(ps)
    ps = merge_weak(ps)
    face = Face(proj, spec)
    BRAND.update(face.brand)
    beats, prev, ri, hi = [], None, 0, 0
    want_phone = False   # v5: a phone the rotation asked for but the page could not hold waits for a page that can
    for n, p in enumerate(ps):
        recent = {l.get("say") for x in beats[-2:] for l in x["lines"] if l["role"] == "k"}
        ls, keys = lines_for(p, recent)
        logo = next((LOGOS[bare(w["word"])] for w in p if bare(w["word"]) in LOGOS), None)
        hook = p[0]["start"] < hook_end
        if logo:
            ground = "phone"
        elif hook:
            ground = cfg["hookRotation"][hi % len(cfg["hookRotation"])]; hi += 1
            if ground == prev:
                ground = cfg["hookRotation"][hi % len(cfg["hookRotation"])]; hi += 1
        else:
            ground = ROTATION[ri % len(ROTATION)]; ri += 1
            if ground == prev:
                ground = ROTATION[ri % len(ROTATION)]; ri += 1
        if nxt_is_last(n, ps) and ground == "footage":  # close on a designed page, never on bare footage
            ground = "paper" if prev == "accent" else "accent"
        fk = next((i for i, l in enumerate(ls) if l["role"] == "k"), len(ls))
        fits_phone = fk <= 1 and len(ls) - fk <= 2 and p[0]["take"] == p[-1]["take"]
        if want_phone and not hook and fits_phone and ground in ("accent", "paper") and prev != "phone":
            ground, want_phone = "phone", False
        if ground == "phone" and not logo and not fits_phone:
            want_phone = True
        if ground == "phone" and (fk > 1 or len(ls) - fk > 2):
            # v5: the phone leaves room for one line above it (top 230-360) and two below (the key + a tail)
            if logo and fk > 1:
                ls[:fk] = [{"text": " ".join(l["text"] for l in ls[:fk]), "role": "s"}]
            if not logo or len(ls) - fk > 2 or len(ls[0]["text"].split()) > 6:
                ground = "accent" if prev != "accent" else "paper"
        if ground in ("card", "phone") and p[0]["take"] != p[-1]["take"]:  # the film would play through the jump cut
            ground = "accent" if prev != "accent" else "paper"
        # pages butt together: a page starts at its take start or its first word, ends where the next begins
        at = takes[p[0]["take"]]["a"] if (n == 0 or ps[n - 1][-1]["take"] != p[0]["take"]) else p[0]["start"] - 0.04
        nxt = ps[n + 1] if n + 1 < len(ps) else None
        to = "end" if nxt is None else (takes[p[-1]["take"]]["b"] if nxt[0]["take"] != p[-1]["take"] else round(nxt[0]["start"] - 0.04, 3))
        b = {"type": "scene", "kind": "stack", "bg": ground, "at": round(max(0, at), 3), "to": to, "lines": ls}
        if ground in ("accent", "paper") and keys:
            flips = [round(keys[0]["start"] - 0.02, 3)]
            tail_w = [w for w in p if w["start"] > keys[-1]["end"]]
            if tail_w: flips.append(round(tail_w[0]["start"] - 0.02, 3))
            b["flips"] = flips
        ic = icon_for(keys)
        if logo:
            b["logo"], b["logoFill"] = logo
        elif ic and n > 0 and ground != "card" and not any(x.get("icon") == ic for x in beats[-2:]):
            b["icon"] = ic
        if ground == "footage" and n == 0:
            for l in ls:
                if l["role"] == "k": l["color"] = "#5FBF8F"; break
        if ground == "footage" and n > 0 and n % 3 == 1:
            for l in ls:
                if l["role"] == "k": l["enter"] = "rise"; break
        if ground == "accent" and len([l for l in ls if l["role"] == "k"]) == 2:
            ki = [i for i, l in enumerate(ls) if l["role"] == "k"][-1]
            if ls[ki - 1]["role"] == "k":   # v5: the ring would cross a small line squeezed above the key
                ls[ki]["ring"] = True
        if hook or cfg.get("burst") == "all":
            kl = [l for l in ls if l["role"] == "k"]
            for j, l in enumerate(kl):
                l["enter"] = "letters" if (n + j) % 2 == 0 else l.get("enter", "ghost")
                l["pulse"] = True
            if ground == "footage":
                b["punch"] = True; b["tilt"] = -2 if n % 2 else 2
            else:
                b["push"] = True
            if ground in ("accent", "paper"):  # flip on every spoken word of the hook
                b["flips"] = [round(w["start"] - 0.02, 3) for w in p[1:]][:4]
            if not b.get("icon") and not b.get("logo") and ic:
                b["icon"] = ic
        t_end = p[-1]["end"] if to == "end" else to
        if ground == "footage":
            if b.get("punch"):
                b["punchOrigin"] = face.origin
            if place_on_footage(b, face, b["at"], t_end) is None:
                # a close-up leaves no room under the chin: the page becomes a card (the face, smaller, framed)
                ground = b["bg"] = "card" if prev != "card" and p[0]["take"] == p[-1]["take"] else ("accent" if prev != "accent" else "paper")
                b.pop("punch", None); b.pop("tilt", None); b.pop("punchOrigin", None); b.pop("y", None); b.pop("keyMax", None)
                b["lines"] = ls   # the uncompacted stack: pages have room
                if ground == "card": b.pop("icon", None)   # an icon would hang over the card's bottom edge
                for l in ls:
                    if l.get("enter") == "rise": l["enter"] = "ghost"
                if ground in ("accent", "paper") and keys:
                    b["flips"] = [round(keys[0]["start"] - 0.02, 3)]
                    if hook: b["push"] = True
        if ground in ("card", "phone"):
            b["handle"] = spec.get("handle", "yourname")
            fc = face.centre(b["at"], t_end)
            if fc: b["filmFace"] = fc
            fh = face.height(b["at"], t_end)
            if ground == "card":
                # v5: the words start UNDER the card (engine default overlaps its bottom by 60 px, which put small lead
                # words over the picture); a tall stack makes the card shorter so the stack ends in the safe area
                est = est_height(b["lines"], 240, bool(b.get("icon")))
                card_h = max(560, min(900, 1500 - est - 280))
                if b["lines"][0]["role"] != "k":
                    if 330 + card_h + 24 + est > SAFE_BOTTOM:
                        card_h = int(max(420, SAFE_BOTTOM - est - 24 - 330))
                    b["cardH"] = card_h
                    b["y"] = 330 + card_h + 24
            if ground == "card" and fh:
                # a close-up face is taller than a short card: narrow the card (portrait) so the whole head fits
                w = int(max(800, min(940, 1080 * 0.95 * card_h / fh)))
                if w < 940: b["cardW"] = w
        beats.append(b); prev = ground
    return spec, beats


def main():
    proj = Path(sys.argv[1]).resolve()
    spec, beats = plan(proj)
    for b in beats:
        print(f'{b["at"]:>6} -> {b["to"]!s:>6}  {b["bg"]:<8} ' + " | ".join(f'{l["role"]}:{l["text"]}' for l in b["lines"]) + (f'  [{b.get("icon") or b.get("logo", [""])}]' if b.get("icon") or b.get("logo") else ""))
    if "--dry" in sys.argv:
        return
    spec["beats"] = [b for b in spec.get("beats", []) if b.get("kind") != "stack"] + beats
    (proj / "reel.json").write_text(json.dumps(spec, indent=2) + "\n")
    print(f"{len(beats)} pages -> {proj / 'reel.json'}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Folio planner (style editorial-collage): plan a reel from its transcript, deterministically, no API key.

    folio_plan.py <project>          plan and write reel.json (takes, page beats, the slam)
    folio_plan.py <project> --dry    print the plan only

What the AI director decides for this template (engine/templates/editorial-collage.md, the style's `director`
notes), done here by rule:
  - cuts: dead air tightened to a short breath, only where the AUDIO is quiet (whisper word times drift), and long
    non-speech stretches (applause, a lull) dropped; the take never opens on silence
  - pages: the hook page 2-4 s in, then about one every 10-15 s, 1.6-3 s each, the speaker back between them.
    Each page = 2-3 short lines in the speaker's own words, spoken WHILE the page is up, each line landing on its
    first word: a serif lead-in, THE key phrase in the brand box (exactly one), a tail (serif, caps connector or a
    marker aside for a contrast / question). One engraving per page that says what the idea is; never repeated.
  - the slam: once, on the most charged word (a verdict, money/time word, number, call to action), 1.4-1.8 s
Everything else (name tag, number cards, logos, object pop-ups, captions, sound, music drops) is the engine's.
"""
import json, re, subprocess, sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent
BY = "folio"

STOP = set("""a an the and or but so to of in on at for with by from as is are was were be been being am i i'm im you
your you're youre we we're our they they're their them he he's she she's her him his it it's its this that that's these
those there there's here here's do does did don't dont doesn't didn't can can't cannot will won't would wouldn't should
could just really very like um uh yeah okay ok also then than now not no yes my me us what what's which who whose how
when where why if because 'cause cause about into out up down over get got going gonna wanna want let's lets have has
had having more most some any all every thing things way lot lots make made use using used gets go goes went said say
says know think mean kind sort bit little well even still actually maybe much many one ones too own off back again
there've who've they've we've you've i've i'd you'd we'd they'd i'll you'll we'll they'll it'll gotta need needs
while during each other another both either such same able sure right come comes came take takes took give gives
gave put puts yourself myself himself herself itself ourselves yourselves themselves before after since ago within across through around between against among toward towards upon
behind beyond under above below inside outside along via per sometimes often usually probably definitely basically
literally especially obviously simply already almost quite rather perhaps there's here's somewhere anyway something anything everything nothing someone anyone everyone people's kinda yet ever only""".split())
FILLER = set("um uh erm er hmm mm ah oh".split())
# content words too vague to carry a page or a slam on their own
WEAK = set("""coming come doing done getting looking saying talking tell told told trying try tried happen happens
happened start started looks seems seemed feel felt keep kept call called mean means meant pretty great good bad
lot big small really first second last next place part point side case fact stuff yeah alright course whole
different certain several today going went other others things everything something anything""".split())
PROFANE = set("shit fuck fucking fucked bitch damn ass asshole crap bullshit dick piss hell".split())
# common verbs: they end a noun phrase, never the key on their own
VERBS = set("""tend tends talk talks became become becomes want wants wanted need needed get make makes go see saw seen
look feel give keep put said told help helps helped take tell call try use uses work works worked love loved like likes
liked let lets bring brings brought show shows showed find run runs ran pass hang decided decide gonna wanna gotta
continue push sit stand move happen happens seem seems ask asked asks start starts stop stops""".split())
CLAUSE = set("and but so because that which who when where if or then while after before until since though although".split())
# a verdict, money / time word, a number, a call to action: what the slam and the key box look for
POWER = set("""money free never always best worst secret mistake mistakes wrong fast faster growth scale win wins lose
loss quality million millions billion billions profit revenue leads clients customers automation ai system results stop
truth simple easy hard business underrated overrated dangerous critical important essential everything nothing
biggest huge massive forever impossible guaranteed proven safe unsafe pain fear failure fail success successful
death die dead love hate problem problems solution answer cost costs price expensive cheap save saves saving double
triple percent zero hundred thousand future change changes changed power powerful brain health healthy risk risks
crazy insane incredible amazing beautiful perfect broken""".split())
CTA = set("follow comment subscribe share save dm start build join try download sign book".split())
CONTRAST = set("not never no without instead don't dont can't cannot won't isn't aren't wasn't nobody".split())
NUMWORD = set("two three four five six seven eight nine ten eleven twelve fifteen twenty thirty forty fifty hundred thousand million billion half double triple".split())
# engraving concepts (engine/core/library/engravings/png): the first match over the key phrase, then the page
CONCEPTS = [
    (r"^(money|cash|revenue|profits?|dollars?|income|costs?|price|prices|pay|paid|paying|budget|funds?|funding|fees?|salary|wealth|rich|cheap|expensive|\$.*)$", "coins"),
    (r"^(save|saves|saved|savings|invest|investing|investment|bank|tax|taxes|economy|economic|financial|finance)$", "moneybag"),
    (r"^(time|hours?|minutes?|seconds?|timeline|fast|faster|quickly|quick|slow|slowly|late|early|wait|waiting|patience|patient|patients|years?|long|forever)$", "hourglass"),
    (r"^(today|tonight|morning|night|deadline|clock|watch)$", "watch"),
    (r"^(day|days|daily|week|weeks|weekly|month|months|monthly|calendar|schedule|scheduled|date|season|summer|winter|appointment|appointments|visit|visits|20\d\d)$", "calendar"),
    (r"^(ai|robot|robots|bots?|agents?|machine|machines|automated|chatgpt|technology|tech)$", "robot"),
    (r"^(system|systems|process|processes|workflows?|automations?|automate|engine|engineering|mechanism|operations?|works|working|machine|order|steps?|method|methods)$", "gears"),
    (r"^(idea|ideas|creative|creativity|insight|insights|inspiration|inspired|discover|discovered|discovery|invent|invented|innovation|new|imagine)$", "lightbulb"),
    (r"^(think|thinking|thought|thoughts|mind|minds|mindset|knowledge|expert|expertise|learn|learning|learned|brain|smart|memory|remember|understand|understanding|science|research|study|studies|education|school|teach|teaching|teacher|students?|mental)$", "brain"),
    (r"^(find|finding|found|search|searching|look|looking|audit|analyze|analyse|analysis|check|checking|test|testing|tests|detect|diagnose|diagnosis|evidence|data|examine|exam|investigate|problems?|issues?|questions?)$", "magnifier"),
    (r"^(team|teams|employees?|staff|people|folks|community|family|families|kids?|children|parents?|friends?|everyone|everybody|public|crowd|audience|followers|members?|providers?|nurses?|doctors?|physicians?|clinicians?|neighbors?|population|society|group|groups|country|nation|state)$", "team"),
    (r"^(clients?|customers?|deals?|partners?|partnership|together|trust|agreement|relationships?|support|help|helping|helped|care|caring|thank|thanks|grateful|welcome)$", "handshake"),
    (r"^(grow|growth|growing|scale|scaling|results?|increase|increased|increasing|numbers|metrics|statistics|percent|rate|rates|more|higher|rise|rising|progress|improve|improved|improvement|better)$", "chart"),
    (r"^(goals?|targets?|focus|aim|purpose|mission|vision|plan|plans|strategy|strategic|decide|decision|decisions|choice|choices|choose)$", "target"),
    (r"^(chess|move|moves|game|games|compete|competition|competitors?|tactics?|position|positions)$", "chess"),
    (r"^(launch|launching|rocket|start|started|starting|begin|beginning|takeoff|big|huge|massive|explode|boost)$", "rocket"),
    (r"^(win|wins|winning|won|best|success|successful|award|awards|champion|victory|achieve|achievement|proud|great)$", "trophy"),
    (r"^(tasks?|todo|checklist|list|lists|recommend|recommendation|recommended|rules?|guidelines?|instructions?|policy|requirements?|routine|steps)$", "checklist"),
    (r"^(phone|phones|calls?|call|text|texts|message|messages|talk|talking|conversation|conversations|speak|speaking|voice|ask|asking|tell|telling)$", "phone"),
    (r"^(email|emails|inbox|mail|letter|letters|outreach|newsletter|send|sent|write|writing|wrote|news)$", "mail"),
    (r"^(computer|computers|laptop|software|app|apps|website|online|internet|digital|code|coding|screen|platform|tools?)$", "laptop"),
    (r"^(climb|climbing|level|levels|career|ladder|step|higher|up|promotion|journey|path|next)$", "ladder"),
    (r"^(you|yourself|point|pointing|hand|hands|choose|pick|vote|raise)$", "hand"),
]
FALLBACK_ENGRAVINGS = ["lightbulb", "magnifier", "hand", "target", "brain", "checklist", "team", "chart"]
FIX = {"ai": "AI", "i": "I", "i'm": "I'm", "i'd": "I'd", "i'll": "I'll", "i've": "I've", "ceo": "CEO", "ceos": "CEOs",
       "chatgpt": "ChatGPT", "youtube": "YouTube", "tiktok": "TikTok", "linkedin": "LinkedIn", "instagram": "Instagram",
       "hpv": "HPV", "usa": "USA", "us": "us"}

HOOK_A, HOOK_B = 1.3, 4.2        # edit seconds: the hook page lands here
EVERY_A, EVERY_B = 9.5, 15.0      # page start to page start
MIN_SPEAKER = 4.0                 # seconds of speaker between two pages
PAGE_MIN, PAGE_MAX = 1.6, 3.0
LINE_CHARS = 16                   # a page line longer than this shrinks below a phone-readable size


def bare(w):
    return re.sub(r"[^\w'$%-]+", "", w.lower()).strip("-'")


def show(w, initial=True):
    """the word as it goes on paper: punctuation off, sentence-start capitals down, acronyms and names kept"""
    core = re.sub(r"^[^\w$]+|[^\w%]+$", "", w)
    b = core.lower()
    if b in FIX:
        return FIX[b]
    if len(core) > 1 and core.isupper():
        return core
    return core[0].lower() + core[1:] if core and initial else core


def load(proj):
    reel = json.loads((proj / "reel.json").read_text())
    d = json.loads((proj / reel.get("words", "build/words.whisper.json")).read_text())
    ws = [w for s in d["segments"] for w in s.get("words", [])] if isinstance(d, dict) else d
    words = []
    for w in ws:
        t = w["word"].strip()
        if t:
            words.append({"word": t, "start": float(w["start"]), "end": max(float(w["end"]), float(w["start"]) + 0.02)})
    return reel, words


# ---------------------------------------------------------------------------------------------- cuts
def silences(src, mn=0.25):
    """quiet stretches from the audio, adaptive threshold (prep levels the voice, which lifts the room noise too)"""
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    y = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    hop = 320
    n = len(y) // hop
    if n < 10:
        return [], None
    fr = y[: n * hop].reshape(n, hop)
    db = 20 * np.log10(np.sqrt((fr ** 2).mean(axis=1)) + 1e-9)
    floor, speech = np.percentile(db, 8), np.percentile(db, 80)
    quiet = db < floor + 0.32 * (speech - floor)
    out, k = [], 0
    while k < n:
        if quiet[k]:
            j = k
            while j < n and quiet[j]:
                j += 1
            if (j - k) * 0.02 >= mn:
                out.append((k * 0.02, j * 0.02))
            k = j
        else:
            k += 1
    return out, db


def tighten(takes, words, sil):
    """split each take at real pauses (keep a short breath), drop long word-less stretches, trim the ends"""
    KEEP, PAUSE = 0.16, 0.55
    out = []
    for t in takes:
        a, b = t["a"], t["b"]
        tw = [w for w in words if a - 0.05 <= (w["start"] + w["end"]) / 2 <= b + 0.05]
        if not tw:
            continue
        cuts = []
        for s0, s1 in sil:
            c0, c1 = max(a, s0 + KEEP), min(b, s1 - KEEP)
            if s1 - s0 < PAUSE or c1 - c0 < 0.25:
                continue
            if any(c0 < (w["start"] + w["end"]) / 2 < c1 for w in tw):
                continue                                   # a word lives there: whisper and the audio disagree, keep it
            cuts.append((c0, c1))
        # long gaps between words that are not quiet (applause, music, a lull with room noise)
        for p, q in zip(tw, tw[1:]):
            if q["start"] - p["end"] >= 1.3:
                cuts.append((p["end"] + 0.3, q["start"] - 0.25))
        # never open on silence / never trail off
        lead_to = tw[0]["start"] - 0.22
        for s0, s1 in sil:
            if s0 <= a + 0.05 < s1:
                lead_to = min(lead_to, s1 - 0.12)
        if lead_to > a + 0.15:
            cuts.append((a, max(a, lead_to)))
        tail_from = tw[-1]["end"] + 0.3
        for s0, s1 in sil:
            if s0 < b - 0.05 <= s1:
                tail_from = max(tail_from, s0 + 0.12)
        if tail_from < b - 0.15:
            cuts.append((min(b, tail_from), b))
        cuts.sort()
        merged = []
        for c in cuts:
            if merged and c[0] <= merged[-1][1] + 0.05:
                merged[-1] = (merged[-1][0], max(merged[-1][1], c[1]))
            else:
                merged.append(c)
        cur = a
        for c0, c1 in merged:
            if c0 - cur > 0.05:
                out.append({"a": round(cur, 3), "b": round(c0, 3)})
            cur = max(cur, c1)
        if b - cur > 0.05:
            out.append({"a": round(cur, 3), "b": round(b, 3)})
    # a piece with no word in it (or under 0.3 s) is a breath or a click: drop it
    keep = []
    for t in out:
        if t["b"] - t["a"] < 0.3 and not any(t["a"] <= (w["start"] + w["end"]) / 2 <= t["b"] for w in words):
            continue
        if not any(t["a"] - 0.02 <= (w["start"] + w["end"]) / 2 <= t["b"] + 0.02 for w in words):
            continue
        keep.append(t)
    return keep


class Timeline:
    def __init__(self, takes):
        self.takes, acc = takes, 0.0
        self.starts = []
        for t in takes:
            self.starts.append(acc)
            acc += t["b"] - t["a"]
        self.total = acc

    def take_of(self, t):
        return next((i for i, k in enumerate(self.takes) if k["a"] - 1e-6 <= t <= k["b"] + 1e-6), None)

    def edit(self, t):
        i = self.take_of(t)
        return None if i is None else self.starts[i] + t - self.takes[i]["a"]


# ---------------------------------------------------------------------------------------------- words
def score(w, i, ws):
    b = bare(w["word"])
    if not b or b in STOP or b in FILLER:
        return 0.0
    s = 1.0 + min(len(b), 10) / 10
    if b in WEAK or b in VERBS or adverb(b):
        s = 0.4
    if b in PROFANE:
        return -5.0
    if b in POWER:
        s += 1.6
    if b in CTA and i > len(ws) * 0.6:
        s += 1.0
    if re.search(r"\d", b) or b in NUMWORD:
        s += 1.2
    if any(re.match(rx, b) for rx, _ in CONCEPTS):
        s += 0.6
    core = re.sub(r"^[^\w]+|[^\w]+$", "", w["word"])
    prev = ws[i - 1]["word"] if i else "."
    if core[:1].isupper() and not re.search(r"[.?!]$", prev) and b not in FIX:
        s -= 0.9                      # a name: the most likely ASR error, never the hero
    if len(b) <= 2:
        s -= 0.5
    if w["end"] - w["start"] < 0.06 and len(b) > 4:
        s -= 0.8                      # a squashed stamp: whisper was unsure where this word is
    return s


def phrases(ws, tl):
    """break at punctuation, pauses, take joins and 8 words"""
    out, cur = [], []
    for i, w in enumerate(ws):
        cur.append(i)
        nxt = ws[i + 1] if i + 1 < len(ws) else None
        if (nxt is None or re.search(r"[.?!,;:]$", w["word"]) or nxt["start"] - w["end"] > 0.3
                or tl.take_of(nxt["start"]) != tl.take_of(w["start"]) or len(cur) >= 8):
            out.append(cur)
            cur = []
    return out


def concept_of(texts, used):
    for t in texts:
        for wd in t.split():
            b = bare(wd)
            for rx, eng in CONCEPTS:
                if re.match(rx, b) and eng not in used:
                    return eng
    return None


def engraving_ok(name):
    return (ENGINE / "library" / "engravings" / "png" / f"{name}.png").exists()


def text_of(ws, idx):
    return " ".join(show(ws[k]["word"], k == 0 or bool(re.search(r"[.?!]$", ws[k - 1]["word"]))) for k in idx).strip()


def adverb(b):
    return len(b) > 4 and b.endswith("ly") and b not in ("family", "supply", "apply", "reply", "italy", "july", "assembly", "butterfly", "belly", "jelly", "rally", "ally")


def is_content(w):
    b = bare(w["word"])
    return bool(b) and b not in STOP and b not in FILLER and b not in VERBS and not adverb(b) and b not in PROFANE


def brk_after(ws, j):
    """a phrase can end after word j: punctuation, the end, or the next word is a function word / verb"""
    return j + 1 >= len(ws) or bool(re.search(r"[.?!,;:]$", ws[j]["word"])) or not is_content(ws[j + 1]) or ws[j + 1]["take"] != ws[j]["take"]


def brk_before(ws, j):
    return j == 0 or bool(re.search(r"[.?!,;:]$", ws[j - 1]["word"])) or not is_content(ws[j - 1]) or ws[j - 1]["take"] != ws[j]["take"]


def key_spans(ws, sc, s, e):
    """THE key phrase candidates: whole runs of content words (an inner 'of'/'and' allowed), or the last two words
    of a long run (the head noun sits last: 'rabbit holes', 'species articles')"""
    out, j = [], s
    while j <= e:
        if not is_content(ws[j]):
            j += 1
            continue
        k = j
        while k + 1 <= e and not re.search(r"[.?!,;:]$", ws[k]["word"]) and (
                is_content(ws[k + 1]) or (bare(ws[k + 1]["word"]) in ("of", "and", "&") and k + 2 <= e and is_content(ws[k + 2]))):
            k += 1
        run = list(range(j, k + 1))
        cand = [run] if len(run) <= 3 and len(text_of(ws, run)) <= LINE_CHARS else []
        if not cand:
            for n in (2, 1):
                tail = run[-n:]
                if is_content(ws[tail[0]]) and len(text_of(ws, tail)) <= LINE_CHARS:
                    cand.append(tail)
                    break
        for c in cand:
            if not brk_after(ws, c[-1]) and c[-1] == e:
                continue                       # the run goes on after the page ends: the box would stop mid-phrase
            out.append(c)
        j = k + 1
    return out


def make_page(ws, sc, s, e, tl, relaxed=False):
    """lines for the words s..e (all spoken while the page is up); None if they don't make a page"""
    best = None
    for k in key_spans(ws, sc, s, e):
        n = len(k)
        v = sum(max(0, sc[j]) for j in k) / (1 + 0.35 * (n - 1)) + (0.3 if n == 2 else 0)
        if len(text_of(ws, k)) < 3 or v <= 0:
            continue
        if best is None or v > best[0]:
            best = (v, k)
    if not best or best[0] < (0.9 if relaxed else 1.4):
        return None                            # nothing worth a page here (only vague words)
    kv, key = best
    # lead-in: up to 3 words right before the key, from a clean start (never from the middle of a phrase)
    lead = []
    j = key[0] - 1
    while j >= s and len(lead) < 3 and not re.search(r"[.?!,;:]$", ws[j]["word"]):
        lead.insert(0, j)
        j -= 1
    while lead and (len(text_of(ws, lead)) > LINE_CHARS or (is_content(ws[lead[0]]) and not brk_before(ws, lead[0])) or bare(ws[lead[0]]["word"]) in FILLER):
        lead = lead[1:]
    if lead and all(not is_content(ws[x]) for x in lead) and (len(lead) < 2 or len(lead) > 2):
        lead = []                              # a lone "the" on its own line reads as a mistake
    # tail: up to 3 words after the key, ending where a phrase ends, never on a function word
    tail = []
    j = key[-1] + 1
    if not re.search(r"[.?!,;:]$", ws[key[-1]]["word"]):
        while j <= e and len(tail) < 3:
            tail.append(j)
            if re.search(r"[.?!,;:]$", ws[j]["word"]):
                break
            j += 1
    while tail and (len(text_of(ws, tail)) > LINE_CHARS or not brk_after(ws, tail[-1]) or not is_content(ws[tail[-1]]) or sc[tail[-1]] < (0.5 if relaxed else 1.2)
                   or (not relaxed and bare(ws[tail[-1]]["word"]) in WEAK)):
        tail = tail[:-1]
    if tail and not any(is_content(ws[x]) for x in tail):
        tail = []
    lines = []
    if lead:
        allstop = all(not is_content(ws[x]) for x in lead)
        lines.append({"idx": lead, "style": "caps" if allstop else "serif"})
    lines.append({"idx": key, "style": "box"})
    if tail:
        first = bare(ws[tail[0]]["word"])
        aside = first in CONTRAST or ws[tail[-1]]["word"].endswith("?")
        lines.append({"idx": tail, "style": "marker" if aside else "serif"})
    if len(lines) < 2:
        return None
    # a name or a capitalised word mid-sentence is the likeliest ASR error: never print it big on a page
    for ln in lines:
        for x in ln["idx"]:
            core = re.sub(r"^[^\w]+|[^\w]+$", "", ws[x]["word"])
            initial = x == 0 or re.search(r"[.?!]$", ws[x - 1]["word"])
            if core[:1].isupper() and not initial and bare(core) not in FIX and not re.search(r"(ean|ian|ese|ish)$", core):
                return None
    for ln in lines:
        ln["text"] = text_of(ws, ln["idx"])
        ln["at"] = round(ws[ln["idx"][0]]["start"], 3)
    return {"lines": lines, "key": key, "kscore": kv}


def plan(proj, verbose=True):
    reel, words = load(proj)
    raw_takes = reel.get("folioRawTakes") or reel["takes"]
    src = proj / reel.get("source", "assets/talk.mp4")
    sil, db = silences(src)
    takes = tighten(raw_takes, words, sil) or raw_takes
    tl = Timeline(takes)
    # words in the cut, in edit order (a word whose middle was cut is not spoken)
    ws = [w for w in words if tl.take_of((w["start"] + w["end"]) / 2) is not None]
    for w in ws:
        ti = tl.take_of((w["start"] + w["end"]) / 2)
        w["start"] = max(w["start"], takes[ti]["a"])
        w["end"] = min(w["end"], takes[ti]["b"])
        w["take"] = ti
        w["e"] = tl.edit(w["start"])
    sc = [score(w, i, ws) for i, w in enumerate(ws)]
    if db is not None and len(ws) > 5:
        # stress: a word said louder than the speaker's usual level is the one they lean on
        import numpy as np
        def level(w):
            seg = db[min(len(db) - 1, int(w["start"] / 0.02)): max(int(w["start"] / 0.02) + 1, int(w["end"] / 0.02))]
            return float(np.mean(seg)) if len(seg) else float(np.median(db))
        lv = [level(w) for w in ws]
        med = float(np.median(lv))
        for i in range(len(ws)):
            if sc[i] > 0:
                sc[i] += max(-0.5, min(0.8, (lv[i] - med) / 4))
    phr = phrases(ws, tl)

    # ---- page candidates: start on the first stressed word of a phrase, end on a phrase boundary
    ends = {ph[-1] for ph in phr}

    def candidates(relaxed=False, lo=0.0, hi=1e9):
        cands = []
        for ph in phr:
            for s in ph:
                ti = ws[s]["take"]
                for e in range(s, min(len(ws), s + 14)):
                    if ws[e]["take"] != ti or ws[e]["end"] - ws[s]["start"] > PAGE_MAX - 0.25:
                        break
                    if e > s and re.search(r"[.?!]$", ws[e - 1]["word"]):
                        break                          # a page never runs across a full stop
                    boundary = e in ends or (sc[e] > 0 and e + 1 < len(ws) and bare(ws[e + 1]["word"]) in CLAUSE)
                    if not boundary or ws[e]["end"] - ws[s]["start"] < 0.7:
                        continue
                    pg = make_page(ws, sc, s, e, tl, relaxed)
                    if not pg:
                        continue
                    first = pg["lines"][0]["idx"][0]
                    at = ws[first]["start"] - 0.06
                    take = takes[ti]
                    at = max(at, take["a"] + 0.01)
                    to = min(take["b"] - 0.02, max(at + PAGE_MIN, ws[e]["end"] + 0.3), at + PAGE_MAX)
                    if to - at < PAGE_MIN - 0.05:
                        continue
                    # the page must not cut mid-word: end in the gap after a word
                    inside = [w for w in ws if w["take"] == ti and w["start"] < to < w["end"] - 0.05]
                    if inside:
                        to = min(take["b"] - 0.02, inside[0]["end"] + 0.05)
                        if to - at > PAGE_MAX + 0.4:
                            continue
                    n_lines = len(pg["lines"])
                    v = pg["kscore"] * 1.5 + 0.4 * n_lines + (0.6 if concept_of([pg["lines"][[l["style"] for l in pg["lines"]].index("box")]["text"]], set()) else 0)
                    cands.append({"at": round(at, 3), "to": round(to, 3), "ea": tl.edit(at), "eb": tl.edit(at) + (to - at),
                                  "lines": pg["lines"], "score": v, "take": ti})
        return cands

    cands = candidates()
    # ---- schedule: the hook page, then one every 10-15 s
    pages = []
    D = tl.total

    def pick(lo, hi, after):
        pool = [c for c in cands if lo <= c["ea"] <= hi and c["ea"] >= after and c["eb"] <= D - 1.2]
        return max(pool, key=lambda c: (c["score"], -c["ea"])) if pool else None

    hook = pick(HOOK_A, HOOK_B, 0)
    late = pick(HOOK_B, 6.5, 0)
    if late and (not hook or late["score"] > hook["score"] + 1.5):
        hook = late                        # a much stronger line a little later beats a weak one on time
    if not hook:
        # nothing strong on time: a plainer line on time beats a late hook (the first page is the pattern break)
        weak = [c for c in candidates(True, HOOK_A - 0.6, HOOK_B) if HOOK_A <= c["ea"] <= HOOK_B and c["eb"] <= D - 1.2]
        hook = max(weak, key=lambda c: c["score"]) if weak else pick(HOOK_A, 9.0, 0)
    if hook:
        hook["hook"] = True
        pages.append(hook)
    last = pages[-1] if pages else None
    while True:
        base = last["ea"] if last else 0
        after = (last["eb"] + MIN_SPEAKER) if last else HOOK_A
        if base + EVERY_A > D - 3.0:
            break
        nxt = pick(base + EVERY_A, base + EVERY_B, after) or pick(base + EVERY_A, base + EVERY_B + 6, after)
        if not nxt:
            break
        pages.append(nxt)
        last = nxt

    # ---- engravings: one per page, the key phrase first, never repeated
    used = set()
    for p in pages:
        box = next(l for l in p["lines"] if l["style"] == "box")
        others = [l["text"] for l in p["lines"] if l is not box]
        eng = concept_of([box["text"]], used) or concept_of(others, used)
        if not eng or not engraving_ok(eng):
            eng = next((f for f in FALLBACK_ENGRAVINGS if f not in used and engraving_ok(f)), "lightbulb")
        used.add(eng)
        p["engraving"] = eng

    # ---- the slam: once, on the most charged word, away from the pages
    slam = None
    busy = [(p["ea"] - 2.5, p["eb"] + 2.5) for p in pages]
    on_pages = {bare(x) for p in pages for l in p["lines"] for x in l["text"].split()}
    best = None
    for i, w in enumerate(ws):
        b = bare(w["word"])
        if sc[i] <= 0 or w["e"] is None or w["e"] < 5.0 or w["e"] > D - 2.6:
            continue
        if any(a < w["e"] < z for a, z in busy):
            continue
        txt = show(w["word"])
        if b in on_pages:
            continue                           # already big on a page
        if txt[:1].isupper() and b not in FIX and i and not re.search(r"[.?!]$", ws[i - 1]["word"]):
            continue                           # a name: the likeliest ASR error
        if not (3 <= len(txt) <= 11) or not re.match(r"^[\w$%'-]+$", txt):
            continue
        v = sc[i] + (1.2 if b in POWER else 0) + (0.8 if re.search(r"[.!?]$", w["word"]) else 0)
        take = takes[w["take"]]
        if take["b"] - w["start"] < 1.45:
            continue
        if best is None or v > best[0]:
            best = (v, i)
    if best and best[0] >= 2.2:
        i = best[1]
        w = ws[i]
        at = round(max(takes[w["take"]]["a"] + 0.01, w["start"] - 0.04), 3)
        to = round(min(takes[w["take"]]["b"] - 0.02, at + 1.7), 3)
        slam = {"type": "slam", "at": at, "to": to, "text": show(w["word"]), "by": BY}
        post = [j for j in range(i + 1, min(len(ws), i + 3)) if ws[j]["take"] == w["take"] and ws[j]["start"] < to - 0.5]
        post = [j for j in post if not re.search(r"[.?!,;:]$", ws[i]["word"])]
        while post and bare(ws[post[-1]]["word"]) in STOP:
            post = post[:-1]
        if post and len(text_of(ws, post)) <= 14:
            slam["post"] = text_of(ws, post)

    beats = [b for b in reel.get("beats", []) if b.get("by") != BY]
    for p in pages:
        beats.append({"type": "scene", "kind": "paper", "at": p["at"], "to": p["to"], "engraving": p["engraving"],
                      "hook": bool(p.get("hook")), "by": BY,
                      "lines": [{"text": l["text"], "style": l["style"], "at": l["at"]} for l in p["lines"]]})
    if slam:
        beats.append(slam)
    beats.sort(key=lambda b: b.get("at", 0) if isinstance(b.get("at", 0), (int, float)) else 0)
    out = dict(reel)
    out["folioRawTakes"] = raw_takes
    out["takes"] = takes
    out["beats"] = beats
    if verbose:
        cut = sum(t["b"] - t["a"] for t in raw_takes) - D
        print(f"takes: {len(raw_takes)} -> {len(takes)}, {cut:.1f} s of dead air cut, {D:.1f} s of speech")
        for p in pages:
            print(f"  page  @{p['ea']:5.1f}-{p['eb']:5.1f}  {p['engraving']:<10} {'HOOK ' if p.get('hook') else ''}" +
                  " / ".join(f"[{l['style']}] {l['text']}" for l in p["lines"]))
        if slam:
            print(f"  slam  @{tl.edit(slam['at']):5.1f}  {slam['text']}" + (f" / {slam['post']}" if slam.get("post") else ""))
        else:
            print("  slam  none (no charged word clear of the pages)")
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    proj = Path(args[0]).resolve()
    out = plan(proj)
    if "--dry" not in sys.argv:
        (proj / "reel.json").write_text(json.dumps(out, indent=2) + "\n")
        print(f"-> {proj / 'reel.json'}")


if __name__ == "__main__":
    main()

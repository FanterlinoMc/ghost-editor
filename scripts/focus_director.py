#!/usr/bin/env python3
"""Focus-template director (hand port of phantasic engine/director/focus_director.py; standalone, not wired into the studio,
independent of the retired engine/director/director.py): turns a transcript into the beats of Hormozi, Gadzhi Motion and Podcast Glow, so a
customer clip gets the edit Ahmed approved by hand without anyone placing graphics.

    focus_director.py <project> [--style hormozi|gadzhi-motion|gadzhi-blue|...|podcast-glow] [--name "..."] [--role "..."]
                                [--cut] [--dry]

  --cut   pick the takes first (smartcut.py: pauses tightened, restarts and fillers removed at real pauses)
  --dry   print the plan, don't write reel.json

Everything on screen is something the speaker said (titles, list items, pills, words on graphics), except the
name card and the short grey notes. Template rules (studied 11-12 Oct 2026, see each style's VERSIONS.md):
  hormozi        red title box on the hook, name card once, a split-screen numbered list whenever he counts points,
                 keyword emphasis in the captions.
  gadzhi-*       3-4 full-screen graphics only on the strongest beats (hook object, list -> icon flow, a number ->
                 counter, payoff -> numbered nodes into an object), never back to back, >= 3 s apart.
  podcast-glow   delegated to glow_plan.py for headlines; the cut-out sets go on the hook, the counted points and the
                 payoff only (40-50 % of the reel), rotating the asset-library sets; leaks on set entries.
"""
import argparse, json, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE   # lives next to mono_plan.py / smartcut.py / glow_plan.py in the fork's scripts/
sys.path.insert(0, str(HERE))
from mono_plan import load_words, bare  # noqa: E402
from focus_review import review  # noqa: E402

# Ahmed's breakdown_plan.sentences / chapter_marks, inlined: the fork has no breakdown_plan.py (and a parallel branch
# may add one), so this script carries the two functions it needs.
ORD = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
       "1": 1, "2": 2, "3": 3, "4": 4, "5": 5}


def sentences(ws):
    out, cur = [], []
    for i, w in enumerate(ws):
        cur.append(w)
        nxt = ws[i + 1] if i + 1 < len(ws) else None
        if nxt is None or re.search(r"[.?!]$", w["word"]) or nxt["start"] - w["end"] > 0.6:
            out.append(cur); cur = []
    return out


def chapter_marks(ws):
    """(index of the marker's first word, number) for 'number one', 'step two', 'first', 'second' ..."""
    marks, seen = [], set()
    for i, w in enumerate(ws):
        b = bare(w["word"])
        nb = bare(ws[i + 1]["word"]) if i + 1 < len(ws) else ""
        n = None
        if b in ("number", "step", "tip", "rule", "mistake", "reason") and nb in ORD:
            n = ORD[nb]
        elif b in ("first", "second", "third", "fourth", "fifth") and (i == 0 or bare(ws[i - 1]["word"]) not in ("the", "a")):
            n = ORD[b]
        if n and n not in seen and (not marks or n == marks[-1][1] + 1 or (not marks and n == 1)):
            marks.append((i, n)); seen.add(n)
    return marks if marks and marks[0][1] == 1 else []

PY = sys.executable
FILL = {"so", "and", "um", "uh", "like", "well", "basically", "literally", "okay", "ok", "right", "now", "then", "actually", "just", "really", "here's", "exactly"}
SAY = re.compile(r"^(i'll|i|i'm|we|you|i'd)\s+(ask|say|would say|going to be asking|be asking|asking|think|ask myself|would)\b", re.I)

# concept -> 3D object (core/library/gm-objects) and line icon (lib/gadzhi.mjs ICONS)
CONCEPTS = [
    (r"\b(cost|costs|price|pricing|money|revenue|profit|roi|return|investment|\$|dollars?|budget|pay|paid|cash|sales?|goal|goals|target|results?)\b", "target", "dollar"),
    (r"\b(time|hours?|minutes?|seconds?|fast|faster|quick|speed|deadline|years?|months?|weeks?|daily|today|tomorrow)\b", "stopwatch", "clock"),
    (r"\b(automat\w*|ai|system|systems|process|workflow|tools?|software|api|machine)\b", "gears", "cpu"),
    (r"\b(grow|growth|scale|scaling|launch|future|faster|boom|skyrocket|win)\b", "rocket", "trend"),
    (r"\b(idea|ideas|insight|clarity|strategy|plan|creative|innovation)\b", "lightbulb", "bolt"),
    (r"\b(think|brain|mind|know|learn|value|smart|decision|question)\b", "puzzle", "target"),
]
ICON_WORDS = [(r"recurring|monthly|repeat|every (month|week)", "repeat"), (r"year|month|calendar|week", "calendar"), (r"api|ai|model|tool|software", "cpu"),
              (r"cost|price|money|\$|revenue|fee", "dollar"), (r"time|hour|minute|second", "clock"), (r"team|employee|people|staff|hire", "users"),
              (r"email|inbox|message", "mail"), (r"sale|growth|grow|revenue up", "trend"), (r"data|report|number|metric", "chart"), (r"customer|client|buy", "cart"),
              (r"document|contract|sop", "doc"), (r"goal|target|outcome", "target")]
NUMWORD = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "ten": 10, "twenty": 20, "fifty": 50, "hundred": 100}


def r3(x):
    return round(x, 3)


def text(ws):
    return " ".join(w["word"] for w in ws)


def concept(s):
    s = s.lower()
    for rx, obj, ico in CONCEPTS:
        if re.search(rx, s):
            return obj, ico
    return "puzzle", "target"


def icon_for(s):
    s = s.lower()
    for rx, ico in ICON_WORDS:
        if re.search(rx, s):
            return ico
    return concept(s)[1]


def trim_lead(ws):
    """drop leading fillers and 'I'll ask / I would say' so a point reads as its content."""
    ws = list(ws)
    while ws and bare(ws[0]["word"]) in FILL:
        ws.pop(0)
    t = text(ws)
    m = SAY.match(t)
    if m:
        n = len(m.group(0).split())
        ws = ws[n:]
        while ws and bare(ws[0]["word"]) in FILL | {"myself", "a", "simple", "question"}:
            ws.pop(0)
    return ws


def clean(t):
    t = re.sub(r"\s+([,?.!])", r"\1", t).strip(" ,;:")
    return t[0].upper() + t[1:] if t else t


def short(ws, n=6):
    ws = trim_lead(ws)
    if len(ws) > n:
        ws = ws[:n]
        while ws and bare(ws[-1]["word"]) in FILL | {"the", "a", "of", "to", "with", "is", "for", "and", "this", "that"}:
            ws.pop()
    return ws


def points(ws):
    """counted points: [(n, marker_word, content_words)] from 'number one / first / step two ...'."""
    marks = chapter_marks(ws)
    out = []
    for k, (i, n) in enumerate(marks):
        end = marks[k + 1][0] if k + 1 < len(marks) else len(ws)
        body = [w for w in ws[i + 2 if bare(ws[i]["word"]) in ("number", "step", "tip", "rule", "mistake", "reason") else i + 1:end]]
        # prefer the question / the sentence that carries the point
        snts = sentences(body) if body else []
        qs = [s for s in snts if s[-1]["word"].endswith("?")]
        best = qs[0] if qs else max(snts, key=len) if snts else body
        # a question introduced by "I'll ask / I'd say, well, / asking myself," -> the question itself (last clause)
        cuts = [k for k, w in enumerate(best[:-1]) if w["word"].endswith(",")]
        if cuts and best[-1]["word"].endswith("?") and len(best) - cuts[-1] - 1 >= 3:
            best = best[cuts[-1] + 1:]
        out.append((n, ws[i], body, best))
    return out


def numbers(ws):
    """spoken numbers worth a counter: $6,000 / 15 seconds / 80% / 500 employees."""
    out = []
    for i, w in enumerate(ws):
        b = w["word"].strip(",.?!")
        m = re.match(r"^\$?([\d,]+(?:\.\d+)?)(%|k|m)?$", b, re.I)
        if not m:
            continue
        v = float(m.group(1).replace(",", ""))
        if v < 2 and not b.startswith("$"):
            continue
        nxt = bare(ws[i + 1]["word"]) if i + 1 < len(ws) else ""
        unit = "%" if m.group(2) == "%" else ("$" if b.startswith("$") else "")
        STOPL = FILL | {"of", "your", "the", "a", "my", "our", "their", "per", "and", "are", "is", "to"}
        label = next((bare(x["word"]) for x in ws[i + 1:i + 5] if bare(x["word"]) not in STOPL and not re.search(r"\d", x["word"])), "")
        out.append({"i": i, "value": v, "prefix": "$" if unit == "$" else "", "suffix": "%" if unit == "%" else (m.group(2) or "").lower(), "label": label, "at": w["start"]})
    return out


def hook(ws):
    ss = sentences(ws)
    return ss[0] if ss else ws[:8]


ING = {"knowing": "know", "measuring": "measure", "focusing": "focus", "asking": "ask", "doing": "do", "building": "build", "thinking": "think",
       "making": "make", "using": "use", "looking": "look", "tracking": "track", "calculating": "calculate", "automating": "automate"}
PREP = {"in", "on", "at", "for", "to", "with", "from", "by", "of", "about", "into", "than", "because", "but", "and", "so", "if", "when"}
MODAL = re.compile(r"\b(?:you |we |i |every \w+ |ceos? )?(?:really )?(?:need to|have to|must|should(?: be)?|got to|gotta|want to|are going to|is going to|will)\s+", re.I)


def title_from(snt):
    """Hormozi title: the promise of the hook in <= 5 words ('HOW I CALCULATE AI ROI', 'KNOW THE NUMBERS')."""
    t = text(trim_lead(snt))
    t = re.sub(r"[.?!]+$", "", t)
    t = re.sub(r"\breturn on investment\b", "ROI", t, flags=re.I)
    m = re.search(r"\b(how (?:i|to|you)\b.*)", t, re.I)
    if m:
        t = re.sub(r"\bi would\b", "I", m.group(1), flags=re.I)
        t = re.sub(r"\s+in under .*$|\s+in \d+ .*$", "", t, flags=re.I)
        words = t.split()[:6]
    else:
        mm = MODAL.search(t)
        if mm:
            t = t[mm.end():]
        elif "," in t and len(t.split(",")[0].split()) <= 5:
            t = t.split(",", 1)[1]
        words = []
        for w in t.replace(",", " ,").split():
            if w == "," or (len(words) >= 2 and w.lower() in PREP):
                break
            words.append(ING.get(w.lower(), w) if not words else w)
            if len(words) >= 5:
                break
    while words and words[-1].lower() in PREP | {"the", "a", "your", "my"}:
        words.pop()
    if len(words) > 3:
        mid = (len(words) + 1) // 2
        return " ".join(words[:mid]) + "\n" + " ".join(words[mid:])
    return " ".join(words)


KEYWORDS = {"cost", "costs", "price", "value", "roi", "ai", "money", "time", "never", "always", "free", "numbers", "data", "revenue", "profit",
            "saved", "save", "saving", "automation", "automate", "clarity", "today", "after", "recurring", "api", "growth", "scale", "one", "two", "three",
            "first", "second", "third", "nothing", "everything", "fast", "simple", "secret", "mistake"}


def emph_words(ws, title=""):
    keep = {b for b in (bare(x) for x in title.replace("\n", " ").split()) if len(b) > 3}
    for w in ws:
        b = bare(w["word"])
        if re.search(r"\d", b) or b in KEYWORDS:
            keep.add(b)
    return sorted(keep)


# words Whisper made up: low confidence AND not an English word -> the clause carrying it is cut from the takes
DICT = None


def real_word(b):
    global DICT
    if DICT is None:
        try:
            DICT = {l.strip().lower() for l in open("/usr/share/dict/words")}   # absent on Windows / slim images: then no word is judged a non-word
        except OSError:
            DICT = set()
    if not DICT or not b.isalpha():
        return True
    return b in DICT or b.rstrip("s") in DICT or b.rstrip("d").rstrip("e") in DICT or (b.endswith("ing") and (b[:-3] in DICT or b[:-3] + "e" in DICT)) or (b.endswith("ed") and b[:-2] in DICT)


def misheard(ws):
    """[(start, end)] source-time spans to cut: the sentence around a low-confidence non-word."""
    cuts = []
    for i, w in enumerate(ws):
        if w.get("p", 1) < 0.65 and not real_word(bare(w["word"])):
            a = i
            while a > 0 and not re.search(r"[.?!]$", ws[a - 1]["word"]):   # the whole sentence: a dangling "And at the same time," reads worse
                a -= 1
            cuts.append((ws[a]["start"], w["end"]))
    return cuts


# ---------- templates ----------
def plan_hormozi(ws, args):
    beats = []
    hk = hook(ws)
    rv = getattr(args, "rv", None)
    ttl = title_from(hk)
    if rv and rv.title:
        tw = rv.title.split()
        ttl = " ".join(tw) if len(tw) <= 3 else " ".join(tw[:(len(tw) + 1) // 2]) + "\n" + " ".join(tw[(len(tw) + 1) // 2:])
    beats.append({"type": "hz-title", "text": ttl, "at": r3(ws[0]["start"]), "to": r3(min(max(hk[-1]["end"] + 0.4, ws[0]["start"] + 3.2), ws[0]["start"] + 4.6))})
    if args.name:
        t = r3(ws[0]["start"] + 1.3)
        beats.append({"type": "hz-name", "name": args.name, "title": args.role or "", "at": t, "to": r3(t + 2.6)})
    pts = points(ws)
    if rv and len(rv.points) >= 2 and len(pts) < 2:
        # unnumbered points the AI found: only points said close together (<= 8 s apart) make one list
        groups, cur = [], [rv.points[0]]
        for p in rv.points[1:]:
            if p.at - cur[-1].at <= 8: cur.append(p)
            else: groups.append(cur); cur = [p]
        groups.append(cur)
        grp = next((g for g in groups if len(g) >= 2), None)
        if grp:
            items = [{"title": clean(p.title), **({"sub": p.sub} if p.sub else {}), "at": r3(p.at)} for p in grp]
            last_w = [w for w in ws if w["start"] >= grp[-1].at]
            beats.append({"type": "hz-list", "at": r3(max(ws[0]["start"], grp[0].at - 0.3)), "to": r3(min(ws[-1]["end"], (last_w[min(len(last_w) - 1, 8)]["end"] if last_w else ws[-1]["end"]) + 0.6)), "items": items})
    if len(pts) >= 2:
        items = [{"title": clean(text(short(best))), "at": r3(best[0]["start"])} for n, mk, body, best in pts]
        end = r3(min(pts[-1][2][-1]["end"], pts[-1][3][-1]["end"] + 2.5))   # inside the take: no padding past the last word
        beats.append({"type": "hz-list", "at": r3(pts[0][1]["start"]), "to": end, "items": items})
    emph = sorted(set(emph_words(ws, beats[0]["text"])) | {e.lower() for e in (rv.emphasis if rv else [])})
    return beats, {"captions": {"emph": emph, "autoEmph": False}}


def plan_gadzhi(ws, args):
    """3-4 graphics on the strongest beats: hook object, counted points -> flow (or nodes), a number -> counter, payoff."""
    cand = []
    hk = hook(ws)
    obj, _ = concept(text(hk))
    tw = title_from(hk).replace("\n", " ").split()
    tw = [w for w in tw if w.lower() != "how"] if len(tw) > 4 else tw
    if len(tw) >= 2:
        # the promise on the object: lead words small, the strongest big serif, the last word big sans below
        lead = tw[:-1]
        big = max(range(len(lead)), key=lambda k: len(lead[k])) if lead else 0
        top = " ".join((f"*{x}*" if k == big and len(lead) > 1 else x) for k, x in enumerate(lead))
        tws = {bare(x) for x in tw}
        span = [w for w in hk if bare(w["word"]) in tws] or hk
        cand.append({"score": 10, "beat": {"type": "scene", "kind": "gm-object", "at": r3(span[0]["start"] - 0.1), "to": r3(min(span[-1]["end"] + 0.5, span[0]["start"] + 3.0)),
                                             "captions": False, "object": obj, "text": top, "textBelow": "^" + tw[-1], "objW": 700, "objY": 540}})
    pts = points(ws)
    if len(pts) >= 2:
        last = pts[-1]
        nodes_at = r3(pts[0][1]["start"])
        # the recap of the counted points lands on the LAST point: chips 1..n drop into the object, pill = its key phrase
        lp = short(last[3], 3)
        o2, _ = concept(text(last[3]))
        a = r3(last[3][0]["start"] - 0.05)
        cand.append({"score": 9, "beat": {"type": "scene", "kind": "gm-nodes", "at": a, "to": r3(min(last[3][-1]["end"] + 0.3, a + 2.4)), "captions": False,
                                           "nodes": [{"n": k + 1, "at": r3(a + 0.1 + 0.25 * k)} for k in range(len(pts))], "object": "puzzle" if o2 == "chart" else o2,
                                           "pill": {"text": text(lp).strip(",.?!").lower(), "at": r3(lp[-1]["start"])}}})
        # a point that lists several things -> icon flow
        for n, mk, body, best in pts[:-1]:
            items = [s for s in sentences(body) if len(s) >= 3]
            if len(items) >= 2:
                its = [{"icon": icon_for(text(s)), "label": text(short(s, 3)).strip(",.?!").lower(), "at": r3(s[0]["start"])} for s in items[-3:]]
                cand.append({"score": 7, "beat": {"type": "scene", "kind": "gm-flow", "at": r3(its[0]["at"] - 0.05), "to": r3(items[-1][-1]["end"] + 0.2), "captions": False, "items": its}})
        del nodes_at
    for nm in numbers(ws)[:2]:
        a = r3(nm["at"] - 0.6)
        cand.append({"score": 8, "beat": {"type": "scene", "kind": "gm-counter", "at": a, "to": r3(nm["at"] + 1.0), "captions": False, "value": nm["value"],
                                           "prefix": nm["prefix"], "suffix": nm["suffix"], "label": nm["label"], "icon": icon_for(nm["label"] or "money"), "countAt": r3(nm["at"]), "countDur": 0.5}})
    # payoff (last sentence) if there were no counted points
    if len(pts) < 2:
        ss = sentences(ws)
        if len(ss) >= 3:
            pay = short(ss[-1], 5)
            if len(pay) >= 3:
                o3, _ = concept(text(ss[-1]))
                ws3 = [w["word"].strip(",.?!") for w in pay]
                cand.append({"score": 8, "beat": {"type": "scene", "kind": "gm-object", "at": r3(pay[0]["start"] - 0.05), "to": r3(pay[-1]["end"] + 0.3), "captions": False,
                                                   "object": o3, "text": " ".join(ws3[:-1]), "textBelow": f"*{ws3[-1]}*", "objW": 600, "objY": 560}})
    # AI-chosen moments come first (score 20), turned into beats with times taken from the spoken words
    rv = getattr(args, "rv", None)
    for m in (rv.moments if rv else []):
        def said_at(label, lo, hi):
            first = bare(label.split()[0]) if label.split() else ""
            hit = next((w for w in ws if lo - 0.3 <= w["start"] <= hi and bare(w["word"]) == first), None)
            return r3(hit["start"]) if hit else None
        b = {"type": "scene", "kind": m.kind, "at": r3(m.at), "to": r3(m.to), "captions": False}
        if m.kind == "gm-object":
            b.update(object=m.object or concept(m.text)[0], text=m.text, objW=700, objY=540, **({"textBelow": m.textBelow} if m.textBelow else {}))
        elif m.kind == "gm-flow":
            its = [{"icon": icon_for(l), "label": l.lower(), "at": said_at(l, m.at, m.to)} for l in m.labels]
            if any(i["at"] is None for i in its) or len(its) < 2:
                continue
            b["items"] = its
        elif m.kind == "gm-counter":
            b.update(value=m.value, prefix=m.prefix, suffix=m.suffix, label=m.label, icon=icon_for(m.label or "money"), countAt=r3(m.at + 0.4), countDur=0.5)
        elif m.kind == "gm-nodes":
            pa = said_at(m.pill, m.at, m.to) if m.pill else None
            b.update(nodes=[{"n": k + 1, "at": r3(m.at + 0.1 + 0.25 * k)} for k in range(3)], object=m.object or "puzzle", **({"pill": {"text": m.pill.lower(), "at": pa}} if pa else {}))
        else:
            continue
        cand.append({"score": 20, "beat": b})
    # pick: best first, <= 4, >= 3 s apart, never overlapping, each <= 3.5 s
    cand.sort(key=lambda c: -c["score"])
    chosen = []
    for c in cand:
        b = c["beat"]
        b["to"] = r3(min(b["to"], b["at"] + 3.5))
        if b["to"] - b["at"] < 0.8:
            continue
        if any(b["at"] < o["to"] + 3.0 and o["at"] < b["to"] + 3.0 for o in chosen):
            continue
        chosen.append(b)
        if len(chosen) >= 4:
            break
    return sorted(chosen, key=lambda b: b["at"]), {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--style")
    ap.add_argument("--name")
    ap.add_argument("--role")
    ap.add_argument("--cut", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--review-file", help="an AI review JSON from elsewhere (same schema as focus_review.Review)")
    args = ap.parse_args()
    proj = Path(args.project).resolve()
    spec = json.loads((proj / "reel.json").read_text())
    if args.style:
        spec["style"] = args.style
    if args.cut or not spec.get("takes"):
        out = subprocess.run([PY, str(SCRIPTS / "smartcut.py"), str(proj)], capture_output=True, text=True)
        if out.returncode != 0 or "{" not in out.stdout:
            raise SystemExit("smartcut.py failed: " + (out.stderr.strip().splitlines() or ["no output"])[-1])
        spec["takes"] = json.loads(out.stdout[out.stdout.index("{"):])["takes"]
    ws, _ = load_words(proj, spec)
    # cut what Whisper made up (needs word confidence "p": fast_transcribe.py writes it since 12 Oct 2026)
    raw = json.loads((proj / spec.get("words", "build/words.whisper.json")).read_text())
    rw = [w for sg in raw["segments"] for w in sg["words"]] if isinstance(raw, dict) else raw
    for w in ws:
        m = next((x for x in rw if abs(x["start"] - w["start"]) < 0.06 and x["word"].strip() == w["word"]), None)
        if m and "p" in m:
            w["p"] = m["p"]
    cuts = misheard(ws)
    rv, notes = review(ws, spec["style"], args.review_file, want_moments=spec["style"].startswith("gadzhi"))
    for n in notes:
        print(f"review: {n}", file=sys.stderr)
    if rv:
        cuts += [(c.start, c.end) for c in rv.cut]
    if cuts:
        # a cut swallows every word that STARTS inside it (Whisper stretches a word's end past the pause)
        cuts = [(c0, max([c1] + [w["end"] for w in ws if c0 - 0.02 <= w["start"] < c1])) for c0, c1 in cuts]
        tk = []
        for k in spec["takes"]:
            segs = [(k["a"], k["b"])]
            for c0, c1 in cuts:
                segs = [p for (a, b) in segs for p in ([(a, b)] if c1 <= a or c0 >= b else [(a, c0 - 0.02), (c1 + 0.04, b)])]
            tk += [{**k, "a": r3(a), "b": r3(b)} for a, b in segs if b - a > 0.3]
        print(f"misheard: cut {[(r3(a), r3(b)) for a, b in cuts]}", file=sys.stderr)
        spec["takes"] = tk
        ws, _ = load_words(proj, spec)
    style = spec["style"]
    args.rv = rv
    if style == "hormozi":
        beats, extra = plan_hormozi(ws, args)
    elif style.startswith("gadzhi"):
        beats, extra = plan_gadzhi(ws, args)
    elif style == "podcast-glow":
        raise SystemExit("podcast-glow: run glow_plan.py (headlines); the cut-out set windows (stage.windows) are not planned by this script in the fork")
    else:
        raise SystemExit(f"no focus director for style {style}")
    # every time must sit inside a kept take: an end that falls in a cut moves back to the take's end, a start forward
    TK = spec["takes"]
    def snap(t, end=False):
        for k in TK:
            if k["a"] - 1e-3 <= t <= k["b"] + 1e-3:
                return r3(min(max(t, k["a"]), k["b"]))
        if end:
            prev = [k for k in TK if k["b"] < t]
            return r3(prev[-1]["b"]) if prev else r3(TK[0]["b"])
        nxt = [k for k in TK if k["a"] > t]
        return r3(nxt[0]["a"]) if nxt else r3(TK[-1]["a"])
    def snap_beat(b):
        b["at"] = snap(b["at"]); b["to"] = max(snap(b["to"], end=True), r3(b["at"] + 0.2))
        for key in ("items", "nodes"):
            for it in b.get(key, []):
                it["at"] = snap(it["at"])
        for key in ("pill",):
            if isinstance(b.get(key), dict):
                b[key]["at"] = snap(b[key]["at"])
        if "countAt" in b:
            b["countAt"] = snap(b["countAt"])
        return b
    beats = [snap_beat(b) for b in beats]
    keep = [b for b in spec.get("beats", []) if b.get("manual")]
    spec["beats"] = keep + beats
    for k, v in extra.items():
        spec[k] = {**spec.get(k, {}), **v}
    print(json.dumps({"style": style, "takes": len(spec["takes"]), "beats": beats, **extra}, indent=1))
    if not args.dry:
        (proj / "reel.json").write_text(json.dumps(spec, indent=1))


if __name__ == "__main__":
    main()

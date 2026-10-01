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
ROTATION = ["footage", "accent", "card", "footage", "phone", "paper", "footage", "accent"]
HOOK = 3.5            # seconds of opening burst: short pages, letter-built keys, punch-ins, pulses, flips on every word
HOOK_ROTATION = ["footage", "accent", "paper", "footage", "card", "accent"]
FIX = {"ai": "AI", "i": "I", "i'm": "I'm", "ceo": "CEO", "chatgpt": "ChatGPT", "youtube": "YouTube", "tiktok": "TikTok",
       "linkedin": "LinkedIn", "instagram": "Instagram"}


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
    if not b or b in STOP:
        return 0
    return len(b) + (6 if b in POWER else 0) + (4 if re.search(r"\d", b) else 0) + (5 if b in LOGOS else 0) + (w["end"] - w["start"]) * 4


def lines_for(p):
    sc = [score(w) for w in p]
    content = [i for i in range(len(p)) if sc[i] > 0]
    if content:
        sc[content[-1]] += 3  # the punchline sits at the end of the phrase
    if max(sc) == 0:  # nothing to punch: the phrase stays small (reference: "I don't", "And I")
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
            word = show(w["word"]).rstrip(",;:")
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


def plan(proj):
    spec = json.loads((proj / "reel.json").read_text())
    ws, takes = load_words(proj, spec)
    ps = phrases(ws)
    hook_end = (ws[0]["start"] if ws else 0) + HOOK
    ps = hook_split(ps, hook_end)
    ps = merge_slivers(ps)
    beats, prev, ri, hi = [], None, 0, 0
    for n, p in enumerate(ps):
        ls, keys = lines_for(p)
        logo = next((LOGOS[bare(w["word"])] for w in p if bare(w["word"]) in LOGOS), None)
        hook = p[0]["start"] < hook_end
        if logo:
            ground = "phone"
        elif hook:
            ground = HOOK_ROTATION[hi % len(HOOK_ROTATION)]; hi += 1
            if ground == prev:
                ground = HOOK_ROTATION[hi % len(HOOK_ROTATION)]; hi += 1
        else:
            ground = ROTATION[ri % len(ROTATION)]; ri += 1
            if ground == prev:
                ground = ROTATION[ri % len(ROTATION)]; ri += 1
        if nxt_is_last(n, ps) and ground == "footage":  # close on a designed page, never on bare footage
            ground = "paper" if prev == "accent" else "accent"
        if ground == "phone" and not logo and len(ls) > 3:  # a tall stack does not fit around the phone
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
        elif ic and n > 0 and not any(x.get("icon") == ic for x in beats[-2:]):
            b["icon"] = ic
        if ground == "footage" and n == 0:
            for l in ls:
                if l["role"] == "k": l["color"] = "#5FBF8F"; break
        if ground == "footage" and n > 0 and n % 3 == 1:
            for l in ls:
                if l["role"] == "k": l["enter"] = "rise"; break
        if ground == "accent" and len([l for l in ls if l["role"] == "k"]) == 2:
            [l for l in ls if l["role"] == "k"][-1]["ring"] = True
        if ground in ("card", "phone"):
            b["handle"] = spec.get("handle", "yourname")
        if hook:
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

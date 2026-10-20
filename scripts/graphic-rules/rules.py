"""Prompt Motion graphic static rules, Python mirror of rules.mjs (same rules.json, re.ASCII).
Usage: python rules.py cases.json  -> prints {"case": "<first failure or null>"} as JSON."""
import json, os, re, sys

J = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "rules.json"), encoding="utf-8"))
def rx(pair):
    src, fl = pair
    f = re.ASCII
    if "i" in fl: f |= re.IGNORECASE
    if "m" in fl: f |= re.MULTILINE
    if "s" in fl: f |= re.DOTALL
    return re.compile(src, f)
NEWLINES = re.compile(J["newlines"][0])  # CRLF and CR -> LF before anything is scanned
SPACES = re.compile(J["unicodeSpaces"])  # Python re reads the \uXXXX escapes itself
def dec(v): return re.sub(r"&quot;|&#34;", '"', re.sub(r"&apos;|&#39;", "'", v)).replace("&amp;", "&")

def scopes(raw):
    html = SPACES.sub(" ", NEWLINES.sub(J["newlines"][1], raw))
    # one left-to-right pass, as the browser's tokenizer reads raw-text elements (see rules.mjs)
    scripts, style_els, parts, last, inside = [], [], [], 0, None
    for m in rx(J["scopes"]["tokens"]).finditer(html):
        before = html[:m.start()]
        if inside is None and before.rfind("<") > before.rfind(">"):
            inside = re.match(r"<[a-z]+", m.group(0), re.ASCII | re.I).group(0)
        if m.group(1) is not None: scripts.append(m.group(1))
        if m.group(2) is not None: style_els.append(m.group(2))
        parts.append(html[last:m.start()]); last = m.end()
    parts.append(html[last:])
    markup = "".join(parts)
    attrs = [dec(m.group(1) if m.group(1) is not None else m.group(2)) for m in rx(J["scopes"]["styleAttr"]).finditer(markup)]
    return {"WHOLE": html, "SCRIPT": "\n".join(scripts), "STYLE": "\n".join(style_els + attrs), "MARKUP": markup, "insideTag": inside}

def fams(v):
    out = []
    for x in re.sub(r"!important", "", v, count=1, flags=re.ASCII | re.I).split(","):
        x = x.strip(); m = re.match(r"""^(['"])([\s\S]*)\1$""", x, re.ASCII)
        x = (m.group(2) if m else x).strip()
        if x: out.append(x)
    return out

def g18(S):
    F = J["fonts"]
    def after_size(v):
        m = rx(F["size"]).match(v); return m.group(1) if m else v
    declared = [f for m in rx(F["face"]).finditer(S["STYLE"]) for f in fams(m.group(1))]
    ok = {x.lower() for x in F["engine"] + F["generic"] + declared}
    lists = [m.group(1) for m in rx(F["css"]).finditer(S["STYLE"])] \
        + [after_size(m.group(1)) for m in rx(F["short"]).finditer(S["STYLE"])] \
        + [m.group(1) if m.group(1) is not None else m.group(2) for m in rx(F["svg"]).finditer(S["MARKUP"])] \
        + [m.group(2) for m in rx(F["jsFam"]).finditer(S["SCRIPT"])] \
        + [after_size(m.group(2)) for m in rx(F["jsFont"]).finditer(S["SCRIPT"])]
    for l in lists:
        for f in fams(l):
            if f.lower() not in ok and not re.match(r"var\(", f, re.ASCII | re.I):
                return "G18:" + json.dumps(f)
    return None

def g36(whole):
    # the first code point inside one of rules.json's glyphs.G36 ranges, as "U+<hex>"; numeric character references
    # count as their character (see rules.mjs)
    def ncr(m):
        c = int(m.group(1), 16) if m.group(1) is not None else int(m.group(2))
        return chr(c) if c <= 0x10FFFF and not 0xD800 <= c <= 0xDFFF else m.group(0)
    for ch in re.sub(J["glyphs"]["ncr"], ncr, whole, flags=re.ASCII):
        c = ord(ch)
        if any(a <= c <= b for a, b in J["glyphs"]["G36"]):
            return "%04X" % c
    return None

def first_fail(html, W=1080, H=1920):
    S, M = scopes(html), J["meta"]
    s = S["SCRIPT"]
    def regex_hit(lo, hi):
        for i, sc, fl, src in J["rules"]:
            if not lo <= int(i[1:]) <= hi: continue
            r = rx([src, fl])
            for k in sc:
                m = r.search(S[k])
                if m: return f"{i}:{k}:{json.dumps(m.group(0))}"
        return None
    count = lambda p: len(rx(p).findall(s))
    def g22():
        lit = list(rx(M["G22lit"]).finditer(s))
        return None if count(M["G22all"]) == 1 and len(lit) == 1 and 0.5 <= float(lit[0].group(1)) <= 30 else "G22"
    def g23():
        a, lit = count(M["G23all"]), list(rx(M["G23lit"]).finditer(s))
        good = a <= 1 and a == len(lit) and all(int(m.group(1)) % 2 == 0 and int(m.group(2)) % 2 == 0 and 16 <= int(m.group(1)) <= W and 16 <= int(m.group(2)) <= H for m in lit)
        return None if good else "G23"
    checks = [lambda: regex_hit(5, 14), lambda: g18(S), lambda: regex_hit(19, 20),
              lambda: None if rx(M["G21"]).search(s) else "G21", g22, g23, lambda: regex_hit(25, 25),
              lambda: "G26" if rx(M["G26"]).search(s) else None, lambda: regex_hit(27, 34),
              lambda: ("G35:" + json.dumps(S["insideTag"])) if S["insideTag"] else None,
              lambda: ("G36:U+" + g36(S["WHOLE"])) if g36(S["WHOLE"]) else None]
    for c in checks:
        r = c()
        if r: return r
    return None

if __name__ == "__main__":
    cases = json.load(open(sys.argv[1], encoding="utf-8"))["cases"]
    sys.stdout.write(json.dumps({k: first_fail(c["html"]) for k, c in cases.items()}))

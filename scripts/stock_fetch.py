#!/usr/bin/env python3
"""Free cutaway stills from Wikimedia Commons (primary) and Openverse (fallback), public domain / CC0 ONLY
(no attribution, commercial use OK).

The director searches by MEANING (from build/context.json), not by the spoken word: "clarity problem" ->
"fog road", "dense fog forest"; "get what you want" -> "lone person mountain summit sunrise".

    stock_fetch.py <project> "<query>" [--n 6] [--tag clarity]     -> assets/stock/<tag>-<k>.jpg + manifest.json
    stock_fetch.py <project> --sheet                                 -> build/stock_sheet.jpg (pick by eye)

Later: Pexels / Unsplash (free API keys, sharper cinematic stock and video) can plug in as extra sources.
"""
import argparse, json, subprocess, sys, time, urllib.parse, urllib.request
from pathlib import Path

API = "https://api.openverse.org/v1/images/"
UA = {"User-Agent": "phantasic-stock/1.0"}


def get(url, raw=False):
    for k in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                b = r.read()
                return b if raw else json.loads(b)
        except Exception:
            time.sleep(1.5 * (k + 1))
    return None


COMMONS = "https://commons.wikimedia.org/w/api.php"
PD_OK = ("public domain", "cc0", "pd", "no restrictions")


def commons(q):
    """Commons search (files), keep only public-domain / CC0 bitmaps, with a 1400 px rendition."""
    u = (f"{COMMONS}?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=50&gsrsearch={urllib.parse.quote(q + ' filetype:bitmap')}"
         "&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1400")
    d = get(u) or {}
    out = []
    for p in (d.get("query", {}).get("pages", {}) or {}).values():
        ii = (p.get("imageinfo") or [{}])[0]; md = ii.get("extmetadata") or {}
        lic = ((md.get("LicenseShortName") or {}).get("value") or "").lower()
        if not any(x in lic for x in PD_OK): continue
        if (ii.get("width") or 0) < 1000: continue
        out.append({"id": f"commons:{p.get('pageid')}", "title": p.get("title", "").replace("File:", ""), "creator": re_strip((md.get("Artist") or {}).get("value", "")),
                    "license": lic, "url": ii.get("thumburl") or ii.get("url"), "foreign_landing_url": ii.get("descriptionurl"),
                    "width": ii.get("width"), "height": ii.get("height")})
    return out


def re_strip(h):
    import re
    return re.sub(r"<[^>]+>", "", h or "").strip()[:80]


def fetch(P, q, n, tag):
    d = P / "assets" / "stock"; d.mkdir(parents=True, exist_ok=True)
    mf = d / "manifest.json"; man = json.loads(mf.read_text()) if mf.exists() else {}
    picks = commons(q)
    if len(picks) < n:   # Openverse as a fallback (it rate-limits anonymous clients)
        res = get(f"{API}?q={urllib.parse.quote(q)}&license=cc0,pdm&page_size=30") or {}
        picks += res.get("results", []) if isinstance(res, dict) else []
    k = sum(1 for v in man.values() if v["tag"] == tag)
    for r in picks:
        if k >= n: break
        if (r.get("width") or 0) < 900 and (r.get("height") or 0) < 900: continue
        if not r.get("url"): continue
        if any(v["id"] == r["id"] for v in man.values()): continue
        b = get(r["url"], raw=True)
        if not b or len(b) < 40000: continue
        k += 1; key = f"{tag}-{k}"
        (d / f"{key}.jpg").write_bytes(b)
        man[key] = {"tag": tag, "query": q, "id": r["id"], "title": r.get("title"), "creator": r.get("creator"), "license": r["license"],
                    "source": r.get("foreign_landing_url") or r.get("url"), "size": [r.get("width"), r.get("height")]}
        print(f"{key:14s} {r['license']:4s} {r.get('width')}x{r.get('height')}  {(r.get('title') or '')[:60]}")
    mf.write_text(json.dumps(man, indent=1))


def sheet(P):
    from PIL import Image, ImageDraw, ImageFont
    d = P / "assets" / "stock"; man = json.loads((d / "manifest.json").read_text())
    keys = sorted(man); W, H = 240, 300
    S = Image.new("RGB", (6 * W, ((len(keys) + 5) // 6) * H), "white")
    for i, k in enumerate(keys):
        im = Image.open(d / f"{k}.jpg").convert("RGB"); im.thumbnail((W - 8, H - 28))
        S.paste(im, ((i % 6) * W + 4, (i // 6) * H + 4)); ImageDraw.Draw(S).text(((i % 6) * W + 4, (i // 6) * H + H - 22), k, fill="black", font=ImageFont.load_default(16))
    out = P / "build" / "stock_sheet.jpg"; S.save(out, quality=85); print(out)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("project"); ap.add_argument("query", nargs="?"); ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--tag", default="img"); ap.add_argument("--sheet", action="store_true"); a = ap.parse_args()
    P = Path(a.project)
    if a.sheet: sheet(P)
    else: fetch(P, a.query, a.n, a.tag)


if __name__ == "__main__":
    main()

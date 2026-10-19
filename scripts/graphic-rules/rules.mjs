// Prompt Motion graphic static rules (spec: references/reel-json.md, "Prompt Motion graphic"), node side.
// The regex sources live in rules.json, shared with rules.py (the Python mirror); parity.mjs checks both agree.
// Covers the regex rules (G5-G28), G18 (fonts) and G21/G22/G23/G26 (literal assignments). G1-G4, G15-G17, G24
// and P1-P3 need the file system or the placement and are not here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const J = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "rules.json"), "utf8"));
const re = ([src, fl], g = false) => new RegExp(src, fl + (g ? "g" : ""));
const SPACES = new RegExp(J.unicodeSpaces, "g");
const dec = (v) => v.replace(/&quot;|&#34;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&");

export function scopes(raw) {
  const html = raw.replace(SPACES, " ");
  const SCRIPT = [...html.matchAll(re(J.scopes.script, true))].map((m) => m[1]).join("\n");
  const styleEls = [...html.matchAll(re(J.scopes.style, true))].map((m) => m[1]);
  const MARKUP = html.replace(re(J.scopes.script, true), "").replace(re(J.scopes.style, true), "");
  const attrs = [...MARKUP.matchAll(re(J.scopes.styleAttr, true))].map((m) => dec(m[1] ?? m[2]));
  return { WHOLE: html, SCRIPT, STYLE: [...styleEls, ...attrs].join("\n"), MARKUP };
}

const fams = (v) => v.replace(/!important/i, "").split(",").map((x) => x.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim()).filter(Boolean);
function g18(S) {
  const F = J.fonts, afterSize = (v) => { const m = v.match(re(F.size)); return m ? m[1] : v; };
  const declared = [...S.STYLE.matchAll(re(F.face, true))].flatMap((m) => fams(m[1]));
  const ok = new Set([...F.engine, ...F.generic, ...declared].map((x) => x.toLowerCase()));
  const lists = [
    ...[...S.STYLE.matchAll(re(F.css, true))].map((m) => m[1]),
    ...[...S.STYLE.matchAll(re(F.short, true))].map((m) => afterSize(m[1])),
    ...[...S.MARKUP.matchAll(re(F.svg, true))].map((m) => m[1] ?? m[2]),
    ...[...S.SCRIPT.matchAll(re(F.jsFam, true))].map((m) => m[2]),
    ...[...S.SCRIPT.matchAll(re(F.jsFont, true))].map((m) => afterSize(m[2])),
  ];
  for (const l of lists) for (const f of fams(l)) if (!ok.has(f.toLowerCase()) && !/^var\(/i.test(f)) return `G18:${JSON.stringify(f)}`;
  return null;
}

/** First failing rule in spec table order, as "Gn:<SCOPE>:<match>" (or "Gn" / "G18:<family>"), or null. */
export function firstFail(html, { W = 1080, H = 1920 } = {}) {
  const S = scopes(html), M = J.meta, s = S.SCRIPT;
  const regexHit = (from, to) => {
    for (const [id, sc, fl, src] of J.rules) {
      const n = +id.slice(1);
      if (n < from || n > to) continue;
      for (const k of sc) { const m = S[k].match(new RegExp(src, fl)); if (m) return `${id}:${k}:${JSON.stringify(m[0])}`; }
    }
    return null;
  };
  const count = (r) => (s.match(re(r, true)) || []).length;
  const checks = [
    () => regexHit(5, 14),
    () => g18(S),
    () => regexHit(19, 20),
    () => (re(M.G21).test(s) ? null : "G21"),
    () => { const lit = [...s.matchAll(re(M.G22lit, true))]; return count(M.G22all) === 1 && lit.length === 1 && +lit[0][1] >= 0.5 && +lit[0][1] <= 30 ? null : "G22"; },
    () => { const all = count(M.G23all), lit = [...s.matchAll(re(M.G23lit, true))];
      return all <= 1 && all === lit.length && lit.every((m) => !(+m[1] % 2) && !(+m[2] % 2) && +m[1] >= 16 && +m[1] <= W && +m[2] >= 16 && +m[2] <= H) ? null : "G23"; },
    () => regexHit(25, 25),
    () => (re(M.G26).test(s) ? "G26" : null),
    () => regexHit(27, 28),
  ];
  for (const c of checks) { const r = c(); if (r) return r; }
  return null;
}

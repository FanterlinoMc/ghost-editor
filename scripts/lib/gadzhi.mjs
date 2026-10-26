// Gadzhi Motion scenes (studied from @manoocreates / @brettfully Iman-Gadzhi-style edits, 12 Oct 2026):
// every few seconds a full-screen graphic replaces the speaker. Kinds (all `gm-*`):
//   gm-object   grey paper ground, a glossy 3D object floats in under a pastel light beam, the spoken words land
//               around it in mixed type (small grey sans, big purple serif italic, big grey sans)
//   gm-kinetic  the same mixed type on the paper ground, no object
//   gm-flow     dark purple ground, a small white title, glass app tiles land one by one joined by drawn curves
//   gm-counter  magenta/purple split ground, a dark glass card: icon, a number that counts up, a label
//   gm-nodes    red (or purple) ground, numbered glass chips in an arc, dotted lines run down into a 3D object,
//               a pill label lands on it
// Words: a token list "let me let you *know* a _little_ ^secret" (plain = small grey sans, *x* = big purple serif
// italic, _x_ = mid purple serif italic, ^x = big grey sans). Each token lands on the matching spoken word, in order.
// Objects: library names (chart, gears, lightbulb, puzzle, rocket, stopwatch, target) from the gm-objects pack, or a path.
// (hand port of phantasic engine/core/scripts/lib/gadzhi.mjs; the theme comes from ctx.gmTheme = spec.gm.theme)
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// the object's real (alpha) bounding box as fractions of its image: library/gm-objects/bounds.json, written by scripts/gm_bounds.mjs;
// a project path or an object not in the file is the whole image
// legacy name: the pack had a brain until 19 Oct 2026 (replaced by the CC0 puzzle); saved reels that name it keep rendering
const gmObj = (o) => (o === "brain" ? "puzzle" : o);
const objBounds = (o) => {
  try { return JSON.parse(fs.readFileSync(path.join(OBJ_DIR, "bounds.json"), "utf8"))[o]; } catch { return null; }
};
const edgeOf = (o) => { const bb = (o.includes("/") ? null : objBounds(gmObj(o))) ?? { top: 0, bottom: 1 }; return { top: bb.top, bottom: bb.bottom }; };
const objAspect = (o) => { try { const f = o.includes("/") ? o : path.join(OBJ_DIR, `${gmObj(o)}.png`); const b = fs.readFileSync(f); return b.readUInt32BE(20) / b.readUInt32BE(16); } catch { return 1; } };
// the pack: 3dicons v1 (CC0), premium style desaturated to graphite + chrome (neutral in every colour theme); see library/gm-objects/SOURCES.md
const OBJ_DIR = process.env.PHANTASIC_GM_OBJECTS || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "library", "gm-objects");
// colour themes: one preset per accent (gadzhi-purple, -blue, -yellow, -red, -green). ink = big serif type on paper,
// glow = halo behind objects, deep = dark ground for flow/counter/nodes, pill = label pill, light = serif on dark
// The five Chrome Motion graphic kinds, in one place so the scene path (motion.mjs) and the layer path
// (layers.mjs, mac-79) agree on what gmScene() will answer to. gmScene returns null for anything else.
export const GM_KINDS = ["gm-object", "gm-kinetic", "gm-flow", "gm-counter", "gm-nodes"];

export const GM_THEMES = {
  purple: { ink: "#4B1F7A", light: "#C4AEF0", glow: "170,135,255", deep: ["#1B0B2C", "#3A1460"], pill: "#7B3FE4" },
  blue:   { ink: "#123E9C", light: "#A9C4FF", glow: "90,150,255",  deep: ["#07132B", "#123A7A"], pill: "#2F6BFF" },
  yellow: { ink: "#8A5A00", light: "#FFE07A", glow: "255,200,60",  deep: ["#1A1405", "#5A4304"], pill: "#F2B705" },
  red:    { ink: "#9E1020", light: "#FFA3AC", glow: "255,90,100",  deep: ["#1E0507", "#6E0A14"], pill: "#E3172B" },
  green:  { ink: "#0E6B43", light: "#9FF0C8", glow: "60,210,140",  deep: ["#04170F", "#0C5234"], pill: "#14B86E" },
};

const ICONS = {
  dollar: '<path d="M12 2v20M17 6.5c0-1.9-2.2-3.5-5-3.5s-5 1.6-5 3.5S9.2 10 12 10s5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M17.5 14.6c2.2.3 3.6 2 4 4.4"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6l8.5 7 8.5-7"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2a1.6 1.6 0 0 0 1.6 1.3h8.6a1.6 1.6 0 0 0 1.5-1.2L21 7H6"/>',
  calculator: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M8 6.5h8M8.5 11h.01M12 11h.01M15.5 11h.01M8.5 14.5h.01M12 14.5h.01M15.5 14.5h.01M8.5 18h.01M12 18h.01M15.5 18h.01"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  doc: '<path d="M6 2.5h8l4 4V21a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 21z"/><path d="M14 2.5V7h4M9 12h6M9 16h6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  repeat: '<path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/>',
};
const icon = (name, size, color = "#fff", sw = 1.7) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.check}</svg>`;

export const GM_CSS = `
  .gm-paper { background: radial-gradient(90% 60% at 50% 42%, #F7F7F8 0%, #E2E2E5 45%, #B5B5BB 100%); }
  .gm-halo { position: absolute; left: 50%; border-radius: 50%; transform: translate(-50%, -50%); background: radial-gradient(closest-side, rgba(var(--gm-glow),.55), rgba(var(--gm-glow),.2) 55%, transparent 100%); filter: blur(30px); }
  .gm-floor { position: absolute; left: 50%; border-radius: 50%; transform: translateX(-50%); background: radial-gradient(closest-side, rgba(45,25,80,.42), rgba(45,25,80,.12) 60%, transparent 100%); filter: blur(10px); }
  .gm-objwrap { position: absolute; left: 50%; transform: translateX(-50%); perspective: 1400px; }
  .gm-paper::after { content: ""; position: absolute; inset: 0; opacity: .5; mix-blend-mode: multiply;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .55 0'/></filter><rect width='300' height='300' filter='url(%23n)'/></svg>"); }
  .gm-cloud { position: absolute; inset: -10%; background: radial-gradient(40% 25% at 30% 30%, rgba(255,255,255,.55), transparent 70%), radial-gradient(35% 22% at 75% 70%, rgba(255,255,255,.4), transparent 70%); filter: blur(30px); }
  .gm-beam { position: absolute; left: 50%; width: 520px; margin-left: -260px; clip-path: polygon(30% 0, 70% 0, 100% 100%, 0 100%);
    background: linear-gradient(180deg, rgba(201,170,255,.85), rgba(214,190,255,.35) 60%, rgba(214,190,255,0)); filter: blur(14px); transform-origin: 50% 0; }
  .gm-obj { position: absolute; left: 50%; transform: translateX(-50%); filter: drop-shadow(0 30px 40px rgba(40,20,70,.35)); }
  .gm-objwrap .gm-obj3 { width: 100%; transform-style: preserve-3d; filter: drop-shadow(0 26px 34px rgba(50,25,90,.30)) drop-shadow(0 4px 6px rgba(50,25,90,.18)); }
  .gm-objwrap img { width: 100%; display: block; }
  .gm-obj img { width: 100%; display: block; }
  .gm-row { position: absolute; left: 0; right: 0; text-align: center; white-space: nowrap; }
  .gm-t { display: inline-block; margin: 0 .16em; vertical-align: baseline; }
  .gm-t.s { font-family: Inter, system-ui, sans-serif; font-weight: 500; font-size: 84px; color: #6F6A7A; letter-spacing: -2.5px; }
  .gm-t.k { font-family: "Instrument Serif", Georgia, serif; font-style: italic; font-size: 196px; color: var(--gm-ink); letter-spacing: -2px; line-height: .9; }
  .gm-t.m { font-family: "Instrument Serif", Georgia, serif; font-style: italic; font-size: 124px; color: var(--gm-ink); line-height: .9; }
  .gm-t.b { font-family: Inter, system-ui, sans-serif; font-weight: 600; font-size: 176px; color: #8C8797; letter-spacing: -7px; line-height: .9; }
  .gm-t.dark.s { color: rgba(255,255,255,.62); } .gm-t.dark.b { color: #fff; } .gm-t.dark.k, .gm-t.dark.m { color: var(--gm-light); }
  .gm-title { position: absolute; left: 70px; top: 230px; font-family: Inter, system-ui, sans-serif; font-weight: 700; font-size: 70px; color: #fff; letter-spacing: -2px; }
  .gm-tile { position: absolute; width: 240px; height: 240px; margin: -120px 0 0 -120px; border-radius: 60px; display: grid; place-items: center;
    background: linear-gradient(160deg, rgba(255,255,255,.34), rgba(255,255,255,.10)); border: 2px solid rgba(255,255,255,.35);
    box-shadow: inset 0 2px 10px rgba(255,255,255,.25), 0 20px 50px rgba(0,0,0,.45); backdrop-filter: blur(8px); }
  .gm-tile-l { position: absolute; transform: translate(-50%, 0); font-family: Inter, system-ui, sans-serif; font-weight: 600; font-size: 46px; color: rgba(255,255,255,.88); white-space: nowrap; }
  .gm-card { position: absolute; left: 50%; top: 50%; width: 600px; height: 680px; margin: -380px 0 0 -300px; border-radius: 70px;
    background: linear-gradient(170deg, #26262B 0%, #0D0D10 100%); border: 3px solid rgba(255,255,255,.22);
    box-shadow: inset 0 0 40px rgba(255,255,255,.08), 0 40px 90px rgba(0,0,0,.6); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; }
  .gm-num { font-family: Inter, system-ui, sans-serif; font-weight: 800; font-size: 170px; letter-spacing: -8px; line-height: .9;
    background: linear-gradient(180deg, #fff, #A9A9B2); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .gm-lab { font-family: Inter, system-ui, sans-serif; font-weight: 700; font-size: 54px; letter-spacing: 6px; color: rgba(255,255,255,.9); text-transform: uppercase; }
  .gm-chip { position: absolute; width: 110px; height: 110px; margin: -55px 0 0 -55px; border-radius: 28px; display: grid; place-items: center;
    background: linear-gradient(160deg, #3A3A40, #121215); border: 3px solid rgba(255,255,255,.55); color: #fff;
    font-family: Inter, system-ui, sans-serif; font-weight: 700; font-size: 58px; box-shadow: 0 14px 30px rgba(0,0,0,.45); }
  .gm-pill { position: absolute; left: 50%; transform: translateX(-50%); padding: 14px 46px 18px; border-radius: 999px; background: var(--gm-pill);
    border: 4px solid #fff; color: #fff; font-family: Inter, system-ui, sans-serif; font-weight: 700; font-size: 50px; white-space: nowrap; box-shadow: 0 12px 30px rgba(0,0,0,.4); }
`;

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}%$]+/gu, "");

// token list -> [{text, cls}] ; then time each token on the next matching spoken word in [t0src, t1src]
function tokens(spec) {
  return spec.trim().split(/\s+/).map((t) => {
    if (/^\*.+\*$/.test(t)) return { text: t.slice(1, -1), cls: "k" };
    if (/^_.+_$/.test(t)) return { text: t.slice(1, -1), cls: "m" };
    if (/^\^./.test(t)) return { text: t.slice(1), cls: "b" };
    return { text: t, cls: "s" };
  });
}
function timeTokens(toks, words, a, b) {
  const spoken = words.filter((w) => w.start >= a - 0.05 && w.start < b + 0.05);
  let k = 0, last = a;
  return toks.map((t) => {
    const want = norm(t.text.replace(/_/g, " "));
    for (let j = k; j < spoken.length; j++) if (norm(spoken[j].word) === want || norm(spoken[j].word).startsWith(want) && want.length > 2) { k = j + 1; last = spoken[j].start; return { ...t, at: last }; }
    return { ...t, at: last };
  });
}
// rows: "|" splits the token string into lines
function rowsOf(spec, words, a, b) {
  const lines = spec.split("|").map((l) => tokens(l));
  const flat = timeTokens(lines.flat(), words, a, b);
  let i = 0;
  return lines.map((l) => l.map(() => flat[i++]));
}

export function gmScene(b, id, t0, t1, ctx) {
  const { tl, E, r3, esc, addSfx, userAsset, words } = ctx;
  const T = GM_THEMES[b.theme ?? ctx.gmTheme ?? "purple"] ?? GM_THEMES.purple;
  const objSrc = (o) => userAsset(o.includes("/") ? o : path.join(OBJ_DIR, `${gmObj(o)}.png`));
  const landWord = (sel, at, cls) => {
    const big = cls !== "s";
    tl.push(`ft("${sel}", { autoAlpha: 0, y: ${big ? 40 : 18}, filter: "blur(${big ? 14 : 8}px)", scale: ${big ? 1.12 : 1} }, { autoAlpha: 1, y: 0, filter: "blur(0px)", scale: 1, duration: ${big ? 0.32 : 0.22}, ease: "power3.out" }, ${at});`);
  };
  // the height typeRows() will occupy (same row heights and fit scale, no side effects)
  const rowsHeight = (spec, big, gap) => {
    let y = 0;
    for (const row of rowsOf(spec, words, t0, t1)) {
      const h = Math.max(...row.map((t) => (big ? { s: 125, m: 165, k: 245, b: 225 } : { s: 92, m: 128, k: 190, b: 172 })[t.cls]));
      const em = { s: 0.5, m: 0.4, k: 0.4, b: 0.52 }, fs0 = big ? { s: 120, m: 160, k: 250, b: 230 } : { s: 84, m: 124, k: 196, b: 176 };
      const estW = row.reduce((a, t) => a + (t.text.length * em[t.cls] + 0.32) * fs0[t.cls], 0), fit = estW > 980 ? r3(980 / estW) : 1;
      y += Math.round(h * (fit < 1 ? fit : 1)) + (gap ?? 6);
    }
    return y;
  };
  const typeRows = (spec, y0, gap, dark, big, tag = "w") => {
    const rows = rowsOf(spec, words, t0, t1);   // ctx.words are on the timeline clock
    let y = y0;
    return rows.map((row, ri) => {
      const h = Math.max(...row.map((t) => (big ? { s: 125, m: 165, k: 245, b: 225 } : { s: 92, m: 128, k: 190, b: 172 })[t.cls]));
      const em = { s: 0.5, m: 0.4, k: 0.4, b: 0.52 }, fs0 = big ? { s: 120, m: 160, k: 250, b: 230 } : { s: 84, m: 124, k: 196, b: 176 };
      const estW = row.reduce((a, t) => a + (t.text.length * em[t.cls] + 0.32) * fs0[t.cls], 0);
      const fit = estW > 980 ? r3(980 / estW) : 1;
      // a nowrap row wider than the frame overflows from its LEFT edge (text-align:center only centres content that fits),
      // so an over-wide row is shrink-wrapped from the frame centre and centred on its own width before the fit scale;
      // a row that fits keeps its plain full-width markup
      const html = `<div class="gm-row" style="top:${y}px${fit < 1 ? `;left:50%;right:auto;transform:translateX(-50%) scale(${fit});transform-origin:50% 0` : ""}">${row.map((t, ti) => {
        const sel = `${id}-${tag}${ri}-${ti}`, at = r3(Math.min(t1 - 0.15, Math.max(t0 + 0.05, t.at - 0.03)));
        landWord(`#${sel}`, at, t.cls);
        addSfx(at, t.cls === "s" ? "tick-1" : "pop-2", "gm word lands", { db: t.cls === "s" ? -16 : -9 });
        return `<span id="${sel}" class="gm-t ${t.cls}${dark ? " dark" : ""}"${big ? ` style="font-size:${({ s: 120, m: 160, k: 250, b: 230 })[t.cls]}px"` : ""}>${esc(t.text.replace(/_/g, " "))}</span>`;
      }).join("")}</div>`;
      y += Math.round(h * (fit < 1 ? fit : 1)) + (gap ?? 6);
      return html;
    }).join("");
  };

  let body = "", cls = "", bg = null;
  if (b.kind === "gm-kinetic" || b.kind === "gm-flow" || b.kind === "gm-nodes") addSfx(t0, "whoosh-2", "gm scene in", { db: -8 });

  if (b.kind === "gm-object" || b.kind === "gm-kinetic") {
    cls = "gm-paper";
    const hasObj = b.kind === "gm-object";
    let objY = b.objY ?? 560, objW = b.objW ?? 780;
    body += `<div class="gm-cloud"></div>`;
    // layout from the object's MEASURED top and bottom edges (alpha bounds), so the words never sit on a tall object: the text
    // block is measured, and if it would reach the object's top the object moves down - and shrinks if it then runs too low.
    // A layout that already clears the object is left exactly as given.
    let textY = b.textY ?? (hasObj ? 300 : 520);
    if (hasObj) {
      const e = edgeOf(b.object), asp = objAspect(b.object), textBottom = textY + rowsHeight(b.text ?? "", !hasObj || b.bigType, b.gap), clear = 18;
      if (objY + e.top * objW * asp < textBottom + clear) objY = Math.round(textBottom + clear - e.top * objW * asp);
      const limit = b.maxBottom ?? 1600, bottom = () => objY + e.bottom * objW * asp;
      if (bottom() > limit) objW = Math.round(objW * Math.max(0.5, (limit - (objY + e.top * objW * asp)) / ((e.bottom - e.top) * objW * asp)));
      if (objY !== (b.objY ?? 560) || objW !== (b.objW ?? 780)) objY = Math.round(textBottom + clear - e.top * objW * asp);
    }
    if (hasObj) {
      const objH = Math.round(objW * objAspect(b.object)), cy = objY + objH / 2;
      body += `<div id="${id}-halo" class="gm-halo" style="top:${cy}px;width:${Math.round(objW * 1.5)}px;height:${Math.round(objW * 1.5)}px"></div>`;
      body += `<div id="${id}-floor" class="gm-floor" style="top:${objY + objH - 30}px;width:${Math.round(objW * 0.9)}px;height:${Math.round(objW * 0.16)}px"></div>`;
      body += `<div id="${id}-ow" class="gm-objwrap" style="top:${objY}px;width:${objW}px"><div id="${id}-obj" class="gm-obj3"><img src="${objSrc(b.object)}" /></div></div>`;
      const hold = r3(Math.max(0.3, t1 - t0 - 0.55));
      tl.push(`ft("#${id}-obj", { autoAlpha: 0, scale: 0.72, y: 90, rotationY: -28, rotationX: 10 }, { autoAlpha: 1, scale: 1, y: 0, rotationY: -8, rotationX: 4, duration: 0.55, ease: "expo.out" }, ${t0});`);
      tl.push(`tl.to("#${id}-obj", { y: -22, rotationY: 8, rotationX: -2, duration: ${hold}, ease: "sine.inOut" }, ${r3(t0 + 0.55)});`);
      tl.push(`ft("#${id}-halo", { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: 0.6, ease: "power2.out" }, ${r3(t0 + 0.05)});`);
      tl.push(`ft("#${id}-floor", { autoAlpha: 0, scaleX: 0.5 }, { autoAlpha: 1, scaleX: 1, duration: 0.5, ease: "power2.out" }, ${r3(t0 + 0.1)});`);
      tl.push(`tl.to("#${id}-floor", { scaleX: 0.86, autoAlpha: 0.7, duration: ${hold}, ease: "sine.inOut" }, ${r3(t0 + 0.55)});`);
      addSfx(t0, "whoosh-2", "gm object in", { db: -6 });
    }
    body += typeRows(b.text ?? "", textY, b.gap, false, !hasObj || b.bigType);
    if (b.textBelow) body += typeRows(b.textBelow, b.textBelowY ?? Math.round(objY + objW * objAspect(b.object) * edgeOf(b.object).bottom - 70), b.gap, false, b.bigType, "u");
  }

  else if (b.kind === "gm-flow") {
    bg = `radial-gradient(90% 60% at 80% 100%, ${T.deep[1]} 0%, ${T.deep[0]} 55%, #07060A 100%)`;
    const items = b.items ?? [];
    const pts = items.map((it, i) => ({ x: it.x ?? [250, 800, 330, 760, 300][i % 5], y: it.y ?? 600 + i * 420 }));
    if (b.title) {
      body += `<div id="${id}-title" class="gm-title">${esc(b.title)}</div>`;
      tl.push(`ft("#${id}-title", { autoAlpha: 0, y: 16, filter: "blur(8px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.3, ease: "power3.out" }, ${t0});`);
    }
    let svg = `<svg style="position:absolute;inset:0" width="1080" height="1920" viewBox="0 0 1080 1920" fill="none">`;
    items.forEach((it, i) => {
      const at = r3(Math.max(t0 + 0.1, E(it.at, "gm flow item") - 0.04)), p = pts[i];
      if (i > 0) {
        const q = pts[i - 1], mx = (q.x + p.x) / 2;
        svg += `<path id="${id}-ln${i}" d="M${q.x + 130} ${q.y} C ${p.x} ${q.y}, ${p.x} ${q.y}, ${p.x} ${p.y - 130}" stroke="rgba(255,255,255,.8)" stroke-width="6" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/>`;
        tl.push(`tl.to("#${id}-ln${i}", { strokeDashoffset: 0, duration: 0.35, ease: "power2.inOut" }, ${r3(at - 0.3)});`);
        void mx;
      }
      body += `<div id="${id}-tile${i}" class="gm-tile" style="left:${p.x}px;top:${p.y}px">${icon(it.icon, 130)}</div>`;
      if (it.label) body += `<div id="${id}-tl${i}" class="gm-tile-l" style="left:${p.x}px;top:${p.y + 140}px">${esc(it.label)}</div>`;
      tl.push(`ft("#${id}-tile${i}", { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.34, ease: "back.out(2)" }, ${at});`);
      if (it.label) tl.push(`ft("#${id}-tl${i}", { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.25 }, ${r3(at + 0.1)});`);
      addSfx(at, i % 2 ? "click-1" : "pop-2", "gm tile", { db: -6 });
    });
    body = svg + `</svg>` + body;
  }

  else if (b.kind === "gm-counter") {
    bg = b.ground === "dark" ? `radial-gradient(80% 60% at 50% 45%, ${T.deep[1]}, #07050B 80%)` : `linear-gradient(90deg, #0A0A0D 0%, #0A0A0D 48%, ${T.deep[1]} 49%, ${T.pill} 100%)`;
    const at = r3(Math.max(t0 + 0.05, E(b.countAt ?? b.at, "gm counter") - 0.05)), v = b.value ?? 100, dur = b.countDur ?? 0.7;
    body = `<div id="${id}-card" class="gm-card">${icon(b.icon ?? "users", 150, "#fff", 1.5)}<div id="${id}-num" class="gm-num">${esc((b.prefix ?? "") + "0" + (b.suffix ?? ""))}</div><div class="gm-lab">${esc(b.label ?? "")}</div></div>`;
    tl.push(`ft("#${id}-card", { autoAlpha: 0, scale: 0.7, y: 60 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.45, ease: "back.out(1.6)" }, ${t0});`);
    tl.push(`(() => { const o = { v: 0 }; const el = document.getElementById("${id}-num"); tl.fromTo(o, { v: 0 }, { v: ${v}, duration: ${dur}, ease: "power2.out", immediateRender: false, onUpdate: () => { el.textContent = ${JSON.stringify(b.prefix ?? "")} + Math.round(o.v).toLocaleString("en-US") + ${JSON.stringify(b.suffix ?? "")}; } }, ${at}); })();`);
    tl.push(`tl.to("#${id}-card", { scale: 1.04, duration: ${r3(Math.max(0.3, t1 - t0 - 0.45))}, ease: "none" }, ${r3(t0 + 0.45)});`);
    addSfx(t0, "whoosh-2", "gm card in", { db: -6 });
    addSfx(r3(at + dur), "tech-ui-confirm", "gm count lands", { db: -6 });
  }

  else if (b.kind === "gm-nodes") {
    bg = `linear-gradient(180deg, #07060A 0%, ${T.deep[1]} 50%, ${T.pill} 100%)`;
    const n = b.nodes ?? [], objY = b.objY ?? 1060;
    let objW = b.objW ?? 520;
    // the pill sits BELOW the object's measured bottom edge; a tall object shrinks until object + pill fit above the bottom margin
    const nodeEdge = b.object ? edgeOf(b.object) : { top: 0, bottom: 1 }, PILL_H = 100, PILL_GAP = 24, PILL_LIMIT = b.maxBottom ?? 1740;
    if (b.object && b.pill && b.pill.y === undefined) {
      const need = () => objY + nodeEdge.bottom * objW * objAspect(b.object) + PILL_GAP + PILL_H;
      if (need() > PILL_LIMIT) objW = Math.round(objW * Math.max(0.5, (PILL_LIMIT - PILL_GAP - PILL_H - objY) / (nodeEdge.bottom * objW * objAspect(b.object))));
    }
    const pos = [[300, 640], [540, 520], [780, 640], [200, 820], [880, 820]];
    let svg = `<svg style="position:absolute;inset:0" width="1080" height="1920" viewBox="0 0 1080 1920" fill="none">`;
    n.forEach((nd, i) => {
      const at = r3(Math.max(t0 + 0.1, E(nd.at, "gm node") - 0.04)), [x, y] = pos[i % pos.length];
      body += `<div id="${id}-c${i}" class="gm-chip" style="left:${x}px;top:${y}px">${esc(String(nd.n ?? i + 1))}</div>`;
      svg += `<path id="${id}-d${i}" d="M${x} ${y + 60} C ${x} ${y + 200}, 540 ${objY - 160}, 540 ${objY + 40}" stroke="rgba(255,255,255,.8)" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 16"/>`;
      tl.push(`ft("#${id}-c${i}", { autoAlpha: 0, scale: 0.3, y: -30 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.32, ease: "back.out(2.2)" }, ${at});`);
      tl.push(`ft("#${id}-d${i}", { autoAlpha: 0, clipPath: "inset(0 0 100% 0)" }, { autoAlpha: 1, clipPath: "inset(0 0 0% 0)", duration: 0.4, ease: "power2.out" }, ${r3(at + 0.12)});`);
      addSfx(at, "tick-1", "gm node", { db: -4 });
    });
    body = svg + `</svg>` + body;
    if (b.object) {
      body += `<div id="${id}-obj" class="gm-obj" style="top:${objY}px;width:${objW}px"><img src="${objSrc(b.object)}" /></div>`;
      tl.push(`ft("#${id}-obj", { autoAlpha: 0, scale: 0.5, y: 120 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.5, ease: "back.out(1.4)" }, ${r3(t0 + 0.05)});`);
      tl.push(`tl.to("#${id}-obj", { y: -20, duration: ${r3(Math.max(0.3, t1 - t0 - 0.55))}, ease: "sine.inOut" }, ${r3(t0 + 0.55)});`);
    }
    if (b.pill) {
      const pa = r3(Math.max(t0 + 0.2, E(b.pill.at, "gm pill") - 0.04));
      body += `<div id="${id}-pill" class="gm-pill" style="top:${b.pill.y ?? (b.object ? Math.round(objY + objW * objAspect(b.object) * nodeEdge.bottom + PILL_GAP) : Math.round(objY + objW * 0.42))}px">${esc(b.pill.text)}</div>`;
      tl.push(`ft("#${id}-pill", { autoAlpha: 0, scale: 0.5 }, { autoAlpha: 1, scale: 1, duration: 0.3, ease: "back.out(2.4)" }, ${pa});`);
      addSfx(pa, "pop-2", "gm pill", { db: -4 });
    }
  }

  else return null;
  body = `<div style="position:absolute;inset:0;--gm-ink:${T.ink};--gm-light:${T.light};--gm-glow:${T.glow};--gm-pill:${T.pill}">${body}</div>`;
  return { body, cls, bg };
}

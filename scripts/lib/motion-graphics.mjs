// The `motion` beat: graphics a designer (Claude) writes for one reel as typed JSON, compiled here to
// absolutely positioned DOM/SVG plus explicit `ft(...)` tweens on the existing paused GSAP timeline.
// Contract: phantasic docs/MOTION-GRAPHICS-SPEC.md. Reference: references/reel-json.md ("motion").
//
//   - No model-written JS/HTML/CSS reaches the page: every value is whitelisted, clamped or escaped.
//   - Every frame is a pure function of time: each tween carries full from/to values, the value
//     BEFORE a key's first tween is that tween's `from` (set at t=0, and what GSAP renders when the
//     playhead is reversed past the start - the two agree), a GAP between two tweens on one key
//     holds the earlier `to` (an explicit hold tween makes the reverse seek agree), and nothing
//     reads a previous frame. No CSS animation/transition, no Date, no randomness.
//   - No network: image `src` only under assets/ or a library/art id; no URLs anywhere.
//   - A bad element/tween is dropped with a warning; only a beat with nothing left, or outside the
//     0.6..8 s span, is dropped whole. compileMotion never throws and never calls die().

import { normalizeRoom } from "./room.mjs";

// The families the composition loads (templates/fonts, via build.mjs's @font-face loop) that suit
// display text. Arabic (RTL) and GeistMono are deliberately out. The planner imports or mirrors this.
export const DESIGNER_FONTS = [
  "Inter", "Geist", "Montserrat", "Oswald", "Unbounded", "Gloock", "Instrument Serif",
  "EB Garamond", "Playfair Display", "Caveat Brush", "Yellowtail", "JetBrains Mono",
];

export const LIMITS = { elements: 12, tweens: 30, minSpan: 0.6, maxSpan: 8, maxText: 80, maxPath: 2000, maxBlurEls: 2 };
export const EASES = {
  none: "none",
  "power1.in": "power1.in", "power1.out": "power1.out", "power1.inOut": "power1.inOut",
  "power2.in": "power2.in", "power2.out": "power2.out", "power2.inOut": "power2.inOut",
  "power3.in": "power3.in", "power3.out": "power3.out", "power3.inOut": "power3.inOut",
  "power4.in": "power4.in", "power4.out": "power4.out", "power4.inOut": "power4.inOut",
  "back.out": "back.out(1.7)", "elastic.out": "elastic.out(1,0.3)", "expo.out": "expo.out", "sine.inOut": "sine.inOut",
};
const SHAPES = ["text", "rect", "ellipse", "line", "path", "image"];
const KEYS = ["x", "y", "scale", "scaleX", "scaleY", "rotate", "opacity", "blur", "draw", "reveal", "count"];
const NODE_KEYS = ["x", "y", "scale", "scaleX", "scaleY", "rotate", "opacity", "blur", "reveal"];
const DRAW_SHAPES = ["line", "path", "rect", "ellipse"];
const ID_RE = /^[a-z0-9-]{1,24}$/;
const HEX_RE = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;
const PATH_RE = /^[MLHVCSQTAZmlhvcsqtaz0-9eE.,+\-\s]*$/;
const SHADOWS = {
  none: "none",
  soft: "0 4px 18px rgba(0,0,0,.45)",
  strong: "0 4px 18px rgba(0,0,0,.55), 0 1px 3px rgba(0,0,0,.7)",
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, lo, hi, def) => (fin(v) ? clamp(v, lo, hi) : def);
const rd = (v, p = 3) => { const k = 10 ** p; return Math.round(v * k) / k; };
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const cleanText = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, LIMITS.maxText);

// "#rrggbb" / "#rrggbbaa" / accent|ink|paper -> a CSS colour, or null
export function resolveColor(c, brand = {}) {
  if (typeof c !== "string") return null;
  const tokens = { accent: brand.accent ?? "#D13F34", ink: brand.ink ?? "#262626", paper: brand.paper ?? "#F4EFE6" };
  const v = Object.hasOwn(tokens, c) ? tokens[c] : c;
  if (!HEX_RE.test(v)) return null;
  if (v.length === 7) return v.toLowerCase();
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${rd(parseInt(v.slice(7, 9), 16) / 255, 3)})`;
}

// "1,200+" -> { pre: "", dec: 0, comma: true, post: "+" }; null if the text is not a number
export function parseCount(text) {
  const m = /^([^\d-]*?)(-?[\d,]*\.?\d+)([^\d]*)$/.exec(String(text).trim());
  if (!m) return null;
  const dot = m[2].indexOf(".");
  return { pre: m[1], dec: dot < 0 ? 0 : m[2].length - dot - 1, comma: m[2].includes(","), post: m[3] };
}
export function formatCount(v, f) {
  const n = Math.round(v * 10 ** f.dec) / 10 ** f.dec;
  const s = f.comma ? n.toLocaleString("en-US", { minimumFractionDigits: f.dec, maximumFractionDigits: f.dec }) : n.toFixed(f.dec);
  return f.pre + s + f.post;
}

// the linear-gradient axis for a CSS-style angle (0 = to top, 90 = to right) over a w x h box
function gradientAxis(w, h, deg) {
  const a = (deg * Math.PI) / 180, dx = Math.sin(a), dy = -Math.cos(a);
  const L = (Math.abs(w * dx) + Math.abs(h * dy)) / 2, cx = w / 2, cy = h / 2;
  return { x1: rd(cx - dx * L, 2), y1: rd(cy - dy * L, 2), x2: rd(cx + dx * L, 2), y2: rd(cy + dy * L, 2) };
}

// the clip-path inset for a wipe at progress r (0 hidden, 1 shown), all px so GSAP can interpolate it
export function revealClip(r, from, w, h, pad) {
  const p = (side) => rd((side + pad) - r * (side + 2 * pad), 2);   // side + pad at r=0 (nothing shows) down to -pad at r=1
  const m = rd(-pad, 2);
  if (from === "right") return `inset(${m}px ${m}px ${m}px ${p(w)}px)`;
  if (from === "top") return `inset(${m}px ${m}px ${p(h)}px ${m}px)`;
  if (from === "bottom") return `inset(${p(h)}px ${m}px ${m}px ${m}px)`;
  return `inset(${m}px ${p(w)}px ${m}px ${m}px)`;        // left (default)
}

/**
 * Compile one `motion` beat.
 * @param b    the beat (reel.json)
 * @param ctx  { id: "b3", t0, t1 (edit seconds, resolved by the caller), W, H, brand,
 *               resolveImage(src) -> project-relative "assets/..." path or null }
 * @returns { ok: false, reason } | { ok: true, html, lines, hideCaptions, room, sfx, warnings }
 */
export function compileMotion(b, ctx) {
  const warnings = [];
  const warn = (m) => warnings.push(`motion ${b?.id ?? "?"}: ${m}`);
  // mac-54: every element left out, as data ({ element, why }), for build/graphics-dropped.json
  const droppedEls = [];
  const dropEl = (id, m) => { warn(m); droppedEls.push({ element: typeof id === "string" ? id : null, why: m }); };
  const { id, t0, t1, W, H, brand = {} } = ctx;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const len = r3(t1 - t0);
  if (!isObj(b)) return { ok: false, reason: "not an object" };
  if (typeof b.id !== "string" || !ID_RE.test(b.id)) return { ok: false, reason: `bad id '${b.id}' (want [a-z0-9-]{1,24})` };
  // a layer (reel.layers[], kind "motion") is timed by the layer, not by words: it passes its own limits
  const minSpan = ctx.minSpan ?? LIMITS.minSpan, maxSpan = ctx.maxSpan ?? LIMITS.maxSpan;
  if (!(len >= minSpan - 1e-6 && len <= maxSpan + 1e-6)) return { ok: false, reason: `span ${len}s outside ${minSpan}..${maxSpan}s` };
  if (!Array.isArray(b.elements) || !b.elements.length) return { ok: false, reason: "no elements" };
  // room: only "below" changes anything; anything else is "none" with a warning (never a die). "below" implies hideCaptions.
  const { room, warning: roomWarning } = normalizeRoom(b.room);
  if (roomWarning) warn(roomWarning);

  // ---------- elements ----------
  const els = new Map();
  const rawEls = b.elements.slice(0, LIMITS.elements);
  if (b.elements.length > LIMITS.elements) warn(`only the first ${LIMITS.elements} elements are used`);
  for (const e of rawEls) {
    if (!isObj(e)) { dropEl(null, "element is not an object, dropped"); continue; }
    if (typeof e.id !== "string" || !ID_RE.test(e.id)) { dropEl(e.id, `element id '${e.id}' is not [a-z0-9-]{1,24}, dropped`); continue; }
    if (els.has(e.id)) { dropEl(e.id, `duplicate element id '${e.id}', dropped`); continue; }
    if (!SHAPES.includes(e.shape)) { dropEl(e.id, `element ${e.id}: unknown shape '${e.shape}', dropped`); continue; }
    const el = { id: e.id, shape: e.shape, uid: `${id}-${e.id}`, z: Math.round(num(e.z, 0, 9, 0)), opacity: num(e.opacity, 0, 1, 1), rotate: num(e.rotate, -180, 180, 0) };
    if (e.shape === "line") {
      const p = ["x", "y", "x2", "y2"].map((k) => num(e[k], -4000, 6000, NaN));
      if (p.some(Number.isNaN)) { dropEl(e.id, `element ${e.id}: line needs x, y, x2, y2, dropped`); continue; }
      const [x, y, x2, y2] = p;
      Object.assign(el, { x: Math.min(x, x2), y: Math.min(y, y2), w: Math.max(1, Math.abs(x2 - x)), h: Math.max(1, Math.abs(y2 - y)), lx1: x - Math.min(x, x2), ly1: y - Math.min(y, y2), lx2: x2 - Math.min(x, x2), ly2: y2 - Math.min(y, y2) });
    } else {
      const g = ["x", "y", "w", "h"].map((k) => num(e[k], -4000, 6000, NaN));
      if (g.some(Number.isNaN) || g[2] <= 0 || g[3] <= 0) { dropEl(e.id, `element ${e.id}: needs numeric x, y and w, h > 0, dropped`); continue; }
      [el.x, el.y, el.w, el.h] = g;
    }
    if (e.shape === "text") {
      const text = cleanText(e.text ?? "");
      if (!text) { dropEl(e.id, `element ${e.id}: empty text, dropped`); continue; }
      let font = e.font;
      if (!DESIGNER_FONTS.includes(font)) { if (font !== undefined) warn(`element ${e.id}: font '${font}' is not in DESIGNER_FONTS, using Inter`); font = "Inter"; }
      const color = e.color === undefined ? "#ffffff" : resolveColor(e.color, brand);
      if (color === null) warn(`element ${e.id}: bad colour '${e.color}', using white`);
      Object.assign(el, {
        text, font, size: num(e.size, 16, 400, 64), weight: Math.round(num(e.weight, 300, 900, 700)),
        italic: e.italic === true, upper: e.upper === true,
        align: ["left", "center", "right"].includes(e.align) ? e.align : "center",
        ls: num(e.letterSpacing, -0.1, 0.5, 0), color: color ?? "#ffffff",
        shadow: Object.hasOwn(SHADOWS, e.shadow) ? e.shadow : "none",
        split: e.split === "words" || e.split === "chars" ? e.split : "none",
      });
    } else if (e.shape === "image") {
      const src = typeof e.src === "string" ? ctx.resolveImage?.(e.src) : null;
      if (!src) { dropEl(e.id, `element ${e.id}: image src '${String(e.src).slice(0, 60)}' is not under assets/ or a library id, dropped`); continue; }
      Object.assign(el, { src, fit: e.fit === "contain" ? "contain" : "cover" });
    } else {
      const fill = e.fill === undefined || e.fill === "none" ? "none" : resolveColor(e.fill, brand);
      const stroke = e.stroke === undefined || e.stroke === "none" ? "none" : resolveColor(e.stroke, brand);
      if (fill === null) warn(`element ${e.id}: bad fill '${e.fill}', using none`);
      if (stroke === null) warn(`element ${e.id}: bad stroke '${e.stroke}', using none`);
      Object.assign(el, { fill: fill ?? "none", stroke: stroke ?? "none", sw: num(e.strokeWidth, 0, 40, stroke && stroke !== "none" ? 4 : 0), cap: ["round", "square", "butt"].includes(e.cap) ? e.cap : "round" });
      if (e.shape === "line" && el.stroke === "none") { dropEl(e.id, `element ${e.id}: a line with no stroke is invisible, dropped`); continue; }
      if (e.shape === "rect" || e.shape === "ellipse") {
        const f2 = e.fill2 === undefined ? null : resolveColor(e.fill2, brand);
        if (f2 && el.fill !== "none") Object.assign(el, { fill2: f2, angle: num(e.gradientAngle, -360, 360, 180) });
        if (e.shape === "rect") el.radius = num(e.radius, 0, 960, 0);
      }
      if (e.shape === "path") {
        if (typeof e.d !== "string" || !e.d.trim() || e.d.length > LIMITS.maxPath || !PATH_RE.test(e.d) || !/^\s*[Mm]/.test(e.d)) { dropEl(e.id, `element ${e.id}: path d is empty, too long, starts without M, or uses a command outside M L H V C S Q T A Z, dropped`); continue; }
        el.d = e.d.trim();
      }
    }
    els.set(el.id, el);
  }
  if (!els.size) return { ok: false, reason: "no valid elements", warnings, dropped: droppedEls, droppedTweens: [] };

  // ---------- tweens -> per-element plans ----------
  // plan: for each (selector, key) a list of segments {at, end, from, to}, used for the backfill at
  // t=0 and for hold tweens across gaps. A tween is emitted as one ft per selector it touches.
  const calls = [];                     // { sel, at, dur, ease, from, to }  (GSAP-ready values)
  const counts = [];                    // { el, at, dur, ease, from, to }
  const segs = new Map();               // `${sel}|${prop}` -> [{ at, end, from, to }]
  const keyFam = (k) => (k === "scale" || k === "scaleX" || k === "scaleY" ? "scale" : k);
  const used = new Map();               // `${eid}|${fam}` -> [[at,end]]
  const blurEls = new Set();
  const rawTw = Array.isArray(b.tweens) ? b.tweens.slice(0, LIMITS.tweens) : [];
  // mac-55: every tween (or tween key) left out, as data ({ tween, target, rule, why }), for build/graphics-dropped.json.
  // Clamps and ease fallbacks still animate, so they are not here.
  const droppedTw = [];
  if (Array.isArray(b.tweens) && b.tweens.length > LIMITS.tweens) {
    warn(`only the first ${LIMITS.tweens} tweens are used`);
    b.tweens.slice(LIMITS.tweens).forEach((tw, k) => droppedTw.push({ tween: LIMITS.tweens + k, target: isObj(tw) && typeof tw.target === "string" ? tw.target : null, rule: "tween-limit", why: `only the first ${LIMITS.tweens} tweens are used` }));
  }
  const drawVis = new Map(), needsDraw = new Set(), needsClip = new Map(), countFmt = new Map(), kept = [];
  const pad = (el) => (el.shape === "text" ? (el.shadow === "none" ? 8 : 28) : Math.ceil((el.sw ?? 0) / 2) + 4);

  rawTw.forEach((tw, ti) => {
    const w = (m) => warn(`tween ${ti}: ${m}`);
    const td = (m, rule) => { w(m); droppedTw.push({ tween: ti, target: isObj(tw) && typeof tw.target === "string" ? tw.target : null, rule, why: `tween ${ti}: ${m}` }); };
    if (!isObj(tw) || !isObj(tw.from) || !isObj(tw.to)) return td("needs target, from and to objects, dropped", "tween");
    const el = els.get(tw.target);
    if (!el) return td(`target '${tw.target}' is not an element of this beat, dropped`, "tween");
    const at = num(tw.at, 0, 1e4, NaN);
    if (Number.isNaN(at)) return td("at must be a number >= 0, dropped", "tween");
    let dur = num(tw.dur, 0.05, 10, NaN);
    if (Number.isNaN(dur)) return td("dur must be 0.05..10, dropped", "tween");
    if (at >= len - 0.05) return td(`starts at ${at}s, at or past the end of the beat (${len}s), dropped`, "tween");
    const ease = Object.hasOwn(EASES, tw.ease) ? EASES[tw.ease] : (tw.ease === undefined ? EASES["power2.out"] : (w(`ease '${tw.ease}' is not allowed, using power2.out`), EASES["power2.out"]));
    // stagger
    let stag = 0, units = null;
    if (tw.stagger !== undefined) {
      if (el.shape === "text" && el.split !== "none") {
        stag = num(tw.stagger, 0, 5, 0);
        units = el.split === "words" ? el.text.split(" ") : [...el.text.replace(/ /g, "")];
        if (units.length > 1 && stag > 0) stag = Math.min(stag, Math.max(0, (len - at - dur) / (units.length - 1)));
      } else td("stagger needs a text element with split set, ignored", "tween-key");
    }
    const span = at + dur + (units && stag > 0 ? (units.length - 1) * stag : 0);
    if (span > len + 1e-6) {
      if (units && stag > 0) { /* stagger already shrunk; dur may still overrun */ }
      const room = len - at - (units && stag > 0 ? (units.length - 1) * stag : 0);
      if (room < 0.05) return td("does not fit before the end of the beat, dropped", "tween");
      dur = r3(Math.min(dur, room));
      w(`ends after the beat; dur clamped to ${dur}s`);
    }
    // keys
    const revFrom = ["left", "right", "top", "bottom"].includes(tw.revealFrom) ? tw.revealFrom : ["left", "right", "top", "bottom"].includes(tw.to.revealFrom) ? tw.to.revealFrom : ["left", "right", "top", "bottom"].includes(tw.from.revealFrom) ? tw.from.revealFrom : "left";
    for (const k of Object.keys(tw.from)) if (k !== "revealFrom" && !KEYS.includes(k)) td(`key '${k}' is not animatable, ignored`, "tween-key");
    const keys = KEYS.filter((k) => k in tw.from && k in tw.to).filter((k) => (fin(tw.from[k]) && fin(tw.to[k])) || (td(`key '${k}' needs numbers in from and to, ignored`, "tween-key"), false));
    for (const k of Object.keys(tw.from)) if (KEYS.includes(k) && !(k in tw.to)) td(`key '${k}' is in from but not in to, ignored`, "tween-key");
    const lim = { x: [-4000, 4000], y: [-4000, 4000], scale: [0, 20], scaleX: [0, 20], scaleY: [0, 20], rotate: [-720, 720], opacity: [0, 1], blur: [0, 30], draw: [0, 1], reveal: [0, 1], count: [-1e12, 1e12] };
    const val = {};
    for (const k of keys) {
      if (k === "draw" && (!DRAW_SHAPES.includes(el.shape) || el.sw <= 0 || el.stroke === "none")) { td(`draw needs a stroked line, path, rect or ellipse, ignored on '${el.id}'`, "tween-key"); continue; }
      if (k === "count" && !(el.shape === "text" && el.split === "none" && parseCount(el.text))) { td(`count needs an unsplit text element whose text is a number, ignored on '${el.id}'`, "tween-key"); continue; }
      if (k === "reveal" && el.shape === "line") { td("reveal on a line is not supported, ignored", "tween-key"); continue; }
      if (k === "blur") {
        if (el.w * el.h > 0.5 * W * H) { td(`blur on '${el.id}' (over half the canvas) ignored`, "tween-key"); continue; }
        if (!blurEls.has(el.id) && blurEls.size >= LIMITS.maxBlurEls) { td(`blur on a third element ('${el.id}') ignored (max ${LIMITS.maxBlurEls})`, "tween-key"); continue; }
      }
      val[k] = [clamp(tw.from[k], ...lim[k]), clamp(tw.to[k], ...lim[k])];
    }
    // overlap: same element + key family must not overlap in time
    for (const k of Object.keys(val)) {
      const fam = `${el.id}|${keyFam(k)}`, iv = [at, r3(span > len ? len : span)];
      if ((used.get(fam) || []).some(([a, e2]) => iv[0] < e2 - 1e-6 && iv[1] > a + 1e-6)) { td(`'${k}' on '${el.id}' overlaps an earlier tween of the same key, that key ignored`, "tween-key"); delete val[k]; continue; }
      used.set(fam, [...(used.get(fam) || []), iv]);
    }
    if (!Object.keys(val).length) return td("no usable keys left, dropped", "tween");
    if ("blur" in val) blurEls.add(el.id);
    kept.push({ el, at, dur, ease, units, stag });

    const targets = units ? units.map((_, i) => ({ sel: `#${el.uid}-u${i}`, off: r3(i * stag) })) : [{ sel: `#${el.uid}-a`, off: 0 }];
    const nodeKeys = Object.keys(val).filter((k) => NODE_KEYS.includes(k));
    if (nodeKeys.length) {
      const conv = (i) => {
        const o = {};
        for (const k of nodeKeys) {
          const v = val[k][i];
          if (k === "rotate") o.rotation = v;
          else if (k === "blur") o.filter = `blur(${rd(v, 2)}px)`;
          else if (k === "reveal") o.clipPath = revealClip(v, revFrom, el.w, el.h, pad(el));
          else o[k] = rd(v, 4);
        }
        return o;
      };
      if ("reveal" in val) needsClip.set(el.uid, { el, revFrom });
      for (const t of targets) {
        const from = conv(0), to = conv(1);
        calls.push({ sel: t.sel, at: r3(at + t.off), dur, ease, from, to });
        for (const p of Object.keys(from)) {
          const kk = `${t.sel}|${p}`;
          if (!segs.has(kk)) segs.set(kk, []);
          segs.get(kk).push({ at: r3(at + t.off), end: r3(at + t.off + dur), from: from[p], to: to[p] });
        }
      }
    }
    if ("draw" in val) {
      needsDraw.add(el.uid);
      const sel = `#${el.uid}-s`, from = { strokeDashoffset: rd(1 - val.draw[0], 4) }, to = { strokeDashoffset: rd(1 - val.draw[1], 4) };
      calls.push({ sel, at: r3(at), dur, ease, from, to });
      if (!drawVis.has(el.uid)) drawVis.set(el.uid, []);
      drawVis.get(el.uid).push({ sel, at: r3(at), dur, from: val.draw[0], to: val.draw[1] });
      const kk = `${sel}|strokeDashoffset`;
      if (!segs.has(kk)) segs.set(kk, []);
      segs.get(kk).push({ at: r3(at), end: r3(at + dur), from: from.strokeDashoffset, to: to.strokeDashoffset });
    }
    if ("count" in val) {
      const f = parseCount(el.text);
      countFmt.set(el.uid, f);
      counts.push({ el, f, at: r3(at), dur, ease, from: val.count[0], to: val.count[1] });
    }
  });

  // ---------- html ----------
  const firstCount = new Map();
  for (const c of [...counts].sort((a, b2) => a.at - b2.at)) if (!firstCount.has(c.el.uid)) firstCount.set(c.el.uid, c);
  const html = [];
  const dim = num(b.dim, 0, 0.8, 0);
  let dimHtml = "";
  if (dim > 0) dimHtml = (`<div id="${id}-dim" class="ov" style="left:0;top:0;width:${W}px;height:${H}px;background:rgba(0,0,0,${rd(dim, 3)});opacity:0"></div>`);
  const sorted = [...els.values()].sort((a, b2) => a.z - b2.z);   // stable: equal z keeps reel order
  sorted.forEach((el, i) => {
    const outer = `left:${rd(el.x, 2)}px;top:${rd(el.y, 2)}px;width:${rd(el.w, 2)}px;height:${rd(el.h, 2)}px;z-index:${i + 1}${el.rotate ? `;transform:rotate(${rd(el.rotate, 2)}deg)` : ""}`;
    let inner = "";
    const sw = el.sw ?? 0;
    const dash = needsDraw.has(el.uid) ? ` pathLength="1" stroke-dasharray="1 2" stroke-dashoffset="0"` : "";
    const strokeAttr = el.stroke !== "none" && sw > 0 ? ` stroke="${el.stroke}" stroke-width="${rd(sw, 2)}" stroke-linecap="${el.cap}" stroke-linejoin="round"` : "";
    const svgOpen = (w, h) => `<svg width="${rd(w, 2)}" height="${rd(h, 2)}" viewBox="0 0 ${rd(w, 2)} ${rd(h, 2)}" style="position:absolute;left:0;top:0;overflow:visible" xmlns="http://www.w3.org/2000/svg">`;
    let fillAttr = "";
    let defs = "";
    if (el.shape === "rect" || el.shape === "ellipse" || el.shape === "path") {
      if (el.fill2) {
        const ax = gradientAxis(el.w, el.h, el.angle);
        defs = `<defs><linearGradient id="${el.uid}-g" gradientUnits="userSpaceOnUse" x1="${ax.x1}" y1="${ax.y1}" x2="${ax.x2}" y2="${ax.y2}"><stop offset="0" stop-color="${el.fill}"/><stop offset="1" stop-color="${el.fill2}"/></linearGradient></defs>`;
        fillAttr = ` fill="url(#${el.uid}-g)"`;
      } else fillAttr = ` fill="${el.fill}"`;
    }
    if (el.shape === "text") {
      const f = firstCount.get(el.uid);
      const sty = `font-family:'${el.font}',system-ui,sans-serif;font-size:${rd(el.size, 1)}px;font-weight:${el.weight};${el.italic ? "font-style:italic;" : ""}${el.upper ? "text-transform:uppercase;" : ""}letter-spacing:${rd(el.ls, 3)}em;color:${el.color};text-align:${el.align};line-height:1.05;text-shadow:${SHADOWS[el.shadow]};width:100%;height:100%;display:flex;align-items:center;justify-content:${el.align === "left" ? "flex-start" : el.align === "right" ? "flex-end" : "center"}`;
      let body;
      if (el.split === "words") body = el.text.split(" ").map((wd, i) => `<span id="${el.uid}-u${i}" style="display:inline-block">${escHtml(wd)}</span>`).join(" ");
      else if (el.split === "chars") {
        let ci = 0;
        body = el.text.split(" ").map((wd) => `<span style="display:inline-block;white-space:nowrap">${[...wd].map((ch) => `<span id="${el.uid}-u${ci++}" style="display:inline-block">${escHtml(ch)}</span>`).join("")}</span>`).join(" ");
      } else body = escHtml(f ? formatCount(f.from, f.f) : el.text);
      inner = `<div id="${el.uid}-a" style="position:absolute;left:0;top:0;width:100%;height:100%;opacity:${rd(el.opacity, 3)}"><div style="${sty}"><div style="max-width:100%;overflow-wrap:break-word">${body}</div></div></div>`;
    } else if (el.shape === "image") {
      inner = `<div id="${el.uid}-a" style="position:absolute;left:0;top:0;width:100%;height:100%;opacity:${rd(el.opacity, 3)}"><img src="${escHtml(el.src)}" style="width:100%;height:100%;object-fit:${el.fit};display:block" alt=""></div>`;
    } else {
      let shape;
      if (el.shape === "rect") shape = `<rect id="${el.uid}-s" x="${rd(sw / 2, 2)}" y="${rd(sw / 2, 2)}" width="${rd(Math.max(0.1, el.w - sw), 2)}" height="${rd(Math.max(0.1, el.h - sw), 2)}" rx="${rd(Math.min(el.radius, (el.w - sw) / 2, (el.h - sw) / 2), 2)}"${fillAttr}${strokeAttr}${dash}/>`;
      else if (el.shape === "ellipse") shape = `<ellipse id="${el.uid}-s" cx="${rd(el.w / 2, 2)}" cy="${rd(el.h / 2, 2)}" rx="${rd(Math.max(0.1, (el.w - sw) / 2), 2)}" ry="${rd(Math.max(0.1, (el.h - sw) / 2), 2)}"${fillAttr}${strokeAttr}${dash}/>`;
      else if (el.shape === "line") shape = `<line id="${el.uid}-s" x1="${rd(el.lx1, 2)}" y1="${rd(el.ly1, 2)}" x2="${rd(el.lx2, 2)}" y2="${rd(el.ly2, 2)}" fill="none"${strokeAttr}${dash}/>`;
      else shape = `<path id="${el.uid}-s" d="${escHtml(el.d)}"${fillAttr}${strokeAttr}${dash}/>`;
      inner = `<div id="${el.uid}-a" style="position:absolute;left:0;top:0;width:100%;height:100%;opacity:${rd(el.opacity, 3)}">${svgOpen(el.w, el.h)}${defs}${shape}</svg></div>`;
    }
    // data-el-id: a stable handle for the studio's live editing (motion layers and motion beats alike)
    html.push(`<div id="${el.uid}" class="ov" data-el-id="${escHtml(el.id)}" style="${outer}">${inner}</div>`);
  });

  // ---------- timeline lines ----------
  const lines = [];
  const J = JSON.stringify;
  const abs = (t) => r3(t0 + t);
  // GSAP's CSS plugin ROUNDS a px-valued stroke-dashoffset to an integer, so a 1 -> 0 draw sat at 1 until its last
  // frame and then popped. The dash offset goes through the attribute plugin (no rounding) instead.
  const gv = (o) => ("strokeDashoffset" in o ? { attr: { "stroke-dashoffset": o.strokeDashoffset } } : o);
  // backfill (value before a key's first tween = its `from`) and holds across mismatched gaps
  for (const [kk, list] of segs) {
    const sel = kk.slice(0, kk.indexOf("|")), prop = kk.slice(kk.indexOf("|") + 1);
    list.sort((a, b2) => a.at - b2.at);
    lines.push(`tl.set(${J(sel)}, ${J(gv({ [prop]: list[0].from }))}, 0);`);
    for (let i = 1; i < list.length; i++) {
      const gap = r3(list[i].at - list[i - 1].end);
      if (gap > 0.001 && list[i - 1].to !== list[i].from) lines.push(`tl.fromTo(${J(sel)}, ${J(gv({ [prop]: list[i - 1].to }))}, ${J({ ...gv({ [prop]: list[i - 1].to }), duration: gap, ease: "none", immediateRender: false })}, ${abs(list[i - 1].end)});`);
    }
  }
  // tl.fromTo directly (not ft): ft's one-off set(from, 0) on a selector's first call would overwrite the
  // backfill above with whichever tween happened to be listed first
  calls.sort((a, b2) => a.at - b2.at);
  // An overshooting ease (back.out, elastic.out) takes blur below 0, and "blur(-0.4px)" is an invalid value: the
  // browser ignores the assignment and KEEPS the previous frame's filter, the one place a frame would depend on
  // the one before it. The modifier floors it at 0 while the tween renders (modifiers run on every render, with
  // or without events).
  const FLOOR_BLUR = `(v) => String(v).replace(/\\(\\s*-[^)]*\\)/, "(0px)")`;
  for (const c of calls) {
    const to = J({ ...gv(c.to), duration: c.dur, ease: c.ease, immediateRender: false });
    lines.push(`tl.fromTo(${J(c.sel)}, ${J(gv(c.from))}, ${"filter" in c.to ? `${to.slice(0, -1)},"modifiers":{"filter":${FLOOR_BLUR}}}` : to}, ${abs(c.at)});`);
  }
  // A stroke drawn to 0 is not invisible: dash offset 1 leaves the end of the dash on the path's first point and a
  // round (or square) cap paints a dot there - before the draw starts, and flickering at sub-pixel level. So a
  // drawn shape is `visibility: hidden` exactly while its draw is 0 (hidden -> visible just after a tween
  // that starts at 0; visible -> hidden at the end of one that finishes at 0).
  for (const [, list] of drawVis) {
    list.sort((a, b2) => a.at - b2.at);
    const sel = list[0].sel;
    lines.push(`tl.set(${J(sel)}, { visibility: ${J(list[0].from > 0 ? "visible" : "hidden")} }, 0);`);
    for (const d of list) {
      if (d.from <= 0) lines.push(`tl.fromTo(${J(sel)}, { visibility: "hidden" }, { visibility: "visible", duration: 0.001, immediateRender: false }, ${abs(d.at)});`);
      if (d.to <= 0) lines.push(`tl.fromTo(${J(sel)}, { visibility: "visible" }, { visibility: "hidden", duration: ${d.dur}, ease: "none", immediateRender: false }, ${abs(d.at)});`);
    }
  }
  // count-ups: a proxy-object tween whose `v` modifier writes the text. NOT onUpdate: the renderer seeks with
  // totalTime(t + .001, suppressEvents) then totalTime(t), and a callback only fires on that second, tiny step -
  // so a jump to a time after (or before) the tween left the text stale, a frame that depended on where the
  // playhead came from. A modifier runs whenever the tween renders, which makes the text a function of time.
  const byEl = new Map();
  for (const c of counts) { if (!byEl.has(c.el.uid)) byEl.set(c.el.uid, []); byEl.get(c.el.uid).push(c); }
  for (const [uid, list] of byEl) {
    list.sort((a, b2) => a.at - b2.at);
    const f = list[0].f;
    const fmt = `(v) => ${J(f.pre)} + (Math.round(v * ${10 ** f.dec}) / ${10 ** f.dec}).${f.comma ? `toLocaleString("en-US", { minimumFractionDigits: ${f.dec}, maximumFractionDigits: ${f.dec} })` : `toFixed(${f.dec})`} + ${J(f.post)}`;
    lines.push(`(() => { const el = document.getElementById(${J(uid + "-a")}).firstChild.firstChild, fmt = ${fmt};`);
    const one = (from, to, dur, ease, at) => `  { const o = { v: ${rd(from, 6)} }; tl.fromTo(o, { v: ${rd(from, 6)} }, { v: ${rd(to, 6)}, duration: ${dur}, ease: ${J(ease)}, immediateRender: false, modifiers: { v: (x) => { el.textContent = fmt(x); return x; } } }, ${abs(at)}); }`;
    list.forEach((c, i) => {
      lines.push(one(c.from, c.to, c.dur, c.ease, c.at));
      const nxt = list[i + 1];
      if (nxt && r3(nxt.at - (c.at + c.dur)) > 0.001 && c.to !== nxt.from) lines.push(one(c.to, c.to, r3(nxt.at - (c.at + c.dur)), "none", c.at + c.dur));
    });
    lines.push(`})();`);
  }
  // dim and exit
  const exitKind = ["fade", "cut", "none"].includes(b.exit) ? b.exit : "fade";
  const fo = Math.min(0.2, len / 3);
  if (dim > 0) {
    lines.push(`ft("#${id}-dim", { opacity: 0 }, { opacity: 1, duration: ${r3(fo)}, ease: "power1.out" }, ${r3(t0)});`);
    lines.push(`ft("#${id}-dim", { opacity: 1 }, { opacity: 0, duration: ${r3(fo)}, ease: "power1.in" }, ${r3(t1 - fo)});`);
  }
  if (exitKind === "fade") lines.push(`ft("#${id}-in", { opacity: 1 }, { opacity: 0, duration: ${r3(fo)}, ease: "power1.in" }, ${r3(t1 - fo)});`);

  const sfx = b.sfx === undefined ? "whoosh" : b.sfx;
  return { ok: true, dropped: droppedEls, droppedTweens: droppedTw, html: dimHtml + `<div id="${id}-in" class="ov"${ctx.beatId != null ? ` data-beat-id="${escHtml(ctx.beatId)}"` : ""} style="left:0;top:0;width:${W}px;height:${H}px">${html.join("")}</div>`, lines, hideCaptions: b.hideCaptions === true || room === "below", room, sfx, dim, exit: exitKind, warnings };
}

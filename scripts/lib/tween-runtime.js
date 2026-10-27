/* tween-runtime.js (mac-65): the reel page's own tween runtime, in place of GSAP (removed, owner's decision 24 Oct 2026).
 * Inlined into every page by build.mjs (no network, no dependency). MIT, part of the engine.
 *
 *   var tl = tween.timeline({ paused: true });
 *   tl.fromTo(targets, from, to, at); tl.to(targets, to, at); tl.set(targets, vars, at);
 *   window.__timelines.main = tl;      // HyperFrames seeks it: tl.totalTime(t, true)
 *
 * THE RULE: every seek is a pure function of time. The page's state after tl.totalTime(t) depends on t alone, never on
 * which times were sought before or in what order (the renderer seeks any frame, in several workers). So nothing is
 * captured lazily during playback, as GSAP does: for each (element, property) the tweens are kept in a track, sorted by
 * start (ties: the order they were added), and the value at t is a fold over the ones that have started:
 *   - the tween that renders LAST in forward playback wins: a running one over a finished one, then the later start
 *     (GSAP's order: children render in start order every frame, a finished tween stops rendering);
 *   - a fromTo starts from its `from`; a to() starts from the track's own value AT ITS START (computed by the same fold,
 *     not read from the page);
 *   - before any tween of the track has started: the `from` of the earliest fromTo / set that renders immediately
 *     (immediateRender, GSAP's default for fromTo; `false` turns it off), else the element's own value (restored).
 * Base values (the element's value before any tween, for to() and for transforms) are read once, at the first seek,
 * for every element at once, before anything is written.
 *
 * Kept from GSAP on purpose, so the look moves as little as possible: the ease formulas (power, sine, expo, circ, back,
 * elastic, bounce; default power1.out), values rounded to 4 decimals, colour channels to integers, a string's exact end
 * value at progress 1 and exact start at 0, transforms composed in GSAP's order (translate(xPercent%, yPercent%)
 * translate(x, y) rotate rotateY rotateX skew scale) with translate3d while a transform tween is mid-flight unless
 * force3D: false, autoAlpha (opacity + visibility hidden at 0, inherit above; on a HyperFrames clip, an element with
 * data-start, visibility is HyperFrames' and only the opacity is written), and non-numeric strings switching to
 * their end value once their tween has started. Supported vars: duration, ease, immediateRender, repeat, yoyo, stagger (number), keyframes,
 * modifiers, onUpdate (called with the tween's state on every seek once it has started), attr, transformOrigin,
 * svgOrigin, force3D. Anything else in vars is a CSS property (camelCase or --custom) or, on a plain object target, a
 * number. Unsupported keys are listed in tween.unsupported (the parity check reads it).
 */
(function () {
  "use strict";
  var R4 = function (v) { return Math.round(v * 10000) / 10000; };
  var clamp01 = function (p) { return p < 0 ? 0 : p > 1 ? 1 : p; };

  // ---------- eases: GSAP 3's formulas ----------
  var HALF_PI = Math.PI / 2, TWO_PI = Math.PI * 2;
  var fromIn = function (easeIn) {
    return { "in": easeIn, out: function (p) { return 1 - easeIn(1 - p); }, inOut: function (p) { return p < 0.5 ? easeIn(p * 2) / 2 : 1 - easeIn((1 - p) * 2) / 2; } };
  };
  var power = function (n) {
    return { "in": n === 1 ? function (p) { return p; } : function (p) { return Math.pow(p, n); },
      out: function (p) { return 1 - Math.pow(1 - p, n); },
      inOut: function (p) { return p < 0.5 ? Math.pow(p * 2, n) / 2 : 1 - Math.pow((1 - p) * 2, n) / 2; } };
  };
  var bounceOut = function (p) {
    var n1 = 7.5625, n2 = 2.75, n3 = 1 / n2;
    return p < n3 ? n1 * p * p : p < 0.7272 ? n1 * Math.pow(p - 1.5 / n2, 2) + 0.75 : p < 0.909 ? n1 * (p -= 2.25 / n2) * p + 0.9375 : n1 * Math.pow(p - 2.625 / n2, 2) + 0.984375;
  };
  var back = function (type, overshoot) {
    var s = overshoot === undefined ? 1.70158 : overshoot;
    var easeIn = function (p) { return p ? p * p * ((s + 1) * p - s) : 0; };
    return fromIn(easeIn)[type];
  };
  var elastic = function (type, amplitude, period) {
    var p1 = amplitude >= 1 ? amplitude : 1;
    var p2 = (period || (type ? 0.3 : 0.45)) / (amplitude < 1 ? amplitude : 1);
    var p3 = p2 / TWO_PI * (Math.asin(1 / p1) || 0);
    var easeOut = function (p) { return p === 1 ? 1 : p1 * Math.pow(2, -10 * p) * Math.sin((p - p3) * p2) + 1; };
    p2 = TWO_PI / p2;
    if (type === "out") return easeOut;
    if (type === "in") return function (p) { return 1 - easeOut(1 - p); };
    return function (p) { return p < 0.5 ? (1 - easeOut(1 - p * 2)) / 2 : 0.5 + easeOut((p - 0.5) * 2) / 2; };
  };
  var FAMILIES = {
    linear: { "in": function (p) { return p; } }, none: { "in": function (p) { return p; } },
    power0: power(1), power1: power(2), power2: power(3), power3: power(4), power4: power(5),
    quad: power(2), cubic: power(3), quart: power(4), quint: power(5), strong: power(5),
    sine: fromIn(function (p) { return p === 1 ? 1 : -Math.cos(p * HALF_PI) + 1; }),
    expo: fromIn(function (p) { return Math.pow(2, 10 * (p - 1)) * p + p * p * p * p * p * p * (1 - p); }),   // GSAP 3.14's (exactly 0 at 0, 1 at 1)
    circ: fromIn(function (p) { return -(Math.sqrt(1 - p * p) - 1); }),
    bounce: { "in": function (p) { return 1 - bounceOut(1 - p); }, out: bounceOut, inOut: function (p) { return p < 0.5 ? (1 - bounceOut(1 - p * 2)) / 2 : 0.5 + bounceOut((p - 0.5) * 2) / 2; } },
  };
  var easeCache = {};
  var DEFAULT = power(2).out;   // GSAP's default ease: power1.out
  function parseEase(e) {
    if (typeof e === "function") return e;
    if (typeof e !== "string" || !e) return DEFAULT;
    if (easeCache[e]) return easeCache[e];
    var m = /^\s*([a-z]+\d?)(?:\.(in|out|inOut))?(?:\(([^)]*)\))?\s*$/i.exec(e), f = null;
    if (m) {
      var fam = m[1].toLowerCase(), type = m[2] || "out", args = m[3] ? m[3].split(",").map(Number) : [];
      if (fam === "linear" || fam === "none") f = FAMILIES.none["in"];
      else if (fam === "back") f = back(type, args.length ? args[0] : undefined);
      else if (fam === "elastic") f = elastic(type, args.length > 0 ? args[0] : 1, args.length > 1 ? args[1] : undefined);
      else if (FAMILIES[fam]) f = FAMILIES[fam][type] || null;
    }
    if (!f) unsupported["ease " + e] = 1;
    return (easeCache[e] = f || DEFAULT);
  }

  // ---------- values ----------
  var NUM_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
  var NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0], red: [255, 0, 0, 1] };
  function parseColor(c) {
    var m;
    if ((m = /^#([0-9a-f]{3,8})$/i.exec(c))) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split("").map(function (x) { return x + x; }).join("");
      var n = parseInt(h.slice(0, 6), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? R4(parseInt(h.slice(6, 8), 16) / 255) : 1];
    }
    if ((m = /^rgba?\(([^)]*)\)$/i.exec(c))) { var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    return NAMED[c.toLowerCase()] || null;
  }
  // colours inside a string become rgba(r,g,b,a) (GSAP's colour filter), so both ends have the same numbers to interpolate
  var COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black|transparent)\b/gi;
  function colorize(s) {
    return s.replace(COLOR_RE, function (c) { var v = parseColor(c); return v ? "rgba(" + v[0] + "," + v[1] + "," + v[2] + "," + v[3] + ")" : c; });
  }
  function hasColor(s) { COLOR_RE.lastIndex = 0; var r = COLOR_RE.test(s); COLOR_RE.lastIndex = 0; return r; }
  // string interpolation, GSAP-style: the END string's structure, its numbers interpolated from the start's numbers by
  // position; the exact start at 0 and the exact end at 1; a string with no numbers takes its end value once started
  function lerpString(a, b, p, key) {
    if (p <= 0) return a;
    if (p >= 1) return b;
    var A = a, B = b;
    if (hasColor(a) || hasColor(b)) { A = colorize(a); B = colorize(b); }
    var na = A.match(NUM_RE) || [], nb = B.match(NUM_RE) || [];
    if (!nb.length) return b;   // a string with no numbers takes its end value as soon as its tween has started (GSAP)
    var i = 0, inColor = [], cpos = 0;
    // which numbers of B are colour channels (rgb rounded to integers, alpha not)
    B.replace(/rgba\(([^)]*)\)/g, function (all, inner, off) { inColor.push([off, off + all.length]); return all; });
    var idx = 0;
    return B.replace(NUM_RE, function (num, off) {
      var k = idx++, s = k < na.length ? parseFloat(na[k]) : 0, e = parseFloat(num), v = s + (e - s) * p;
      var ch = -1;
      for (var c = 0; c < inColor.length; c++) if (off > inColor[c][0] && off < inColor[c][1]) { ch = (B.slice(inColor[c][0], off).match(/,/g) || []).length; break; }
      return String(ch >= 0 && ch < 3 ? Math.round(v) : R4(v));
    });
  }

  // ---------- properties ----------
  var TRANSFORM = { x: "px", y: "px", z: "px", xPercent: "%", yPercent: "%", rotation: "deg", rotate: "deg", rotationZ: "deg", rotationX: "deg", rotationY: "deg",
    scale: "", scaleX: "", scaleY: "", skewX: "deg", skewY: "deg" };
  var ALIAS = { rotate: "rotation", rotationZ: "rotation" };
  var UNITLESS = { opacity: 1, zIndex: 1, fontWeight: 1, lineHeight: 1, flexGrow: 1, flexShrink: 1, order: 1, autoAlpha: 1 };
  var RESERVED = { duration: 1, ease: 1, immediateRender: 1, repeat: 1, yoyo: 1, stagger: 1, keyframes: 1, modifiers: 1, onUpdate: 1, delay: 1, overwrite: 1,
    force3D: 1, transformOrigin: 1, svgOrigin: 1, attr: 1, paused: 1, lazy: 1, id: 1, parent: 1 };
  var unsupported = {};
  var kebab = function (k) { return k.charAt(0) === "-" ? k : k.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); }); };

  // ---------- the timeline ----------
  function Timeline() {
    this._tracks = [];          // { target, key, kind, segs: [] }
    this._trackOf = new Map();  // target -> { key -> track }
    this._els = [];             // every element target, in first-use order
    this._updates = [];         // { seg, fn, target }
    this._order = 0;
    this._end = 0;
    this._time = 0;
    this._based = false;
    this._timeScale = 1;
  }
  var TP = Timeline.prototype;
  TP._targets = function (t) {
    if (typeof t === "string") return Array.prototype.slice.call(document.querySelectorAll(t));
    if (Array.isArray(t)) return t.reduce(function (a, x) { return a.concat(TP._targets(x)); }, []);
    if (t && typeof t.length === "number" && typeof t !== "function" && !(t instanceof Element)) return Array.prototype.slice.call(t);
    return t ? [t] : [];
  };
  TP._track = function (target, key, kind) {
    var m = this._trackOf.get(target);
    if (!m) { m = {}; this._trackOf.set(target, m); if (target instanceof Element) this._els.push(target); }
    if (!m[key]) { m[key] = { target: target, key: key, kind: kind, segs: [], base: undefined }; this._tracks.push(m[key]); }
    return m[key];
  };
  // one tween: from (null for to()) / to on each target, at, dur
  TP._add = function (targets, fromVars, toVars, at, isSet) {
    var self = this, list = this._targets(targets);
    var dur = isSet ? 0 : (typeof toVars.duration === "number" ? toVars.duration : 0.5);
    var ease = parseEase(toVars.ease), stag = typeof toVars.stagger === "number" ? toVars.stagger : 0;
    var rep = (toVars.repeat | 0) > 0 ? toVars.repeat | 0 : 0, yoyo = !!toVars.yoyo;
    var imm = fromVars ? toVars.immediateRender !== false : false;
    var f3d = toVars.force3D, mods = toVars.modifiers || null;
    if (typeof toVars.stagger === "object" && toVars.stagger) unsupported["stagger object"] = 1;
    if (toVars.keyframes) return this._keyframes(list, toVars, at);
    list.forEach(function (target, i) {
      var start = +(at + i * stag).toFixed(6);
      var span = { start: start, dur: dur, ease: ease, rep: rep, yoyo: yoyo, order: self._order++, imm: imm, f3d: f3d, mods: mods };
      self._end = Math.max(self._end, start + dur * (rep + 1));
      var put = function (key, kind, fv, tv) {
        self._track(target, key, kind).segs.push({ span: span, from: fv, to: tv, alpha: kind === "alpha" });
      };
      var isEl = target instanceof Element;
      var keys = Object.keys(toVars).concat(fromVars ? Object.keys(fromVars).filter(function (k) { return !(k in toVars); }) : []);
      keys.forEach(function (k) {
        if (RESERVED[k]) return;
        var tv = k in toVars ? toVars[k] : fromVars[k], fv = fromVars && k in fromVars ? fromVars[k] : null;
        if (!isEl) { if (typeof tv === "number" || typeof tv === "string") put(k, typeof tv === "number" ? "num" : "str", fv, tv); else unsupported["object key " + k] = 1; return; }
        if (k === "autoAlpha") { put("opacity", "num", fv, tv); put("visibility", "alpha", fv, tv); return; }
        if (k === "scale") { put("scaleX", "tf", fv, tv); put("scaleY", "tf", fv, tv); return; }
        if (TRANSFORM[k] !== undefined) { put(ALIAS[k] || k, "tf", fv, tv); return; }
        put(k, typeof tv === "number" ? "css-num" : "css-str", fv, tv);
      });
      if (isEl && toVars.attr) Object.keys(toVars.attr).forEach(function (a) { put("@" + a, "attr", fromVars && fromVars.attr ? fromVars.attr[a] : null, toVars.attr[a]); });
      // force3D alone makes GSAP write the element's transform (identity at rest): a stacking context, so mirrored
      if (isEl && ("force3D" in toVars || (fromVars && "force3D" in fromVars)) && !keys.some(function (k) { return TRANSFORM[k] !== undefined; })) put("__tf", "tf", null, 0);
      ["transformOrigin", "svgOrigin"].forEach(function (k) { if (isEl && (k in toVars || (fromVars && k in fromVars))) put(k, "origin", fromVars ? fromVars[k] : null, k in toVars ? toVars[k] : fromVars[k]); });
      if (typeof toVars.onUpdate === "function") self._updates.push({ span: span, fn: toVars.onUpdate });
    });
    return this;
  };
  // keyframes [{...vars, duration, ease}]: consecutive to() tweens, the whole run repeated by the outer repeat / yoyo
  TP._keyframes = function (list, vars, at) {
    var self = this, rep = (vars.repeat | 0) > 0 ? vars.repeat | 0 : 0, total = 0;
    vars.keyframes.forEach(function (k) { total += typeof k.duration === "number" ? k.duration : 0.5; });
    for (var r = 0; r <= rep; r++) {
      var t = at + r * total;
      var frames = vars.yoyo && r % 2 ? null : vars.keyframes;
      if (!frames) { unsupported["keyframes yoyo"] = 1; frames = vars.keyframes; }
      frames.forEach(function (k) {
        var kv = {}; Object.keys(k).forEach(function (x) { kv[x] = k[x]; });
        if (kv.ease === undefined && vars.ease !== undefined) kv.ease = vars.ease;
        var d = typeof kv.duration === "number" ? kv.duration : 0.5;
        self._add(list, null, kv, +t.toFixed(6), false);
        t += d;
      });
    }
    return this;
  };
  TP.fromTo = function (t, from, to, at) { return this._add(t, from || {}, to || {}, typeof at === "number" ? at : this._end, false); };
  TP.to = function (t, vars, at) { return this._add(t, null, vars || {}, typeof at === "number" ? at : this._end, false); };
  TP.set = function (t, vars, at) { return this._add(t, null, vars || {}, typeof at === "number" ? at : this._end, true); };
  TP.from = function (t, vars, at) { unsupported["from()"] = 1; return this; };

  // progress of a span at time t (null before it starts), repeat / yoyo applied
  function progress(span, t) {
    if (t < span.start - 1e-9) return null;
    if (span.dur <= 0) return 1;
    var local = t - span.start, cycles = span.rep + 1;
    if (local >= span.dur * cycles) return span.yoyo && span.rep % 2 ? 0 : 1;
    var c = Math.floor(local / span.dur), p = (local - c * span.dur) / span.dur;
    if (span.yoyo && c % 2) p = 1 - p;
    return clamp01(p);
  }

  // ---------- base values (read once, before the first write) ----------
  function decompose(tf) {
    var b = { x: 0, y: 0, z: 0, xPercent: 0, yPercent: 0, rotation: 0, rotationX: 0, rotationY: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 };
    if (!tf || tf === "none") return b;
    var m3 = /^matrix3d\(([^)]*)\)$/.exec(tf);
    if (m3) {
      // columns: c1 (a, b, c), c2 (e, f, g), c3 (i, j, k), translation (m, n, o); R = Rz Ry Rx, scale last (GSAP's order)
      var q = m3[1].split(",").map(parseFloat), hyp = function (x, y, z) { return Math.sqrt(x * x + y * y + z * z); };
      var sx = hyp(q[0], q[1], q[2]), sy = hyp(q[4], q[5], q[6]), sz = hyp(q[8], q[9], q[10]) || 1, D = 180 / Math.PI;
      b.x = R4(q[12]); b.y = R4(q[13]); b.z = R4(q[14]);
      b.scaleX = R4(sx); b.scaleY = R4(sy);
      b.rotationY = R4(Math.asin(Math.max(-1, Math.min(1, -q[2] / sx))) * D);
      b.rotationX = R4(Math.atan2(q[6] / sy, q[10] / sz) * D);
      b.rotation = R4(Math.atan2(q[1] / sx, q[0] / sx) * D);
      return b;
    }
    var m = /^matrix\(([^)]*)\)$/.exec(tf);
    if (!m) { unsupported["base transform " + tf.slice(0, 20)] = 1; return b; }
    var v = m[1].split(",").map(parseFloat), a = v[0], bb = v[1], c = v[2], d = v[3];
    b.x = R4(v[4]); b.y = R4(v[5]);
    b.scaleX = R4(Math.sqrt(a * a + bb * bb));
    b.rotation = a || bb ? R4(Math.atan2(bb, a) * 180 / Math.PI) : 0;
    var skew = c || d ? Math.atan2(c, d) * 180 / Math.PI + b.rotation : 0;
    b.scaleY = R4(Math.sqrt(c * c + d * d) * Math.abs(Math.cos(skew * Math.PI / 180)));
    b.skewX = R4(skew);
    return b;
  }
  TP._readBases = function () {
    var self = this;
    this._baseOf = new Map();
    this._els.forEach(function (el) {
      var cs = getComputedStyle(el), m = self._trackOf.get(el), rec = { inline: {}, cs: {} };
      Object.keys(m).forEach(function (key) {
        var tr = m[key];
        if (tr.kind === "tf") return;
        if (tr.kind === "attr") { rec.inline[key] = el.getAttribute(key.slice(1)); return; }
        var css = key === "visibility" ? "visibility" : kebab(key);
        if (tr.kind === "origin") css = key === "svgOrigin" ? "transform-origin" : "transform-origin";
        rec.inline[key] = el.style.getPropertyValue(css);
        rec.cs[key] = cs.getPropertyValue(css);
      });
      if (Object.keys(m).some(function (k) { return m[k].kind === "tf"; })) {
        rec.tfInline = el.style.getPropertyValue("transform");
        rec.tfAttr = el instanceof SVGElement ? el.getAttribute("transform") : null;
        rec.tf = decompose(el instanceof SVGElement && !(el instanceof SVGSVGElement) ? "none" : cs.transform);
        // GSAP's reading of a centred element: a translate of exactly minus half its size is xPercent / yPercent -50
        // (a CSS translate(-50%, -50%)), so a tween's own xPercent: -50 replaces it instead of adding to it
        if (el.offsetWidth && rec.tf.x && Math.round(el.offsetWidth / 2) === Math.round(-rec.tf.x)) { rec.tf.xPercent = -50; rec.tf.x = 0; }
        if (el.offsetHeight && rec.tf.y && Math.round(el.offsetHeight / 2) === Math.round(-rec.tf.y)) { rec.tf.yPercent = -50; rec.tf.y = 0; }
      }
      self._baseOf.set(el, rec);
    });
    this._tracks.forEach(function (tr) {
      tr.segs.sort(function (p, q) { return p.span.start - q.span.start || p.span.order - q.span.order; });
      if (!(tr.target instanceof Element)) tr.base = tr.target[tr.key];
      else if (tr.kind === "tf") tr.base = tr.key === "__tf" ? 0 : self._baseOf.get(tr.target).tf[tr.key];
      else if (tr.kind === "attr") { var a = self._baseOf.get(tr.target).inline[tr.key]; tr.base = a === null ? null : a; }
      else { var r = self._baseOf.get(tr.target); tr.base = r.cs[tr.key]; tr.inline = r.inline[tr.key]; }
    });
    this._based = true;
  };

  // ---------- evaluation ----------
  var numOf = function (v) { return typeof v === "number" ? v : parseFloat(v); };
  function lerp(tr, a, b, p) {
    if (tr.kind === "origin") return p > 0 || a === null || a === undefined ? b : a;
    if (typeof b === "number" && (typeof a === "number" || a === null || a === undefined || !isNaN(parseFloat(a)))) {
      var s = a === null || a === undefined ? 0 : numOf(a);
      return R4(s + (b - s) * p);
    }
    var A = a === null || a === undefined ? "" : String(a), B = String(b);
    var out = lerpString(A, B, p, tr.key);
    // an overshooting ease (back, elastic) drives blur() etc. below 0, which CSS rejects: the write would be dropped and
    // the element keep whatever an earlier seek left (GSAP shows the previous value, seek-order dependent). Floored at 0.
    if (tr.key === "filter" || tr.key === "backdropFilter") out = out.replace(/\b(blur|brightness|contrast|saturate|grayscale|sepia|invert|opacity)\((-[\d.]+)/g, function (all, f) { return f + "(0"; });
    return out;
  }
  // the track's value at t: { v, seg, p } (seg null: no tween has started)
  // the winner among the started tweens is the one that renders LAST in forward playback (GSAP's order, which the
  // engine's tweens were written for): the latest min(t, end), i.e. any still-running tween over a finished one; among
  // those, the later start (then the later added). Still a pure function of t.
  var endOf = function (sp) { return sp.start + sp.dur * (sp.rep + 1); };
  function valueAt(tr, t) {
    var win = null, wp = 0, wi = -1, wk = -Infinity;
    for (var i = 0; i < tr.segs.length; i++) {
      var p = progress(tr.segs[i].span, t);
      if (p === null) continue;
      var k = Math.min(t, endOf(tr.segs[i].span));
      if (k > wk + 1e-9 || Math.abs(k - wk) <= 1e-9) { win = tr.segs[i]; wp = p; wi = i; wk = Math.max(k, wk); }
    }
    if (!win) {
      for (var j = 0; j < tr.segs.length; j++) if (tr.segs[j].span.imm && tr.segs[j].from !== null) return { v: tr.segs[j].from, seg: tr.segs[j], p: 0, pre: true };
      return { v: tr.base, seg: null, p: 0 };
    }
    var from = win.from;
    if (from === null || from === undefined) {
      if (win.fromAt === undefined) win.fromAt = valueBefore(tr, wi);   // a to(): the track's value at its own start (fixed)
      from = win.fromAt;
    }
    var e = win.span.ease, r = win.span.dur <= 0 ? 1 : wp === 0 || wp === 1 ? wp : e(wp);
    var v = lerp(tr, from, win.to, r);
    if (win.span.mods && win.span.mods[tr.key]) v = win.span.mods[tr.key](v, tr.target);
    return { v: v, seg: win, p: wp, ratio: r };
  }
  // the value just before segment i starts, from the segments before it (deterministic: a fold, not a page read)
  function valueBefore(tr, i) {
    var s = tr.segs[i], t = s.span.start;
    var sub = { kind: tr.kind, key: tr.key, target: tr.target, base: tr.base, segs: tr.segs.slice(0, i) };
    var r = valueAt(sub, t);
    return r.v;
  }
  function fmtCss(tr, v) {
    if (typeof v !== "number") return String(v);
    if (UNITLESS[tr.key] || tr.key.charAt(0) === "-") return String(v);
    return v + "px";
  }
  TP._render = function (t) {
    var self = this;
    if (!this._based) this._readBases();
    var tfOf = new Map(), pre = [], post = [];
    this._tracks.forEach(function (tr) {
      var el = tr.target, r = valueAt(tr, t);
      if (!(el instanceof Element)) {
        if (r.v !== undefined) el[tr.key] = r.v;
        // before any tween of an object has started, its first tween's modifier runs on that tween's from-value: a
        // modifier with a side effect (a count writing textContent) then shows the start state, never a later seek's
        if (!r.seg) { var s0 = tr.segs[0]; if (s0 && s0.span.mods && s0.span.mods[tr.key]) pre.push({ at: s0.span.start, order: s0.span.order, run: s0.span.mods[tr.key].bind(null, s0.from !== null && s0.from !== undefined ? s0.from : tr.base, el) }); }
        else if (r.seg.span.mods && r.seg.span.mods[tr.key]) post.push({ at: r.seg.span.start, order: r.seg.span.order, run: function () {} });
        return;
      }
      if (tr.kind === "tf") { var o = tfOf.get(el); if (!o) tfOf.set(el, o = { comp: {}, started: false, mid: false, f3d: undefined }); o.comp[tr.key] = r.v; if (r.seg) { o.started = true; if (r.p > 0 && r.p < 1 && r.seg.span.dur > 0) { o.mid = true; if (r.seg.span.f3d !== undefined) o.f3d = r.seg.span.f3d; } } return; }
      if (tr.kind === "attr") { var name = tr.key.slice(1); if (r.seg || r.pre) el.setAttribute(name, String(r.v)); else if (tr.base === null) el.removeAttribute(name); else el.setAttribute(name, tr.base); return; }
      if (tr.key === "visibility" && isClip(el)) return;   // HyperFrames owns a clip's visibility (its data-start window): opacity only
      if (tr.key === "visibility") {
        // autoAlpha (a number: hidden at 0, inherit above) and explicit visibility (a string) share this track
        if (!r.seg && !r.pre) { setInline(el, "visibility", tr.inline); return; }
        // an autoAlpha segment: hidden exactly when the opacity it drives is 0 at t (GSAP's autoAlpha)
        if (r.seg && r.seg.alpha) { var op = valueAt(self._trackOf.get(el).opacity, t); el.style.setProperty("visibility", numOf(op.v) === 0 ? "hidden" : "inherit"); return; }
        el.style.setProperty("visibility", String(r.v));
        return;
      }
      if (tr.kind === "origin") {
        if (tr.key === "svgOrigin") { el.__twSvgOrigin = r.seg || r.pre ? r.v : undefined; return; }
        if (r.seg || r.pre) el.style.setProperty("transform-origin", String(r.v)); else setInline(el, "transform-origin", tr.inline);
        return;
      }
      var css = kebab(tr.key);
      if (r.seg || r.pre) el.style.setProperty(css, fmtCss(tr, r.v));
      else setInline(el, css, tr.inline);
    });
    // object modifiers with side effects (several counts writing one text): the ones not started yet first, the one
    // starting EARLIEST last (its start state wins); then the started ones by start, the LATEST last (it wins)
    pre.sort(function (p, q) { return q.at - p.at || q.order - p.order; }).forEach(function (x) { x.run(); });
    this._tracks.forEach(function (tr) { if (tr.target instanceof Element) return; var r = valueAt(tr, t); if (r.seg) post.push({ at: r.seg.span.start, order: r.seg.span.order, tr: tr }); });
    post.filter(function (x) { return x.tr; }).sort(function (p, q) { return p.at - q.at || p.order - q.order; }).forEach(function (x) { valueAt(x.tr, t); });
    tfOf.forEach(function (o, el) {
      var rec = self._baseOf.get(el), c = o.comp, b = rec.tf;
      var any = o.started || Object.keys(c).some(function () { return false; });
      // a pre-start immediateRender from-value counts as started for the transform (GSAP renders it at creation)
      self._trackOf.get(el) && Object.keys(self._trackOf.get(el)).forEach(function (k) { var tr = self._trackOf.get(el)[k]; if (tr.kind === "tf" && valueAt(tr, t).pre) any = true; });
      if (!any) { setInline(el, "transform", rec.tfInline); if (rec.tfAttr !== null && el instanceof SVGElement) el.setAttribute("transform", rec.tfAttr); return; }
      var g = function (k) { return c[k] !== undefined && c[k] !== null ? numOf(c[k]) : b[k]; };
      if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) { el.setAttribute("transform", svgTransform(el, g)); return; }
      var use3D = o.f3d === true || (o.f3d !== false && o.mid);
      var x = g("x"), y = g("y"), z = g("z"), s = "";
      if (g("xPercent") || g("yPercent")) s += "translate(" + g("xPercent") + "%, " + g("yPercent") + "%) ";
      if (use3D || x || y || z) s += z || use3D ? "translate3d(" + x + "px, " + y + "px, " + z + "px) " : "translate(" + x + "px, " + y + "px) ";
      if (g("rotation")) s += "rotate(" + g("rotation") + "deg) ";
      if (g("rotationY")) s += "rotateY(" + g("rotationY") + "deg) ";
      if (g("rotationX")) s += "rotateX(" + g("rotationX") + "deg) ";
      if (g("skewX") || g("skewY")) s += "skew(" + g("skewX") + "deg, " + g("skewY") + "deg) ";
      if (g("scaleX") !== 1 || g("scaleY") !== 1) s += "scale(" + g("scaleX") + ", " + g("scaleY") + ") ";
      el.style.setProperty("transform", s.trim() || "translate(0px, 0px)");
    });
    // every painter on every seek, started or not: it reads tl.time() and its tween's object, both set above, so it is
    // a pure function of t. (GSAP calls onUpdate only while a tween renders, and not at all under totalTime(t, true),
    // HyperFrames' seek: a painter's writes then outlive the frame they were made for.)
    this._updates.forEach(function (u) { u.fn(); });
  };
  // a HyperFrames clip: it sets style.visibility on every [data-start] element (not video / audio / img) on every frame,
  // from the clip's window. GSAP wrote visibility only while an autoAlpha tween rendered, so the two never fought; a
  // runtime that restores state on every seek would undo HyperFrames' "hidden" and show a clip outside its window.
  function isClip(el) { return el.hasAttribute("data-start") && !/^(VIDEO|AUDIO|IMG)$/.test(el.tagName); }
  function setInline(el, css, v) { if (v) el.style.setProperty(css, v); else el.style.removeProperty(css); }
  // SVG: the transform attribute, around svgOrigin (user units) when given, else the element's own origin (0 0)
  function svgTransform(el, g) {
    var o = (el.__twSvgOrigin || "0 0").split(/[\s,]+/).map(parseFloat), ox = o[0] || 0, oy = o[1] || 0;
    var s = "translate(" + R4(g("x") + ox) + " " + R4(g("y") + oy) + ")";
    if (g("rotation")) s += " rotate(" + g("rotation") + ")";
    if (g("skewX")) s += " skewX(" + g("skewX") + ")";
    if (g("scaleX") !== 1 || g("scaleY") !== 1) s += " scale(" + g("scaleX") + " " + g("scaleY") + ")";
    return s + " translate(" + -ox + " " + -oy + ")";
  }

  // ---------- the interface HyperFrames 0.8.81 calls (measured: totalTime(t, true), progress, timeScale, duration,
  // totalDuration, pause, getChildren) and the page's own (time, seek) ----------
  TP.duration = function () { return this._end; };
  TP.totalDuration = function () { return this._end; };
  TP.time = function (t) { if (t === undefined) return this._time; this._time = t; this._render(t); return this; };
  TP.totalTime = TP.time;
  TP.seek = function (t) { return this.time(t); };
  TP.progress = function (p) { if (p === undefined) return this._end ? this._time / this._end : 0; return this.time(p * this._end); };
  TP.timeScale = function (v) { if (v === undefined) return this._timeScale; this._timeScale = v; return this; };
  TP.pause = function () { return this; };
  TP.play = function () { return this; };
  TP.paused = function () { return true; };
  TP.isActive = function () { return false; };
  TP.getChildren = function () { return []; };
  TP.kill = function () { return this; };
  TP.eventCallback = function () { return this; };

  window.tween = { timeline: function (vars) { return new Timeline(vars); }, parseEase: parseEase, unsupported: unsupported, version: "1" };
  window.__timelines = window.__timelines || {};
})();

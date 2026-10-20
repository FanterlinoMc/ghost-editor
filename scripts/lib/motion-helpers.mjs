// Motion helpers (references/reel-json.md "Motion helpers (v3.4)"): our own small easing / spring / tween / keyframe /
// path / count-up library, injected by wrapperHtml (graphic.mjs) ahead of every Prompt Motion graphic's scripts as a
// frozen, non-writable, non-configurable window.motion. Every helper is a pure function of its arguments: no state,
// no timers, no clock, no randomness. motionLib's source text IS the injected code (Function.prototype.toString),
// so the tests run exactly what the page runs. Math natives are captured when the library is built (before any graphic
// script), so a graphic that reassigns Math.pow later does not change what the helpers return.
export function motionLib() {
  "use strict";
  var M = Math, pow = M.pow, sqrt = M.sqrt, exp = M.exp, cos = M.cos, sin = M.sin, atan2 = M.atan2, abs = M.abs, PI = M.PI;
  var isArr = Array.isArray, frz = Object.freeze, Str = String, toFixed = Number.prototype.toFixed;
  function cl(p) { return p > 0 ? (p < 1 ? p : 1) : 0; }
  var C1 = 1.70158, C2 = C1 * 1.525, C3 = C1 + 1;
  var E = {
    linear: function (p) { return p; },
    quadIn: function (p) { return p * p; },
    quadOut: function (p) { return 1 - (1 - p) * (1 - p); },
    quadInOut: function (p) { return p < 0.5 ? 2 * p * p : 1 - pow(-2 * p + 2, 2) / 2; },
    cubicIn: function (p) { return p * p * p; },
    cubicOut: function (p) { return 1 - pow(1 - p, 3); },
    cubicInOut: function (p) { return p < 0.5 ? 4 * p * p * p : 1 - pow(-2 * p + 2, 3) / 2; },
    expoIn: function (p) { return p === 0 ? 0 : pow(2, 10 * p - 10); },
    expoOut: function (p) { return p === 1 ? 1 : 1 - pow(2, -10 * p); },
    expoInOut: function (p) { return p === 0 ? 0 : p === 1 ? 1 : p < 0.5 ? pow(2, 20 * p - 10) / 2 : (2 - pow(2, -20 * p + 10)) / 2; },
    backIn: function (p) { return C3 * p * p * p - C1 * p * p; },
    backOut: function (p) { return 1 + C3 * pow(p - 1, 3) + C1 * pow(p - 1, 2); },
    backInOut: function (p) { return p < 0.5 ? (pow(2 * p, 2) * ((C2 + 1) * 2 * p - C2)) / 2 : (pow(2 * p - 2, 2) * ((C2 + 1) * (p * 2 - 2) + C2) + 2) / 2; }
  };
  Object.keys(E).forEach(function (n) { var f = E[n]; E[n] = function (p) { return f(cl(p)); }; });
  function easeFn(e) {
    if (e === undefined || e === null) return E.linear;
    if (typeof e === "function") return e;
    if (typeof e === "string" && Object.prototype.hasOwnProperty.call(E, e)) return E[e];
    throw new TypeError("motion: unknown ease " + Str(e));
  }
  function lerp(a, b, k) {
    if (isArr(a)) {
      if (!isArr(b) || b.length !== a.length) throw new TypeError("motion: from/to lengths differ");
      var out = [];
      for (var i = 0; i < a.length; i++) out.push(a[i] + (b[i] - a[i]) * k);
      return out;
    }
    return a + (b - a) * k;
  }
  function progress(t, t0, t1) { return t1 > t0 ? cl((t - t0) / (t1 - t0)) : (t < t0 ? 0 : 1); }
  function tween(t, t0, t1, from, to, ease) { return lerp(from, to, easeFn(ease)(progress(t, t0, t1))); }
  function keyframes(t, kf) {
    var n = kf.length;
    if (!n) throw new TypeError("motion: keyframes needs at least one keyframe");
    if (t <= kf[0][0]) return lerp(kf[0][1], kf[0][1], 0);
    for (var i = 1; i < n; i++) if (t < kf[i][0]) return lerp(kf[i - 1][1], kf[i][1], easeFn(kf[i][2])(progress(t, kf[i - 1][0], kf[i][0])));
    return lerp(kf[n - 1][1], kf[n - 1][1], 0);
  }
  function stagger(i, each, t, delay) { return t - (delay || 0) - i * each; }
  function spring(t, o) {
    o = o || {};
    var k = o.stiffness === undefined ? 100 : o.stiffness, c = o.damping === undefined ? 10 : o.damping, m = o.mass === undefined ? 1 : o.mass;
    var from = o.from === undefined ? 0 : o.from, to = o.to === undefined ? 1 : o.to, v0 = o.velocity || 0;
    if (!(k > 0) || !(m > 0) || !(c >= 0)) throw new RangeError("motion: bad spring");
    if (t <= 0) return from;
    var w0 = sqrt(k / m), z = c / (2 * sqrt(k * m)), x0 = from - to, x;
    if (abs(z - 1) < 1e-6) x = exp(-w0 * t) * (x0 + (v0 + w0 * x0) * t);
    else if (z < 1) { var wd = w0 * sqrt(1 - z * z); x = exp(-z * w0 * t) * (x0 * cos(wd * t) + ((v0 + z * w0 * x0) / wd) * sin(wd * t)); }
    else { var q = w0 * sqrt(z * z - 1), r1 = -z * w0 + q, r2 = -z * w0 - q, b = (v0 - r1 * x0) / (r2 - r1); x = (x0 - b) * exp(r1 * t) + b * exp(r2 * t); }
    return to + x;
  }
  function countUp(t, t0, t1, from, to, o) {
    o = o || {};
    var d = o.decimals || 0, sep = o.separator === undefined ? "," : Str(o.separator), pt = o.point === undefined ? "." : Str(o.point);
    var v = tween(t, t0, t1, from, to, o.ease), s = toFixed.call(abs(v), d), neg = v < 0 && /[1-9]/.test(s);
    var dot = s.indexOf("."), ip = dot < 0 ? s : s.slice(0, dot), fp = dot < 0 ? "" : s.slice(dot + 1), g = "";
    while (ip.length > 3) { g = sep + ip.slice(-3) + g; ip = ip.slice(0, -3); }
    return (o.prefix === undefined ? "" : Str(o.prefix)) + (neg ? "-" : "") + ip + g + (fp ? pt + fp : "") + (o.suffix === undefined ? "" : Str(o.suffix));
  }
  // pathPoint: M L H V C Q Z (absolute and relative); each curve sampled at 64 fixed steps, arc length on the polyline
  function pathPoint(d, p) {
    var tok = Str(d).match(/[a-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [], i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0;
    var pts = [], NS = 64;
    function bz(a, b, c, e, u, k) { var w = 1 - u; return c ? w * w * w * a + 3 * w * w * u * b + 3 * w * u * u * c[k] + u * u * u * e : w * w * a + 2 * w * u * b + u * u * e; }
    function num() { var v = +tok[i++]; if (v !== v) throw new SyntaxError("motion: bad path " + Str(d)); return v; }
    function add(px, py, start) { pts.push([px, py, !!start || !pts.length]); }
    while (i < tok.length) {
      if (/^[a-z]$/i.test(tok[i])) cmd = tok[i++];
      else if (!cmd) throw new SyntaxError("motion: path must start with M");
      var C = cmd.toUpperCase(), rel = cmd !== C, ox = rel ? x : 0, oy = rel ? y : 0, s;
      if (C === "M") { x = ox + num(); y = oy + num(); sx = x; sy = y; add(x, y, true); cmd = rel ? "l" : "L"; }
      else if (C === "L") { x = ox + num(); y = oy + num(); add(x, y); }
      else if (C === "H") { x = ox + num(); add(x, y); }
      else if (C === "V") { y = oy + num(); add(x, y); }
      else if (C === "Z") { x = sx; y = sy; add(x, y); }
      else if (C === "C" || C === "Q") {
        var a = [x, y], b = [ox + num(), oy + num()], c = C === "C" ? [ox + num(), oy + num()] : null, e = [ox + num(), oy + num()];
        for (s = 1; s <= NS; s++) add(bz(a[0], b[0], c, e[0], s / NS, 0), bz(a[1], b[1], c, e[1], s / NS, 1));
        x = e[0]; y = e[1];
      } else throw new SyntaxError("motion: unsupported path command " + cmd);
    }
    if (!pts.length) throw new SyntaxError("motion: empty path");
    var L = [0], tot = 0, j;
    for (j = 1; j < pts.length; j++) { tot += pts[j][2] ? 0 : sqrt(pow(pts[j][0] - pts[j - 1][0], 2) + pow(pts[j][1] - pts[j - 1][1], 2)); L.push(tot); }
    var want = cl(p) * tot, ang = 0, k1 = 1;
    for (j = 1; j < pts.length; j++) if (!pts[j][2] && L[j] > L[j - 1]) { k1 = j; if (L[j] >= want) break; }
    var P0 = pts[k1 - 1] || pts[0], P1 = pts[k1] || pts[0], seg = L[k1] - L[k1 - 1] || 0, f = seg > 0 ? cl((want - L[k1 - 1]) / seg) : 0;
    if (pts.length > 1 && seg > 0) ang = atan2(P1[1] - P0[1], P1[0] - P0[0]) * 180 / PI;
    return tot > 0 ? { x: P0[0] + (P1[0] - P0[0]) * f, y: P0[1] + (P1[1] - P0[1]) * f, angle: ang } : { x: pts[0][0], y: pts[0][1], angle: 0 };
  }
  return frz({ version: "3.4", ease: frz(E), spring: spring, stagger: stagger, tween: tween, keyframes: keyframes, pathPoint: pathPoint, countUp: countUp });
}
// the injected text: one statement, window.motion non-writable / non-configurable, the object and motion.ease frozen
// (the source with its indentation and whole-line // comments dropped: smaller, same code)
export const MOTION_SRC = motionLib.toString().split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).join("\n");
export const MOTION_SNIPPET = `Object.defineProperty(window, "motion", { value: (${MOTION_SRC})(), writable: false, configurable: false, enumerable: true });`;

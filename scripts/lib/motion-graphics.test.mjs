#!/usr/bin/env node
// Asserts the `motion` beat compiler (lib/motion-graphics.mjs).
//
//   node scripts/lib/motion-graphics.test.mjs
//
// Pure string work: no browser, no files except the template font listing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileMotion, DESIGNER_FONTS, resolveColor, parseCount, formatCount, revealClip } from "./motion-graphics.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`ok    ${label}`);
  else { failures++; console.log(`FAIL  ${label}${detail ? " - " + detail : ""}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ctx = { id: "b3", t0: 10, t1: 14, W: 1080, H: 1920, brand: { accent: "#F2C14E", ink: "#111111" }, resolveImage: (s) => (s === "assets/ok.png" ? s : null) };
const beat = (extra = {}) => ({ type: "motion", by: "designer", id: "m1", at: 1, to: 5, elements: [{ id: "t", shape: "text", x: 100, y: 200, w: 800, h: 200, text: "Hello", font: "Inter", size: 120 }], tweens: [], ...extra });
const run = (b, c = ctx) => compileMotion(b, c);

// fonts: every DESIGNER_FONTS family has a file in templates/fonts, named the way build.mjs's @font-face loop names it
const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(path.join(here, "..", "..", "templates", "fonts")).filter((f) => f.endsWith(".woff2"));
const FONT_NAMES = { "instrument-serif": "Instrument Serif", "caveat-brush": "Caveat Brush", yellowtail: "Yellowtail", "eb-garamond": "EB Garamond", "playfair-display": "Playfair Display", "jetbrains-mono": "JetBrains Mono", "geist-mono": "GeistMono" };
const loaded = new Set(files.map((f) => { const m = /^(.*?)-(latin-ext|latin|cyrillic|arabic)/.exec(f); return FONT_NAMES[m[1]] || m[1].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "); }));
for (const f of DESIGNER_FONTS) check(`DESIGNER_FONTS '${f}' is loaded by the composition`, loaded.has(f));

// colours
eq("hex passes", resolveColor("#ABCDEF"), "#abcdef");
eq("alpha hex becomes rgba", resolveColor("#ff000080", {}), "rgba(255,0,0,0.502)");
eq("accent token", resolveColor("accent", ctx.brand), "#f2c14e");
eq("paper token has a default", resolveColor("paper", ctx.brand), "#f4efe6");
eq("a name is not a colour", resolveColor("red"), null);
eq("a url is not a colour", resolveColor("url(http://x)"), null);
eq("css injection is not a colour", resolveColor("#fff;background:url(x)"), null);

// counts
eq("parseCount plain", parseCount("1,200+"), { pre: "", dec: 0, comma: true, post: "+" });
eq("parseCount money", parseCount("$4.50k"), { pre: "$", dec: 2, comma: false, post: "k" });
eq("parseCount rejects words", parseCount("many"), null);
eq("formatCount commas", formatCount(1234.4, parseCount("1,200+")), "1,234+");
eq("formatCount decimals", formatCount(2.345, parseCount("$4.50k")), "$2.35k");

// beat-level drops
check("span under 0.6 s drops the beat", run(beat(), { ...ctx, t1: 10.5 }).ok === false);
check("span over 8 s drops the beat", run(beat(), { ...ctx, t1: 19 }).ok === false);
check("bad beat id drops the beat", run(beat({ id: "Bad Id" })).ok === false);
check("no elements drops the beat", run(beat({ elements: [] })).ok === false);
check("a minimal beat compiles", run(beat()).ok === true);

// escaping and injection
{
  const r = run(beat({ elements: [{ id: "t", shape: "text", x: 0, y: 0, w: 500, h: 100, text: `<img src=x onerror="alert(1)">&"'`, font: "Inter", size: 50 }] }));
  check("text is escaped", r.ok && !r.html.includes("<img") && r.html.includes("&lt;img") && r.html.includes("&amp;") && r.html.includes("&quot;"));
  check("no URL scheme or script reaches the page", !/https?:|javascript:|<script|url\(/i.test(r.html));
}
{
  const r = run(beat({ elements: [{ id: "t", shape: "text", x: 0, y: 0, w: 500, h: 100, text: "x".repeat(200), font: "Comic Sans", size: 9999, color: "javascript:1" }] }));
  check("text is cut to 80 chars", r.ok && !r.html.includes("x".repeat(81)) && r.html.includes("x".repeat(80)));
  check("size clamps to 400", r.ok && r.html.includes("font-size:400px"));
  check("unknown font falls back to Inter with a warning", r.ok && r.html.includes("font-family:'Inter'") && r.warnings.some((w) => w.includes("DESIGNER_FONTS")));
  check("bad colour falls back to white", r.ok && r.html.includes("color:#ffffff"));
}

// images only under assets/ or a library id
{
  const el = (src) => beat({ elements: [{ id: "i", shape: "image", x: 0, y: 0, w: 300, h: 300, src }, { id: "t", shape: "text", x: 0, y: 400, w: 300, h: 100, text: "keep", font: "Inter" }] });
  check("image under assets/ is kept", run(el("assets/ok.png")).html.includes('src="assets/ok.png"'));
  for (const bad of ["https://evil.test/a.png", "//evil.test/a.png", "file:///etc/passwd", "../x.png", "data:image/png;base64,AAAA"]) {
    const r = run(el(bad));
    check(`image src '${bad}' is dropped, the rest stays`, r.ok && !r.html.includes("<img") && r.html.includes("keep"));
  }
}

// shapes
{
  const r = run(beat({ elements: [
    { id: "r", shape: "rect", x: 10, y: 10, w: 400, h: 200, fill: "accent", fill2: "#000000", gradientAngle: 90, radius: 40, stroke: "ink", strokeWidth: 6 },
    { id: "e", shape: "ellipse", x: 10, y: 300, w: 200, h: 200, fill: "#ffffff" },
    { id: "l", shape: "line", x: 100, y: 700, x2: 500, y2: 900, stroke: "#ffffff", strokeWidth: 8, cap: "round" },
    { id: "p", shape: "path", x: 100, y: 1000, w: 300, h: 300, d: "M0 0 C 100 0 200 300 300 300", stroke: "accent", strokeWidth: 10 },
  ] }));
  check("all four SVG shapes compile", r.ok && ["<rect", "<ellipse", "<line", "<path", "linearGradient"].every((t) => r.html.includes(t)));
  check("shape colours resolve tokens", r.html.includes("#f2c14e") && r.html.includes("#111111"));
}
{
  const bad = run(beat({ elements: [
    { id: "p1", shape: "path", x: 0, y: 0, w: 100, h: 100, d: "M0 0 L 10 10 <script>", stroke: "#ffffff" },
    { id: "p2", shape: "path", x: 0, y: 0, w: 100, h: 100, d: "L0 0", stroke: "#ffffff" },
    { id: "p3", shape: "path", x: 0, y: 0, w: 100, h: 100, d: "M" + " 1".repeat(1100), stroke: "#ffffff" },
    { id: "t", shape: "text", x: 0, y: 0, w: 100, h: 100, text: "ok", font: "Inter" },
  ] }));
  check("path with a script, with no M, or over 2000 chars is dropped", bad.ok && !bad.html.includes("<path") && bad.warnings.length === 3);
}

// tweens: the compiled lines
{
  const b = beat({ tweens: [{ target: "t", at: 0, dur: 0.5, ease: "back.out", from: { y: 80, opacity: 0, scale: 0.6 }, to: { y: 0, opacity: 1, scale: 1 } }] });
  const r = run(b);
  const l = r.lines.join("\n");
  check("tween becomes a fromTo with immediateRender false", /tl\.fromTo\("#b3-t-a", \{"y":80,"scale":0\.6,"opacity":0\}, \{"y":0,"scale":1,"opacity":1,"duration":0\.5,"ease":"back\.out\(1\.7\)","immediateRender":false\}, 10\)/.test(l), l);
  check("backfill: the value before the first tween is its from, set at t=0", l.includes('tl.set("#b3-t-a", {"y":80}, 0);') && l.includes('tl.set("#b3-t-a", {"opacity":0}, 0);'), l);
  check("beat time is added to the tween time", l.includes(", 10);"), l);
}
{
  const b = beat({ tweens: [
    { target: "t", at: 0, dur: 0.4, from: { x: -100 }, to: { x: 0 } },
    { target: "t", at: 1.4, dur: 0.4, from: { x: 50 }, to: { x: 200 } },   // gap, and 0 != 50: needs a hold
    { target: "t", at: 1.0, dur: 0.6, from: { x: 0 }, to: { x: 1 } },      // overlaps the second on x
  ] });
  const r = run(b);
  const l = r.lines.join("\n");
  check("a mismatched gap gets a hold of the earlier `to`", l.includes('tl.fromTo("#b3-t-a", {"x":0}, {"x":0,"duration":1,"ease":"none","immediateRender":false}, 10.4);'), l);
  check("overlapping tweens on one key drop the later one", r.warnings.some((w) => w.includes("overlaps")), r.warnings.join("|"));
}
{
  const r = run(beat({ tweens: [
    { target: "t", at: 0, dur: 1, from: { x: 0 }, to: { x: 10 } },
    { target: "nope", at: 0, dur: 1, from: { x: 0 }, to: { x: 10 } },
    { target: "t", at: 0, dur: 1, from: { x: 0 } },
    { target: "t", at: 3.99, dur: 1, from: { y: 0 }, to: { y: 5 } },
    { target: "t", at: 2, dur: 5, from: { y: 0 }, to: { y: 5 } },
  ] }));
  check("tween to a missing target, without `to`, or starting at the end is dropped", r.warnings.filter((w) => /dropped/.test(w)).length === 3, r.warnings.join("|"));
  check("a tween running past the beat end has its dur clamped", r.lines.join("\n").includes('"duration":2,'), r.lines.join("\n"));
}
{
  const r = run(beat({ tweens: [{ target: "t", at: 0, dur: 1, ease: "bounce", from: { x: 0 }, to: { x: 1 } }] }));
  check("an unknown ease falls back to power2.out", r.lines.join("").includes('"ease":"power2.out"'));
}

// draw
{
  const b = beat({ elements: [{ id: "p", shape: "path", x: 0, y: 0, w: 300, h: 300, d: "M0 0 L300 300", stroke: "#ffffff", strokeWidth: 8 }], tweens: [{ target: "p", at: 0, dur: 1, ease: "none", from: { draw: 0 }, to: { draw: 1 } }] });
  const r = run(b);
  check("draw uses pathLength 1 with a dash pattern longer than the path", r.html.includes('pathLength="1"') && r.html.includes('stroke-dasharray="1 2"'));
  check("draw tweens dashoffset 1 -> 0 on the shape", r.lines.join("").includes('"#b3-p-s", {"strokeDashoffset":1}, {"strokeDashoffset":0'));
  const bad = run(beat({ tweens: [{ target: "t", at: 0, dur: 1, from: { draw: 0 }, to: { draw: 1 } }] }));
  check("draw on text is ignored", bad.warnings.some((w) => w.includes("draw needs")));
}

// reveal
{
  const b = beat({ tweens: [{ target: "t", at: 0, dur: 1, from: { reveal: 0 }, to: { reveal: 1 }, revealFrom: "left" }] });
  const l = run(b).lines.join("");
  check("reveal tweens a clip-path inset", l.includes('"clipPath":"inset(') && l.includes("tl.fromTo"));
  eq("reveal 0 from the left hides everything", revealClip(0, "left", 800, 200, 8), "inset(-8px 808px -8px -8px)");
  eq("reveal 1 shows the box and its padding", revealClip(1, "left", 800, 200, 8), "inset(-8px -8px -8px -8px)");
  eq("reveal from the top", revealClip(0, "top", 800, 200, 8), "inset(-8px -8px 208px -8px)");
}

// blur limits
{
  const el = (id, w = 200, h = 200) => ({ id, shape: "rect", x: 0, y: 0, w, h, fill: "#ffffff" });
  const tw = (t) => ({ target: t, at: 0, dur: 1, from: { blur: 20 }, to: { blur: 0 } });
  const r = run(beat({ elements: [el("a"), el("b"), el("c"), el("big", 1000, 1500)], tweens: [tw("a"), tw("b"), tw("c"), { ...tw("big"), target: "big" }] }));
  check("blur on a third element is dropped", r.warnings.some((w) => w.includes("third element")));
  check("blur on an element over half the canvas is dropped", r.warnings.some((w) => w.includes("over half")));
  check("blur compiles to filter: blur(px)", r.lines.join("").includes('"filter":"blur(20px)"'));
}

// split + stagger
{
  const b = beat({ elements: [{ id: "t", shape: "text", x: 0, y: 0, w: 900, h: 200, text: "one two three", font: "Inter", size: 100, split: "words" }], tweens: [{ target: "t", at: 0.2, dur: 0.4, stagger: 0.1, from: { y: 40, opacity: 0 }, to: { y: 0, opacity: 1 } }] });
  const r = run(b);
  const l = r.lines.join("\n");
  check("words become spans", ["u0", "u1", "u2"].every((u) => r.html.includes(`id="b3-t-${u}"`)));
  check("one baked fromTo per word with offsets", l.includes('"#b3-t-u0"') && l.includes(", 10.2);") && l.includes(", 10.3);") && l.includes(", 10.4);"), l);
  const c = run(beat({ elements: [{ id: "t", shape: "text", x: 0, y: 0, w: 900, h: 200, text: "ab cd", font: "Inter", split: "chars" }], tweens: [{ target: "t", at: 0, dur: 0.3, stagger: 0.05, from: { opacity: 0 }, to: { opacity: 1 } }] }));
  check("chars become spans (spaces are not units)", c.html.includes('id="b3-t-u3"') && !c.html.includes('id="b3-t-u4"'));
  const ns = run(beat({ tweens: [{ target: "t", at: 0, dur: 0.3, stagger: 0.05, from: { opacity: 0 }, to: { opacity: 1 } }] }));
  check("stagger without split is ignored with a warning", ns.warnings.some((w) => w.includes("stagger needs")));
  const long = run(beat({ elements: [{ id: "t", shape: "text", x: 0, y: 0, w: 900, h: 200, text: "a b c d e f g h", font: "Inter", split: "words" }], tweens: [{ target: "t", at: 0, dur: 0.5, stagger: 2, from: { opacity: 0 }, to: { opacity: 1 } }] }));
  const ends = long.lines.filter((x) => x.startsWith("tl.fromTo")).map((x) => /, ([\d.]+)\);$/.exec(x)[1] * 1);
  check("stagger shrinks so the last word still ends inside the beat", Math.max(...ends) + 0.5 <= 14 + 1e-6, JSON.stringify(ends));
}

// count
{
  const b = beat({ elements: [{ id: "n", shape: "text", x: 0, y: 0, w: 900, h: 300, text: "1,200", font: "Inter", size: 200 }], tweens: [{ target: "n", at: 0, dur: 1.5, ease: "power2.out", from: { count: 0 }, to: { count: 1200 } }] });
  const r = run(b);
  const l = r.lines.join("\n");
  check("count is a proxy-object tween", l.includes("const o = { v: 0 }") && l.includes("tl.fromTo(o,") && l.includes("onUpdate"), l);
  check("count shows the from value before the first tween", r.html.includes(">0<"), r.html);
  check("count on a non-number is ignored", run(beat({ tweens: [{ target: "t", at: 0, dur: 1, from: { count: 0 }, to: { count: 5 } }] })).warnings.some((w) => w.includes("count needs")));
}

// dim, exit, captions, sfx
{
  const r = run(beat({ dim: 0.6, hideCaptions: true, sfx: "none" }));
  check("dim adds a full-canvas layer faded in and out", r.html.includes('id="b3-dim"') && r.lines.join("").includes('"#b3-dim"') && r.dim === 0.6);
  check("dim is clamped to 0.8", run(beat({ dim: 5 })).html.includes("rgba(0,0,0,0.8)"));
  check("hideCaptions and sfx are passed through", r.hideCaptions === true && r.sfx === "none");
  check("exit fade (default) fades the wrapper over 0.2 s", run(beat()).lines.join("").includes('ft("#b3-in", { opacity: 1 }, { opacity: 0, duration: 0.2'));
  check("exit cut and exit none add nothing", run(beat({ exit: "cut" })).lines.length === 0 && run(beat({ exit: "none" })).lines.length === 0);
  eq("default sfx is whoosh", run(beat()).sfx, "whoosh");
}

// limits
{
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, shape: "rect", x: 0, y: 0, w: 50, h: 50, fill: "#fff" }));
  const r = run(beat({ elements: many }));
  check("only 12 elements are kept", (r.html.match(/class="ov" style="left:0px/g) || []).length === 12 && r.warnings.some((w) => w.includes("12 elements")));
  const tws = Array.from({ length: 40 }, (_, i) => ({ target: "e0", at: i * 0.05, dur: 0.05, from: { x: 0 }, to: { x: 1 } }));
  const r2 = run(beat({ elements: many, tweens: tws }));
  check("only 30 tweens are kept", r2.warnings.some((w) => w.includes("30 tweens")));
  check("duplicate element ids are dropped", run(beat({ elements: [many[0], many[0]] })).warnings.some((w) => w.includes("duplicate")));
}

// determinism of the compiler itself: same input, same bytes
{
  const b = beat({ dim: 0.3, tweens: [{ target: "t", at: 0, dur: 0.5, from: { y: 50, opacity: 0 }, to: { y: 0, opacity: 1 } }] });
  const a = JSON.stringify(run(b)), c = JSON.stringify(run(JSON.parse(JSON.stringify(b))));
  check("the compiler is deterministic", a === c);
  check("no Date, Math.random or CSS animation in the output", !/Date|Math\.random|@keyframes|animation:|transition:/.test(a));
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall ok");

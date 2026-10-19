#!/usr/bin/env node
// node scripts/build-popcard-defocus.test.mjs        (GSAP_JS=<path to gsap.min.js 3.14.2> to force the real-GSAP seek)
// A popcard defocuses and dims the camera behind it by tweening #fx's filter (the layer that wraps every take's <video>, the
// cut-out and the behind layers). In Pitch (look.refocus + captions.energyPunch) more tweens drive that same filter - the
// refocus pull after a page, the energy punch, a leak's bloom - and each ended on "blur(0px) brightness(1)", so one landing
// inside a card re-sharpened the speaker for the rest of it. In the Pitch acceptance reel the 11.8 s energy span punches
// inside the card after the take join, so it looked like "popcards after a join don't blur".
// Which of two overlapping GSAP tweens on a property shows depends on the seek (forward frame by frame: the one that updates
// last; a jump: the later start), so every case is checked under both:
//   - #take-1 (the second take's video) and #matte-1 are inside #fx
//   - inside every card hold (its defocus done .. its focus-return starting) the camera is at least the card's blur and dim
//   - after every card (its focus-return done) the camera is sharp again on every frame no other #fx tween is moving
//   - edges: a punch 10 ms before the return (ends after the card: must end sharp), a pull 10 ms before the card, an outFade
//     card with a punch 0.1 s before its return, look.refocus.dur 0.6, a leak bloom inside a card
//   - opt-in: no overlap, the exact pre-fix tweens
// The real GSAP is used when it is found (GSAP_JS, or the fork's vendor/gsap/3.14.2/gsap.min.js); without it the frames where
// every #fx tween has settled are checked against both seek orders' rules.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const GSAP_JS = [process.env.GSAP_JS, path.join(HERE, "..", "vendor", "gsap", "3.14.2", "gsap.min.js")].find((p) => p && fs.existsSync(p));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-popcard-defocus-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 10, FPS = 30, JOIN = 4.9;
ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));
// the matte is stubbed (never remove-background in a test)
ff("-f", "lavfi", "-i", `color=c=black@0.0:size=108x192:rate=${FPS}:duration=${SEC},format=yuva420p`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", path.join(root, "talk-matte.webm"));
const text = "today your child is due for four shots and i say it this way because studies show it works and parents who hear it this way are more likely to say yes".split(" ");
const words = { segments: [{ start: 0, end: SEC, words: text.map((w, i) => ({ word: w, start: +(0.2 + i * 0.3).toFixed(2), end: +(0.42 + i * 0.3).toFixed(2) })) }] };
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 6 }, (_, i) => [i * 2, 400, 1000, 340, 740, 560, 800]) };

let n = 0;
function build(beats, energy, extra = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.copyFileSync(path.join(root, "talk-matte.webm"), path.join(dir, "assets", "talk-matte.webm"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  // two takes, a hard join at edit 4.9 s (recording 5.0 s): after it, edit time = recording time - 0.1
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "popcard-defocus", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0, style: "pitch", matte: true,
    takes: [{ a: 0, b: JOIN }, { a: 5.0, b: SEC }], captions: { energy }, beats, ...extra }, null, 2));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary(), PHANTASIC_SFX_PACK: path.join(root, "no-such-pack") } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return fs.readFileSync(path.join(dir, "index.html"), "utf8");
}
// every #fx tween line, as written into the page
const fxLines = (html) => html.split("\n").map((l) => l.trim()).filter((l) => /^tl\.(to|fromTo|set)\("#fx"/.test(l));
const tw = (line) => {
  const m = line.match(/^tl\.(to|fromTo|set)\("#fx", (\{[^}]*\})(?:, (\{[^}]*\}))?, ([\d.]+)\);$/);
  const to = m[3] ?? m[2];
  return { kind: m[1], start: +m[4], dur: +(to.match(/duration: ([\d.]+)/)?.[1] ?? 0), filter: to.match(/filter: "([^"]*)"/)?.[1] };
};
// the popcard holds read off the card's own pair of to() tweens: { a, aEnd, b, bEnd, blur, dim }
const holds = (html) => {
  const ts = fxLines(html).map(tw), out = [];
  ts.forEach((t, i) => {
    const m = t.kind === "to" && t.dur === 0.25 && t.filter?.match(/^blur\((\d+)px\) brightness\(([\d.]+)\)$/), r = ts[i + 1];
    if (m && +m[1] > 0 && +m[2] < 1 && r?.kind === "to" && r.filter === "blur(0px) brightness(1)" && r.dur !== 0.25) out.push({ a: t.start, aEnd: t.start + t.dur, b: r.start, bEnd: r.start + r.dur, blur: +m[1], dim: +m[2] });
  });
  return out;
};
const parse = (f) => { const m = f.match(/blur\(([\d.]+)px\) brightness\(([\d.]+)\)/); return { blur: +m[1], bright: +m[2] }; };
const frames = (a, b) => { const out = []; for (let k = Math.ceil(a * FPS - 1e-6); k / FPS < b - 1e-6; k++) out.push(k / FPS); return out; };

// the #fx filter at each frame time, under a forward frame-by-frame seek and under a jump straight to the frame
function filterAt(html, times) {
  const lines = fxLines(html);
  if (GSAP_JS) {
    const run = (forward) => {
      const ctx = { console, setTimeout, clearTimeout, requestAnimationFrame: (f) => setTimeout(f, 16), cancelAnimationFrame: clearTimeout }; ctx.window = ctx; ctx.self = ctx; vm.createContext(ctx);
      vm.runInContext(fs.readFileSync(GSAP_JS, "utf8"), ctx);
      const mk = () => { const FX = { filter: "blur(0px) brightness(1)", scale: 1 }; const tl = ctx.gsap.timeline({ paused: true }); new Function("tl", "FX", lines.map((l) => l.replace('"#fx"', "FX")).join("\n"))(tl, FX); return [tl, FX]; };
      if (forward) { const [tl, FX] = mk(); const out = new Map(); for (let k = 0; k <= Math.ceil(SEC * FPS); k++) { tl.seek(k / FPS, false); out.set(k, FX.filter); } return times.map((t) => out.get(Math.round(t * FPS))); }
      return times.map((t) => { const [tl, FX] = mk(); tl.seek(t, false); return FX.filter; });
    };
    return { forward: run(true), jump: run(false) };
  }
  // no GSAP: only frames where every #fx tween has settled; forward = the latest-ending one shows (ties: later start), jump = the latest start
  const ts = lines.map(tw).filter((t) => t.filter);
  const settled = (t) => !ts.some((x) => x.start <= t + 1e-9 && t < x.start + x.dur - 1e-9);
  const pick = (t, key) => { const done = ts.filter((x) => x.start <= t + 1e-9); return done.sort((p, q) => key(p) - key(q) || p.start - q.start).at(-1)?.filter ?? "blur(0px) brightness(1)"; };
  return { forward: times.map((t) => settled(t) ? pick(t, (x) => x.start + x.dur) : null), jump: times.map((t) => settled(t) ? pick(t, (x) => x.start) : null) };
}
// inside every hold: at least the card's blur and dim (a leak's bloom may brighten it); after every hold, wherever no other #fx tween moves: sharp
function assertCards(html, label, { bloom = false } = {}) {
  const hs = holds(html), ts = fxLines(html).map(tw);
  assert.ok(hs.length, `${label}: a popcard hold`);
  for (const h of hs) {
    const next = Math.min(SEC, ...hs.filter((o) => o.a > h.a).map((o) => o.a));
    // a tween that starts inside the card and outlives it (ends after the return) keeps its sharp end by design: the camera
    // starts coming back when it starts, so the hold is checked up to there
    const leaver = Math.min(h.b, ...ts.filter((x) => x.filter && x.start >= h.a && x.start < h.b && x.start + x.dur > h.bEnd + 1e-6).map((x) => x.start));
    const inside = frames(h.aEnd + 1e-3, leaver);
    const afterT = frames(h.bEnd + 1e-3, next).filter((t) => !ts.some((x) => x !== undefined && x.start <= t + 1e-9 && t < x.start + x.dur - 1e-9 && !(x.start === h.b)));
    assert.ok(afterT.length, `${label}: frames after the card at ${h.a}`);
    for (const [order, vals] of Object.entries(filterAt(html, [...inside, ...afterT]))) vals.forEach((f, k) => {
      if (f == null) return;
      const t = k < inside.length ? inside[k] : afterT[k - inside.length], { blur, bright } = parse(f);
      if (k < inside.length) assert.ok(blur >= h.blur - 0.01 && (bloom || bright <= h.dim + 0.005), `${label} (${order} seek): at ${t.toFixed(3)} s inside the card ${h.a}..${h.b} the camera is "${f}", not defocused`);
      else assert.ok(blur < 0.01 && Math.abs(bright - 1) < 0.005, `${label} (${order} seek): at ${t.toFixed(3)} s after the card ${h.a}..${h.bEnd} the camera is "${f}", not sharp`);
    });
  }
  return hs;
}
const check = (label) => console.log(`ok    ${label}${GSAP_JS ? " [real GSAP]" : " [settled frames]"}`);

// as in the Pitch acceptance reel: a highlight page ends just before the after-join card and an energy span opens inside it
const PAGE = { type: "scene", kind: "highlight", at: 5.1, to: 5.3, lines: [{ text: "are more likely", at: 5.1 }] };
const BEFORE = { type: "popcard", ui: { type: "tokens", text: "How many tokens" }, label: "before", at: 2.2, to: 3.6 };
const AFTER = { type: "popcard", ui: { type: "bars", title: "Uptake", labels: ["Ask", "Tell"] }, label: "after", at: 5.4, to: 7.2 };
const ENERGY = [[0.1, 0.5], [6.1, 7.0]];

after(() => fs.rmSync(root, { recursive: true, force: true }));
if (!GSAP_JS) console.log("note  no gsap.min.js found (GSAP_JS / vendor/gsap/3.14.2): checking settled frames only");

test("a popcard after the take join keeps the speaker (take 2 inside #fx) defocused, and sharp again after it", () => {
  const html = build([PAGE, BEFORE, AFTER], ENERGY);
  const fx = html.indexOf('<div id="fx">'), t1v = html.indexOf('<video id="take-1"'), m1 = html.indexOf('<video id="matte-1"');
  assert.ok(fx >= 0 && t1v > fx && m1 > fx, "#take-1 (the second take's video) and #matte-1 are inside #fx");
  const hs = assertCards(html, "join reel");
  assert.ok(hs.length === 2 && hs[0].bEnd < JOIN && hs[1].a > JOIN, `one card before the join, one after: ${JSON.stringify(hs)}`);
  check("cards before and after the join: defocused inside (energy punch inside the after-join card), sharp after");
});

test("edges: a punch 10 ms before the return, a pull 10 ms before the card", () => {
  // after-join card: edit 5.3..7.1, return at 6.8; the page ends at edit 5.29, the punch starts at edit 6.79
  const html = build([{ ...PAGE, to: 5.39 }, AFTER], [[0.1, 0.5], [6.91, 7.6]]);
  assert.ok(fxLines(html).some((l) => /, 6\.79\);$/.test(l)) && fxLines(html).some((l) => /, 5\.29\);$/.test(l)), "the edge tweens are where the case says");
  assertCards(html, "edges");
  check("punch crossing the return ends sharp after the card; pull crossing the card's start settles defocused");
});

test("edges: an outFade card with a punch 0.1 s before its return; look.refocus.dur 0.6", () => {
  // card edit 2.2..3.6 with outFade 0.18: return at 3.46 for 0.14 s; the punch at 3.36; a page ending at 2.0 pulls for 0.6 s into the card
  const html = build([{ type: "scene", kind: "highlight", at: 1.6, to: 2.0, lines: [{ text: "are more likely", at: 1.6 }] }, { ...BEFORE, outFade: 0.18 }, { ...AFTER, at: 6.4, to: 8.2 }], [[0.1, 0.5], [3.38, 4.2], [7.6, 8.3]],
    { look: { refocus: { blur: 20, dur: 0.6 } } });
  assert.ok(fxLines(html).some((l) => /, 3\.36\);$/.test(l)), "the punch 0.1 s before the outFade return");
  assertCards(html, "outFade + long pull");
  check("outFade card and a 0.6 s pull: defocused inside, sharp after");
});

test("a leak bloom inside a card blooms the defocused camera and settles back on the defocus", () => {
  const html = build([BEFORE, { type: "leak", at: 2.6, to: 3.0 }], ENERGY);
  assert.match(html, /tl\.to\("#fx", \{ filter: "blur\(9px\) brightness\(1\.08\)", duration: 0\.1/, "the bloom keeps the blur (0.72 x 1.5)");
  assert.match(html, /tl\.to\("#fx", \{ filter: "blur\(9px\) brightness\(0\.72\)", duration: 0\.25, ease: "power2\.in" \}, 2\.75\);/, "the bloom returns to the card's defocus");
  assertCards(html, "leak", { bloom: true });
  check("leak inside a card: bloom blur(9px) brightness(1.08), back to blur(9px) brightness(0.72), sharp after the card");
});

test("opt-in: punches and pulls outside every hold keep their exact tweens", () => {
  const html = build([PAGE, BEFORE], ENERGY);
  const ts = fxLines(html).map(tw).filter((t) => t.filter && !/brightness\(0\.72\)/.test(t.filter));
  for (const t of ts) assert.equal(t.filter, "blur(0px) brightness(1)", `no hold: the tween at ${t.start} still ends sharp`);
  assert.match(html, /tl\.fromTo\("#fx", \{ scale: 1\.2, filter: "blur\(12px\) brightness\(1\)" \}, \{ scale: 1, filter: "blur\(0px\) brightness\(1\)", duration: 0\.28/);
  check("no overlap: refocus and energyPunch tweens byte-identical to before");
});

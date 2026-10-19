#!/usr/bin/env node
// node scripts/build-popcard-defocus.test.mjs
// A popcard defocuses and dims the camera behind it by tweening #fx's filter (the layer that wraps every take's <video>, the
// cut-out and the behind layers). In Pitch (look.refocus + captions.energyPunch) three more tweens drive that same filter -
// the refocus pull after a page, the energy punch, and a leak's bloom - and each ended on "blur(0px) brightness(1)". In GSAP
// the later-starting tween on a property wins, so one that started inside a popcard re-sharpened the speaker for the rest
// of the card. In the Pitch acceptance reel that happened after the take join (the highlight page's refocus pull and the
// 11.8 s energy span both land there), so it looked like "popcards after a join don't blur".
//   - the element showing take 2 (#take-1) and the cut-out (#matte-1) sit inside #fx
//   - for every instant inside each popcard hold, the #fx filter tween that governs it (the latest one started at or
//     before it) settles on the card's blur + dim, not on sharp - before and after the join
//   - opt-in: the same reel with the popcard moved off the punch/pull builds the exact pre-fix tweens
import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-popcard-defocus-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 10, FPS = 30;
ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));
// the matte is stubbed (never remove-background in a test)
ff("-f", "lavfi", "-i", `color=c=black@0.0:size=108x192:rate=${FPS}:duration=${SEC},format=yuva420p`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", path.join(root, "talk-matte.webm"));
const text = "today your child is due for four shots and i say it this way because studies show it works and parents who hear it this way are more likely to say yes".split(" ");
const words = { segments: [{ start: 0, end: SEC, words: text.map((w, i) => ({ word: w, start: +(0.2 + i * 0.3).toFixed(2), end: +(0.42 + i * 0.3).toFixed(2) })) }] };
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 6 }, (_, i) => [i * 2, 400, 1000, 340, 740, 560, 800]) };

let n = 0;
function build(beats, energy) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.copyFileSync(path.join(root, "talk-matte.webm"), path.join(dir, "assets", "talk-matte.webm"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  // two takes, a hard join at edit 4.9 s (recording 5.0 s); edit time = recording time - 0.1 after it
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "popcard-defocus", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0, style: "pitch", matte: true,
    takes: [{ a: 0, b: 4.9 }, { a: 5.0, b: SEC }], captions: { energy }, beats }, null, 2));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary(), PHANTASIC_SFX_PACK: path.join(root, "no-such-pack") } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return fs.readFileSync(path.join(dir, "index.html"), "utf8");
};
// every tween on #fx that sets filter: { start, end filter }
const fxTweens = (html) => [...html.matchAll(/tl\.(to|fromTo)\("#fx", (\{[^}]*\})(?:, (\{[^}]*\}))?, ([\d.]+)\);/g)]
  .map((m) => ({ kind: m[1], start: +m[4], to: (m[3] ?? m[2]).match(/filter: "([^"]*)"/)?.[1] })).filter((t) => t.to);
// the popcard holds: [defocus start, focus-return start, blur, dim] read off the popcard's own pair of tweens
const holds = (html) => {
  const ts = fxTweens(html), out = [];
  ts.forEach((t, i) => { const m = t.to.match(/^blur\((\d+)px\) brightness\(([\d.]+)\)$/); if (t.kind === "to" && m && +m[1] > 0 && +m[2] < 1 && ts[i + 1]?.kind === "to" && ts[i + 1].to === "blur(0px) brightness(1)") out.push([t.start, ts[i + 1].start, +m[1], +m[2]]); });
  return out;
};
// the filter #fx settles on at t: the latest-started filter tween at or before t renders last in GSAP and wins
const governing = (html, t) => fxTweens(html).filter((x) => x.start <= t + 1e-9).sort((a, b) => a.start - b.start).at(-1);
const check = (label) => console.log(`ok    ${label}`);

// as in the Pitch acceptance reel: a highlight page ends just before the after-join card (its refocus pull starts before the card,
// so the card's own tween wins there) and an energy span opens inside it (the punch starts inside: this is the one that broke)
const PAGE = { type: "scene", kind: "highlight", at: 5.1, to: 5.3, lines: [{ text: "are more likely", at: 5.1 }] };
const BEFORE = { type: "popcard", ui: { type: "tokens", text: "How many tokens" }, label: "before", at: 2.2, to: 3.6 };
const AFTER = { type: "popcard", ui: { type: "bars", title: "Uptake", labels: ["Ask", "Tell"] }, label: "after", at: 5.4, to: 7.2 };
const ENERGY = [[0.1, 0.5], [6.1, 7.0]];

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("a popcard after the take join keeps the speaker (take 2 inside #fx) defocused for its whole hold", () => {
  const html = build([PAGE, BEFORE, AFTER], ENERGY);
  const fx = html.indexOf('<div id="fx">'), t1v = html.indexOf('<video id="take-1"'), m1 = html.indexOf('<video id="matte-1"');
  assert.ok(fx >= 0 && t1v > fx && m1 > fx, "#take-1 (the second take's video) and #matte-1 are inside #fx");
  const hs = holds(html);
  assert.equal(hs.length, 2, `two popcard holds: ${JSON.stringify(hs)}`);
  const join = 4.9;
  assert.ok(hs[0][1] < join && hs[1][0] > join, `one card before the join, one after: ${JSON.stringify(hs)}`);
  for (const [a, b, blur, dim] of hs) for (let t = a; t < b - 1e-6; t += 1 / FPS) {
    const g = governing(html, t);
    assert.equal(g.to, `blur(${blur}px) brightness(${dim})`, `at ${t.toFixed(3)} s (card ${a}..${b}) the #fx tween started at ${g.start} settles on "${g.to}", not the card's defocus`);
  }
  check("both cards: every frame of the hold settles on blur(9px) brightness(0.72), the energy punch inside the after-join card included");
});

test("a leak bloom inside a card blooms the defocused camera and settles back on the defocus", () => {
  const html = build([BEFORE, { type: "leak", at: 2.6, to: 3.0 }], ENERGY);
  assert.match(html, /tl\.to\("#fx", \{ filter: "blur\(9px\) brightness\(1\.08\)", duration: 0\.1/, "the bloom keeps the blur (0.72 x 1.5)");
  assert.match(html, /tl\.to\("#fx", \{ filter: "blur\(9px\) brightness\(0\.72\)", duration: 0\.25, ease: "power2\.in" \}, 2\.75\);/, "the bloom returns to the card's defocus");
  check("leak inside a card: bloom blur(9px) brightness(1.08), back to blur(9px) brightness(0.72)");
});

test("opt-in: punches and pulls outside every hold keep their exact tweens", () => {
  const html = build([PAGE, BEFORE], ENERGY);
  const ts = fxTweens(html).filter((t) => !/brightness\(0\.72\)/.test(t.to));
  for (const t of ts) assert.equal(t.to, "blur(0px) brightness(1)", `no hold: the tween at ${t.start} still ends sharp`);
  assert.match(html, /tl\.fromTo\("#fx", \{ scale: 1\.2, filter: "blur\(12px\) brightness\(1\)" \}, \{ scale: 1, filter: "blur\(0px\) brightness\(1\)", duration: 0\.28/);
  check("no overlap: refocus and energyPunch tweens byte-identical to before");
});

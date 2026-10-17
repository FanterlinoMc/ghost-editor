#!/usr/bin/env node
// node scripts/build-noir.test.mjs
// The Noir premium look (style id premium-noir + colour variants), hand-ported from phantasic engine/core
// (1c15911 premium kit, dc92283 Noir v0.1, 6720aa5 / 3fe7728 review fixes, 684837f colour variants):
//   - captions.style "noir": cinema subtitles at a fixed height in the lower letterbox bar, ONE gold italic word per line
//   - spec.letterbox: two black bars (h scaled to the format), above the picture, under the captions
//   - look.preset "noir-film": an SVG tone-curve filter on #base (+ grain / vignette defaults the style overrides)
//   - spec.punch: eased punch-ins (sine.inOut over punch.frames), no #tx wrapper at blur 0
//   - cadence.faceAnchor: each punch-in scales around THAT TAKE'S SOURCE's face
//   - endcard variant "caps" + font "serif": the chapter card
//   - music.optional: the bed named by the style is not shipped, so the reel builds without it (warning, no crash)
//   - everything above is absent from a reel that does not use Noir (the byte-identity check proves the rest)
// Sources are tiny lavfi files, like build-review-fixes.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-noir-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 12, FPS = 30;
const mk = (name, freq) => ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, name));
mk("talk.mp4", 200); mk("talk-1.mp4", 300);

const sentence = "hello there this is the talking head speaking for a few seconds about a remarkable community and an isolated island far away from everywhere else".split(" ");
const wordsFor = (n = sentence.length, t0 = 0.3) => ({ segments: [{ start: 0, end: SEC, words: Array.from({ length: n }, (_, i) => ({ word: sentence[i % sentence.length], start: +(t0 + i * 0.35).toFixed(2), end: +(t0 + 0.25 + i * 0.35).toFixed(2) })) }] });
const faceAt = (left, right) => ({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 7 }, (_, i) => [i * 2, 300, 900, left, right, 480, 700]) });

let n = 0;
function project(reel, { second = false } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(wordsFor(second ? 16 : 34)));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(faceAt(340, 740)));        // centre x 540
  if (second) {
    fs.copyFileSync(path.join(root, "talk-1.mp4"), path.join(dir, "assets", "talk-1.mp4"));
    fs.writeFileSync(path.join(dir, "build", "words-1.whisper.json"), JSON.stringify(wordsFor(16)));
    fs.writeFileSync(path.join(dir, "build", "face-1.json"), JSON.stringify(faceAt(200, 400)));    // centre x 300
  }
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "noir", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.4, zoom: {}, takes: [{ a: 0, b: SEC }], beats: [], ...reel }, null, 2));
  return dir;
}
const run = (dir, env = {}) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
const build = (dir, env) => { const r = run(dir, env); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const truth = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "build", "edit_truth.json"), "utf8"));
const check = (label) => console.log(`ok    ${label}`);
const count = (s, re) => (s.match(re) || []).length;

try {
  // ---- single source, premium-noir ----
  let dir = project({ style: "premium-noir", captions: { emph: ["remarkable", "isolated"] },
    beats: [{ type: "endcard", variant: "caps", font: "serif", bg: "black", arrow: false, fade: 0, size: 96, title: "I.  Home", at: 6, to: 7 }] });
  const log = build(dir);
  let h = html(dir);
  assert.equal(count(h, /class="lbx"/g), 2, "two letterbox bars");
  assert.match(h, /class="lbx" style="position:absolute;left:0;right:0;top:0;height:270px;background:#000;z-index:7"/);
  assert.match(h, /class="lbx" style="position:absolute;left:0;right:0;bottom:0;height:270px;/);
  check("letterbox: two 270 px bars at z 7");
  assert.match(h, /class="cap-group clip" style="top:1668px/, "captions at the style's fixedY");
  assert.ok(count(h, /class="cap-group /g) > 2);
  assert.ok(count(h, /class="w emph"/g) >= 2, "an emphasis word per line");
  assert.ok(h.includes("font-style: italic; color: #E2BE6A"), "gold italic emphasis css");
  assert.match(h, /font-family: 'Instrument Serif'/);
  assert.match(h, />remarkable</, "the captions.emph word is the emphasis word when present");
  assert.match(h, /class="w emph">(remarkable|isolated)</);
  check("noir captions: fixed height 1668, serif, gold italic emphasis word");
  assert.ok(h.includes('<filter id="pk-grade-noir-film"'), "grade defs written");
  assert.ok(h.includes('tl.set("#base", { filter: "url(#pk-grade-noir-film) contrast(1.08)" }, 0);'));
  assert.match(h, /#base \{ transform: scale\([^)]*\); filter: url\(#pk-grade-noir-film\) contrast\(1\.08\); \}/);
  assert.match(h, /id="grain" class="look-grain" style="opacity:0\.09"/, "style grain 0.09 beats the preset's 0.06");
  assert.match(h, /rgba\(0,0,0,0\.5\) 100%/, "style vignette 0.5 beats the preset's 0.42");
  check("noir-film grade: SVG filter on #base, style grain/vignette win over the preset");
  assert.match(h, /tl\.fromTo\("#snap", \{ scale: 1 \}, \{ scale: 1\.1, duration: 0\.667, ease: "sine\.inOut", immediateRender: false \}/);
  assert.ok(!h.includes('id="tx"'), "punch.blur is 0: no #tx wrapper");
  check("eased punch: sine.inOut over 20 frames, no #tx at blur 0");
  assert.ok(h.includes("transformOrigin: \"540px "), "faceAnchor: origin on the face centre");
  const snaps = truth(dir).snaps;
  assert.ok(snaps.some((s) => s.origin && s.origin[0] === 540 && s.dur === 0.667 && s.ease === "sine.inOut"), "edit_truth carries origin / dur / ease for eased, anchored snaps");
  check("cadence.faceAnchor: punch-ins scale around the face; edit_truth snaps gain origin/dur/ease");
  assert.match(h, /italic 400 96px\/1\.15 'Instrument Serif'/);
  assert.match(h, /id="[^"]*-c0" style="display:none">I<\/span>/, "serif chapter card keeps its case");
  assert.ok(!/>i</.test(h.slice(h.indexOf("-bg"), h.indexOf("-bg") + 200)));
  check("chapter card: endcard variant caps, serif, case kept");
  assert.ok(!h.includes('id="music-bed"'), "no music bed when the style's track is not on disk");
  assert.match(log, /music 'silent-descent' is not available on disk \(music\.optional\)/);
  check("music.optional: missing track -> warning, no bed, build succeeds");
  assert.ok(fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8").includes('"mode": "noir"'), "fixed captions still reach caption_layout.json");
  check("caption_layout.json logs the noir blocks");

  // ---- the same reel, any other style: none of it appears ----
  dir = project({ style: "clean" });
  build(dir);
  h = html(dir);
  for (const needle of ['class="lbx"', "pk-grade", 'class="w emph"', 'id="tx"', "transformOrigin"]) assert.ok(!h.includes(needle), `style clean must not contain ${needle}`);
  assert.ok(!/class="w [^"]/.test(h));
  assert.ok(!("origin" in (truth(dir).snaps[0] || {})));
  check("a non-Noir style carries none of the Noir output");

  // ---- colour variant through extends ----
  dir = project({ style: "premium-noir-ice" });
  build(dir);
  assert.ok(html(dir).includes("color: #A9D4F5"), "ice variant: gold -> ice");
  assert.ok(html(dir).includes('class="lbx"'), "ice variant extends premium-noir");
  check("premium-noir-ice extends premium-noir and recolours the emphasis word");

  // ---- unknown preset dies with a message ----
  dir = project({ style: "clean", look: { preset: "no-such-grade" } });
  const bad = run(dir);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown look\.preset 'no-such-grade'/);
  check("unknown look.preset fails with the list of presets");

  // ---- other formats: letterbox and caption height scale with H ----
  dir = project({ style: "premium-noir", format: "1:1" });
  fs.writeFileSync(path.join(dir, "build", "crop-1x1.json"), JSON.stringify({ W: 1080, H: 1080, srcW: 1080, srcH: 1920, scale: 1, offsetX: 0, offsetY: -420, mode: "cover" }));
  const r11 = run(dir);
  if (r11.status === 0) {
    h = html(dir);
    assert.match(h, /top:0;height:152px;background:#000;z-index:7/, "270 * 1080/1920 = 152");
    assert.match(h, /class="cap-group clip" style="top:938px/, "1668 * 1080/1920 = 938");
    check("1:1: letterbox 152 px, captions at 938");
  } else console.log(`skip  1:1 (needs prep.sh crop plan: ${r11.stderr.split("\n")[0]})`);

  // ---- multi-source: each take's own source supplies the face ----
  dir = project({ style: "premium-noir", takes: [{ a: 0, b: 6, src: "assets/talk.mp4" }, { a: 0, b: 6, src: "assets/talk-1.mp4" }] }, { second: true });
  build(dir);
  h = html(dir);
  const origins = [...h.matchAll(/transformOrigin: "(\d+)px (\d+)px"/g)].map((m) => +m[1]);
  assert.ok(origins.includes(540), `first recording's face centre (540) in ${origins}`);
  assert.ok(origins.includes(300), `second recording's face centre (300) in ${origins}`);
  assert.equal(truth(dir).sources.length, 2);
  check("multi-source Noir: punch-ins anchor on the face of the take's own recording");

  // ---- noir orphan guard: a 3+1 wrap moves one word down, so the last line has 2 words; other styles never get a <br> ----
  for (const [style, expectBr] of [["premium-noir", true], ["clean", false]]) {
    dir = project({ style });
    const ow = ["village", "journey", "morning", "evening."];
    fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: SEC, words: ow.map((word, i) => ({ word, start: +(0.3 + i * 0.35).toFixed(2), end: +(0.55 + i * 0.35).toFixed(2) })) }] }));
    build(dir);
    h = html(dir);
    if (expectBr) assert.match(h, /id="cg0w1"[^>]*>journey<\/span><br><span id="cg0w2"/, "the line break lands before the third word");
    else assert.ok(!/class="cap-group[^>]*>(?:(?!<\/div>).)*<br>/s.test(h), `${style}: no <br> inside a caption block`);
  }
  check("noir orphan guard: 3+1 wrap becomes 2+2 (noir only)");

  // ---- sections mode (I-25 prototype) ----
  dir = project({ style: "premium-noir" });
  build(dir);
  const out = path.join(dir, "build", "section-0.html");
  build(dir, { GE_SECTION_START: "0", GE_SECTION_END: "6", GE_SECTION_OUT: out });
  const sh = fs.readFileSync(out, "utf8");
  assert.ok(sh.includes('class="lbx"') && sh.includes("pk-grade-noir-film"));
  check("a section build carries the letterbox and the grade defs");

  // ---- blank reel ----
  dir = project({ style: "premium-noir", origin: "blank", takes: [], source: undefined, words: undefined, face: undefined });
  build(dir);
  assert.ok(fs.existsSync(path.join(dir, "index.html")));
  check("blank reel with premium-noir builds");

  // ---- a layer and the watermark with the bars on ----
  dir = project({ style: "premium-noir", watermark: { text: "NOIR" },
    layers: [{ id: "tx", kind: "text", pin: true, at: 3, dur: 2, text: "Over the bars", size: 70, color: "#ffffff", bg: "#000000aa", align: "center", box: { x: 90, y: 1400, w: 900, h: 160 }, z: 1, overCaptions: true, by: "user" }] });
  build(dir);
  h = html(dir);
  assert.ok(h.includes("NOIR") && h.includes("Over the bars") && h.includes('class="lbx"'));
  check("watermark and a text layer build alongside the letterbox");

  console.log("\nall build-noir checks passed");
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

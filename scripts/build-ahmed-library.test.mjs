#!/usr/bin/env node
// node scripts/build-ahmed-library.test.mjs
// Phase B1 of "merge the rest of Ahmed's work": the RENDERER features of his library bundle, each opt-in. Hand ports of phantasic
// engine/core (origin/main). One section per feature; a reel that does not set a new key builds exactly as before (the byte-identity
// gate covers that, this file checks that the feature itself is in the HTML).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-library-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 12, FPS = 30;
const mk = (name, freq) => ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, name));
mk("talk.mp4", 200); mk("talk-1.mp4", 300);
ff("-f", "lavfi", "-i", "color=c=0x3060c0:size=64x64:duration=0.1", "-frames:v", "1", path.join(root, "pic.png"));

const text = "why does money matter so much. because time is remarkable and scary. the remarkable thing is scary. a community far away lives on an isolated island. money and time again. remarkable people keep going. it is scary but remarkable. thank you for watching.".split(" ");
const wordsFor = (n) => ({ segments: [{ start: 0, end: SEC, words: Array.from({ length: n }, (_, i) => ({ word: text[i % text.length], start: +(0.3 + i * 0.3).toFixed(2), end: +(0.55 + i * 0.3).toFixed(2) })) }] });
const faceAt = (left, right) => ({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 7 }, (_, i) => [i * 2, 300, 780, left, right, 450, 650]) });

let n = 0;
// matte: stub the cut-out files the build would otherwise cut with `npx hyperframes remove-background` (far too heavy for a test)
function project(reel, { second = false, matte = false, face1 = true } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.copyFileSync(path.join(root, "pic.png"), path.join(dir, "assets", "pic.png"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(wordsFor(second ? 18 : 38)));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(faceAt(340, 740)));
  if (second) {
    fs.copyFileSync(path.join(root, "talk-1.mp4"), path.join(dir, "assets", "talk-1.mp4"));
    fs.writeFileSync(path.join(dir, "build", "words-1.whisper.json"), JSON.stringify(wordsFor(18)));
    if (face1) fs.writeFileSync(path.join(dir, "build", "face-1.json"), JSON.stringify(faceAt(200, 400)));
  }
  if (matte) {
    fs.writeFileSync(path.join(dir, "assets", "talk-matte.webm"), "stub");
    if (second && face1) fs.writeFileSync(path.join(dir, "assets", "talk-1-matte.webm"), "stub");
  }
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "lib", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.4, zoom: {}, takes: [{ a: 0, b: SEC }], beats: [], ...reel }, null, 2));
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8" });
const build = (dir) => { const r = run(dir); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const check = (label) => console.log(`ok    ${label}`);
const count = (s, re) => (s.match(re) || []).length;

try {
  // ================= ground beat =================
  let dir = project({ matte: true, beats: [{ type: "ground", at: 2, to: 5, paper: "grid", text: "MONEY", hideCaptions: true, lead: "a small line" }] }, { matte: true });
  let log = build(dir);
  let h = html(dir);
  const gi = h.indexOf('class="clip ground"');
  assert.ok(gi > 0 && gi < h.indexOf('id="matte-0"'), "the page sits behind the cut-out (between the plate and the matte)");
  assert.ok(h.includes("MONEY") && h.includes("a small line") && h.includes("background-size:54px 54px"), "word, lead line and grid paper");
  assert.ok(h.includes('tl.set("#b0", { autoAlpha: 0 }, 0); tl.set("#b0", { autoAlpha: 1 }, 2);'), "a cut: hidden at 0, shown at at");
  assert.ok(/tl\.set\("\.cw, \.cap-group[^"]*", \{ color: "#111"/.test(h), "captions switch to dark ink on a light page");
  assert.ok(!h.includes('id="b0-in"') && !h.includes('<div id="b0" class="clip layer"'), "a ground adds no overlay layer and no exit tween");
  const caps = [...h.matchAll(/tl\.to\("#caps", \{ autoAlpha: 0, duration: 0\.08 \}, ([\d.]+)\)/g)].map((m) => Number(m[1]));
  assert.ok(caps.some((t) => Math.abs(t - 2) < 0.01), "hideCaptions hides the captions from at");
  check("ground: behind the matte, word + lead, grid, dark caption ink, hideCaptions, no overlay layer");

  // frame 0: only the "show" set, never a hide and a show at the same instant
  dir = project({ matte: true, beats: [{ type: "ground", at: 0, to: 3, color: "#7a1020" }] }, { matte: true });
  build(dir); h = html(dir);
  assert.ok(h.includes('tl.set("#b0", { autoAlpha: 1 }, 0);') && !h.includes('tl.set("#b0", { autoAlpha: 0 }, 0)'), "ground from frame 0: one set, no hide");
  check("ground at frame 0: a single show set (no hide at the same instant)");

  // fade-in; ground pages skip the brand tint (look-ov), only when a ground exists
  dir = project({ matte: true, look: { tint: { color: "#123456" } }, beats: [{ type: "ground", at: 2, to: 4, paper: "cream", in: "fade" }] }, { matte: true });
  build(dir); h = html(dir);
  assert.ok(h.includes('ft("#b0", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 }, 2);'), "in: fade");
  assert.ok(/<div class="look-ov" style="position:absolute;inset:0;z-index:3/.test(h), "the brand tint is marked look-ov");
  assert.ok(h.includes('tl.set(".look-ov", { visibility: "hidden" }, 2);') && h.includes('tl.set(".look-ov", { visibility: "visible" }, 4);'), "tint hidden while the page is up");
  dir = project({ look: { tint: { color: "#123456" } } });
  build(dir); h = html(dir);
  assert.ok(!h.includes("look-ov"), "no ground: no look-ov markup at all");
  check("ground: fade-in, tint switched off while up, and no look-ov without a ground");

  // matteWindows: the cut-out only inside behind/ground windows
  dir = project({ matte: true, matteWindows: true, beats: [{ type: "ground", at: 3, to: 5, paper: "white" }] }, { matte: true });
  build(dir); h = html(dir);
  assert.ok(h.includes('tl.set(".matte", { autoAlpha: 0 }, 0);') && h.includes('tl.set(".matte", { autoAlpha: 1 }, 2.98);') && h.includes('tl.set(".matte", { autoAlpha: 0 }, 5.02);'), "matteWindows");
  check("matteWindows: the cut-out shows only in the ground window");

  // a ground needs the matte
  dir = project({ beats: [{ type: "ground", at: 2, to: 4, paper: "white" }] });
  let r = run(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /'ground' beat needs "matte": true/);
  check("ground without matte: refused with a clear message");

  // two recordings: per-take mattes (previously a die), and the ground sits behind both
  const TAKES2 = [{ a: 0, b: 6, src: "assets/talk.mp4" }, { a: 0, b: 6, src: "assets/talk-1.mp4" }];
  dir = project({ matte: true, takes: TAKES2, beats: [{ type: "ground", at: 1, to: 5, paper: "grid", src: "assets/talk.mp4" }] }, { second: true, matte: true });
  build(dir); h = html(dir);
  assert.ok(h.includes('id="matte-0" class="matte" src="assets/talk-matte.webm"') && h.includes('id="matte-1" class="matte" src="assets/talk-1-matte.webm"'), "each take reads its own recording's matte");
  check("ground, two recordings: take 0 reads talk-matte.webm, take 1 reads talk-1-matte.webm");

  // a recording with no face track has no cut-out: warned, not fatal
  dir = project({ matte: true, takes: TAKES2, beats: [{ type: "ground", at: { src: "assets/talk.mp4", t: 1 }, to: { src: "assets/talk-1.mp4", t: 3 }, paper: "white" }] }, { second: true, matte: true, face1: false });
  log = build(dir);
  assert.match(log, /ground at 1s: assets\/talk-1\.mp4 has no face track/);
  check("ground over a take with no face track: warned");

  // multi-source matte without a ground is still refused
  dir = project({ matte: true, takes: TAKES2 }, { second: true, matte: true });
  r = run(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /spec\.matte with 2 sources is not supported/);
  check("matte on two recordings with no ground/stage: still refused");

  // ================= beat types: boxline, like, label, pin, headpage, photostack, uicard, cover, starflash, whiteflash =================
  const PIC = "assets/pic.png";
  const LIB_BEATS = [
    { type: "boxline", at: 1, to: 2.5, text: "why does money matter", quotes: true, label: "the host" },
    { type: "like", at: 2.6, to: 4 },
    { type: "label", at: 4, to: 5.5, text: "Chapter one" },
    { type: "pin", at: 10, to: 11.5, text: "FOLLOW" },
    { type: "headpage", at: 5.6, to: 7, src: PIC, pin: true, avatars: [{ src: PIC, at: 6 }] },
    { type: "photostack", at: 7.1, to: 8.8, items: [{ src: PIC, label: "one" }, { src: PIC, label: "two", at: 8 }] },
    { type: "uicard", at: 8.9, to: 10, src: PIC, pins: [{ x: 30, y: 40, at: 9.2 }] },
    { type: "cover", at: 0.2, to: 1, y0: 1500, y1: 1900, color: "#101010" },
    { type: "starflash", at: 11, to: 11.8, field: ["#7a1020", "#3a0810"], text: "THE END" },
    { type: "whiteflash", at: 3, to: 3.4 },
  ];
  dir = project({ beats: LIB_BEATS });
  log = build(dir); h = html(dir);
  for (const sel of ["bx", "bx-lab", "lk", "lbl", "lbl-box", "pin"]) assert.ok(new RegExp(`^  \\.${sel} \\{`, "m").test(h), `css .${sel}`);
  assert.match(h, /class="ov bx" style="left:70px;top:1120px;width:640px;font-size:54px;transform:rotate\(-1\.5deg\)">‘WHY DOES MONEY MATTER’/, "boxline: uppercased quote in the white box");
  assert.ok(h.includes("👍 Liked") && h.includes('tl.set("#b1-b", { display: "inline" }'), "like: the pill flips to Liked on the click");
  assert.ok(h.includes("lbl-txt") && h.includes('id="b2-c0"'), "label: letter by letter");
  assert.ok(h.includes('class="ov pin"') && h.includes("FOLLOW"), "pin");
  assert.ok(h.includes("M12 0C5.4 0 0 5.2") && count(h, /id="b4-w\d+"/g) >= 2, "headpage: typed-on spoken words and a pin");
  assert.ok(h.includes('id="b5-fr"') && h.includes('id="b5-lt1"') && h.includes("two"), "photostack: frame and two labelled photos");
  assert.ok(h.includes('id="b6-in" class="ov"') && h.includes('id="b6-pn0"'), "uicard with a pin");
  assert.ok(h.includes("linear-gradient(180deg, transparent 0, #101010 120px"), "cover band with a feathered top");
  assert.ok(h.includes('id="b8-f"') && h.includes("THE END") && h.includes('id="b8-s"'), "starflash with a colour field and text");
  assert.ok(h.includes('id="b9-in" style="position:absolute;inset:0;background:#fff"'), "whiteflash");
  // full-page beats and covers have no scale-out exit tween; the others do
  for (const id of ["b4", "b5", "b9", "b7"]) assert.ok(!new RegExp(`tl\\.to\\("#${id}-in", \\{ autoAlpha: 0, scale: 0\\.9, duration: 0\\.18`).test(h), `no scale exit on #${id}`);
  assert.ok(/tl\.to\("#b0-in", \{ autoAlpha: 0, scale: 0\.9, duration: 0\.18/.test(h), "boxline keeps the normal exit");
  const et = JSON.parse(fs.readFileSync(path.join(dir, "build", "edit_truth.json"), "utf8"));
  assert.deepEqual(et.beats.map((b) => b.type).sort(), LIB_BEATS.map((b) => b.type).sort(), "edit_truth lists the new types");
  assert.deepEqual(Object.keys(et.beats[0]), ["type", "kind", "at", "to", "in", "out"], "edit_truth beat shape unchanged");
  check("beat types: boxline, like, label, pin, headpage, photostack, uicard, cover, starflash, whiteflash (+ edit_truth)");

  // gating: none of that CSS appears on a plain reel
  dir = project({ beats: [{ type: "popcard", at: 2, to: 4, src: PIC }] });
  build(dir); h = html(dir);
  for (const sel of ["bx", "lk", "lbl", "pin"]) assert.ok(!new RegExp(`^  \\.${sel} \\{`, "m").test(h), `no .${sel} css without the beat`);
  check("beat CSS is only written when the beat exists");

  // ================= caption styles: cluster, duo, podcast, type =================
  const layoutModes = (d) => { const j = JSON.parse(fs.readFileSync(path.join(d, "build", "caption_layout.json"), "utf8")); return new Set((j.blocks || j.log || []).map((b) => b.mode)); };
  dir = project({ captions: { style: "cluster", heroes: ["money", "remarkable"], serif: ["remarkable"], stairs: [[3, 4], [500, 600]], glowWords: ["scary"], glowColor: "#ffd21e", align: "center" } });
  log = build(dir); h = html(dir);
  assert.ok(count(h, /class="cl clip"/g) >= 5 && h.includes('class="cw hb"') && h.includes('class="cw hs"') && h.includes('class="cw sm"'), "cluster: phrases with a small lead, a hero and a serif hero");
  assert.ok(h.includes('class="cl-row" style="margin-left:'), "cluster: a staircase phrase");
  assert.ok(/^  \.cl \{ position: absolute;/m.test(h) && h.includes(".cw.glw { color: #ffd21e"), "cluster css (glowColor)");
  assert.match(log, /captions\.stairs \[500, 600\] does not resolve to one kept take: dropped/, "an unresolvable span is dropped, not widened");
  assert.ok(layoutModes(dir).has("cluster"), "cluster blocks are logged for caption_layout.json / qa.py");
  assert.ok(!h.includes("cap-group clip"), "cluster replaces the default caption groups");
  check("captions cluster: lead / hero / serif hero / staircase / glow word, a bad span dropped with a warning, logged");

  dir = project({ captions: { style: "duo", energy: [[2, 3.5], [900, 901]], serif: ["remarkable"], fixedY: 1100 } });
  log = build(dir); h = html(dir);
  assert.ok(count(h, /class="duo clip big/g) >= 2 && count(h, /class="duo clip"/g) >= 10, "duo: big words inside the energy span, small elsewhere");
  assert.ok(h.includes("duo clip ser") || h.includes(" ser\""), "duo: serif word");
  assert.match(log, /captions\.energy \[900, 901\] does not resolve to one kept take: dropped/);
  assert.ok(layoutModes(dir).has("duo"), "duo logged");
  check("captions duo: one word at a time, big in the energy span, serif words, a bad span dropped");

  dir = project({ showLogo: { small: "THE", big: "SHOW" }, captions: { style: "podcast", keys: ["money", "time"], reds: ["scary"], splitAtPages: true }, beats: [{ type: "uicard", at: 5, to: 8, src: PIC, y: 1000, h: 400 }] });
  build(dir); h = html(dir);
  assert.ok(h.includes('class="pcw pck"') && h.includes("#F0333A") && h.includes('class="pc-small"') && h.includes('class="pc-key"'), "podcast: key words yellow, reds, small-over-big stack");
  assert.ok(h.includes('class="show-logo"') && /^  \.show-logo \{/m.test(h) && h.includes("<b>SHOW</b>"), "showLogo");
  const pcTops = [...h.matchAll(/class="pc-group clip" style="top:(\d+)px" data-start="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(pcTops.length >= 5 && pcTops.filter(([y, t]) => t > 5 && t < 8).every(([y]) => y < 1000), "podcast captions step above a uicard");
  assert.ok(layoutModes(dir).has("podcast"), "podcast logged");
  dir = project({ beats: [] });
  build(dir); h = html(dir);
  assert.ok(!h.includes("show-logo"), "no showLogo css/markup without it");
  check("captions podcast: keys / reds / stacks, steps above a uicard, showLogo (only when set)");

  // showLogo "fromShow" (styles/podcast.json): derived from spec.show as podcast_plan.py does, so a director-composed reel has one
  // the opt-in lives on the REEL (the planner writes it), never in a preset: a preset key would reach every stored
  // podcast reel carrying `show` and grow a logo on its next rebuild (CP3, 25 Oct)
  assert.equal(JSON.parse(fs.readFileSync(path.join(HERE, "..", "styles", "podcast.json"), "utf8")).showLogo, undefined, "podcast.json must not set showLogo");
  const logo = (reel) => { const d = project(reel); build(d); const m = html(d).match(/class="show-logo"[^>]*><i>([^<]*)<\/i><b>([^<]*)<\/b>/); return m ? [m[1], m[2]] : null; };
  assert.deepEqual(logo({ showLogo: "fromShow", show: "AK Consulting" }), ["AK", "CONSULTING"], "two words -> small over big");
  assert.deepEqual(logo({ showLogo: "fromShow", show: "The Money Hour · Sam Lee" }), ["THE MONEY", "HOUR"], "the guest after ' · ' is not part of the logo");
  assert.deepEqual(logo({ showLogo: "fromShow", show: "Dwell" }), ["", "DWELL"], "one word -> big only");
  assert.equal(logo({ showLogo: "fromShow", show: "TBD" }), null, "a placeholder show gives no logo");
  assert.equal(logo({ showLogo: "fromShow" }), null, "no show, no logo");
  assert.deepEqual(logo({ showLogo: { small: "MY", big: "OWN" }, show: "AK Consulting" }), ["MY", "OWN"], "an explicit showLogo still wins");
  // the one combination that could change existing output: a podcast-style reel WITH show and no showLogo -> no logo
  assert.equal(logo({ style: "podcast", show: "AK Consulting" }), null, "style podcast + show alone draws no logo");
  assert.deepEqual(logo({ style: "podcast", show: "AK Consulting", showLogo: "fromShow" }), ["AK", "CONSULTING"], "podcast + the reel's opt-in does");
  check("showLogo fromShow: derived from spec.show (guest and placeholders dropped), explicit object wins, never from a preset");

  // mac-74: popcard face check (the test face spans y 300..780): over a sharp camera the card moves off the face
  const pcTop = (h_) => { const m = h_.match(/class="ov popcard" style="top:(\d+)px/); return m ? +m[1] : null; };
  const PC = { type: "popcard", at: 2, to: 5, src: PIC, label: "France" };
  dir = project({ beats: [{ ...PC }] }); build(dir);
  assert.equal(pcTop(html(dir)), 780 + 40, "no defocus: the card moves below the chin (face bottom 780 + 40)");
  dir = project({ look: { fx: true }, beats: [{ ...PC }] }); build(dir);
  assert.equal(pcTop(html(dir)), 300, "a defocused camera: the card stays over the speaker, as designed");
  dir = project({ beats: [{ ...PC, y: 300 }] }); build(dir);
  assert.equal(pcTop(html(dir)), 300, "an explicit y is the reel's call");
  dir = project({ beats: [{ ...PC, stage: "#111" }] }); build(dir);
  assert.equal(pcTop(html(dir)), 300, "a full-frame stage hides the footage");
  dir = project({ beats: [{ ...PC, h: 900 }] }); log = build(dir); h = html(dir);
  assert.equal(pcTop(h), 300, "no room either side: the card stays...");
  assert.ok(h.includes('id="fx"'), "...and the camera is defocused behind it (#fx written), so it is never on a sharp face");
  assert.match(log, /popcard at 2: no room beside the face, so the camera is defocused behind the card/);
  dir = project({ beats: [{ ...PC, h: 900, defocus: false }] }); log = build(dir);
  assert.equal(pcTop(html(dir)), null, "defocus: false and no room: left out, never drawn on a sharp face");
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "build", "graphics-dropped.json"), "utf8")).dropped.some((d) => d.type === "popcard" && d.rule === "face"), "recorded");
  dir = project({ look: { fx: false }, beats: [{ ...PC, h: 900 }] }); log = build(dir);
  assert.equal(pcTop(html(dir)), null, "a style that opted out of #fx (look.fx: false) is never defocused for it: left out");
  assert.ok(!html(dir).includes('id="fx"'));
  // CP3: the defocus a popcard forces is ITS layer only - a leak's bloom (inert without #fx) stays inert
  const bloomTweens = (h_) => (h_.match(/tl\.to\("#fx", \{ filter: "blur\(0px\) brightness\(1\.5\)"/g) || []).length;
  dir = project({ beats: [{ type: "leak", at: 6, to: 7 }] }); build(dir); const leakAlone = html(dir);
  dir = project({ beats: [{ ...PC, h: 900 }, { type: "leak", at: 6, to: 7 }] }); build(dir);
  assert.ok(html(dir).includes('id="fx"'), "the popcard still defocuses");
  assert.equal(bloomTweens(html(dir)), 0, "no leak bloom on #fx: it was inert before and stays inert");
  assert.equal(bloomTweens(leakAlone), 1, "a leak on its own still carries its (inert) bloom tween, as at the pin");
  // the author's own #fx (look.fx) keeps its leak bloom when a popcard is in the reel too (simplifying the guard to
  // `if (popcardFx)` must not be able to touch this; today popcardFx cannot be set when FX_BASE is, which this pins)
  dir = project({ look: { fx: true }, beats: [{ ...PC, h: 900 }, { type: "leak", at: 6, to: 7 }] }); build(dir);
  assert.equal(bloomTweens(html(dir)), 1, "look.fx + popcard + leak: the leak bloom is still there");
  check("popcard face check: moves off a sharp face; no room -> defocus; defocus:false + no room -> dropped + recorded; defocused/stage/explicit y untouched");

  dir = project({ captions: { style: "type", reds: ["scary", "remarkable."] } });
  build(dir); h = html(dir);
  assert.ok(count(h, /class="tc clip/g) >= 5 && h.includes("tc-red") && h.includes("tc-cur") && h.includes('class="tc-ch"'), "type: cards typed letter by letter behind a cursor, red verdicts");
  assert.ok(/^  \.tc-cur \{/m.test(h) && h.includes('tl.set("#tc0 .tc-ch", { display: "none" }, 0);'), "type css and the typewriter sets");
  check("captions type: typed-on cards, cursor, red verdict cards");

  // type behind the head (stage + captions.behind): the card sits between the plate and the speaker, placed from the head-top track of its own take
  fs.writeFileSync(path.join(root, "headtop.json"), JSON.stringify(Array.from({ length: 61 }, (_, i) => [+(i / 5).toFixed(2), 300])));
  dir = project({ stage: { fixedScale: 1 }, captions: { style: "type", behind: true } }, { matte: true });
  fs.writeFileSync(path.join(dir, "build", "headtop.json"), fs.readFileSync(path.join(root, "headtop.json")));
  build(dir); h = html(dir);
  assert.ok(h.indexOf('<div id="caps">') > h.indexOf('<div id="pip">') && h.indexOf('<div id="caps">') < h.indexOf('<div id="base">'), "captions sit inside #pip, under the speaker");
  assert.equal(count(h, /<div id="caps">/g), 1, "and only once");
  assert.ok(layoutModes(dir).has("behind"), "behind-the-head cards are logged");
  check("captions type + stage + behind: cards under the cut-out, placed from the head-top track");

  // ================= look layer: refocus, energyPunch, cleanScenes, target =================
  const HEADPAGE = { type: "headpage", at: 5.6, to: 7, src: PIC };
  dir = project({ look: { refocus: { blur: 12, dur: 0.4 }, cleanScenes: true, grain: 0.1, vignette: 0.3 }, beats: [HEADPAGE] });
  build(dir); h = html(dir);
  assert.equal(count(h, /<div id="fx">/g), 1, "one #fx wrapper");
  assert.ok(h.indexOf('<div id="fx">') > h.indexOf('<div id="push">') && h.indexOf('<div id="fx">') < h.indexOf('id="take-0"'), "#fx wraps the footage, inside #push");
  assert.ok(/^  #fx \{ position: absolute; inset: 0; transform-origin: 540px \d+px;/m.test(h), "#fx css");
  assert.ok(h.includes('tl.fromTo("#fx", { filter: "blur(12px) brightness(1)" }, { filter: "blur(0px) brightness(1)", duration: 0.4, ease: "power2.out", immediateRender: true }, 0);'), "refocus: the opening pull");
  assert.ok(/immediateRender: false \}, 7\);/.test(h), "refocus: a pull when the page ends (7 s)");
  assert.ok(h.includes('class="look-grain look-ov"') && h.includes('class="look-vignette look-ov"'), "cleanScenes marks the grain and vignette look-ov");
  assert.ok(h.includes('tl.set(".look-ov", { visibility: "hidden" }, 5.6);') && h.includes('tl.set(".look-ov", { visibility: "visible" }, 7);'), "cleanScenes hides the overlays on a headpage");
  dir = project({ look: { grain: 0.1 }, beats: [HEADPAGE] });
  build(dir); h = html(dir);
  assert.ok(!h.includes('id="fx"') && !h.includes("#fx {") && !h.includes("look-ov"), "no refocus/energyPunch/cleanScenes: no #fx and no look-ov at all");
  check("look layer: refocus pulls on a #fx wrapper, cleanScenes via look-ov, and nothing extra when unset");

  dir = project({ captions: { style: "duo", energy: [[2, 3.5]], energyPunch: { scale: 1.2, blur: 5 } } });
  build(dir); h = html(dir);
  assert.equal(count(h, /<div id="fx">/g), 1);
  assert.ok(h.includes('tl.fromTo("#fx", { scale: 1.2, filter: "blur(5px) brightness(1)" }, { scale: 1, filter: "blur(0px) brightness(1)", duration: 0.28, ease: "power3.out", immediateRender: false }, 1.98);'), "energyPunch at the energy span start");
  check("captions.energyPunch: a punch at each duo energy span");

  // look.target: the grade is steered by a measured clip when python + OpenCV exist, else the style grade stays - either way no placeholder is left
  dir = project({ look: { grade: "saturate(1.3) contrast(1.05)", target: { sat: 70, luma: 100 } }, beats: [{ type: "mood", at: 3, to: 4 }] });
  log = build(dir); h = html(dir);
  assert.ok(!h.includes("__LOOK_GRADE__"), "the mood placeholder is always filled in");
  assert.ok(/look target: clip sat/.test(log) || /look\.target: could not measure the clip/.test(log), "measured, or warned that it could not be");
  assert.match(h, /tl\.set\("#base", \{ filter: "(saturate\(1\.3\) contrast\(1\.05\)[^"]*) grayscale\(1\) contrast\(1\.12\)"\.trim\(\) \}, 3\);/, "the mood beat carries the (final) grade");
  check(`look.target: mood placeholder filled, ${/look target: clip sat/.test(log) ? "clip measured" : "clip not measurable here (no python+OpenCV), style grade kept"}`);

  // ================= cadence.targetPerMin / cadence.burst =================
  const snapsOf = (d) => JSON.parse(fs.readFileSync(path.join(d, "build", "edit_truth.json"), "utf8")).snaps.map((x) => x.t);
  dir = project({ cadence: { every: 1.3 } });
  build(dir); const plain = snapsOf(dir);
  dir = project({ cadence: { every: 1.3, burst: { count: 3, gap: 0.5, hold: 3 } } });
  build(dir); const bursty = snapsOf(dir);
  const gaps = bursty.slice(1).map((t, i) => +(t - bursty[i]).toFixed(2));
  assert.ok(plain.length >= 4 && bursty.length >= 3, "punches exist");
  assert.ok(gaps.some((g) => g < 1.0) && gaps.some((g) => g >= 2.5), `burst: close punches and long rests (${gaps.join(" ")})`);
  assert.ok(Math.min(...plain.slice(1).map((t, i) => t - plain[i])) >= 0.6 - 1e-6, "without burst the minGap rule is unchanged");
  dir = project({ cadence: { targetPerMin: 20, burst: { count: 2, gap: 0.6 } } });
  log = build(dir);
  assert.match(log, /cadence target 20\/min: 0 natural changes in 12\.0 s -> punch every [\d.]+ s \(bursts, hold [\d.]+ s\)/);
  check("cadence: burst clusters punches, targetPerMin sets the pace, plain cadence unchanged");

  console.log("\nall build-ahmed-library tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

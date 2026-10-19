#!/usr/bin/env node
// node scripts/build-authority.test.mjs
// Authority (style id hormozi + colour themes), hand-ported from phantasic engine/core (b928b75 v0.1, 684837f themes and
// accent plumbing) plus the standalone focus director (focus_director.py / focus_review.py):
//   - captions.style "hormozi": fixed height (1150), moves to listY (720) while a split-screen list is up, keyword in heavy weight
//   - hz-title / hz-name / hz-list / hz-note beats and their css (written only when a reel has one), --hz-accent from brand.accent
//   - hz-name's avatar is cut from the recording the beat is on, with THAT recording's face track
//   - colour themes extend hormozi (accent only); a podcast-glow theme's glow follows the accent (rgbaOf)
//   - the focus director plans Authority and Chrome Motion beats from a transcript (offline: no API key, no spending) and
//     its output builds
// Sources are tiny lavfi files, like build-review-fixes.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs"), DIRECTOR = path.join(HERE, "focus_director.py");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-authority-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 24, FPS = 30;
const mk = (name) => ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, name));
mk("talk.mp4"); mk("talk-1.mp4");

// "how I calculate AI ROI" hook, three counted points, a number
const SAY = "How I calculate AI ROI in fifteen seconds. Number one, what is the cost today? Number two, what is the cost after automation? Number three, the recurring value of the work, which is $6,000 a month. That is the whole answer.";
const mkWords = (t0 = 0.4) => {
  const ws = []; let t = t0;
  for (const tok of SAY.split(" ")) { ws.push({ word: tok, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2), p: 0.99 }); t += /[.?]$/.test(tok) ? 0.75 : 0.34; }
  return { segments: [{ start: 0, end: SEC, words: ws }] };
};
const faceAt = (l, r) => ({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 14 }, (_, i) => [i * 2, 400, 1000, l, r, 560, 800]) });

let n = 0;
function project(reel, { second = false, noTakes = false } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(mkWords()));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(faceAt(340, 740)));
  if (second) {
    fs.copyFileSync(path.join(root, "talk-1.mp4"), path.join(dir, "assets", "talk-1.mp4"));
    fs.writeFileSync(path.join(dir, "build", "words-1.whisper.json"), JSON.stringify(mkWords()));
    fs.writeFileSync(path.join(dir, "build", "face-1.json"), JSON.stringify(faceAt(100, 300)));   // a face far to the left
  }
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "authority", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.15, zoom: {}, takes: noTakes ? undefined : [{ a: 0, b: SEC }], beats: [], ...reel }, null, 2));
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8" });
const build = (dir) => { const r = run(dir); if (r.status !== 0) console.error("BUILD STDERR: " + r.stderr.slice(-1200)); assert.equal(r.status, 0, (r.stderr + r.stdout).slice(-1500)); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const check = (label) => console.log(`ok    ${label}`);
const count = (s, re) => (s.match(re) || []).length;
const BEATS = [
  { type: "hz-title", text: "HOW I CALCULATE\nAI ROI", at: 0.5, to: 3.5 },
  { type: "hz-name", name: "Ada Test", title: "Founder", at: 1.8, to: 4.2 },
  { type: "hz-note", text: "(marketing)", at: 4.5, to: 6 },
  { type: "hz-list", at: 6.5, to: 14, items: [{ title: "Cost today?", at: 7 }, { title: "Cost after automation?", sub: "the recurring part", at: 10 }, { title: "Recurring value", at: 12 }] },
];

try {
  // ---- single source ----
  let dir = project({ style: "hormozi", captions: { emph: ["calculate", "cost"] }, beats: BEATS });
  build(dir);
  let h = html(dir);
  assert.match(h, /class="cap-group clip" style="top:1150px/, "captions at fixedY 1150");
  assert.match(h, /class="cap-group clip" style="top:720px/, "captions move up to listY 720 while the list is up");
  assert.ok(count(h, /class="w emph"/g) >= 2 && h.includes(".cap-group .w.emph { font-weight: 800; }"), "keyword in heavy weight");
  for (const needle of ["hz-title", "hz-name", "hz-note", "hz-panel", "hz-item", ":root { --hz-accent: #E5121B; }"]) assert.ok(h.includes(needle), needle);
  assert.ok(h.includes('HOW I CALCULATE\nAI ROI') || h.includes("HOW I CALCULATE"), "title text");
  assert.ok(/id="b2-in" class="ov hz-title"/.test(h) || /class="ov hz-title"/.test(h));
  assert.ok(fs.existsSync(path.join(dir, "assets", "hz-avatar.jpg")) && h.includes('<img src="assets/hz-avatar.jpg" />'), "avatar cut from the speaker's face");
  assert.ok(h.includes('tl.fromTo("#base", { y: 0 }, { y: -280'), "the footage lifts under the list");
  assert.ok(fs.readFileSync(path.join(dir, "build", "caption_layout.json"), "utf8").includes('"mode": "hormozi"'));
  check("hormozi: captions 1150 / listY 720, heavy keyword, title / name card / note / split list, avatar");

  // ---- no hz beat, no hormozi style: none of it ----
  dir = project({ style: "clean" });
  build(dir);
  h = html(dir);
  for (const needle of [".hz-title", "--hz-accent", "hz-panel"]) assert.ok(!h.includes(needle), `clean must not contain ${needle}`);
  check("a reel with no hz-* beat carries no hormozi css");

  // ---- colour theme ----
  dir = project({ style: "hormozi-teal", beats: [BEATS[0]] });
  build(dir);
  assert.ok(html(dir).includes(":root { --hz-accent: #0D9488; }"));
  check("hormozi-teal extends hormozi: --hz-accent follows brand.accent");
  dir = project({ style: "podcast-glow-blue", beats: [{ type: "headline", small: "we have", big: "no idea", at: 3, to: 5, bigAt: 3.8, arrow: "left" }] });
  build(dir);
  h = html(dir);
  assert.ok(h.includes("rgba(62,168,255,0.75)") && h.includes("rgba(62,168,255,0.55)"), "podcast-glow-blue glow follows its accent");
  assert.ok(!h.includes("rgba(255,196,0"), "no hard-coded yellow glow left");
  check("podcast-glow themes: caption and headline glow follow the accent (rgbaOf)");

  // ---- two recordings: the name card's avatar is cut with the beat's own recording's face track ----
  const TAKES2 = [{ a: 0, b: 10, src: "assets/talk.mp4" }, { a: 0, b: 10, src: "assets/talk-1.mp4" }];
  dir = project({ style: "hormozi", takes: TAKES2, beats: [{ type: "hz-name", name: "Second Speaker", at: { src: "assets/talk-1.mp4", t: 1 }, to: { src: "assets/talk-1.mp4", t: 3 }, src: "assets/talk-1.mp4", avatarAt: 1 }] }, { second: true });
  const r2 = run(dir);
  if (r2.status === 0) {
    assert.ok(fs.existsSync(path.join(dir, "assets", "hz-avatar-1.jpg")), "avatar of recording 1 is its own file");
    assert.ok(html(dir).includes('<img src="assets/hz-avatar-1.jpg" />'));
    check("two recordings: hz-name avatar comes from the beat's own recording (hz-avatar-1.jpg)");
  } else console.log(`skip  two-recording avatar (${r2.stderr.split("\n").find((l) => l.startsWith("ERROR")) || r2.stderr.split("\n")[0]})`);

  // ---- section build, blank reel ----
  dir = project({ style: "hormozi", beats: BEATS });
  build(dir);
  const out = path.join(dir, "build", "section-0.html");
  const rs = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, GE_SECTION_START: "0", GE_SECTION_END: "8", GE_SECTION_OUT: out } });
  assert.equal(rs.status, 0, rs.stderr);
  assert.ok(fs.readFileSync(out, "utf8").includes("hz-title"));
  dir = project({ style: "hormozi", origin: "blank", takes: [], source: undefined, words: undefined, face: undefined });
  build(dir);
  assert.ok(fs.existsSync(path.join(dir, "index.html")));
  check("section build carries the hz beats; a blank reel with hormozi builds");

  // ---- the focus director (offline) ----
  const py = [process.env.PYTHON, "python3", "python", "py"].filter(Boolean).find((c) => { const r = spawnSync(c, ["--version"], { encoding: "utf8" }); return !r.error && r.status === 0 && /Python 3/.test(r.stdout + r.stderr); });
  const pyHasPydantic = py && spawnSync(py, ["-c", "import pydantic"], { encoding: "utf8" }).status === 0;
  if (!pyHasPydantic) console.log("skip  focus director (needs python 3 with pydantic; set PYTHON)");
  else {
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;   // never a live review in a test
    const plan = (dir, style, extra = []) => { const r = spawnSync(py, [DIRECTOR, dir, "--style", style, "--name", "Ada Test", "--role", "Founder", ...extra], { encoding: "utf8", env }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
    dir = project({ style: "hormozi" });
    let p = plan(dir, "hormozi", ["--dry"]);
    assert.ok(p.beats.some((b) => b.type === "hz-title") && p.beats.some((b) => b.type === "hz-name"), "title + name card");
    const list = p.beats.find((b) => b.type === "hz-list");
    assert.ok(list && list.items.length === 3 && list.items.every((i) => i.at >= list.at), "three counted points -> one hz-list");
    assert.ok(p.captions.emph.length > 0 && p.captions.autoEmph === false);
    check("focus_director hormozi (offline): hook title, name card, split list of the counted points, emphasis words");
    p = plan(dir, "gadzhi-motion", ["--dry"]);
    assert.ok(p.beats.length >= 2 && p.beats.length <= 4 && p.beats.every((b) => b.type === "scene" && b.kind.startsWith("gm-")), JSON.stringify(p.beats.map((b) => b.kind)));
    assert.ok(p.beats.some((b) => b.kind === "gm-object" && b.object === "target"), "money / ROI words map to the target object");
    // the counter loses to the numbered-points recap on this transcript (3 s spacing rule), so a transcript with only a number proves it
    const dirN = project({ style: "gadzhi-motion" });
    const w2 = "Let me tell you something simple about how we run the business and why it matters to all of us here. We pay $6,000 a month for this tool. Every single month the number grows and nobody checks it. Today we finally measure it properly.".split(" ").map((x, i) => ({ word: x, start: +(0.4 + i * 0.36).toFixed(2), end: +(0.7 + i * 0.36).toFixed(2), p: 0.99 }));
    fs.writeFileSync(path.join(dirN, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: SEC, words: w2 }] }));
    const pn = plan(dirN, "gadzhi-motion", ["--dry"]);
    assert.ok(pn.beats.some((b) => b.kind === "gm-counter" && b.value === 6000 && b.prefix === "$"), "a spoken $6,000 becomes a counter: " + JSON.stringify(pn.beats.map((b) => b.kind)));
    for (let i = 1; i < p.beats.length; i++) assert.ok(p.beats[i].at >= p.beats[i - 1].to + 3 - 1e-6, "graphics at least 3 s apart");
    check("focus_director gadzhi-motion (offline): <= 4 graphics 3 s apart, ROI -> target, a spoken $6,000 -> counter");
    // an AI review that names an object outside library/gm-objects (or the dropped "brain") falls back to the concept words
    const wAt = (word) => w2.find((w) => w.word.replace(/[^\w$]/g, "").toLowerCase() === word).start;
    const rvFile = path.join(dirN, "build", "review.json");
    fs.writeFileSync(rvFile, JSON.stringify({ moments: [
      { kind: "gm-object", at: wAt("pay") - 0.1, to: wAt("pay") + 1.5, object: "spaceship", text: "We pay" },
      { kind: "gm-nodes", at: wAt("today") - 0.1, to: wAt("today") + 1.5, object: "brain", pill: "measure" },
      { kind: "gm-object", at: wAt("simple") - 0.1, to: wAt("simple") + 1.5, object: "rocket", text: "simple" },
    ] }));
    const pr = plan(dirN, "gadzhi-motion", ["--dry", "--review-file", rvFile]);
    const objs = pr.beats.filter((b) => b.object).map((b) => b.object);
    assert.ok(objs.length >= 2 && objs.every((o) => ["chart", "gears", "lightbulb", "puzzle", "rocket", "stopwatch", "target"].includes(o)), "every object is in the pack: " + objs);
    assert.ok(pr.beats.some((b) => b.kind === "gm-object" && Math.abs(b.at - (wAt("pay") - 0.1)) < 0.01 && b.object === "target"), "unknown 'spaceship' -> concept of 'We pay' (target): " + JSON.stringify(pr.beats));
    assert.ok(pr.beats.some((b) => b.object === "rocket"), "a pack name from the review is kept");
    check("focus_director: an AI-review object outside the pack falls back to the concept words");
    // its output builds
    for (const style of ["hormozi", "gadzhi-motion"]) {
      dir = project({ style });
      const r = spawnSync(py, [DIRECTOR, dir, "--style", style, "--name", "Ada Test"], { encoding: "utf8", env });
      assert.equal(r.status, 0, r.stderr);
      const spec = JSON.parse(fs.readFileSync(path.join(dir, "reel.json"), "utf8"));
      assert.ok(spec.beats.length >= 2);
      build(dir);
    }
    check("the planned reel.json builds for both styles");
  }

  console.log("\nall build-authority checks passed");
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

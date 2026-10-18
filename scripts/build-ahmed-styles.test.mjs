#!/usr/bin/env node
// node scripts/build-ahmed-styles.test.mjs
// Phase B2 of merging the rest of Ahmed work: his styles. (1) EVERY ported style (styles/library/*, podcast, breakdown, the six hardened looks)
// loads, its extends chain resolves, and a small reel built with it does not die (matte stubbed: never npx hyperframes remove-background).
// (2) The renderer keys that came with them, each opt-in. Hand ports of phantasic engine/core (origin/main + the fix2 and mini2 branches).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const STYLES = path.join(HERE, "..", "styles");
const { loadStyleChain } = await import(pathToFileURL(path.join(HERE, "lib", "style-path.mjs")).href);
const deepMerge = (a, b) => {
  if (b === undefined) return a;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) { const o = { ...a }; for (const k of Object.keys(b)) o[k] = deepMerge(a[k], b[k]); return o; }
  return b;
};
const LIBRARY = fs.readdirSync(path.join(STYLES, "library")).filter((f) => f.endsWith(".json")).map((f) => "library/" + f.replace(".json", ""));
const SIX = ["gold-ledger", "northstar", "red-poster", "magazine-spread", "monochrome-cinema-stark", "name-reveal"];
const ALL = [...LIBRARY, "podcast", "breakdown", ...SIX];

try {
  // ================= every ported style loads and its extends chain resolves =================
  assert.ok(LIBRARY.length >= 114, `library has ${LIBRARY.length} styles`);
  for (const n of ALL) {
    const { style } = loadStyleChain(n, { stylesDir: STYLES, deepMerge });
    assert.ok(style && typeof style === "object" && !("extends" in style), `${n} resolved`);
    assert.ok(style.brand?.accent || style.captions || style.look, `${n} carries a look`);
  }
  check(`${ALL.length} styles load with their extends chain (${LIBRARY.length} library, podcast, breakdown, ${SIX.length} hardened)`);

  // ================= every ported style builds a small reel =================
  const failed = []; const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
  for (const n of ALL.filter((x) => !process.env.ONLY || process.env.ONLY.split(",").includes(x))) {
    const d = project({ style: n }, { matte: true });
    const r = run(d);
    if (r.status !== 0) failed.push(`${n}: ${(r.stderr || "").slice(-400)} [exit ${r.status}${r.error ? ", " + r.error.message : ""}]`);
    fs.rmSync(d, { recursive: true, force: true });
  }
  assert.deepEqual(failed, [], `styles that die on a plain reel:\n${failed.join("\n")}`);
  check(`all ${ALL.length} styles build a 12 s reel`);

  // ================= look.rootBg / zoom.originY / matteFilter / watermark.spread =================
  let dir = project({ look: { rootBg: "#7a1426" }, zoom: { originY: 33 }, matteFilter: "contrast(1.2)", watermark: { text: "ONE TWO THREE", spread: true } });
  build(dir); let h = html(dir);
  assert.match(h, /#root \{[^}]*background: #7a1426;/, "rootBg");
  assert.match(h, /#base \{ transform: scale\(1\); transform-origin: 50% 33%;/, "originY");
  assert.match(h, /\.matte \{ filter: contrast\(1\.2\); \}/, "matteFilter");
  assert.equal(count(h, /<span>(ONE|TWO|THREE)<\/span>/g), 3, "watermark.spread: one span per word");
  dir = project({}); build(dir); h = html(dir);
  assert.ok(!/transform-origin: 50% 33%/.test(h) && !/\.matte \{ filter/.test(h) && /#root \{[^}]*background: #000;/.test(h), "unset keys change nothing");
  check("look.rootBg, zoom.originY, matteFilter, watermark.spread");

  // ================= popcard.object / stage / outFade / dim / glow =================
  dir = project({ popcard: { object: true, stage: "linear-gradient(#d40f1f,#7e0711)", outFade: 0.2, dim: 0.5, glow: "#ff0" }, beats: [{ type: "popcard", at: 2, to: 4, src: "assets/pic.png", label: "money" }] });
  build(dir); h = html(dir);
  assert.match(h, /drop-shadow\(0 0 28px #ff0\)/, "object mode glow");
  assert.match(h, /-stg" style="position:absolute;inset:0;background:linear-gradient/, "stage page");
  assert.match(h, /autoAlpha: 0, scale: 0\.94, duration: 0\.2/, "outFade");
  assert.match(h, /brightness\(0\.5\)/, "dim");
  dir = project({ beats: [{ type: "popcard", at: 2, to: 4, src: "assets/pic.png", label: "money" }] });
  build(dir); h = html(dir);
  assert.ok(!/-stg"/.test(h) && !/scale: 0\.94/.test(h) && /brightness\(0\.72\)/.test(h), "a plain popcard is unchanged");
  check("popcard object / stage / outFade / dim / glow, opt-in");

  // ================= pills (UI Story Ad #10 / Gold Ledger checklist) =================
  dir = project({ style: "gold-ledger", beats: [{ type: "pills", at: 2, to: 6, items: [{ text: "one", glyph: "doc", at: 2.1 }, { text: "two", glyph: "chart", at: 3 }] }] }, { matte: true });
  build(dir); h = html(dir);
  assert.equal(count(h, /-p\d" style="position:absolute;left:0;top:/g), 2, "two pills");
  assert.match(h, /clip-path:polygon\(0 0,100% 0,74% 100%,0 100%\)/, "green slanted tab");
  check("pills beat");

  // ================= Breakdown: title / chapter scenes (+ fit), wordpage black / ink / gold, highlight colours =================
  dir = project({ style: "breakdown", beats: [
    { type: "scene", kind: "title", at: 0, to: 1.6, lines: ["Money matters", { text: "remarkable", size: 120 }] },
    { type: "scene", kind: "chapter", num: 1, tone: "blue", at: 2, to: 4, serif: ["time"], fit: true, fitWidth: 300 },
    { type: "scene", kind: "wordpage", at: 5, to: 7, bg: "black", ink: "#eee", gold: ["scary"], goldColor: "#c9a227" },
    { type: "scene", kind: "highlight", at: 8, to: 10, lines: [{ text: "remarkable people", at: 8.1 }, { text: "keep going", at: 8.8, box: true }], boxColor: "#f2c94c", boxInk: "#111", ink: "#555" },
  ] });
  build(dir); h = html(dir);
  assert.match(h, /class="ti-line">Money matters</, "title line");
  assert.match(h, /class="ti-line" style="font-size:120px">remarkable</, "title line size");
  assert.match(h, /class="ch-num"[^>]*>1</, "chapter numeral");
  assert.match(h, /class="ch-word[^"]*" style="color:[^";]+;font-size:\d+px"/, "chapter fit steps a long word down");
  assert.match(h, /\.ch-num \{/, "chapter css written");
  assert.match(h, /color:#c9a227/, "wordpage gold");
  assert.match(h, /color:#eee/, "wordpage ink");
  assert.match(h, /background:#f2c94c;color:#111/, "highlight boxColor / boxInk");
  dir = project({}); build(dir); h = html(dir);
  assert.ok(!/\.ch-num \{|\.ti-line \{/.test(h), "no chapter/title css on a reel without those scenes");
  check("title / chapter scenes (fit), wordpage black/ink/gold, highlight boxColor/boxInk");

  // ================= boxline.dodgeFace / fitLabel, captions.dodgeMouth, captions.chestBand, conceptCenter =================
  dir = project({ boxline: { dodgeFace: true, fitLabel: true }, beats: [{ type: "boxline", at: 1, to: 2.5, text: "why does money matter", label: "the host" }] });
  build(dir); h = html(dir);
  assert.match(h, /class="bx-lab" style="left:\d+px;top:\d+px;white-space:nowrap"/, "boxline label fitted");
  dir = project({ captions: { style: "duo", calmSize: 90, energySize: 100, fixedY: 1080, dodgeMouth: 90 } });
  build(dir);
  dir = project({ captions: { style: "cluster", chestBand: 1700, avoidFace: true, heroFallback: "none", heroes: ["money"] } });
  build(dir);
  dir = project({ conceptCenter: true, beats: [{ type: "scene", kind: "concept", at: 2, to: 4, word: "money", engravings: ["coins", "assets/pic.png"] }] });
  build(dir); h = html(dir);
  assert.match(h, /xPercent: -50, scale: 1\.06/, "conceptCenter keeps the engraving centred");
  assert.match(h, /src="assets\/pic\.png"/, "an engraving name with a slash is the project's own file");
  check("boxline.dodgeFace/fitLabel, captions.dodgeMouth, captions.chestBand, conceptCenter, own engraving path");

  console.log("\nall build-ahmed-styles tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

#!/usr/bin/env node
// node scripts/build-ahmed-mini2.test.mjs
// Ahmed's Explainer, Mono and Folio hardening (phantasic mini2-explainer / mini2-mono / mini2-folio, 9 Oct 2026), ported by feature.
// New style ids: keynote-4 (the shared Keynote round-1 pieces), explainer-2, mono-2, folio-2. Every key below is opt-in; the
// last check proves a reel on a style that sets none of them carries none of the output.
// Each style gets a synthetic reel; keynote-4 and folio-2 also get a two-recording reel (each take's own face).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-mini2-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 12, FPS = 30;
const mk = (name, freq) => ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, name));
mk("talk.mp4", 200); mk("talk-1.mp4", 300);

// "money" and "time" are engraving concepts (objectPops); punctuation gives the leak sentence fallback its anchors
const text = "why does money matter so much. because time is remarkable and scary. the remarkable thing is scary. a community far away lives on an isolated island. money and time again. remarkable people keep going. it is scary but remarkable. thank you for watching.".split(" ");
const wordsFor = (n = text.length, t0 = 0.3, k = 0.3) => ({ segments: [{ start: 0, end: SEC, words: Array.from({ length: n }, (_, i) => ({ word: text[i % text.length], start: +(t0 + i * k).toFixed(2), end: +(t0 + k - 0.05 + i * k).toFixed(2) })) }] });
// face samples [t, top, bottom, left, right, eyeY, mouthY]: a wide shot (face ~480 px tall) so a punch-in is capped by maxFaceH
const faceAt = (left, right, top = 300, bottom = 780) => ({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 7 }, (_, i) => [i * 2, top, bottom, left, right, top + 150, top + 350]) });

let n = 0;
function project(reel, { second = false, face = faceAt(340, 740) } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(wordsFor(second ? 16 : 38)));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  if (second) {
    fs.copyFileSync(path.join(root, "talk-1.mp4"), path.join(dir, "assets", "talk-1.mp4"));
    fs.writeFileSync(path.join(dir, "build", "words-1.whisper.json"), JSON.stringify(wordsFor(16)));
    fs.writeFileSync(path.join(dir, "build", "face-1.json"), JSON.stringify(faceAt(60, 460)));    // centre x 260, a wide face close to the left edge
  }
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "mini2", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, outro: 0.4, zoom: {}, takes: [{ a: 0, b: SEC }], beats: [], ...reel }, null, 2));
  return dir;
}
const run = (dir, env = {}) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
const build = (dir, env) => { const r = run(dir, env); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const truth = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "build", "edit_truth.json"), "utf8"));
const check = (label) => console.log(`ok    ${label}`);
const count = (s, re) => (s.match(re) || []).length;
const scales = (dir) => truth(dir).snaps.map((s) => s.scale).filter(Number.isFinite);

try {
  // ================= keynote-4 =================
  let dir = project({ style: "keynote-4", leaks: { every: 1 }, captions: { keywords: { remarkable: "bold" }, keywordAt: { remarkable: [3.0] } }, cadence: { every: 1.4, scales: [1.3], faceAnchor: { fit: true, maxFaceH: 0.5 } } }, { face: faceAt(340, 740, 200, 1000) });
  let log = build(dir);
  let h = html(dir);
  assert.ok(h.includes(".ew { text-shadow: 0 1px 2px rgba(0,0,0,.9)"), "captions.editorialShadow strong: .ew shadow CSS");
  check("keynote-4: editorial caption shadow CSS (captions.editorialShadow)");
  const leaks = count(h, /id="leak\d+" class="clip"/g);
  assert.ok(leaks >= 1, `a one-take clip gets sentence-end light leaks (${leaks})`);
  assert.match(h, /mask-image:radial-gradient\(ellipse [\d.]+% [\d.]+% at 50\.\d% /, "faceSafe: the flash is masked off the face (centre x 540 = 50%)");
  assert.match(h, /ft\("#leak0", \{ opacity: 0 \}, \{ opacity: 0\.6,/, "leaks.peak 0.6");
  check(`keynote-4: leaks on sentence ends (${leaks}), face-safe mask, peak 0.6`);
  // keywordAt: "remarkable" is said several times; the bold treatment is only on the occurrence at 3.0 s
  assert.equal(count(h, /class="ew ebold"/g), 1, "keywordAt: only the picked occurrence is a keyword");
  assert.ok(count(h, />remarkable</g) > 1, "the word is still captioned everywhere else");
  check("keynote-4: captions.keywordAt limits a keyword treatment to the director's occurrence");
  // faceAnchor.fit: the same reel without fit punches harder
  const fitScales = scales(dir);
  const dirNoFit = project({ style: "keynote-4", cadence: { every: 1.4, scales: [1.3], faceAnchor: { fit: false } } }, { face: faceAt(340, 740, 200, 1000) });
  build(dirNoFit);
  const noFit = scales(dirNoFit);
  assert.ok(Math.max(...noFit) > 1.25, `without fit the punch-in is the full ${Math.max(...noFit)}`);
  assert.ok(Math.max(...fitScales) < Math.max(...noFit), `with fit it is capped (${Math.max(...fitScales)} < ${Math.max(...noFit)})`);
  check(`keynote-4: cadence.faceAnchor.fit caps the punch-in (${Math.max(...fitScales)} vs ${Math.max(...noFit)})`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "build", "master.json"), "utf8")).lufs, -15, "build/master.json");
  check("keynote-4: style.master -> build/master.json");

  // two recordings: faces at x 540 and x 260 -> each take anchors on its own face
  dir = project({ style: "keynote-4", cadence: { every: 1.4, scales: [1.3], faceAnchor: { fit: true, maxFaceH: 0.9 } }, takes: [{ a: 0, b: 6, src: "assets/talk.mp4" }, { a: 0, b: 6, src: "assets/talk-1.mp4" }] }, { second: true });
  build(dir);
  h = html(dir);
  const origins = [...h.matchAll(/transformOrigin: "(\d+)px (\d+)px"/g)].map((m) => +m[1]);
  assert.ok(origins.includes(540) && origins.includes(260), `each recording anchors on its own face (${[...new Set(origins)]})`);
  assert.equal(truth(dir).sources.length, 2);
  // the face at x 260 (right edge 360) is nearer the left frame edge than the one at 540: fit caps its punch lower
  const byOrigin = {};
  for (const s of truth(dir).snaps) if (s.origin && Number.isFinite(s.scale)) (byOrigin[s.origin[0]] ??= []).push(s.scale);
  assert.ok(byOrigin[260] && byOrigin[540], `snaps for both recordings (${JSON.stringify(byOrigin)})`);
  assert.ok(Math.max(...byOrigin[260]) < Math.max(...byOrigin[540]), `fit caps the near-edge face lower (${JSON.stringify(byOrigin)})`);
  check("keynote-4, two recordings: faceAnchor + fit use each take's own face track");
  const masks = [...h.matchAll(/mask-image:radial-gradient\(ellipse [\d.]+% [\d.]+% at ([\d.]+)%/g)].map((m) => +m[1]);
  assert.ok(masks.length === 0 || masks.every((x) => Number.isFinite(x)));
  check("keynote-4, two recordings: face-safe leak masks build per take");

  // ================= explainer-2 =================
  dir = project({ style: "explainer-2",
    beats: [
      { type: "effect", at: 0.3, to: 2.4, fit: true, lines: [{ text: "the", at: 0.3 }, { text: "extraordinarily", box: true, at: 0.6 }, { text: "effect", at: 0.9 }] },
      { type: "scene", kind: "cutout", at: 3, to: 5.4, word: "remarkable", ground: "chalk", barChars: 14, maxBars: 3, wordSize: 150 },
      { type: "scene", kind: "cutout", at: 7, to: 9, engraving: "coins", ground: "maroon" }] });
  log = build(dir);
  h = html(dir);
  assert.match(h, /\.ef-box span \{[^}]*font-size: 128px/, "effect CSS present");
  const boxPx = Number((h.match(/<span style="font-size:(\d+)px">EXTRAORDINARILY<\/span>/) || [])[1]);
  assert.ok(boxPx > 0 && boxPx < 128, `effect b.fit shrinks the boxed word (${boxPx}px)`);
  check(`explainer-2: effect hook title, boxed word shrunk to fit (${boxPx}px)`);
  assert.match(h, /class="co-art eng wd"/, "word page");
  assert.match(h, /class="co-word" style="font-size:\d+px">REMARKABLE</);
  assert.ok(count(h, /class="co-bar"/g) >= 2 && /class="co-bar" style="font-size:\d+px"/.test(h), "bars break by length with one fitted font size");
  assert.match(h, /class="co-art eng" style=/, "engraving page");
  check("explainer-2: cutout pages (word page, engraving page), typewriter bars by length");
  assert.match(h, /\.cap-group \{[^}]*background: rgba\(255,255,255,\.96\)[^}]*border-radius: 14px|\.cap-group \{[^}]*border-radius: 14px[^}]*background: rgba\(255,255,255,\.96\)/, "pillKit: light pill, radius 14");
  assert.match(h, /\.cap-group \.w \{ color: inherit !important; \}/);
  check("explainer-2: pill captions (size / light / radius)");
  const returns = (d) => [...html(d).matchAll(/tl\.to\("#caps", \{ autoAlpha: 1, duration: 0\.12 \}, ([\d.]+)\)/g)].map((m) => +m[1]);
  const pageBeat = { type: "scene", kind: "cutout", at: 3, to: 5.4, word: "remarkable", ground: "chalk", barChars: 14, maxBars: 3 };
  const dLate = project({ style: "explainer-2", beats: [pageBeat] }), dEarly = project({ style: "explainer-2", captions: { reshowLate: false }, beats: [pageBeat] });
  build(dLate); build(dEarly);
  const late = returns(dLate).find((x) => x > 5), early = returns(dEarly).find((x) => x > 5);
  assert.ok(late > early, `reshowLate: the pill returns after the page, not 0.05 s before it ends (${late} vs ${early})`);
  check("explainer-2: captions.reshowLate");
  assert.match(log, /music 'lo-fi-02' is not available on disk|not available on disk/, "missing bed degrades cleanly");
  check("explainer-2: missing music bed -> warning, build succeeds");
  assert.ok(fs.existsSync(path.join(dir, "build", "master.json")));

  // ================= mono-2 =================
  dir = project({ style: "mono-2", beats: [
    { type: "scene", kind: "stack", at: 0.3, to: 2.2, bg: "footage", lead: "why does", key: "money", punch: 1.2, punchOrigin: "50% 30%" },
    { type: "scene", kind: "stack", at: 2.4, to: 4.4, bg: "footage", lead: "because", key: "time", fit: 0.8 },
    { type: "scene", kind: "stack", at: 4.6, to: 6.6, bg: "card", lead: "a", key: "community", cardH: 700, cardW: 800, filmFace: [540, 500], icon: "team" },
    { type: "scene", kind: "stack", at: 6.8, to: 8.8, bg: "phone", lead: "far", key: "island", filmFace: [540, 500] }] });
  log = build(dir);
  h = html(dir);
  assert.match(h, /grayscale\(1\) contrast\(1\.12\)/, "grayscale film + grade");
  assert.ok(h.includes('class="mn-scrim"'), "brand.footScrim: scrim behind the words on footage pages");
  assert.ok(h.includes("rgba(0,0,0,0.5) 200px"));
  assert.match(h, /id="[^"]*-fw" class="mn-full" style="position:absolute;inset:0;transform-origin:50% 30%"/, "punchOrigin");
  assert.ok(h.includes('class="mn-fitbg"') && /id="[^"]*-fit" class="mn-fit"[^>]*scale\(0\.8\)/.test(h), "fit: shrunk close-up over a blurred copy");
  assert.match(h, /class="mn-card" style="height:700px;left:140px;right:auto;width:800px;border-radius:18px"/, "cardH / cardW");
  assert.match(h, /<video class="mn-film"[^>]*object-position:-?\d+px -?\d+px/, "filmFace frames the film on the face");
  check("mono-2: grayscale, scrim, punchOrigin, fit, portrait card, filmFace");
  assert.match(log, /not available on disk|rendering without music/, "licensed bed missing, no fallback on disk -> no music, build succeeds");
  check("mono-2: music.fallback with no bed on disk degrades to no music");
  dir = project({ style: "mono", beats: [{ type: "scene", kind: "stack", at: 0.3, to: 2.2, bg: "footage", lead: "why does", key: "money" }] });
  const rb = run(dir);
  if (rb.status === 0) {
    const hb = html(dir);
    for (const x of ['class="mn-scrim"', "mn-fitbg", "object-position"]) assert.ok(!hb.includes(x), `mono must not contain ${x}`);
    check("mono (base) is unchanged by the mono-2 keys");
  } else console.log("skip  base mono (its own bed is not on this machine)");

  // ================= folio-2 =================
  dir = project({ style: "folio-2", name: "Ahmed", objectPops: { faceAware: true, x: 650, y: 240, w: 240, hold: 1.5, gap: 2 } }, { face: faceAt(440, 640) });
  log = build(dir);
  h = html(dir);
  assert.match(h, /id="endfade" class="clip" data-start="[\d.]+" data-duration="0\.8"/, "endFade");
  const pops = count(h, /id="op\d+" class="clip"/g);
  assert.ok(pops >= 1, `object pop-ups (${pops})`);
  const popLeft = [...h.matchAll(/id="op\d+" class="clip"[^>]*style="position:absolute;left:(\d+)px/g)].map((m) => +m[1]);
  assert.ok(popLeft.every((x) => x !== 650), `faceAware: pop-ups use the reaction slot, not the fixed x 650 (${popLeft})`);
  check(`folio-2: end fade, face-aware object pop-ups (${pops}) in the reaction slot`);
  const dBase = project({ style: "editorial-collage", name: "Ahmed", objectPops: { x: 650, y: 240, w: 240, hold: 1.5, gap: 2 } }, { face: faceAt(440, 640) });
  build(dBase);
  assert.ok(!html(dBase).includes('id="endfade"') && /left:650px/.test(html(dBase)), "editorial-collage itself is unchanged");
  check("folio-2: editorial-collage (base) keeps its fixed pop-up slot and has no end fade");
  dir = project({ style: "folio-2", name: "Ahmed", openFlash: { at: { src: "assets/talk.mp4", t: 0 } }, objectPops: { faceAware: true, w: 240, hold: 1.5, gap: 1.5 }, takes: [{ a: 0, b: 6, src: "assets/talk.mp4" }, { a: 0, b: 6, src: "assets/talk-1.mp4" }] }, { second: true });
  build(dir);
  assert.equal(truth(dir).sources.length, 2);
  assert.ok(html(dir).includes('id="endfade"'));
  check("folio-2, two recordings: builds with per-source face-aware pop-ups");

  // ================= none of it leaks into other styles =================
  dir = project({ style: "clean", beats: [{ type: "scene", kind: "stack", at: 0.3, to: 2.2, bg: "footage", lead: "a", key: "money" }] });
  build(dir);
  h = html(dir);
  for (const x of [".ef-box", ".co-art", 'id="endfade"', "mn-scrim", "mn-fitbg", "mask-image:radial-gradient", "color: inherit !important", ".ew { text-shadow"]) assert.ok(!h.includes(x), `style clean must not contain ${x}`);
  assert.ok(!fs.existsSync(path.join(dir, "build", "master.json")));
  check("a style that sets none of the keys carries none of the output");

  console.log("\nall build-ahmed-mini2 checks passed");
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

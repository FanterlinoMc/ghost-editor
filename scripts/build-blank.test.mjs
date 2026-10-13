#!/usr/bin/env node
// node scripts/build-blank.test.mjs
// build.mjs on the blank-timeline inputs (BLANK-TIMELINE-SPEC.md, Stage 1):
//   - a blank reel (origin "blank", no takes) -> a valid black page of 1 s; the same reel WITHOUT the
//     marker still fails
//   - a 3-source reel (talking head + silent clip + still image), takes from all three, where only
//     the talking head has a transcript and a face track
//   - a reel with no `words` at all
//   - a reel whose PRIMARY source is a still image / silent clip (the voice-peak decode must not run)
// Sources are tiny lavfi files shaped like prep.sh's output (H.264 + stereo AAC).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-blank-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const enc = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest"];
const SEC = 6;
const clips = {
  talk: () => ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=30:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`, ...enc, path.join(root, "talk.mp4")),
  silent: () => ff("-f", "lavfi", "-i", `testsrc=size=108x192:rate=30:duration=${SEC}`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", ...enc, path.join(root, "silent.mp4")),
  image: () => ff("-f", "lavfi", "-i", "color=c=navy:size=108x192:rate=30", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(SEC), ...enc, path.join(root, "image.mp4")),
};
for (const c of Object.values(clips)) c();

const words = { segments: [{ start: 0, end: SEC, words: "hello there this is the talking head speaking for a few seconds now".split(" ").map((w, i) => ({ word: w, start: 0.3 + i * 0.35, end: 0.55 + i * 0.35 })) }] };
const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 5 }, (_, i) => [i * 2, 300, 900, 340, 740, 480, 700]) };

let n = 0;
function project(reel, { sources = {}, files = {} } = {}) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  for (const [dst, from] of Object.entries(sources)) fs.copyFileSync(path.join(root, from), path.join(dir, "assets", dst));
  for (const [rel, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), JSON.stringify(v));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "blank test", fps: 30, outro: 0, music: null, style: "clean", zoom: {}, beats: [], ...reel }, null, 2));
  return dir;
}
const build = (dir) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8" });
const truth = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "build", "edit_truth.json"), "utf8"));

try {
  // ---- blank reel ----
  let dir = project({ origin: "blank", takes: [] });
  let r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.match(html, /data-composition-id="main"/);
  assert.match(html, /data-duration="1"/);
  assert.match(html, /data-width="1080" data-height="1920"/);
  assert.match(html, /window\.__timelines\["main"\] = tl;/);
  assert.doesNotMatch(html, /<video|<audio/);
  assert.deepEqual(truth(dir), { total: 1, speech: 0, fps: 30, takes: [], snaps: [], pushes: [], beats: [] });
  // a blank reel with a 16:9 format is a black 16:9 page
  dir = project({ origin: "blank", takes: [], format: "16:9" });
  assert.equal(build(dir).status, 0);
  assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /data-width="1920" data-height="1080"/);
  // ...and without the marker an empty reel is still an error
  r = build(project({ takes: [] }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no takes/);
  r = build(project({ origin: "something-else", takes: [] }));
  assert.notEqual(r.status, 0);

  // ---- 3 sources: talking head (words + face), silent clip, image ----
  const three = {
    source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json",
    takes: [
      { a: 0, b: 3, src: "assets/talk.mp4" },
      { a: 1, b: 3, src: "assets/talk-1.mp4", transition: "blur" },
      { a: 0, b: 2.5, src: "assets/talk-2.mp4", hold: 0.5 },
      { a: 3, b: 5, src: "assets/talk.mp4" },
    ],
  };
  dir = project(three, {
    sources: { "talk.mp4": "talk.mp4", "talk-1.mp4": "silent.mp4", "talk-2.mp4": "image.mp4" },
    files: { "build/words.whisper.json": words, "build/face.json": face },
  });
  r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  let t = truth(dir);
  assert.deepEqual(t.sources, ["assets/talk.mp4", "assets/talk-1.mp4", "assets/talk-2.mp4"]);
  assert.deepEqual(t.takes.map((k) => k.srcIndex), [0, 1, 2, 0]);
  assert.equal(t.takes.length, 4);
  const out = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  for (const s of ["assets/talk.mp4", "assets/talk-1.mp4", "assets/talk-2.mp4"]) assert.ok(out.includes(`src="${s}"`), s);
  // captions come from the talking head's takes only; the silent clip and the image own none
  const edit = JSON.parse(fs.readFileSync(path.join(dir, "build", "words.edit.json"), "utf8"));
  assert.ok(edit.length > 0);
  assert.ok(edit.every((w) => w.start < 3 + 1e-6 || w.start >= 3 + 2 + 2.5 + 0.5 - 1e-6), "no caption may fall on the silent clip or the image");
  // the face-less sources are called out, not silently given the speaker's face
  assert.match(r.stdout, /source assets\/talk-1\.mp4 has no face track/);
  assert.match(r.stdout, /source assets\/talk-2\.mp4 has no face track/);
  assert.match(r.stdout, /source assets\/talk-1\.mp4 has no transcript/);
  // the hold still of the image take is clamped to ITS file, not the first source's
  assert.ok(fs.existsSync(path.join(dir, "assets", "hold-2.jpg")));

  // ---- no words at all ----
  dir = project({ source: "assets/talk.mp4", takes: [{ a: 0, b: 4 }, { a: 4.5, b: 6 }], cadence: { every: 1.3 } }, { sources: { "talk.mp4": "talk.mp4" } });
  r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "build", "words.edit.json"), "utf8")).length, 0);
  assert.equal(truth(dir).takes.length, 2);
  // a words path that IS named but missing is still a failure (the pre-existing contract)
  dir = project({ source: "assets/talk.mp4", words: "build/nope.json", takes: [{ a: 0, b: 4 }] }, { sources: { "talk.mp4": "talk.mp4" } });
  assert.notEqual(build(dir).status, 0);

  // ---- primary source is an image / a silent clip, no spec.source needed ----
  dir = project({
    takes: [{ a: 0, b: 2, src: "assets/talk-5.mp4" }, { a: 0, b: 3, src: "assets/talk-6.mp4", transition: "whip" }],
  }, { sources: { "talk-5.mp4": "image.mp4", "talk-6.mp4": "silent.mp4" } });
  r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  t = truth(dir);
  assert.equal(t.total, 5);
  assert.equal(t.takes[1].transition, "whip");
  // an image as the only source, outro on: the end still is cut from it
  dir = project({ outro: 2, takes: [{ a: 0, b: 3, src: "assets/talk-5.mp4" }] }, { sources: { "talk-5.mp4": "image.mp4" } });
  r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(dir, "assets", "outro.jpg")));

  // ---- multi-source motion beats (staging bug 1): a beat on the talking head AFTER the B-roll ----
  // every source starts at 0 s, so a bare time like 1.5 is covered by the B-roll AND the talking head.
  const msTakes = [{ a: 0, b: 3, src: "assets/talk-1.mp4" }, { a: 0, b: 5, src: "assets/talk.mp4", transition: "blur" }];
  const msBeat = (extra) => ({ type: "motion", id: "big", by: "user", at: 1.5, to: 3.5, hideCaptions: true, exit: "fade", ...extra,
    elements: [{ id: "number", shape: "text", x: 90, y: 520, w: 900, h: 340, z: 2, text: "50%", font: "Montserrat", size: 280, weight: 900, align: "center", color: "#ffffff" }],
    tweens: [{ target: "number", at: 0, dur: 0.5, ease: "power2.out", from: { opacity: 0 }, to: { opacity: 1 } }] });
  const msFiles = { "build/words.whisper.json": words, "build/face.json": face };
  const msSources = { "talk.mp4": "talk.mp4", "talk-1.mp4": "silent.mp4" };
  const ms = (beats, extra = {}) => project({ source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", takes: msTakes, beats, ...extra }, { sources: msSources, files: msFiles });
  // (a) no src on the beat, style "clean" (no designer:true): scheduled on the PRIMARY source (talking head), at 3 + 1.5, with a warning
  dir = ms([msBeat({})]);
  r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!/motion beat .* dropped/.test(r.stdout), "the beat must not be dropped: " + r.stdout);
  assert.ok(r.stdout.includes("is in 2 sources") && r.stdout.includes("used assets/talk.mp4 (the primary source)"), r.stdout);
  let mb = truth(dir).beats.filter((b) => b.type === "motion");
  assert.deepEqual(mb.map((b) => [b.at, b.to]), [[4.5, 6.5]]);
  assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /data-beat-id="big"/);
  // (b) explicit src on the beat: it means that recording, no warning (the B-roll one lands at 1.5)
  dir = ms([msBeat({ src: "assets/talk-1.mp4", to: 3 }), msBeat({ id: "big2", src: "assets/talk.mp4", at: 4, to: 4.8 })]);
  r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!/is in 2 sources/.test(r.stdout));
  mb = truth(dir).beats.filter((b) => b.type === "motion");
  assert.deepEqual(mb.map((b) => [b.at, b.to]), [[1.5, 3], [7, 7.8]]);
  // a src that is not a source of the reel is refused, not guessed
  r = build(ms([msBeat({ src: "assets/nope.mp4" })]));
  assert.match(r.stdout + r.stderr, /dropped|not a source/);
  // (c) a bare time that only one source covers needs no src
  dir = ms([msBeat({ at: 3.5, to: 4.8 })]);
  r = build(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(truth(dir).beats.filter((b) => b.type === "motion").map((b) => b.at), [6.5]);
  // (d) the page's timeline is as long as the reel (3 + 5 s), not as long as its last tween
  const msHtml = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.ok(/tl[.]set[(][{][}], [{][}], 8[)];\s*window[.]__timelines\["main"\] = tl;/.test(msHtml), "timeline padded to the reel length");
  assert.match(msHtml, /data-duration="8"/);
  console.log("ok    multi-source motion beats: src, primary-source rule, timeline length");

  // ---- layer hideCaptions: the captions go while a motion/text layer is up ----
  const lyr = (hide) => project({ source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", takes: [{ a: 0, b: 6 }],
    layers: [{ id: "gx", kind: "text", pin: true, at: 1, dur: 2, text: "Hi", size: 70, color: "#ffffff", box: { x: 90, y: 400, w: 900, h: 160 }, z: 1, by: "user", ...(hide ? { hideCaptions: true } : {}) }] }, { sources: { "talk.mp4": "talk.mp4" }, files: msFiles });
  const shown = lyr(false), hidden = lyr(true);
  assert.equal(build(shown).status, 0); assert.equal(build(hidden).status, 0);
  assert.notEqual(fs.readFileSync(path.join(shown, "index.html"), "utf8"), fs.readFileSync(path.join(hidden, "index.html"), "utf8"), "hideCaptions must change the captions");
  assert.deepEqual(truth(hidden).layers.map((l) => l.hideCaptions), [true]);
  assert.deepEqual(truth(shown).layers.map((l) => l.hideCaptions), [undefined]);
  console.log("ok    layer hideCaptions");
  console.log("build blank / multi-source: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

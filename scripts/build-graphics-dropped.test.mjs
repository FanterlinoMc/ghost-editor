// mac-54: every graphic the build leaves out is recorded in build/graphics-dropped.json (kind, id, at, to, t, rule,
// why, warning). The drops themselves are unchanged (byte-identity proves the rest); a build that drops nothing has no file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { goodGraphic } from "./lib/graphic-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gdrop-"));
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=108x192:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=200:duration=8",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(root, "talk.mp4")]);
const words = { segments: [{ start: 0, end: 8, words: "one two three four five six seven eight nine ten eleven twelve".split(" ").map((w, i) => ({ word: w, start: 0.3 + i * 0.6, end: 0.7 + i * 0.6 })) }] };
// a face that fills the frame: no room beside it for a sticker
const fullFace = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 5 }, (_, i) => [i * 2, 200, 1700, 20, 1060, 600, 1200]) };
let n = 0;
function project(reel, face = fullFace) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets", "graphics"), { recursive: true }); fs.mkdirSync(path.join(dir, "build"));
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "assets", "graphics", "bad.html"), goodGraphic({ seekExtra: "var q = Math.random();" }));   // G12
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "drops", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json",
    fps: 30, outro: 0, music: null, style: "clean", zoom: {}, beats: [], takes: [{ a: 0, b: 8 }], ...reel }, null, 2));
  return dir;
}
const build = (dir) => spawnSync(process.execPath, [path.join(HERE, "build.mjs"), "."], { cwd: dir, encoding: "utf8" });
const record = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "build", "graphics-dropped.json"), "utf8")).dropped;
const FILE = (dir) => path.join(dir, "build", "graphics-dropped.json");

const motion = (id, extra = {}) => ({ type: "motion", id, at: 1, to: 3, hideCaptions: true, exit: "fade", sfx: "none",
  elements: [{ id: "t", shape: "text", text: "Hello", x: 100, y: 300, w: 600, h: 120, size: 80 }], tweens: [], ...extra });

test("each kind of drop is recorded with its rule and a plain sentence; the warnings are unchanged", () => {
  const dir = project({ beats: [
    motion("nodesign"),                                                                  // clean is not a designer style
    motion("part", { by: "user", elements: [{ id: "t", shape: "text", text: "Hi", x: 100, y: 300, w: 600, h: 120, size: 80 }, { id: "z", shape: "blob" }] }),
    { type: "graphic", id: "unsafe", html: "assets/graphics/bad.html", at: 4, to: 5 },   // G12, before any render
    { type: "emoji", at: 6, emoji: "🔥" },                                                // the face fills the frame
  ] });
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr);
  const d = record(dir);
  const by = (k, id) => d.find((x) => x.kind === k && (id === undefined || x.id === id));
  const m = by("motion beat", "nodesign");
  assert.equal(m.rule, "designer-off"); assert.equal(m.at, 1); assert.equal(m.to, 3); assert.equal(m.t, 1);
  assert.equal(m.why, 'The motion graphic "nodesign" at 0:01 was dropped because the reel\'s style does not allow designer graphics.');
  assert.ok(r.stdout.includes(m.warning), "`warning` is the build's own warning, word for word");
  const e = by("motion element", "part/z");
  assert.equal(e.rule, "element"); assert.match(e.warning, /unknown shape 'blob', dropped/);
  assert.equal(e.why, 'One part ("z") of the motion graphic at 0:01 was left out because it could not be drawn.');
  const g = by("graphic beat", "unsafe");
  assert.equal(g.rule, "G12"); assert.equal(g.t, 4);
  assert.equal(g.why, 'The graphic "unsafe" at 0:04 was dropped because its HTML file failed a safety check.');
  assert.ok(r.stdout.includes(g.warning));
  const s = by("sticker");
  assert.equal(s.type, "emoji"); assert.equal(s.rule, "no-room"); assert.equal(s.at, 6);
  assert.equal(s.why, "The emoji at 0:06 was left out because the speaker's face fills the frame and there is no room beside it.");
  for (const x of d) for (const k of ["kind", "id", "type", "at", "to", "t", "rule", "why", "warning"]) assert.ok(k in x, `${k} in ${JSON.stringify(x)}`);
  assert.equal(d.length, 4, JSON.stringify(d.map((x) => x.kind + ":" + x.id)));
});

test("mac-55: tweens and tween keys a kept motion graphic leaves out are recorded, for beats and motion layers", () => {
  const el = [{ id: "t", shape: "text", text: "Hi", x: 100, y: 300, w: 600, h: 120, size: 80 }];
  const ok = { target: "t", at: 0, dur: 0.3, from: { opacity: 0 }, to: { opacity: 1 } };
  const dir = project({
    beats: [motion("anim", { by: "user", elements: el, tweens: [
      ok,
      { target: "ghost", at: 0, dur: 0.3, from: { opacity: 0 }, to: { opacity: 1 } },               // no such element: dropped
      { target: "t", at: 0.5, dur: 0.3, from: { opacity: 0, color: 1 }, to: { opacity: 1, color: 2 } }, // 'color' is not animatable
    ] }), motion("many", { by: "user", at: 4, to: 6, elements: el, tweens: Array.from({ length: 31 }, (_, k) => ({ ...ok, at: k * 0.05 })) })],
    layers: [{ id: "lay", kind: "motion", pin: true, at: 6.5, dur: 1, elements: el, tweens: [{ target: "nope", at: 0, dur: 0.3, from: { x: 0 }, to: { x: 10 } }] }],
  }, { fps: 5, w: 1080, h: 1920, samples: [[0, 300, 900, 340, 740, 480, 700], [8, 300, 900, 340, 740, 480, 700]] });
  const r = build(dir);
  assert.equal(r.status, 0, r.stderr);
  const d = record(dir).filter((x) => x.kind === "motion tween");
  const get = (id) => d.find((x) => x.id === id);
  assert.equal(get("anim/tween 1").rule, "tween");
  assert.equal(get("anim/tween 1").why, 'An animation (tween 1 on "ghost") of the motion graphic at 0:01 was left out, so that part does not move as planned.');
  assert.ok(r.stdout.includes(get("anim/tween 1").warning), "warning is the build's own text");
  assert.equal(get("anim/tween 2").rule, "tween-key");
  assert.match(get("anim/tween 2").warning, /key 'color' is not animatable, ignored/);
  assert.equal(get("many/tween 30").rule, "tween-limit");
  assert.equal(get("many/tween 30").why, "An animation (tween 30 on \"t\") of the motion graphic at 0:04 was left out because a motion graphic may have at most 30 animations.");
  assert.equal(get("lay/tween 0").type, "motion layer");
  assert.equal(get("lay/tween 0").why, 'An animation (tween 0 on "nope") of the motion layer at 0:06 was left out, so that part does not move as planned.');
  assert.ok(!d.some((x) => x.id === "anim/tween 0"), "a kept tween is not recorded");
});

test("a rebuild that drops nothing removes the file; a reel that never dropped anything never has one", () => {
  const dir = project({ beats: [motion("nodesign")] });
  assert.equal(build(dir).status, 0);
  assert.ok(fs.existsSync(FILE(dir)));
  const reel = JSON.parse(fs.readFileSync(path.join(dir, "reel.json"), "utf8")); reel.beats = [];
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify(reel));
  assert.equal(build(dir).status, 0);
  assert.ok(!fs.existsSync(FILE(dir)), "no stale record");
  const clean = project({});
  assert.equal(build(clean).status, 0);
  assert.ok(!fs.existsSync(FILE(clean)));
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

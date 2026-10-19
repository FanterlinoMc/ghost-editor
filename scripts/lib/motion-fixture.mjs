// Shared by scripts/motion-determinism.mjs and scripts/motion-cost.mjs: a self-contained synthetic
// project (no fixture checkout needed) and hand-written `motion` beats near the spec's limits.
//
//   makeProject(dir, { beat, seconds })  -> builds <dir> with the fork's build.mjs, returns { dir, html, out }
//   BUSY_BEAT   12 elements, 30 tweens: blur, draw, reveal, count, split by word and by char, holds
//   BLUR_BEAT   the blur limit case: two elements just under 50% of the canvas, blurred the whole beat
//   stripBlur() BUSY_BEAT without its blur keys (isolates what blur costs)
//
// Everything is deterministic input; nothing here touches the network except what build.mjs/hyperframes do.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL = path.resolve(HERE, "..", "..");
export const BUILD_MJS = path.join(SKILL, "scripts", "build.mjs");

// the beat sits at 2.0..8.0 of a single kept take 0..SECONDS, so output time == source time
export const BEAT_AT = 2.0, BEAT_TO = 8.0, SECONDS = 10;

const el = (o) => o;
export const BUSY_BEAT = {
  type: "motion", by: "designer", id: "busy", at: BEAT_AT, to: BEAT_TO, hideCaptions: false, dim: 0.35, exit: "fade", sfx: "none",
  elements: [
    el({ id: "card", shape: "rect", x: 60, y: 200, w: 960, h: 560, fill: "ink", fill2: "accent", gradientAngle: 135, stroke: "#ffffff", strokeWidth: 3, radius: 36, z: 1 }),
    el({ id: "title", shape: "text", x: 100, y: 230, w: 880, h: 220, text: "Stop doing DMs by hand", font: "Montserrat", size: 96, weight: 800, upper: true, align: "left", color: "#ffffff", shadow: "strong", split: "words", z: 4 }),
    el({ id: "sub", shape: "text", x: 100, y: 450, w: 880, h: 90, text: "Automate the boring part", font: "Inter", size: 48, weight: 500, align: "left", color: "paper", split: "chars", z: 4 }),
    el({ id: "count", shape: "text", x: 100, y: 540, w: 480, h: 190, text: "1,200", font: "Gloock", size: 150, weight: 700, align: "left", color: "accent", shadow: "soft", z: 4 }),
    el({ id: "label", shape: "text", x: 560, y: 600, w: 420, h: 80, text: "DMs per month", font: "Inter", size: 44, weight: 600, align: "left", color: "#ffffff", z: 4 }),
    el({ id: "rule", shape: "line", x: 100, y: 770, x2: 980, y2: 770, stroke: "accent", strokeWidth: 8, cap: "round", z: 3 }),
    el({ id: "swoosh", shape: "path", x: 100, y: 800, w: 700, h: 160, d: "M0 140 C 170 0 330 180 500 60 S 650 20 696 80", stroke: "#ffffff", strokeWidth: 10, cap: "round", z: 3 }),
    el({ id: "ring", shape: "ellipse", x: 760, y: 820, w: 220, h: 220, fill: "none", stroke: "accent", strokeWidth: 10, z: 3 }),
    el({ id: "dot", shape: "ellipse", x: 830, y: 890, w: 80, h: 80, fill: "accent", z: 3 }),
    el({ id: "bar", shape: "rect", x: 100, y: 1000, w: 880, h: 20, fill: "paper", radius: 10, z: 2 }),
    el({ id: "tag", shape: "text", x: 560, y: 1060, w: 440, h: 120, text: "no copy-paste", font: "Caveat Brush", size: 80, weight: 400, align: "right", color: "accent", shadow: "soft", rotate: -6, z: 4 }),
    el({ id: "glow", shape: "ellipse", x: 300, y: 1100, w: 480, h: 480, fill: "accent", opacity: 0.35, z: 0 }),
  ],
  tweens: [
    { target: "card", at: 0, dur: 0.6, ease: "power3.out", from: { reveal: 0 }, to: { reveal: 1 }, revealFrom: "left" },
    { target: "card", at: 0, dur: 0.6, ease: "power3.out", from: { y: 40 }, to: { y: 0 } },
    { target: "card", at: 3.0, dur: 1.5, ease: "sine.inOut", from: { scale: 1 }, to: { scale: 1.03 } },
    { target: "card", at: 4.8, dur: 0.6, ease: "none", from: { opacity: 1 }, to: { opacity: 0.9 } },
    { target: "title", at: 0.2, dur: 0.5, stagger: 0.12, ease: "back.out", from: { y: 60, opacity: 0, blur: 14 }, to: { y: 0, opacity: 1, blur: 0 } },
    { target: "title", at: 2.6, dur: 0.4, ease: "power2.out", from: { scale: 1 }, to: { scale: 1.08 } },
    { target: "title", at: 3.2, dur: 0.4, ease: "power2.in", from: { scale: 1.08 }, to: { scale: 1 } },
    { target: "title", at: 5.0, dur: 0.5, stagger: 0.05, ease: "power1.in", from: { opacity: 1 }, to: { opacity: 0 } },
    { target: "sub", at: 0.8, dur: 0.3, stagger: 0.03, ease: "power2.out", from: { opacity: 0 }, to: { opacity: 1 } },
    { target: "sub", at: 0.8, dur: 0.4, stagger: 0.03, ease: "power3.out", from: { y: 20 }, to: { y: 0 } },
    { target: "count", at: 1.0, dur: 1.4, ease: "power2.out", from: { count: 0 }, to: { count: 1200 } },
    { target: "count", at: 1.0, dur: 0.5, ease: "back.out", from: { scale: 0.7 }, to: { scale: 1 } },
    { target: "count", at: 1.0, dur: 0.3, ease: "none", from: { opacity: 0 }, to: { opacity: 1 } },
    { target: "count", at: 3.0, dur: 1.0, ease: "power2.inOut", from: { count: 1200 }, to: { count: 1500 } },
    { target: "label", at: 1.2, dur: 0.5, ease: "power2.out", from: { reveal: 0 }, to: { reveal: 1 }, revealFrom: "bottom" },
    { target: "label", at: 1.2, dur: 0.5, ease: "power2.out", from: { x: 30 }, to: { x: 0 } },
    { target: "rule", at: 1.6, dur: 0.6, ease: "power2.inOut", from: { draw: 0 }, to: { draw: 1 } },
    { target: "rule", at: 4.6, dur: 0.4, ease: "none", from: { opacity: 1 }, to: { opacity: 0 } },
    { target: "swoosh", at: 1.8, dur: 1.0, ease: "power2.inOut", from: { draw: 0 }, to: { draw: 1 } },
    { target: "swoosh", at: 4.0, dur: 0.8, ease: "power2.inOut", from: { draw: 1 }, to: { draw: 0 } },
    { target: "ring", at: 2.0, dur: 0.8, ease: "back.out", from: { draw: 0, scale: 0.5 }, to: { draw: 1, scale: 1 } },
    { target: "ring", at: 3.0, dur: 1.5, ease: "power1.inOut", from: { rotate: 0 }, to: { rotate: 90 } },
    { target: "dot", at: 2.2, dur: 0.6, ease: "elastic.out", from: { scale: 0 }, to: { scale: 1 } },
    { target: "dot", at: 3.5, dur: 0.5, ease: "sine.inOut", from: { y: 0 }, to: { y: -30 } },
    { target: "dot", at: 4.0, dur: 0.5, ease: "sine.inOut", from: { y: -30 }, to: { y: 0 } },
    { target: "bar", at: 0.5, dur: 0.8, ease: "power3.out", from: { reveal: 0 }, to: { reveal: 1 }, revealFrom: "right" },
    { target: "bar", at: 3.5, dur: 0.8, ease: "power2.inOut", from: { scaleX: 1 }, to: { scaleX: 0.5 } },
    { target: "tag", at: 2.4, dur: 0.5, ease: "back.out", from: { x: 200, opacity: 0 }, to: { x: 0, opacity: 1 } },
    { target: "tag", at: 3.4, dur: 0.6, ease: "power1.inOut", from: { rotate: 0 }, to: { rotate: 10 } },
    { target: "glow", at: 0, dur: 1.0, ease: "power2.out", from: { blur: 30, opacity: 0 }, to: { blur: 10, opacity: 1 } },
  ],
};

// the blur limit case: 2 elements, each 1000 x 1000 (48% of the 1080 x 1920 canvas, under the 50% rule),
// blurred across the whole beat; nothing else on screen
export const BLUR_BEAT = {
  type: "motion", by: "designer", id: "blur", at: BEAT_AT, to: BEAT_TO, hideCaptions: false, dim: 0, exit: "fade", sfx: "none",
  elements: [
    { id: "a", shape: "rect", x: 40, y: 100, w: 1000, h: 1000, fill: "accent", fill2: "ink", gradientAngle: 45, radius: 80, z: 1 },
    { id: "b", shape: "ellipse", x: 40, y: 800, w: 1000, h: 1000, fill: "paper", fill2: "accent", gradientAngle: 200, opacity: 0.8, z: 2 },
  ],
  tweens: [
    { target: "a", at: 0, dur: 2.5, ease: "power2.out", from: { blur: 30 }, to: { blur: 0 } },
    { target: "a", at: 3.0, dur: 3.0, ease: "power2.in", from: { blur: 0 }, to: { blur: 30 } },
    { target: "b", at: 0, dur: 2.5, ease: "power2.out", from: { blur: 30 }, to: { blur: 0 } },
    { target: "b", at: 3.0, dur: 3.0, ease: "power2.in", from: { blur: 0 }, to: { blur: 30 } },
  ],
};

// "Making room": a two-line headline and a count-up in the panel under the shrunk footage (y 1440..1800).
// at 2.0, to 6.0 -> room window 2.0..6.567 s (frames 60..197), footage at 0.73 from 2.35 to 6.217.
export const ROOM_BEAT = {
  type: "motion", by: "designer", id: "room", at: 2.0, to: 6.0, room: "below", exit: "fade", sfx: "none",
  elements: [
    { id: "l1", shape: "text", x: 90, y: 1450, w: 900, h: 120, text: "Stop doing", font: "Montserrat", size: 96, weight: 800, upper: true, align: "left", color: "#ffffff", shadow: "strong", z: 3 },
    { id: "l2", shape: "text", x: 90, y: 1560, w: 900, h: 120, text: "DMs by hand", font: "Montserrat", size: 96, weight: 800, upper: true, align: "left", color: "accent", z: 3 },
    { id: "rule", shape: "line", x: 90, y: 1700, x2: 990, y2: 1700, stroke: "accent", strokeWidth: 8, cap: "round", z: 2 },
    { id: "count", shape: "text", x: 90, y: 1720, w: 480, h: 170, text: "1,200", font: "Gloock", size: 140, weight: 700, align: "left", color: "#ffffff", z: 3 },
    { id: "unit", shape: "text", x: 590, y: 1790, w: 400, h: 70, text: "DMs a month", font: "Inter", size: 44, weight: 600, align: "left", color: "#ffffff", z: 3 },
  ],
  tweens: [
    { target: "l1", at: 0.35, dur: 0.4, ease: "power3.out", from: { y: 40, opacity: 0 }, to: { y: 0, opacity: 1 } },
    { target: "l2", at: 0.35, dur: 0.4, ease: "power3.out", from: { y: 40, opacity: 0 }, to: { y: 0, opacity: 1 } },
    { target: "rule", at: 0.5, dur: 0.5, ease: "power2.inOut", from: { draw: 0 }, to: { draw: 1 } },
    { target: "count", at: 0.6, dur: 1.4, ease: "power2.out", from: { count: 0 }, to: { count: 1200 } },
    { target: "count", at: 0.6, dur: 0.3, ease: "none", from: { opacity: 0 }, to: { opacity: 1 } },
    { target: "unit", at: 0.8, dur: 0.4, ease: "power2.out", from: { opacity: 0 }, to: { opacity: 1 } },
  ],
};
// two room beats whose windows overlap (2.0..4.55 and 3.5..6.55 -> frames 60..137 and 105..197): ONE shrink 60..197
export const ROOM_OVERLAP_BEATS = [
  { ...ROOM_BEAT, id: "room-a", to: 4.0, elements: ROOM_BEAT.elements.slice(0, 2), tweens: ROOM_BEAT.tweens.slice(0, 2) },
  { ...ROOM_BEAT, id: "room-b", at: 3.5, elements: ROOM_BEAT.elements.slice(3, 5), tweens: ROOM_BEAT.tweens.slice(3, 4).concat(ROOM_BEAT.tweens.slice(5, 6)) },
];

// reel.layers[] (BLANK-TIMELINE-SPEC.md, Stage 3) over the same single 10 s take: a video picture-in-picture
// (anchored, so it rides take 0), an image logo pinned for the whole reel, a text box over the captions, a
// still image sliding up, and a motion layer. All five kinds, every enter/exit shape the layers use.
export const LAYERS_FIXTURE = [
  { id: "pip", kind: "video", src: "assets/pip.mp4", anchor: { take: 0, offset: 3 }, dur: 3.5, in: 0.5, box: { x: 620, y: 140, w: 380, h: 676 }, fit: "cover", radius: 28, shadow: true, z: 2, audio: "off", enter: "pop", exit: "fade", by: "user" },
  { id: "logo", kind: "logo", src: "assets/mark.png", pin: true, at: 0, dur: 10, z: 6, by: "user" },
  { id: "note", kind: "text", pin: true, at: 5, dur: 4, text: "Over the captions", font: "Gloock", size: 72, color: "#ffffff", bg: "#000000b0", align: "center", box: { x: 90, y: 1500, w: 900, h: 170 }, radius: 24, z: 4, overCaptions: true, enter: "fade", exit: "fade", by: "user" },
  { id: "sticker", kind: "image", src: "assets/mark.png", pin: true, at: 1, dur: 3, box: { x: 60, y: 1100, w: 260, h: 260 }, fit: "contain", radius: 40, shadow: "strong", opacity: 0.9, z: 1, enter: "slide-up", exit: "none", by: "user" },
  { id: "gfx", kind: "motion", pin: true, at: 2, dur: 6, z: 3, enter: "slide-up", exit: "fade", by: "user",
    elements: [
      el({ id: "plate", shape: "rect", x: 80, y: 860, w: 920, h: 220, fill: "ink", fill2: "accent", gradientAngle: 120, radius: 32, z: 1 }),
      el({ id: "head", shape: "text", x: 120, y: 880, w: 840, h: 90, text: "Twelve seconds long", font: "Inter", size: 64, weight: 800, align: "left", color: "#ffffff", z: 2 }),
      el({ id: "num", shape: "text", x: 120, y: 970, w: 600, h: 100, text: "1,200", font: "Gloock", size: 84, weight: 700, align: "left", color: "accent", z: 2 }),
      el({ id: "rule", shape: "line", x: 120, y: 1100, x2: 960, y2: 1100, stroke: "#ffffff", strokeWidth: 6, z: 2 }),
    ],
    tweens: [
      { target: "head", at: 0.3, dur: 0.5, ease: "power3.out", from: { y: 30, opacity: 0 }, to: { y: 0, opacity: 1 } },
      { target: "num", at: 0.5, dur: 1.4, ease: "power2.out", from: { count: 0 }, to: { count: 1200 } },
      { target: "rule", at: 0.6, dur: 0.8, ease: "power2.inOut", from: { draw: 0 }, to: { draw: 1 } },
    ] },
];

// A hand-written, vector-only Lottie (no third-party animation): 30 fps, frames 0..60, 400 x 400. One shape layer, a
// red 60 px square whose centre moves linearly from x 50 to x 350 at y 200 (x = 50 + 5 * frame), so a frame number can
// be read back from the pixels. Written into the project by makeProject({ files }) - never a library asset.
export const LOTTIE_FIXTURE = {
  v: "5.7.4", fr: 30, ip: 0, op: 60, w: 400, h: 400, nm: "fixture-move", ddd: 0, assets: [],
  layers: [{
    ddd: 0, ind: 1, ty: 4, nm: "box", sr: 1, ao: 0, ip: 0, op: 60, st: 0, bm: 0,
    ks: {
      o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
      p: { a: 1, k: [{ t: 0, s: [50, 200, 0], i: { x: 1, y: 1 }, o: { x: 0, y: 0 } }, { t: 60, s: [350, 200, 0] }] },
    },
    shapes: [{ ty: "gr", nm: "sq", it: [
      { ty: "rc", d: 1, s: { a: 0, k: [60, 60] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
      { ty: "fl", c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 1 },
      { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
    ] }],
  }],
};
export const LOTTIE_FILE = "assets/lottie/move.json";
// two Lottie elements of the same file (one inlined copy): "once" starts 0.5 s in at 1.5x and holds its last frame
// (frame = min(floor((t - 2.5) * 45), 59)); "loopy" loops at 1x from the beat's start (frame = floor((t - 2) * 30) % 60).
// "once" also fades and scales in, so the box tweens and the frame driver run together.
export const LOTTIE_BEAT = {
  type: "motion", by: "designer", id: "lot", at: BEAT_AT, to: BEAT_TO, hideCaptions: false, dim: 0, exit: "fade", sfx: "none",
  elements: [
    { id: "once", shape: "lottie", src: LOTTIE_FILE, x: 340, y: 300, w: 400, h: 400, start: 0.5, speed: 1.5, loop: false, z: 2 },
    { id: "loopy", shape: "lottie", src: LOTTIE_FILE, x: 340, y: 900, w: 400, h: 400, loop: true, frames: [0, 60], z: 1 },
  ],
  tweens: [
    { target: "once", at: 0.5, dur: 0.4, ease: "power2.out", from: { opacity: 0, scale: 0.8 }, to: { opacity: 1, scale: 1 } },
  ],
};
// the frame each element shows at output second t (the spec's formula, written out independently of the compiler);
// the driver stops with the beat, so after BEAT_TO a player keeps the frame of the beat's end
export const lottieFrameAt = (t) => {
  const u = Math.min(t, BEAT_TO);
  return { once: u < 2.5 ? 0 : Math.min(Math.floor((u - 2.5) * 45 + 1e-3), 59), loopy: u < 2 ? 0 : Math.floor((u - 2) * 30 + 1e-3) % 60 };
};

export function stripBlur(beat) {
  const b = structuredClone(beat);
  for (const tw of b.tweens) { delete tw.from.blur; delete tw.to.blur; }
  b.tweens = b.tweens.filter((tw) => Object.keys(tw.from).length);
  b.id = `${beat.id}-nb`;
  return b;
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26, ...opts });

// ~2.5 words a second across [0.3, seconds - 0.3]
function words(seconds) {
  const text = "Every second of this synthetic clip carries a caption so the motion beat has real company on screen while it plays and then leaves again".split(" ");
  const step = (seconds - 0.6) / text.length, out = [];
  text.forEach((w, i) => out.push({ word: w, start: +(0.3 + i * step).toFixed(2), end: +(0.3 + i * step + step * 0.8).toFixed(2) }));
  return { segments: [{ start: 0, end: seconds, words: out }] };
}

/**
 * Create (or rebuild) a project at `dir` and run the fork's build.mjs on it.
 * beat: a motion beat object, or null for the same reel with no motion beat. files: { "assets/...": string | object }.
 */
export function makeProject(dir, { beat = null, beats = null, layers = null, seconds = SECONDS, style = "keynote-3", reuseSource = true, files = null } = {}) {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  for (const [rel, body] of Object.entries(files || {})) {   // extra project files, e.g. { "assets/lottie/move.json": LOTTIE_FIXTURE }
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === "string" ? body : JSON.stringify(body));
  }
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  const src = path.join(dir, "assets", "talk.mp4");
  if (!(reuseSource && fs.existsSync(src))) {
    // testsrc2 moves, so the video layer is real work for the renderer; -g 30 avoids the sparse-keyframe warning
    sh("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30:duration=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=180:duration=${seconds}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30", "-c:a", "aac", "-shortest", "-movflags", "+faststart", "-y", src]);
  }
  if (layers) {   // media the layers point at: a moving clip for the picture-in-picture, a still for the logo / sticker
    const pip = path.join(dir, "assets", "pip.mp4"), mark = path.join(dir, "assets", "mark.png");
    if (!fs.existsSync(pip)) sh("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-an", "-y", pip]);
    if (!fs.existsSync(mark)) sh("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=256x256:rate=1", "-frames:v", "1", "-y", mark]);
  }
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words(seconds)));
  const samples = []; for (let t = 0; t <= seconds + 4; t += 2) samples.push([t, 300, 900, 340, 740, 480, 700]);
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples }));
  const reel = { title: "motion determinism fixture", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json",
    style, fps: 30, outro: 0, music: null, takes: [{ a: 0, b: seconds }], zoom: {}, beats: beats ?? (beat ? [beat] : []), ...(layers ? { layers } : {}) };
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify(reel, null, 2));
  const log = sh(process.execPath, [BUILD_MJS, "."], { cwd: dir });
  return { dir, html: path.join(dir, "index.html"), log };
}

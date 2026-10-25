#!/usr/bin/env node
// mac-64 (+ mac-71: build_s / render_s, a no-beat control `none`): one rendered sample of every beat type and every scene kind the engine renders, all on the same clip, so the
// planner's director can be widened against evidence (references/scene-kinds.md is the inventory these samples back).
//
//   node scripts/scene-kinds-samples.mjs <prepped project> <out dir> [--only a,b] [--no-render] [--frames]
//
// <prepped project>: a folder with assets/talk.mp4, build/words.whisper.json and build/face.json (transcribe.py and
// face_track.py output). Nothing from it is committed; every sample is written under <out dir>/<name>/ as its own
// project (a copy of reel.json, the built index.html, the render, a 3-frame strip). Each sample is the source span
// TAKE (7 s) with the one beat at 30.0..33.5 (source seconds, the unit reel.json uses). Renders go through
// scripts/render.mjs (vendored GSAP and fonts) under the render lock, one at a time. Writes <out dir>/results.json:
// { name: { group, type, kind, style, build, render, warnings, drops, strip, why } }.
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs"), RENDER = path.join(HERE, "render.mjs");
const argv = process.argv.slice(2);
const [SRC, OUT] = argv.filter((a) => !a.startsWith("--"));
if (!SRC || !OUT) { console.error("usage: node scripts/scene-kinds-samples.mjs <prepped project> <out dir> [--only a,b] [--no-render]"); process.exit(1); }
const ONLY = (argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const NO_RENDER = argv.includes("--no-render");
const TAKE = { a: 29.0, b: 36.0 }, AT = 30.0, TO = 33.5;
const STRIP_T = [1.3, 2.6, 4.1];   // output seconds: just in, middle, late (the beat is 1.0..4.5 in the output)

const S = (kind, extra = {}, style) => ({ group: "scene", style, beat: { type: "scene", kind, at: AT, to: TO, ...extra } });
const B = (type, extra = {}, style, reel = {}) => ({ group: "beat", style, reel, beat: { type, at: AT, to: TO, ...extra } });
const MATTE = { matte: true };

export const SAMPLES = {
  none: { group: "control", beat: null },
  // ---- beat types (build.mjs `switch (b.type)`) ----
  big: B("big", { text: "3x", sub: "faster edits" }),
  chips: B("chips", { items: [{ text: "Sheffield" }, { text: "English" }, { text: "France" }] }),
  strike: B("strike", { text: "born here", strikeAt: 31.5 }),
  quote: B("quote", { header: "My dad said", lines: [{ text: "We're moving", at: 30.2 }, { text: "to France.", at: 31.0, big: true }] }),
  list: B("list", { lines: [{ text: "Sheffield", at: 30.2 }, { text: "France", at: 30.9 }, { text: "Back again", at: 31.6 }], stamp: "NOPE", stampAt: 32.4 }),
  emoji: B("emoji", { emoji: "🎓", x: 640, y: 1250 }),   // pinned: the close-up leaves the reaction slot no room (see icon)
  slam: B("slam", { text: "ENGLISH", pre: "studying", at: 31.2 }, "editorial-collage"),
  nametag: B("nametag", { name: "James", title: "Student, University of Sheffield" }),
  icon: B("icon", { name: "graduation-cap", x: 640, y: 1250 }),
  logo: B("logo", { icon: "github", x: 640, y: 1250 }),
  meme: B("meme", { id: "vine-boom", x: 600, y: 1250 }),
  endcard: B("endcard", { title: "Follow for more", line: "New every week", url: "example.com" }),
  "endcard-caps": B("endcard", { variant: "caps", title: "I.|Home", font: "serif" }),
  headline: B("headline", { small: "studying", big: "ENGLISH", bigAt: 31.28, pos: "low" }, "podcast-glow"),
  "hz-title": B("hz-title", { text: "MOVING TO FRANCE" }, "hormozi"),
  "hz-name": B("hz-name", { name: "James", title: "Student" }, "hormozi"),
  "hz-list": B("hz-list", { items: [{ title: "Sheffield", sub: "born here", at: 30.2 }, { title: "France", sub: "from age five", at: 31.0 }] }, "hormozi"),
  "hz-note": B("hz-note", { text: "born here, raised in France" }, "hormozi"),
  behind: B("behind", { text: "ENGLISH" }, undefined, MATTE),
  ground: B("ground", { color: "#7a1f2b", text: "ENGLISH" }, undefined, MATTE),
  effect: B("effect", { lines: [{ text: "the", at: 30.0 }, { text: "move", box: true, at: 30.4 }, { text: "to france", at: 30.9 }], fit: true }, "explainer-2"),
  titlebox: B("titlebox", { text: "Born in Sheffield" }),
  popcard: B("popcard", { ui: { type: "calendar", title: "Moved at five" }, label: "France" }),
  pills: B("pills", { items: [{ text: "Sheffield", at: 30.2 }, { text: "France", at: 30.8 }, { text: "English degree", at: 31.4 }] }),
  uicard: B("uicard", { src: "assets/still.jpg", pins: [{ x: 40, y: 50, at: 30.6 }] }),
  photostack: B("photostack", { items: [{ src: "assets/still.jpg", label: "Sheffield" }, { src: "assets/still2.jpg", label: "France", at: 31.5 }] }),
  headpage: B("headpage", { src: "assets/still.jpg", pin: true }),
  cover: B("cover", { y0: 1500, y1: 1920 }),
  whiteflash: B("whiteflash", {}),
  starflash: B("starflash", { field: ["#101820", "#2b3a55"], text: "FRANCE" }),
  boxline: B("boxline", { text: "studying English", quotes: true, label: "James" }, "podcast"),
  like: B("like", {}),
  label: B("label", { text: "Chapter one" }, "breakdown"),
  pin: B("pin", { text: "FRANCE" }, "breakdown"),
  leak: B("leak", {}),
  mood: B("mood", {}),
  motion: B("motion", { id: "sample", by: "designer", hideCaptions: false, elements: [
    { id: "card", shape: "rect", x: 90, y: 1250, w: 900, h: 300, fill: "ink", radius: 32, z: 1 },
    { id: "t", shape: "text", x: 130, y: 1300, w: 820, h: 200, text: "Sheffield → France", font: "Montserrat", size: 84, weight: 800, align: "left", color: "#ffffff", split: "words", z: 2 },
  ] }, undefined, { designer: true }),
  graphic: B("graphic", { id: "g1", html: "assets/graphics/kinetic-type.html", mode: "overlay", box: { x: 240, y: 1200, w: 600, h: 600 } }),   // the engine's own fixture file
  // ---- mac-71 misuse variants: the shapes a model will plausibly write, to show what the engine does with them ----
  "emoji-auto": B("emoji", { emoji: "🎓" }),                  // no x/y: the engine places it
  "icon-auto": B("icon", { name: "graduation-cap" }),
  "logo-auto": B("logo", { icon: "github" }),
  "hz-list-text": B("hz-list", { items: [{ text: "Sheffield", at: 30.2 }, { text: "France", at: 31.0 }] }, "hormozi"),
  "scene-gm-nodes-pillstr": S("gm-nodes", { object: "puzzle", pill: "English", nodes: [{ n: 1, at: 30.2 }, { n: 2, at: 30.8 }] }, "gadzhi-motion"),
  // ---- scene kinds (motion.mjs buildScene) ----
  "scene-card": S("card", { lines: [{ text: "Born in", at: 30.1 }, { text: "Sheffield", at: 30.5, size: 120 }], pill: { text: "then France", at: 31.2 }, cursor: { clickAt: 32.0 } }),
  "scene-stats": S("stats", { bg: "accent", badges: [{ value: "5", sub: "years old", at: 30.2 }, { value: "2", sub: "countries", at: 30.9 }] }),
  "scene-fly3d": S("fly3d", { items: [{ text: "Sheffield", at: 30.1 }, { text: "France", at: 30.9 }, { text: "English", at: 31.6 }] }),
  "scene-image": S("image", { src: "assets/still.jpg", zoom: [1, 1.1] }),
  "scene-window": S("window", { self: 40 }),
  "scene-clip": S("clip", { src: "assets/broll.mp4" }),
  "scene-sentence": S("sentence", { lines: ["studying English"], hero: { text: "ENGLISH", at: 31.28 } }),
  "scene-ui": S("ui", { title: "notes", prompt: { text: "where did you grow up?", at: 30.1 }, lines: [{ text: "Sheffield", at: 31.0 }, { text: "France", at: 31.6 }] }),
  "scene-device": S("device", { lines: [{ text: "where are you from?", at: 30.2 }, { text: "Sheffield, then France", at: 31.0, me: true }] }),
  "scene-kinetic": S("kinetic", { text: "studying *English*" }),
  "scene-paper": S("paper", { lines: [{ text: "studying", style: "serif", at: 30.1 }, { text: "English", style: "box", at: 31.28 }] }),
  "scene-tv": S("tv", { items: [{ self: 40, dur: 1.2 }, { self: 44, dur: 1.2 }, { src: "assets/still.jpg", dur: 1.1 }] }),
  "scene-collage": S("collage", { paper: "grid", items: [{ type: "text", style: "headline", text: "STUDYING" }, { type: "text", style: "box", text: "English" }] }),
  "scene-wordpage": S("wordpage", { bg: "accent" }),
  "scene-highlight": S("highlight", { lines: [{ text: "studying English", at: 29.64, box: true }] }),
  "scene-cardpage": S("cardpage", { items: [{ at: 30.1, logo: "github" }, { at: 31.2, logo: "google" }] }),
  "scene-concept": S("concept", { word: "English" }),
  "scene-stack": S("stack", { lead: "studying", key: "English", tail: "in Sheffield" }, "mono"),
  "scene-chapter": S("chapter", { num: 1, text: "Home" }, "breakdown"),
  "scene-title": S("title", { word: "HOME", lines: ["born in Sheffield"] }, "breakdown"),
  "scene-cutout": S("cutout", { word: "ENGLISH" }, "explainer-2"),
  "scene-gm-object": S("gm-object", { object: "lightbulb", text: "studying *English*" }, "gadzhi-motion"),
  "scene-gm-kinetic": S("gm-kinetic", { text: "studying English" }, "gadzhi-motion"),
  "scene-gm-flow": S("gm-flow", { title: "the move", items: [{ label: "Sheffield", icon: "target", at: 30.2 }, { label: "France", icon: "rocket", at: 31.0 }, { label: "back", icon: "target", at: 31.8 }] }, "gadzhi-motion"),
  "scene-gm-counter": S("gm-counter", { value: 5, label: "years old", icon: "stopwatch", countAt: 30.3 }, "gadzhi-motion"),
  "scene-gm-nodes": S("gm-nodes", { object: "puzzle", pill: { text: "English", at: 31.3 }, nodes: [{ n: 1, at: 30.2 }, { n: 2, at: 30.8 }, { n: 3, at: 31.4 }] }, "gadzhi-motion"),
};

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });

function prepAssets(dir) {
  const a = path.join(dir, "assets");
  fs.mkdirSync(a, { recursive: true });
  const talk = path.join(a, "talk.mp4");
  if (!fs.existsSync(talk)) fs.linkSync(path.resolve(SRC, "assets", "talk.mp4"), talk);
  const ff = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  // stills and B-roll cut from the same recording (no library or licensed asset)
  if (!fs.existsSync(path.join(a, "still.jpg"))) ff(["-ss", "40", "-i", talk, "-frames:v", "1", "-q:v", "3", path.join(a, "still.jpg")]);
  if (!fs.existsSync(path.join(a, "still2.jpg"))) ff(["-ss", "46", "-i", talk, "-frames:v", "1", "-q:v", "3", path.join(a, "still2.jpg")]);
  const g = path.join(a, "graphics", "kinetic-type.html");
  if (!fs.existsSync(g)) { fs.mkdirSync(path.dirname(g), { recursive: true }); fs.copyFileSync(path.join(HERE, "fixtures", "graphics", "kinetic-type.html"), g); }
  if (!fs.existsSync(path.join(a, "broll.mp4"))) ff(["-ss", "40", "-t", "5", "-i", talk, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(a, "broll.mp4")]);
}

function sample(name, s) {
  const dir = path.join(OUT, name);
  fs.rmSync(path.join(dir, "index.html"), { force: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  prepAssets(dir);
  for (const f of ["words.whisper.json", "face.json"]) fs.copyFileSync(path.resolve(SRC, "build", f), path.join(dir, "build", f));
  const reel = { title: `scene-kinds ${name}`, source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: 30, outro: 0,
    music: null, takes: [TAKE], zoom: {}, ...(s.style ? { style: s.style } : { style: "clean" }), ...s.reel, beats: s.beat ? [s.beat] : [] };
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify(reel, null, 2));
  const res = { group: s.group, type: s.beat?.type ?? null, kind: s.beat?.kind ?? null, style: reel.style };
  const tb = Date.now();
  const b = sh(process.execPath, [BUILD, "."], { cwd: dir, env: { ...process.env, MATTE_THREADS: process.env.MATTE_THREADS || "6" } });
  const log = (b.stdout || "") + (b.stderr || "");
  fs.writeFileSync(path.join(dir, "build.log"), log);
  res.build = b.status === 0 ? "ok" : "FAIL";
  res.build_s = +((Date.now() - tb) / 1000).toFixed(1);
  const wi = log.indexOf("WARNINGS:");
  res.warnings = wi >= 0 ? log.slice(wi + 9).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("->")).slice(0, 8) : [];
  const dropped = path.join(dir, "build", "graphics-dropped.json");
  res.drops = fs.existsSync(dropped) ? (JSON.parse(fs.readFileSync(dropped, "utf8")).dropped || []).map((d) => `${d.rule}: ${d.why}`) : [];
  if (res.build !== "ok") { res.why = log.trim().split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400); return res; }
  if (NO_RENDER) return res;
  const out = path.join(dir, "build", "sample.mp4");
  const tr = Date.now();
  const r = sh("lockf", ["-k", "/tmp/phantasic-render.lock", process.execPath, RENDER, "-o", out, "--quiet"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "render.log"), (r.stdout || "") + (r.stderr || ""));
  res.render = r.status === 0 && fs.existsSync(out) ? "ok" : "FAIL";
  res.render_s = +((Date.now() - tr) / 1000).toFixed(1);
  if (res.render !== "ok") { res.why = ((r.stderr || "") + (r.stdout || "")).trim().split("\n").slice(-3).join(" | ").slice(0, 400); return res; }
  // a 3-frame strip: just in, middle, late
  const frames = STRIP_T.map((t, i) => { const f = path.join(dir, `f${i}.png`); execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "scale=360:-1", f]); return f; });
  res.strip = path.join(dir, "strip.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", ...frames.flatMap((f) => ["-i", f]), "-filter_complex", "hstack=inputs=3", res.strip]);
  frames.forEach((f) => fs.rmSync(f));
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fs.mkdirSync(OUT, { recursive: true });
  const resFile = path.join(OUT, "results.json");
  const results = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, "utf8")) : {};
  for (const [name, s] of Object.entries(SAMPLES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const t0 = Date.now();
    results[name] = { ...sample(name, s), seconds: Math.round((Date.now() - t0) / 1000) };
    console.log(`${name.padEnd(18)} build ${results[name].build}${results[name].render ? ` render ${results[name].render}` : ""}${results[name].why ? `  ${results[name].why.slice(0, 160)}` : ""}`);
    fs.writeFileSync(resFile, JSON.stringify(results, null, 1));
  }
}

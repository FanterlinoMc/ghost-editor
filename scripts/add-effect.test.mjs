#!/usr/bin/env node
// node --test scripts/add-effect.test.mjs
// The ready-to-add effects library and the tool that stamps one into a reel.
//
// Every effect is an EXISTING engine primitive written out in the engine's own grammar, so what is
// worth pinning is not capability - it is that each template carries the shape that cost a build to
// find: `title` takes `lines` and NOT `text` (a `text` field builds an empty card with no warning),
// a hand-written collage item needs its own x/y (the auto-stack only runs on the paper->collage path,
// so unpositioned items all land at 120,600 on top of each other), and a `behind` beat is useless
// without reel.matte. A template that loses one of those is worse than no template.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "add-effect.mjs");
const LIB = JSON.parse(fs.readFileSync(path.join(HERE, "..", "library", "effects", "manifest.json"), "utf8"));
const run = (dir, ...a) => spawnSync(process.execPath, [TOOL, ...a], { cwd: dir, encoding: "utf8" });
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "add-effect-"));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "t", source: "assets/talk.mp4",
    words: "build/words.whisper.json", face: "build/face.json", fps: 30, outro: 0, music: null,
    style: "keynote-3", zoom: {}, takes: [{ a: 0, b: 20 }], beats: [] }, null, 2));
  return dir;
}
const reel = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "reel.json"), "utf8"));

test("add-effect: every template is a beat, a layer or a reel setting, and names its params", () => {
  const names = Object.keys(LIB.effects);
  assert.ok(names.length >= 8, `expected the eight reference effects, got ${names.length}`);
  for (const [n, e] of Object.entries(LIB.effects)) {
    assert.ok(e.beat || e.layer || e.reel, `${n}: no beat, layer or reel template`);
    assert.ok(Array.isArray(e.params) && e.params.length, `${n}: no params listed`);
    assert.ok(typeof e.what === "string" && e.what.length > 20, `${n}: no description`);
    // mac-82: a reel-level effect is a SETTING, not a moment, so it has no type/kind - cutout-outline
    // styles the cut-out wherever it is shown. Only the timed shapes must name what they build.
    if (e.beat || e.layer) assert.ok((e.beat ?? e.layer).type || (e.beat ?? e.layer).kind, `${n}: the template has no type/kind`);
    else assert.ok(Object.keys(e.reel).length, `${n}: an empty reel template sets nothing`);
  }
});

test("add-effect: the shapes that cost a build to find are in the templates", () => {
  const title = LIB.effects["card-word"].beat;
  assert.ok(Array.isArray(title.lines) && !("text" in title), "card-word must use `lines`, never `text`");
  const items = LIB.effects["word-tiles"].beat.items;
  assert.ok(items.every((i) => Number.isFinite(i.x) && Number.isFinite(i.y)), "every collage item needs its own x/y");
  assert.equal(new Set(items.map((i) => `${i.x},${i.y}`)).size, items.length, "collage items must not share a position");
  assert.match(LIB.effects["text-behind"].needs ?? "", /matte/, "text-behind must say it needs the matte");
});

test("add-effect: --list prints every effect with its params", () => {
  const r = run(os.tmpdir(), "--list");
  assert.equal(r.status, 0, r.stderr);
  for (const n of Object.keys(LIB.effects)) assert.match(r.stdout, new RegExp(n), `${n} missing from --list`);
});

test("add-effect: a beat lands in beats[], sorted by time, with its nested times stamped", () => {
  const dir = project();
  assert.equal(run(dir, ".", "card-word", "--at", "12", "--to", "14", "--text", "FRANCE").status, 0);
  assert.equal(run(dir, ".", "keyword-takeover", "--at", "4", "--to", "6", "--text", "ENGLISH").status, 0);
  const b = reel(dir).beats;
  assert.deepEqual(b.map((x) => x.at), [4, 12], "beats must be sorted by time, not append order");
  assert.equal(b[0].text, "ENGLISH");
  assert.equal(b[1].lines[0].text, "FRANCE");
  assert.equal(b[1].lines[0].at, 12, "a nested at:0 must be stamped to the beat's start, never left at 0");
});

test("add-effect: text-behind turns the matte on, because the beat is inert without it", () => {
  const dir = project();
  const r = run(dir, ".", "text-behind", "--at", "3", "--to", "5", "--text", "TWO WORDS");
  assert.equal(r.status, 0, r.stderr);
  const x = reel(dir);
  assert.deepEqual([x.matte, x.matteWindows, x.matteClip], [true, true, true]);
  assert.match(r.stdout, /matte/, "and it says so rather than changing the reel silently");
});

test("add-effect: a layer lands in layers[] with a unique id and a duration", () => {
  const dir = project();
  assert.equal(run(dir, ".", "chrome-overlay", "--at", "2", "--dur", "4").status, 0);
  assert.equal(run(dir, ".", "chrome-overlay", "--at", "8", "--to", "11").status, 0);
  const l = reel(dir).layers;
  assert.equal(l.length, 2);
  assert.notEqual(l[0].id, l[1].id, "a second copy must not reuse the first one's id");
  assert.equal(l[1].dur, 3, "--to on a layer becomes a duration");
});

test("add-effect: --set reaches into the template, and refuses what it cannot place", () => {
  const dir = project();
  const r = run(dir, ".", "ring-badge", "--at", "5", "--to", "8", "--set", "badges.0.value=42", "--set", 'badges.0.sub="yrs"');
  assert.equal(r.status, 0, r.stderr);
  const b = reel(dir).beats[0];
  assert.equal(b.badges[0].value, 42);
  assert.equal(b.badges[0].sub, "yrs");
  assert.notEqual(run(dir, ".", "ring-badge", "--at", "5", "--to", "8", "--set", "nope").status, 0, "--set without = must fail");
  assert.notEqual(run(dir, ".", "no-such-effect", "--at", "1", "--to", "2").status, 0);
  assert.notEqual(run(dir, ".", "keyword-takeover", "--at", "1").status, 0, "a beat with no --to must fail");
});

test("add-effect: a motion tween's time and y are RELATIVE, so neither is stamped or moved", () => {
  const dir = project();
  assert.equal(run(dir, ".", "caption-plate", "--at", "9.1", "--dur", "1.9", "--y", "150").status, 0);
  const l = reel(dir).layers[0];
  // the first tween starts at 0 = the layer's own start. Stamped to 9.1 it would sit past a 1.9 s
  // layer and the compiler drops every tween, silently stripping the movement.
  assert.equal(l.tweens[0].at, 0, "a tween's at must stay relative to the layer");
  assert.equal(l.tweens[2].from.y, 48, "a tween's y is a movement, not a position: --y must not touch it");
  // --y places the TOP of the card, and moves every y and y2 together
  const ys = l.elements.map((e) => e.y);
  assert.equal(Math.min(...ys), 150, `--y 150 must put the top at 150, got ${JSON.stringify(ys)}`);
  assert.equal(l.elements[1].y2, l.elements[1].y, "the rule's y2 must move with its y or it draws diagonally");
});

test("add-effect: every effect says whether it replaces the speaker", () => {
  for (const [n, e] of Object.entries(LIB.effects)) {
    assert.ok(["overlay", "full", "full-dimmed"].includes(e.frame), `${n}: frame is ${JSON.stringify(e.frame)}`);
    assert.ok(typeof e.needs === "string" && e.needs.length, `${n}: no needs line`);
    assert.ok(typeof e.what === "string", `${n}: no description`);
  }
  // Pin the PROPERTY, not a count: a count goes stale the moment a limitation is lifted, which is
  // exactly what happened when mac-82 built three of them and this line failed for the right reason.
  assert.ok(Array.isArray(LIB.limitations) && LIB.limitations.length, "the manifest must record what cannot be done");
  for (const l of LIB.limitations) assert.ok(typeof l === "string" && l.length > 20, `a limitation must say what and why: ${JSON.stringify(l)}`);
  const r = run(os.tmpdir(), "--list");
  assert.match(r.stdout, /OVER the footage/, "--list must group by frame");
  assert.match(r.stdout, /cannot do/, "--list must print the limitations");
});

test("add-effect: the caption plate's two lines fit inside its plate", () => {
  const els = LIB.effects["caption-plate"].layer.elements;
  const plate = els[0], last = els.at(-1);
  assert.ok(last.y + last.h <= plate.y + plate.h, `line 2 ends at ${last.y + last.h}, plate ends at ${plate.y + plate.h}`);
});

test("add-effect: mac-82 - the three effects that were recorded as impossible now exist", () => {
  for (const n of ["progress-arc", "letterpress", "cutout-outline"]) assert.ok(LIB.effects[n], `${n} missing`);
  // the arc is a share of a circle, so it has to be bounded
  const arc = LIB.effects["progress-arc"].beat.badges[0];
  assert.ok(arc.arc >= 0 && arc.arc <= 100, `arc is ${arc.arc}`);
  // letterpress is light and shade: it needs one of the two press shadows
  assert.match(JSON.stringify(LIB.effects["letterpress"].layer), /"shadow":"(engrave|emboss)"/);
  // and none of the three is still listed as something that cannot be done
  const left = LIB.limitations.join(" ");
  for (const gone of ["progress ARC", "Engraved or embossed", "outline around the cut-out"]) {
    assert.ok(!left.includes(gone), `"${gone}" is built now but still listed as a limitation`);
  }
});

test("add-effect: a reel-level effect merges into the reel, not into beats or layers", () => {
  const dir = project();
  const r = run(dir, ".", "cutout-outline", "--color", "#00A3FF");
  assert.equal(r.status, 0, r.stderr);
  const x = reel(dir);
  assert.ok(typeof x.matteFilter === "string" && x.matteFilter.includes("#00A3FF"), "--color must recolour every drop-shadow");
  assert.ok(!x.matteFilter.includes("#C8102E"), "the template's default colour must be gone");
  assert.equal(x.matte, true, "and it must turn the cut-out on, since the outline is drawn on it");
  assert.equal((x.beats ?? []).length, 0, "a reel-level effect must not add a beat");
  assert.equal((x.layers ?? []).length, 0, "nor a layer");
});

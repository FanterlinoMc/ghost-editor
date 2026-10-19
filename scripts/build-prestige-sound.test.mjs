#!/usr/bin/env node
// node --test scripts/build-prestige-sound.test.mjs
// mac-4: Prestige (premium-belmar) sound design - the sfxDesign pass and the drop's sounds - against a STUB library and
// against the silent library. The stub library is made here, in the OS temp folder: a manifest + timing.json copied from the
// engine's (durations capped) and one generated tone or noise burst per id (ffmpeg sine / anoisesrc). No audio file is ever
// committed. Covers:
//   - stub library: the drop's riser (peak before the 3 f gap, cut + fade), boom, tail and flash-cut sounds at the right times and
//     levels (role level + the field's dB + the drop lift), the low-density design pass (word-pop ticks, riser + hit on the cut into
//     B-roll, a whip swish on every #tx whip), every event written as an <audio> tag with its start and volume, files copied
//   - a library holding only part of the ids (as a partial pack mapping would): the drop's lists and the design families fall
//     back to the ids that are there, and nothing is reported skipped
//   - the silent library: the same reel builds, the drop still cuts, no sound event and no sfx tag, the skipped-sound warning
//   - the new die(): drop.<sound field> not an id / list of ids / false / "none"
//   - opt-in: premium-belmar reels without the new fields (no drop, a placed drop) build the same sections.json, sfx_events.json and
//     index.html as the base engine (git archive of PRESTIGE_BASE_REF, default commit 290994d; skipped only without git or the commit)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "prestige-sound-"));
process.on("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } });
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const SEC = 14, FPS = 30;
ff("-f", "lavfi", "-i", `testsrc2=size=108x192:rate=${FPS}:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=200:duration=${SEC}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4"));
const text = "so we have no idea what this really costs and nobody is dying to tell you the truth about it because the number is huge".split(" ");
const wordsIn = (spans) => {
  const words = []; let i = 0;
  for (const [a, b] of spans) for (let t = a; t + 0.25 < b; t += 0.3) words.push({ word: text[i++ % text.length], start: +t.toFixed(2), end: +(t + 0.22).toFixed(2) });
  return { segments: [{ start: 0, end: SEC, words }] };
};
let n = 0;
function project(reel, spans) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(wordsIn(spans)));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 8 }, (_, i) => [i * 2, 400, 1000, 340, 740, 560, 800]) }));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "prestige sound", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: FPS, takes: [{ a: 0, b: SEC }], ...reel }));
  return dir;
}
// a build never cuts a matte here (Prestige has no stage / matte); npx is blocked anyway so a slip fails fast instead of running a model
const fakeBin = path.join(root, "fake-bin"); fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, "npx.cmd"), "@echo off\r\necho npx is disabled in build-prestige-sound.test.mjs 1>&2\r\nexit /b 97\r\n");
fs.writeFileSync(path.join(fakeBin, "npx"), "#!/bin/sh\necho 'npx is disabled in build-prestige-sound.test.mjs' >&2\nexit 97\n", { mode: 0o755 });
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
const run = (dir, lib) => spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: lib, [pathKey]: fakeBin + path.delimiter + process.env[pathKey] } });
const build = (dir, lib) => { const r = run(dir, lib); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout + r.stderr; };
const html = (dir) => fs.readFileSync(path.join(dir, "index.html"), "utf8");
const jsonOf = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, "build", f), "utf8"));
const near = (a, b, e, msg) => assert.ok(Math.abs(a - b) <= e, `${msg ?? ""} ${a} vs ${b}`);
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------- the stub library: the engine's manifest + timing for these ids, a generated wav each ----------
const realMan = JSON.parse(fs.readFileSync(path.join(HERE, "..", "library", "sfx", "manifest.json"), "utf8"));
const realTiming = JSON.parse(fs.readFileSync(path.join(HERE, "..", "library", "sfx", "timing.json"), "utf8"));
const PRESTIGE_IDS = ["cinematic-rumble-riser", "riser-1", "cinematic-deep-boom", "impact-1", "whoosh-cine", "tech-camera-flash", "click-1",
  "pop-whoosh-light", "pop-1", "tick-1", "burn-whoosh-fast", "tech-digital-whoosh", "burn-whoosh-tunnel", "zoom-sweep-small", "zoom-sweep-short"];
function stubLibrary(name, ids) {
  const lib = path.join(root, name);
  fs.mkdirSync(path.join(lib, "sfx"), { recursive: true }); fs.mkdirSync(path.join(lib, "music"), { recursive: true });
  const man = {}, timing = {};
  for (const id of PRESTIGE_IDS) {   // every id keeps its manifest entry; only `ids` get a file (a mapping that left some out)
    const dur = Math.min(realMan[id].duration, 1.2);
    man[id] = { ...realMan[id], duration: dur };
    timing[id] = { ...realTiming[id], dur, peak_t: Math.min(realTiming[id].peak_t, dur - 0.05) };
    if (!ids.includes(id)) continue;
    const k = PRESTIGE_IDS.indexOf(id);
    const src = k % 2 ? `anoisesrc=color=pink:amplitude=0.5:duration=${dur}` : `sine=frequency=${220 + k * 30}:duration=${dur}`;
    ff("-f", "lavfi", "-i", src, "-ar", "48000", "-ac", "1", path.join(lib, "sfx", realMan[id].file));
  }
  fs.writeFileSync(path.join(lib, "sfx", "manifest.json"), JSON.stringify(man));
  fs.writeFileSync(path.join(lib, "sfx", "timing.json"), JSON.stringify(timing));
  fs.writeFileSync(path.join(lib, "music", "manifest.json"), JSON.stringify({}));
  return { lib, timing };
}
const FULL = stubLibrary("lib-full", PRESTIGE_IDS);
const PART = stubLibrary("lib-part", PRESTIGE_IDS.filter((id) => !["cinematic-deep-boom", "tech-camera-flash", "pop-1", "burn-whoosh-fast"].includes(id)));

// A small Prestige reel: three takes (whip transitions on the joins), a B-roll cut-in (a major cut), the drop placed at 6 s.
const PRESTIGE = {
  style: "premium-belmar",
  takes: [{ a: 0, b: 3.6 }, { a: 4, b: 5.8 }, { a: 6, b: 14 }],
  captions: { emph: ["idea"] },
  // the lists a deployment or a reel may set (the style keeps the single default ids): the first id on disk plays
  drop: { at: 9, shots: [{ self: 1 }, { self: 3 }], riser: ["cinematic-rumble-riser", "riser-1"], boom: ["cinematic-deep-boom", "impact-1"], tail: ["whoosh-cine"], cutSfx: ["tech-camera-flash", "click-1"] },
  outro: 1,
  beats: [{ type: "scene", kind: "image", self: 2, at: 1.5, to: 2.6 }],
};
const SPANS = [[0.3, 3.5], [4.1, 5.7], [6.1, 8.6]];
const DROP_T0 = 3.6 + 1.8 + 3;   // source 9 s inside take 2 (starts at source 6 s, output 5.4 s)
const GAP = 3 / FPS;

test("Prestige against a stub library: drop sounds and the design pass at the right times and levels, each an <audio> tag", () => {
  const dir = project(PRESTIGE, SPANS);
  const log = build(dir, FULL.lib);
  assert.match(log, /drop at 8\.4s: 7 cuts in/);
  assert.match(log, /sfx design \(low\): \d+ sounds/);
  assert.doesNotMatch(log, /sound\(s\) skipped/, "every id Prestige asks for is in the stub library");
  const sx = jsonOf(dir, "sfx_events.json"), ev = sx.events, h = html(dir);
  const vol = (role, db) => r3(Math.min(1, Math.pow(10, (sx.voiceP95 + sx.roleDb[role] + db + 1) / 20)));
  const lifted = (v) => r3(Math.min(1, v * Math.pow(10, 3 / 20)));
  const one = (why) => { const xs = ev.filter((e) => e.why.startsWith(why)); assert.equal(xs.length, 1, `one '${why}' event`); return xs[0]; };

  // the drop
  const boom = one("drop boom");
  near(boom.t, DROP_T0, 0.002, "boom on the first shot");
  assert.equal(boom.id, "cinematic-deep-boom");
  assert.equal(boom.vol, lifted(vol("impact", 0)), "boom: impact level + boomDb 0, lifted 3 dB inside the drop");
  const riser = one("drop riser");
  assert.equal(riser.id, "cinematic-rumble-riser");
  near(riser.t, DROP_T0 - GAP - FULL.timing["cinematic-rumble-riser"].peak_t, 0.002, "riser peaks on the gap");
  near(riser.t + riser.dur, DROP_T0 - GAP, 0.003, "riser cut where the 3 f silence starts");
  assert.equal(riser.fade, 0.03);
  assert.equal(riser.vol, vol("whoosh", 2), "riser: whoosh level + riserDb 2, not lifted (it starts before the drop)");
  const tail = one("drop tail");
  near(tail.t, DROP_T0 + 0.02, 0.002); assert.equal(tail.id, "whoosh-cine");
  assert.equal(tail.vol, lifted(vol("whoosh", -2)));
  const flashT = [...h.matchAll(/id="dropflash-\d+" class="clip" data-start="([\d.]+)"/g)].map((m) => +m[1]);
  const cuts = ev.filter((e) => e.why === "drop flash cut");
  assert.ok(flashT.length >= 2, "flash cuts in the ladder");
  assert.deepEqual(cuts.map((e) => e.t), flashT, "a flash-cut sound on every white flash");
  for (const e of cuts) { assert.equal(e.id, "tech-camera-flash"); assert.equal(e.vol, lifted(vol("ui", -2))); }

  // the design pass (density low)
  const design = ev.filter((e) => e.design);
  const ticks = design.filter((e) => e.design === "tick");
  assert.ok(ticks.length >= 3, `word-pop ticks (${ticks.length})`);
  assert.ok(ticks.every((e) => e.t + FULL.timing[e.id].peak_t < DROP_T0 - 0.3 || e.t >= 12), "no word pop inside the drop");
  for (const e of ticks) assert.ok(["click-1", "pop-1", "tick-1"].includes(e.id));
  const cutIn = 1.5;
  const rz = design.find((e) => e.design === "riser"), hit = design.find((e) => e.design === "hit");
  assert.ok(rz && hit, "riser + hit on the cut into B-roll");
  near(rz.t + FULL.timing[rz.id].peak_t, cutIn, 0.002, "design riser peaks on the cut");
  near(rz.t + rz.dur, cutIn + 0.04, 0.003, "and is cut just after it"); assert.equal(rz.fade, 0.06);
  near(hit.t + FULL.timing[hit.id].peak_t, cutIn, 0.002, "hit peaks on the cut");
  assert.equal(hit.vol, vol("impact", 2), "hit: impact level + hitDb 2");
  assert.ok(!design.some((e) => e.design === "tail"), "density low: no tail");
  const whips = jsonOf(dir, "edit_truth.json").txTransitions.filter((x) => x.kind === "whip");
  assert.ok(whips.length >= 1, "the style's whip transitions");
  for (const w of whips) assert.ok(design.some((e) => e.design === "whip" && Math.abs(e.t + FULL.timing[e.id].peak_t - w.t) < 0.002), `a whip swish peaking on the #tx whip at ${w.t}`);
  // every event is in the mix: an <audio> tag with its file, start and volume, and the file copied next to the page
  const tags = [...h.matchAll(/<audio id="sfx-\d+" src="([^"]+)" data-start="([\d.]+)"[^>]*data-volume="([\d.]+)"/g)].map((m) => `${m[1]}@${+m[2]}@${+m[3]}`);
  assert.equal(tags.length, ev.length, "one tag per event");
  for (const e of ev) {
    assert.ok(tags.includes(`${e.src}@${e.t}@${e.vol}`), `tag for ${e.id} at ${e.t}`);
    assert.ok(fs.existsSync(path.join(dir, e.src)), `${e.src} copied`);
  }
});

test("Prestige against a partial library: the drop's id lists and the design families fall back to the ids on disk", () => {
  const full = project(PRESTIGE, SPANS);
  build(full, FULL.lib);
  const dir = project(PRESTIGE, SPANS);
  const log = build(dir, PART.lib);
  assert.doesNotMatch(log, /sound\(s\) skipped/, "nothing skipped: every family / list has a member on disk");
  const ev = jsonOf(dir, "sfx_events.json").events, ev0 = jsonOf(full, "sfx_events.json").events;
  assert.equal(ev.find((e) => e.why === "drop boom").id, "impact-1", "boom: the list's second id");
  assert.ok(ev.filter((e) => e.why === "drop flash cut").every((e) => e.id === "click-1"), "flash cut: the list's second id");
  assert.equal(ev.filter((e) => e.why === "drop flash cut").length, ev0.filter((e) => e.why === "drop flash cut").length);
  // turn by turn against the full-library run: a missing id's turn goes to the next member of its group, every other turn is unchanged
  const SUB = { "pop-1": "tick-1", "burn-whoosh-fast": "tech-digital-whoosh", "cinematic-deep-boom": "impact-1", "tech-camera-flash": "click-1" };
  const turns = (xs) => xs.filter((e) => e.design || e.why.startsWith("drop "));
  const got = turns(ev), want = turns(ev0);
  assert.ok(want.some((e) => e.id === "pop-1") && want.some((e) => e.id === "burn-whoosh-fast") && want.some((e) => e.design === "hit"), "the full run uses the ids the partial library lacks");
  assert.equal(got.length, want.length, "no turn lost");
  for (let i = 0; i < want.length; i++) {
    assert.equal(got[i].why, want[i].why, `turn ${i}`);
    assert.equal(got[i].id, SUB[want[i].id] ?? want[i].id, `turn ${i} (${want[i].why} at ${want[i].t}): ${want[i].id} -> its fallback`);
  }
});

test("Prestige against the silent library: builds, the drop still cuts, no sound at all, one skipped-sound warning", () => {
  const dir = project(PRESTIGE, SPANS);
  const log = build(dir, silentLibrary());
  assert.match(log, /drop at 8\.4s: 7 cuts in/);
  assert.match(log, /sfx design \(low\): 0 sounds/);
  assert.match(log, /\d+ sound\(s\) skipped, \d+ id\(s\) unavailable: .*cinematic-deep-boom/);
  assert.deepEqual(jsonOf(dir, "sfx_events.json").events, []);
  const h = html(dir);
  assert.ok(/id="dropflash-\d+"/.test(h), "the ladder's white flashes are still there");
  assert.ok(!/<audio id="sfx-/.test(h), "no sfx tag");
  assert.ok(!fs.existsSync(path.join(dir, "assets", "sfx")) || fs.readdirSync(path.join(dir, "assets", "sfx")).length === 0, "no sound copied");
});

test("drop sound fields: false / \"none\" silence one sound; anything but an id, a list of ids, false or \"none\" dies", () => {
  const dir = project({ ...PRESTIGE, drop: { ...PRESTIGE.drop, boom: false, cutSfx: "none" } }, SPANS);
  build(dir, FULL.lib);
  const ev = jsonOf(dir, "sfx_events.json").events;
  assert.ok(!ev.some((e) => e.why === "drop boom" || e.why === "drop flash cut"));
  assert.ok(ev.some((e) => e.why.startsWith("drop riser")) && ev.some((e) => e.why === "drop tail"));
  for (const [k, v] of [["boom", 5], ["riser", []], ["cutSfx", ["tech-camera-flash", 3]], ["tail", true]]) {
    const r = run(project({ ...PRESTIGE, drop: { ...PRESTIGE.drop, [k]: v } }, SPANS), FULL.lib);
    assert.notEqual(r.status, 0, `drop.${k}: ${JSON.stringify(v)} should fail`);
    assert.ok((r.stdout + r.stderr).includes(`drop.${k} must be a sound id, a non-empty list of sound ids, false or "none" (got ${JSON.stringify(v)})`), r.stdout + r.stderr);
  }
});

// Opt-in proof for the style itself: premium-belmar reels that use none of the new fields build the same bytes as the base engine
// (sections.json carries a globalHash over spec.drop, so even a style-only change to the drop block would show here). The base engine
// is `git archive` of PRESTIGE_BASE_REF (default 290994d, the engine/release-1019b commit this work started from; a commit, so it does
// not go stale once this branch is merged). Skipped ONLY when git is not installed or the ref is not in this clone (a shallow CI
// checkout); any other git archive / tar error fails the test.
const BASE_REF = process.env.PRESTIGE_BASE_REF || "290994d";
const REPO = path.join(HERE, "..");
const baseSkip = (() => {
  const v = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (v.error) return `git is not available (${v.error.code ?? v.error.message})`;
  const r = spawnSync("git", ["-C", REPO, "rev-parse", "--verify", "--quiet", `${BASE_REF}^{commit}`], { encoding: "utf8" });
  if (r.status !== 0) return `${BASE_REF} is not in this clone (a shallow checkout? fetch it, or set PRESTIGE_BASE_REF)`;
  return null;
})();
test(`premium-belmar without the new fields builds byte-identically to ${BASE_REF} (no drop; a placed drop; silent and stub library)`, (t) => {
  if (baseSkip) { t.skip(baseSkip); return; }
  const baseEngine = path.join(root, "base-engine");
  const tar = execFileSync("git", ["-C", REPO, "archive", "--format=tar", BASE_REF, "scripts", "styles", "presets", "templates", "brands", "templates-registry.json"], { maxBuffer: 1 << 28 });
  fs.mkdirSync(baseEngine); execFileSync("tar", ["-xf", "-", "-C", baseEngine], { input: tar });
  const runWith = (engine, dir, lib) => {
    const r = spawnSync(process.execPath, [path.join(engine, "scripts", "build.mjs"), "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: lib, [pathKey]: fakeBin + path.delimiter + process.env[pathKey] } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  };
  const plain = { ...PRESTIGE, drop: undefined, beats: PRESTIGE.beats };
  const dropped = { ...PRESTIGE, drop: { at: 9, shots: [{ self: 1 }, { self: 3 }] } };
  for (const [label, reel] of [["no drop", plain], ["placed drop", dropped]]) for (const lib of [silentLibrary(), FULL.lib]) {
    const mine = project(reel, SPANS), base = project(reel, SPANS);
    runWith(path.join(HERE, ".."), mine, lib); runWith(baseEngine, base, lib);
    for (const f of ["build/sections.json", "build/sfx_events.json", "index.html"]) {
      // the project folder name differs (p<N>); the bytes may name it, so compare with it masked
      const read = (d) => fs.readFileSync(path.join(d, f), "utf8").split(path.basename(d)).join("<proj>");
      assert.ok(read(mine) === read(base), `${label}, ${lib === FULL.lib ? "stub" : "silent"} library: ${f} differs from ${BASE_REF}`);
    }
  }
});

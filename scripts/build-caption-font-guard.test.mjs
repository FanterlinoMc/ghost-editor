#!/usr/bin/env node
// node --test scripts/build-caption-font-guard.test.mjs
// mac-42: a caption group whose own transform is tweened (Broadsheet's pop-in) was centred or ~40 px off depending on
// whether its webfont beat the renderer's first seek (GSAP bakes the fallback-font half-width as px). The guard
// (scripts/lib/caption-font-guard.mjs) waits for the caption fonts, then makes GSAP re-read every group it already parsed.
//   - unit, with stubs: nothing happens before the font loads settle; then the parsed group gets its own inline
//     transform properties back BEFORE GSAP re-reads it, the unparsed one is left alone, the timeline is re-rendered
//   - build: a broadsheet reel emits the guard ahead of its first tween; a clean reel emits nothing (stays byte-identical)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { silentLibrary } from "./lib/silent-library.mjs";
import { captionFontGuard, needsCaptionFontGuard } from "./lib/caption-font-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");

test("needsCaptionFontGuard: only a tween on a caption group itself, not on its words", () => {
  assert.equal(needsCaptionFontGuard([`ft("#cg3", { scale: 0.9 }, { scale: 1, duration: 0.12 }, 1.2);`]), true);
  assert.equal(needsCaptionFontGuard([`tl.to("#cg0", { y: -20 }, 0.5);`]), true);
  assert.equal(needsCaptionFontGuard([`ft("#cg3w1", { scale: 1 }, { scale: 1.08 }, 0.3);`, `tl.set("#cg0w2", { color: "#fff" }, 1);`]), false);
  assert.equal(needsCaptionFontGuard([]), false);
});

// a page with two caption groups: cg0 is parsed by GSAP before the font arrives (GSAP folded its rotate into an
// inline px transform, as _parseTransform does), cg1 is not parsed yet
function page() {
  const log = [];
  const el = (id, style, kids) => ({ id, style: { ...style }, textContent: kids.map((k) => k.textContent).join(" "), querySelectorAll: () => kids });
  const w = (t) => ({ textContent: t, style: {}, querySelectorAll: () => [] });
  const cg0 = el("cg0", { rotate: "1.12deg", transform: "" }, [w("That"), w("I"), w("recommend")]);
  const cg1 = el("cg1", { rotate: "-1.6deg", transform: "translateX(-50%) scale(0.85)" }, [w("so"), w("that")]);
  let release;
  const fontsDone = new Promise((r) => { release = r; });
  const doc = {
    querySelectorAll: (s) => (s === ".cap-group" ? [cg0, cg1] : []),
    defaultView: { getComputedStyle: (n) => ({ fontStyle: "normal", fontWeight: "400", fontSize: "58px", fontFamily: "Gloock, Georgia, serif" }) },
    fonts: { load: (f, text) => { log.push(["load", f, text]); return fontsDone; } },
  };
  const gsap = { getProperty: (target, p, unit, uncache) => { log.push(["parse", target.id, p, uncache, target.style.transform, target.style.rotate]); return 0; } };
  const tl = { totalTime: () => 0.25, render: (t, s, f) => log.push(["render", t, s, f]) };
  return { cg0, cg1, doc, gsap, tl, log, release };
}

test("captionFontGuard: waits for the fonts, restores then re-reads parsed groups, re-renders", async () => {
  const { cg0, cg1, doc, gsap, tl, log, release } = page();
  const done = captionFontGuard(tl, gsap, doc);
  // what the first seek does before the font is in: GSAP parses cg0 and folds its rotate into a px transform
  cg0._gsap = { x: "-236.455px", xPercent: 0 };
  cg0.style.transform = "translate(-236.455px, -4.62px) rotate(1.12deg) scale(0.9, 0.9)";
  cg0.style.rotate = "none";
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log.filter((l) => l[0] !== "load"), [], "nothing may be re-read before the fonts have loaded");
  assert.ok(log.some((l) => l[0] === "load" && /58px Gloock/.test(l[1]) && /recommend/.test(l[2])), "the caption font is asked for, with the caption text");
  release();
  assert.equal(await done, 1);
  const rest = log.filter((l) => l[0] !== "load");
  // re-read with uncache, seeing the ORIGINAL inline properties (the CSS translateX(-50%) and the tilt), not GSAP's px
  assert.deepEqual(rest[0], ["parse", "cg0", "x", true, "", "1.12deg"]);
  assert.deepEqual(rest[1], ["render", 0.25, true, true]);
  assert.equal(rest.length, 2, "cg1 was never parsed: it is left for GSAP to read with the font in place");
  assert.equal(cg1.style.transform, "translateX(-50%) scale(0.85)");
});

test("captionFontGuard: a font that fails to load still lets the guard finish", async () => {
  const { cg0, doc, gsap, tl, log } = page();
  doc.fonts.load = () => Promise.reject(new Error("404"));
  cg0._gsap = { x: "-200px" };
  assert.equal(await captionFontGuard(tl, gsap, doc), 1);
  assert.equal(log.filter((l) => l[0] === "render").length, 1);
});

test("build: broadsheet (pop-in on the group) emits the guard before its tweens; clean emits none", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "caption-font-guard-"));
  try {
    const SEC = 4;
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=108x192:rate=30:duration=${SEC}`, "-f", "lavfi", "-i", `sine=frequency=220:duration=${SEC}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-ac", "2", "-shortest", path.join(root, "talk.mp4")], { stdio: "pipe" });
    const text = "that i recommend so that most of them tend to be".split(" ");
    const words = { segments: [{ start: 0, end: SEC, words: text.map((w, i) => ({ word: w, start: +(0.2 + i * 0.33).toFixed(2), end: +(0.45 + i * 0.33).toFixed(2) })) }] };
    const face = { fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 3 }, (_, i) => [i * 2, 400, 1000, 340, 740, 560, 800]) };
    const html = (style) => {
      const dir = path.join(root, style);
      fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
      fs.mkdirSync(path.join(dir, "build"), { recursive: true });
      fs.copyFileSync(path.join(root, "talk.mp4"), path.join(dir, "assets", "talk.mp4"));
      fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify(words));
      fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify(face));
      fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "cfg", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", fps: 30, style, outro: 0, music: null, takes: [{ a: 0, b: SEC }], zoom: {}, beats: [] }, null, 2));
      const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary(), PHANTASIC_SFX_PACK: path.join(root, "no-such-pack") } });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      return fs.readFileSync(path.join(dir, "index.html"), "utf8");
    };
    const b = html("broadsheet");
    const at = b.indexOf("(function captionFontGuard(");
    assert.ok(at > 0, "broadsheet tweens its caption groups: the guard must be in the page");
    assert.ok(at > b.indexOf("const tl = gsap.timeline") && at < b.indexOf('ft("#cg0"'), "the guard records the groups before any tween is added");
    assert.ok(b.includes("})(tl, gsap, document);"));
    const c = html("clean");
    assert.ok(c.includes('class="cap-group'), "the clean reel has captions");
    assert.ok(!c.includes("captionFontGuard"), "no tween on a caption group: nothing emitted, the page is unchanged");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

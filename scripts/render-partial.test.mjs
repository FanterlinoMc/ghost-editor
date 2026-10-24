// mac-63: scripts/render-partial.mjs, partial rendering.
//   - windows are frame-aligned, follow sections.json, merge short ones and split long ones
//   - a window page shifts every timed element by -a, trims a clip that starts before it (media-start moved with it),
//     switches off what it never shows (a <video> becomes a src-less <div>), and replays the page's own timeline from a
//   - a window's key moves only when something it shows changes; the sound's key ignores the picture
//   - a reel renders by windows to the SAME captured pixels as a full render (PNG sequences, md5 per frame), the joined
//     mp4 has the full render's frame count and decoded audio, and editing one graphic re-renders only its window
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planWindows, timedElements, windowPage, audioPage, windowKey, audioKey, renderPartial, compare } from "./render-partial.mjs";
import { runRenderAsync } from "./lib/vendor.mjs";
import { silentLibrary } from "./lib/silent-library.mjs";
import { findChrome } from "./lib/browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "render-partial-test-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

test("planWindows: frame-aligned, from the sections, short ones merged, long ones split", () => {
  const secs = (...s) => s.map((start) => ({ start }));
  assert.deepEqual(planWindows(secs(0, 5, 10), 15, 30).map((w) => [w.fa, w.fb]), [[0, 150], [150, 300], [300, 450]]);
  // the 1 s section 4..5 joins the one it follows (4..9), and so does the trailing 1 s (9..10)
  assert.deepEqual(planWindows(secs(0, 4, 5, 9), 10, 30, { min: 3 }).map((w) => [w.a, w.b]), [[0, 4], [4, 10]]);
  // a 25 s section split evenly under max 10
  assert.deepEqual(planWindows(secs(0), 25, 30, { max: 10 }).map((w) => [w.a, w.b]), [[0, 8.333333], [8.333333, 16.666667], [16.666667, 25]]);
  // a section start off the frame grid snaps to it
  assert.deepEqual(planWindows(secs(0, 4.01), 8, 30).map((w) => w.fa), [0, 120]);
});

const PAGE = `<html><head><style>.x{}</style></head><body>
<div id="root" class="" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="10" data-fps="30">
<video id="take-0" src="assets/a.mp4" data-start="0" data-duration="4" data-media-start="0" data-track-index="0" muted playsinline></video>
<video id="take-1" src="assets/a.mp4" data-start="4" data-duration="6" data-media-start="10" data-track-index="0" muted playsinline></video>
<div id="b1" class="clip" data-start="5" data-duration="2" data-track-index="2"><div id="b1-in">One</div></div>
<div id="b2" class="clip" data-start="1" data-duration="2" data-track-index="2"><div id="b2-in">Two</div></div>
<audio id="take-0-audio" src="assets/a.mp4" data-start="0" data-duration="4" data-media-start="0" data-track-index="10"></audio>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.fromTo("#b1-in", { opacity: 0 }, { opacity: 1 }, 5.1);
  tl.fromTo("#b2-in", { opacity: 0 }, { opacity: 1 }, 1.1);
  tl.set({}, {}, 10);
  window.__timelines["main"] = tl;
</script>
</body></html>`;

test("timedElements finds the outermost timed elements, not the root", () => {
  assert.deepEqual(timedElements(PAGE).map((e) => [e.tag, e.s, e.d, e.ids[0]]), [["video", 0, 4, "take-0"], ["video", 4, 6, "take-1"], ["div", 5, 2, "b1"], ["div", 1, 2, "b2"], ["audio", 0, 4, "take-0-audio"]]);
});

test("windowPage: shifted, trimmed, the rest switched off, the page's timeline replayed from a", () => {
  const p = windowPage(PAGE, 6, 10);
  assert.match(p, /<div id="root"[^>]*data-duration="4"/);
  // take-1 (4..10) trimmed to 6..10: starts at 0, lasts 4, its media starts 2 s later
  assert.match(p, /<video id="take-1" src="assets\/a\.mp4" data-start="0" data-duration="4" data-media-start="12"/);
  // b1 (5..7) trimmed to 6..7
  assert.match(p, /<div id="b1" class="clip" data-start="0" data-duration="1"/);
  // take-0 and b2 are never on screen: off, untimed, the video a src-less div (no 45 s decode wait)
  assert.match(p, /<div data-pr-off id="take-0"><\/div>/);
  assert.match(p, /<div data-pr-off id="b2" class="clip"><div id="b2-in">Two<\/div><\/div>/);
  assert.doesNotMatch(p, /<audio/);
  assert.match(p, /inner\.tweenFromTo\(6, 10/);
  assert.match(p, /\[data-pr-off\]\{display:none !important\}/);
  // the sound page keeps every <audio>, no video, 1 frame a second
  const a = audioPage(PAGE);
  assert.match(a, /<audio id="take-0-audio"/);
  assert.doesNotMatch(a, /<video/);
  assert.match(a, /data-fps="1"/);
});

test("windowKey moves only for the window an edit is on screen in", () => {
  const keys = (html) => [[0, 4], [4, 6], [6, 10]].map(([a, b]) => windowKey(html, a, b));
  const k0 = keys(PAGE);
  assert.equal(new Set(k0).size, 3);
  // b1 (on screen 5..7) edited: windows 4-6 and 6-10 change, 0-4 does not
  const k1 = keys(PAGE.replace(">One<", ">Uno<"));
  assert.deepEqual(k1.map((k, i) => k !== k0[i]), [false, true, true]);
  // a script line that only names b2 (1..3) moves window 0-4 only
  const k2 = keys(PAGE.replace("{ opacity: 1 }, 1.1)", "{ opacity: 0.9 }, 1.1)"));
  assert.deepEqual(k2.map((k, i) => k !== k0[i]), [true, false, false]);
  // the page head (CSS, fonts) moves every window
  assert.ok(keys(PAGE.replace(".x{}", ".x{color:red}")).every((k, i) => k !== k0[i]));
  // the sound's key ignores the picture, follows the audio elements
  assert.equal(audioKey(PAGE.replace(">One<", ">Uno<")), audioKey(PAGE));
  assert.notEqual(audioKey(PAGE.replace('data-media-start="0" data-track-index="10"', 'data-media-start="1" data-track-index="10"')), audioKey(PAGE));
});

// --- real renders -------------------------------------------------------------------------------------------------
const chrome = findChrome();
const SECONDS = 6;
function reel(dir, label) {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  const src = path.join(dir, "assets", "talk.mp4");
  if (!fs.existsSync(src)) execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=360x640:rate=30:duration=${SECONDS}`, "-f", "lavfi", "-i", `sine=frequency=180:duration=${SECONDS}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-shortest", "-y", src]);
  const text = "two takes one graphic and captions the whole way through".split(" ");
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: SECONDS,
    words: text.map((w, i) => ({ word: w, start: +(0.2 + i * 0.55).toFixed(2), end: +(0.2 + i * 0.55 + 0.45).toFixed(2) })) }] }));
  const beat = { type: "motion", by: "designer", id: "g1", at: 3.4, to: 5.6, exit: "fade", sfx: "none",
    elements: [{ id: "t", shape: "text", x: 90, y: 300, w: 900, h: 200, text: label, font: "Montserrat", size: 84, weight: 800, upper: true, align: "left", color: "#ffffff", z: 2 }],
    tweens: [{ target: "t", at: 0.1, dur: 0.4, ease: "power3.out", from: { y: 30, opacity: 0 }, to: { y: 0, opacity: 1 } }] };
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "partial", source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/none.json",
    style: "clean", fps: 30, outro: 0, music: null, designer: true, takes: [{ a: 0, b: 3 }, { a: 3, b: 6 }], zoom: {}, beats: [beat] }, null, 2));
  const r = spawnSync(process.execPath, [path.join(HERE, "build.mjs"), "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary() } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
}
const frameHashes = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) =>
  crypto.createHash("md5").update(execFileSync("ffmpeg", ["-v", "error", "-i", path.join(dir, f), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 26 })).digest("hex"));

test("a reel rendered by windows: the full render's pixels, frames and sound; one edited graphic re-renders one window", { skip: chrome ? false : "no Chrome", timeout: 600000 }, async () => {
  const dir = path.join(root, "reel");
  reel(dir, "Stop doing DMs by hand");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "build", "sections.json"), "utf8"));
  const wins = planWindows(manifest.sections, manifest.total, 30);
  assert.deepEqual(wins.map((w) => [w.a, w.b]), [[0, 3], [3, 6]], "two takes, two windows");
  // captured pixels: the full page and each window page as PNG sequences, frame for frame
  const full = path.join(root, "full-seq");
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  let r = await runRenderAsync(["--format", "png-sequence", "-o", full, "--quiet"], { cwd: dir });
  assert.equal(r.status, 0, r.error + r.stderr.slice(-1500));
  const want = frameHashes(full).slice(0, SECONDS * 30);
  const got = [];
  for (const w of wins) {
    fs.writeFileSync(path.join(dir, "win.html"), windowPage(html, w.a, w.b));
    const out = path.join(root, `win-${w.fa}`);
    r = await runRenderAsync(["-c", "win.html", "--format", "png-sequence", "-o", out, "--quiet"], { cwd: dir });
    assert.equal(r.status, 0, r.error + r.stderr.slice(-1500));
    got.push(...frameHashes(out).slice(0, w.fb - w.fa));
  }
  fs.rmSync(path.join(dir, "win.html"));
  assert.equal(got.length, want.length);
  assert.deepEqual(got.map((h, i) => (h === want[i] ? "" : `frame ${i}`)).filter(Boolean), [], "window frames differ from the full render's");
  // the mp4: rendered by windows, joined, the sound muxed; checked against a full mp4 render
  r = await runRenderAsync(["-o", "build/full.mp4", "--quiet"], { cwd: dir });
  assert.equal(r.status, 0, r.error);
  const p1 = await renderPartial(dir, { output: "build/partial.mp4" });
  assert.deepEqual([p1.windows, p1.rendered, p1.reused, p1.audio], [2, 2, 0, "rendered"]);
  const c = compare(path.join(dir, "build/partial.mp4"), path.join(dir, "build/full.mp4"));
  assert.deepEqual(c.frames, [SECONDS * 30, SECONDS * 30]);
  assert.equal(c.audioSame, true, "decoded sound differs from the full render's");
  assert.ok(c.psnrMin > 40, `PSNR ${c.psnrMin} dB: more than per-segment encoding noise`);
  // nothing changed: nothing renders
  const p2 = await renderPartial(dir, { output: "build/partial.mp4" });
  assert.deepEqual([p2.rendered, p2.reused, p2.audio], [0, 2, "reused"]);
  // the graphic (3.4..5.6, second take) edited: its window only, the sound reused
  reel(dir, "Stop answering DMs by hand");
  const p3 = await renderPartial(dir, { output: "build/partial.mp4" });
  assert.deepEqual([p3.rendered, p3.reused, p3.audio], [1, 1, "reused"]);
  assert.deepEqual(p3.plan.filter((w) => !w.cached).map((w) => [w.a, w.b]), [[3, 6]]);
});

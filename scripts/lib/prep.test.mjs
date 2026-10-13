// node scripts/lib/prep.test.mjs
// prep.sh's source-kind detection and the talk-N.json sidecar (BLANK-TIMELINE-SPEC.md, Stage 1).
// Inputs are tiny lavfi-generated files; image clips are cut to 1 s via PREP_IMAGE_SECONDS (the
// real default is 30 s; a default-length run is not repeated here, it costs ~40 s of encode for
// no extra coverage).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PREP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prep.sh").split(path.sep).join("/");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "prep-test-"));
const p = (...a) => path.join(root, ...a).split(path.sep).join("/");
const ff = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" });
const probe = (file, entries, sel) => execFileSync("ffprobe", ["-v", "error", ...(sel ? ["-select_streams", sel] : []), "-show_entries", entries, "-of", "csv=p=0", file]).toString().trim();

const V = ["-f", "lavfi", "-i", "testsrc=size=180x320:rate=30:duration=2"];
const enc = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
const inputs = {
  silent: () => ff(...V, ...enc, p("silent.mp4")),
  // loud, continuous: reads as speech-like
  loud: () => ff(...V, "-f", "lavfi", "-i", "sine=frequency=300:duration=2", ...enc, "-c:a", "aac", p("loud.mp4")),
  // far below any voice: room tone
  quiet: () => ff(...V, "-f", "lavfi", "-i", "sine=frequency=300:duration=2,volume=0.0005", ...enc, "-c:a", "aac", p("quiet.mp4")),
  png: () => ff("-f", "lavfi", "-i", "testsrc=size=160x284", "-frames:v", "1", p("near.png")),     // 9:16-ish -> cover
  wide: () => ff("-f", "lavfi", "-i", "testsrc=size=320x180", "-frames:v", "1", p("wide.jpg")),     // 16:9 on 9:16 -> blurred fill
};
inputs.silent(); inputs.loud(); inputs.quiet(); inputs.png(); inputs.wide();
// a 0.2 s loud blip in 2 s of silence: loud, but well under 25% non-silent
ff("-f", "lavfi", "-i", "sine=frequency=300:duration=0.2", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.8", "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]", "-map", "[a]", p("blip.wav"));
ff(...V, "-i", p("blip.wav"), ...enc, "-c:a", "aac", "-shortest", p("blip.mp4"));
// an image whose extension says nothing: kind must come from the demuxer
fs.copyFileSync(p("near.png"), p("mystery.dat"));

function prep(file, idx, fmt = "9:16") {
  const proj = p("proj");
  execFileSync("bash", [PREP, p(file), proj, fmt, String(idx)], { stdio: "pipe", env: { ...process.env, PREP_IMAGE_SECONDS: "1" } });
  const side = JSON.parse(fs.readFileSync(`${proj}/assets/talk-${idx}.json`, "utf8"));
  const out = fmt === "9:16" ? `${proj}/assets/talk-${idx}.mp4` : `${proj}/assets/talk-${idx}-${fmt.replace(":", "x")}.mp4`;
  return { side, out, proj };
}

try {
  // video with sound: kind video, speech-like
  let r = prep("loud.mp4", 1);
  assert.deepEqual(r.side, { kind: "video", duration: r.side.duration, hasAudio: true, speechLikely: true });
  assert.ok(Math.abs(r.side.duration - 2) < 0.2);

  // no audio stream: kind silent, the OUTPUT still has stereo AAC of the same length
  r = prep("silent.mp4", 2);
  assert.deepEqual({ ...r.side, duration: 0 }, { kind: "silent", duration: 0, hasAudio: false, speechLikely: false });
  assert.equal(probe(r.out, "stream=codec_name,channels", "a:0"), "aac,2");
  assert.ok(Math.abs(parseFloat(probe(r.out, "format=duration")) - 2) < 0.2);
  assert.ok(Math.abs(r.side.duration - 2) < 0.2);

  // audible only as room tone, and a short blip in silence: both false
  assert.equal(prep("quiet.mp4", 3).side.speechLikely, false);
  assert.equal(prep("quiet.mp4", 3).side.hasAudio, true);
  assert.equal(prep("blip.mp4", 4).side.speechLikely, false);

  // images: 1080x1920 at 30 fps with a silent audio track; cover vs blurred fill from the aspect
  r = prep("near.png", 5);
  assert.deepEqual({ ...r.side, duration: 0 }, { kind: "image", duration: 0, hasAudio: false, speechLikely: false });
  assert.equal(probe(r.out, "stream=width,height,r_frame_rate", "v:0"), "1080,1920,30/1");
  assert.equal(probe(r.out, "stream=codec_name,channels", "a:0"), "aac,2");
  assert.equal(JSON.parse(fs.readFileSync(`${r.proj}/build/crop-5-9x16.json`, "utf8")).mode, "centre");
  r = prep("wide.jpg", 6);
  assert.equal(r.side.kind, "image");
  assert.equal(JSON.parse(fs.readFileSync(`${r.proj}/build/crop-6-9x16.json`, "utf8")).mode, "pad");
  // another format: a 16:9 picture on a 16:9 canvas is a plain cover
  r = prep("wide.jpg", 6, "16:9");
  assert.equal(probe(r.out, "stream=width,height", "v:0"), "1920,1080");
  assert.equal(JSON.parse(fs.readFileSync(`${r.proj}/build/crop-6-16x9.json`, "utf8")).mode, "centre");

  // the extension is not trusted: a .dat that the demuxer reads as an image is an image
  assert.equal(prep("mystery.dat", 7).side.kind, "image");
  console.log("prep kind detection: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

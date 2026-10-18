#!/usr/bin/env node
// node scripts/ahmed-tools.test.mjs
// Ahmed's small stand-alone tools, ported from phantasic engine/core/scripts (phase A): engravings_fetch.py, engravings_process.py,
// sfx_index.py, look_stats.py, vcheck.py, upscale.py. None calls a paid service. They run on synthetic inputs here; the network
// fetch is exercised with its two network functions replaced. upscale.py needs torch + spandrel (not installed everywhere), so it is
// only compiled. Skipped, and says so, when no python with OpenCV and numpy is found.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ahmed-tools-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const check = (label) => console.log(`ok    ${label}`);
const python = ["py", "python3", "python"].find((c) => spawnSync(c, ["-c", "import cv2, numpy"], { stdio: "ignore" }).status === 0);
const run = (script, args, env = {}) => {
  const r = spawnSync(python, [path.join(HERE, script), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `${script}: ${r.stderr}${r.stdout}`);
  return r.stdout;
};

try {
  if (!python) { console.log("skip  ahmed-tools: no python with OpenCV and numpy"); process.exit(0); }

  // every script compiles (upscale.py only needs torch when it runs)
  for (const s of ["engravings_fetch", "engravings_process", "sfx_index", "look_stats", "vcheck", "upscale"]) {
    const r = spawnSync(python, ["-m", "py_compile", path.join(HERE, `${s}.py`)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  check("all six scripts compile");

  // ---- sfx_index.py: two synthetic wavs -> timing.json + INDEX.md ----
  const sfx = path.join(root, "sfx");
  fs.mkdirSync(sfx);
  ff("-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", path.join(sfx, "a.wav"));
  ff("-f", "lavfi", "-i", "sine=frequency=880:duration=1.0,volume=0.1", path.join(sfx, "b.wav"));
  fs.writeFileSync(path.join(sfx, "manifest.json"), JSON.stringify({ a: { file: "a.wav", role: "ui", tags: ["tick"] }, b: { file: "b.wav", role: "whoosh", tags: [] }, gone: { file: "missing.wav", role: "ui" } }));
  assert.match(run("sfx_index.py", [], { SFX_DIR: sfx }), /2 sounds/);
  const timing = JSON.parse(fs.readFileSync(path.join(sfx, "timing.json"), "utf8"));
  assert.deepEqual(Object.keys(timing).sort(), ["a", "b"], "a manifest entry with no file on disk is skipped");
  assert.ok(Math.abs(timing.a.dur - 0.5) < 0.05 && Math.abs(timing.b.dur - 1) < 0.05, JSON.stringify(timing));
  assert.ok(timing.b.peak_db < timing.a.peak_db - 15, "the quiet one reads quieter");
  assert.match(fs.readFileSync(path.join(sfx, "INDEX.md"), "utf8"), /\| a \| ui \| tick \| 0\.5 /);
  check("sfx_index.py: timing.json + INDEX.md from a synthetic kit (SFX_DIR), missing files skipped");

  // ---- vcheck.py: voice vs mix ----
  ff("-f", "lavfi", "-i", "sine=frequency=500:duration=2", path.join(root, "voice.wav"));
  ff("-f", "lavfi", "-i", "sine=frequency=500:duration=2", "-f", "lavfi", "-i", "sine=frequency=1700:duration=2,volume=0.1", "-filter_complex", "[0][1]amix=inputs=2:weights=1 1:normalize=0", path.join(root, "mix.wav"));
  ff("-f", "lavfi", "-i", "sine=frequency=500:duration=2", "-f", "lavfi", "-i", "sine=frequency=1700:duration=2,volume=6", "-filter_complex", "[0][1]amix=inputs=2:weights=1 1:normalize=0", path.join(root, "loud-mix.wav"));
  let out = run("vcheck.py", [path.join(root, "voice.wav"), path.join(root, "mix.wav")]);
  assert.match(out, /speech windows under \+6 dB: none/, out);
  out = run("vcheck.py", [path.join(root, "voice.wav"), path.join(root, "loud-mix.wav")]);
  assert.doesNotMatch(out, /under \+6 dB: none/, "a bed far louder than the voice is flagged");
  check("vcheck.py: a quiet bed passes, a bed 15 dB over the voice is flagged");

  // ---- look_stats.py ----
  ff("-f", "lavfi", "-i", "color=c=0x808080:size=128x228:rate=10:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "grey.mp4"));
  const ls = JSON.parse(run("look_stats.py", [path.join(root, "grey.mp4"), "--takes", "[[0,1],[1.5,2.5]]", "--n", "6"]));
  assert.ok(ls.sat < 6, `grey has no saturation (${ls.sat})`);
  assert.ok(Math.abs(ls.luma - 128) < 12, `mid grey luma (${ls.luma})`);
  check("look_stats.py: saturation and luma inside the kept takes");

  // ---- engravings_process.py: a dark drawing on off-white paper, from a file:// URL -> alpha cut-out + manifest ----
  const lib = path.join(root, "eng");
  fs.mkdirSync(path.join(lib, "gen"), { recursive: true });
  const src = path.join(lib, "gen", "src.png");
  ff("-f", "lavfi", "-i", "color=c=0xE8E4D8:size=400x300", "-vf", "drawbox=x=150:y=100:w=100:h=100:color=0x222222:t=fill", "-frames:v", "1", src);
  fs.writeFileSync(path.join(lib, "gen", "urls.txt"), `ring ${new URL("file:///" + src.split(path.sep).join("/")).href}\n\n`);
  run("engravings_process.py", [], { ENGRAVINGS_DIR: lib });
  const png = path.join(lib, "png", "ring.png");
  assert.ok(fs.existsSync(png));
  const px = execFileSync(python, ["-c", `import cv2,sys;i=cv2.imread(sys.argv[1],cv2.IMREAD_UNCHANGED);print(i.shape[2],i.shape[0],i.shape[1],i[i.shape[0]//2,i.shape[1]//2,3],i[0,0,3])`, png], { encoding: "utf8" }).trim().split(" ").map(Number);
  assert.equal(px[0], 4, "BGRA");
  assert.ok(px[1] < 300 && px[2] < 300, `cropped to the drawing (${px[2]}x${px[1]})`);
  assert.ok(px[3] > 200 && px[4] < 20, `ink is opaque, paper is transparent (${px[3]}, ${px[4]})`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lib, "manifest.json"), "utf8")).ring.file, "png/ring.png");
  check("engravings_process.py: paper lifted to transparent, cropped, manifest entry (ENGRAVINGS_DIR, file:// URL)");

  // ---- engravings_fetch.py: Wikimedia API and download replaced; only public-domain / CC0 bitmaps are kept ----
  const lib2 = path.join(root, "eng2");
  const stub = `
import sys, os
sys.path.insert(0, ${JSON.stringify(HERE)})
sys.argv = ["engravings_fetch.py", "--per", "2", "--only", "brain"]
import engravings_fetch as e
def page(i, lic, mime="image/jpeg", w=900):
    return {"title": f"File:b{i}.jpg", "index": i, "imageinfo": [{"thumburl": f"https://x/{i}.jpg", "url": f"https://x/{i}.jpg", "descriptionurl": f"https://c/{i}", "mime": mime, "width": w, "height": w, "extmetadata": {"LicenseShortName": {"value": lic}}}]}
e.api = lambda p: {"query": {"pages": {"1": page(1, "CC BY-SA 4.0"), "2": page(2, "Public domain"), "3": page(3, "CC0"), "4": page(4, "PD", w=100), "5": page(5, "Public domain", mime="image/svg+xml")}}}
e.get = lambda url: b"img:" + url.encode()
e.main()
`;
  out = execFileSync(python, ["-c", stub], { encoding: "utf8", env: { ...process.env, ENGRAVINGS_DIR: lib2 } });
  const man = JSON.parse(fs.readFileSync(path.join(lib2, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(man), ["brain-1", "brain-2"], out);
  assert.deepEqual(Object.values(man).map((m) => m.licence), ["Public domain", "CC0"], "CC BY-SA, small and non-bitmap files are dropped");
  assert.equal(fs.readFileSync(path.join(lib2, "raw", "brain-1.img"), "utf8"), "img:https://x/2.jpg");
  check("engravings_fetch.py: keeps only Public Domain / CC0 bitmaps of a usable size (network stubbed)");

  console.log("\nall ahmed-tools checks passed");
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

#!/usr/bin/env node
// node --test scripts/vendor.test.mjs
// A render never loads a library from a CDN (vendor/manifest.json, scripts/vendor-offline.cjs, runRender() in
// scripts/lib/vendor.mjs, its CLI scripts/render.mjs):
//   - every vendored file matches its sha256 and has its licence and SOURCES note next to it
//   - a built reel (and a blank one) has no http(s) <script src>/<link href> that is not vendored. A new CDN tag in
//     build.mjs (lottie, three, a GSAP plugin, another GSAP version) fails here until it is vendored.
//   - the preload answers the page's CDN URL with the vendored bytes while Node's other fetches are refused
//     (VENDOR_OFFLINE=1: Node only, Chrome is not covered by it), and refuses a manifest URL whose copy is altered
//   - runRender() fails a render whose stderr does not show the preload serving every vendored URL the page uses
//   - every `hyperframes ... render` invocation under scripts/ goes through runRender()
// The page keeps the CDN URL itself: it is part of every golden reel's hashed index.html (byte-identity.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LIBRARIES, VENDOR, PRELOAD, MARK, runRender } from "./lib/vendor.mjs";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const GSAP = LIBRARIES.find((l) => l.name === "gsap");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-test-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

// every http(s) URL a <script src> or <link href> on the page points at
const externalRefs = (html) => [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
  .map((m) => m[1].trim()).filter((u) => /^(https?:)?\/\//i.test(u));
const unvendored = (html) => externalRefs(html).filter((u) => !LIBRARIES.some((l) => l.url === u));

function project(name, reel, withSource = true) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  if (withSource) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=108x192:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=200:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-shortest", path.join(dir, "assets", "talk.mp4")], { stdio: "pipe" });
    const text = "a short clip with captions so the page has real timeline content".split(" ");
    fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: 4, words: text.map((w, i) => ({ word: w, start: 0.2 + i * 0.3, end: 0.45 + i * 0.3 })) }] }));
    fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: Array.from({ length: 4 }, (_, i) => [i, 300, 900, 340, 740, 480, 700]) }));
  }
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: "vendor test", fps: 30, outro: 0, music: null, style: "clean", zoom: {}, beats: [], ...reel }, null, 2));
  const r = spawnSync(process.execPath, [BUILD, "."], { cwd: dir, encoding: "utf8", env: { ...process.env, PHANTASIC_LIB: silentLibrary() } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return fs.readFileSync(path.join(dir, "index.html"), "utf8");
}

// node -e <probe> with the preload: fetch the GSAP URL, then an unvendored CDN URL; prints JSON
const PROBE = `
  const crypto = require("node:crypto");
  (async () => {
    let ok = false, h = "", err = "", blocked = "";
    let body = "";
    try { const r = await fetch(${JSON.stringify(GSAP.url)}, { signal: AbortSignal.timeout(15000) }); ok = r.ok; const b = Buffer.from(await r.arrayBuffer()); h = crypto.createHash("sha256").update(b).digest("hex"); body = b.length < 2000 ? b.toString() : ""; } catch (e) { err = String(e.message); }
    try { await fetch("https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"); } catch (e) { blocked = String(e.message); }
    console.log(JSON.stringify({ ok, sha: h, err, blocked, body }));
  })();`;
const probe = (preload) => {
  const r = spawnSync(process.execPath, ["-e", PROBE], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--require "${preload}"`, VENDOR_OFFLINE: "1" } });
  assert.equal(r.status, 0, r.stderr);
  return { ...JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr };
};

test("every vendored file matches its sha256 and carries its licence and SOURCES note", () => {
  assert.ok(GSAP);
  for (const e of LIBRARIES) {
    assert.match(e.version, /^\d+\.\d+\.\d+$/, `${e.name}: pin an exact version`);
    assert.ok(e.url.includes(`@${e.version}/`), `${e.name}: the URL must name the pinned version ${e.version}`);
    assert.equal(sha(fs.readFileSync(path.join(VENDOR, e.file))), e.sha256, `${e.file} was altered`);
    for (const f of [e.license, e.sources]) assert.ok(f && fs.statSync(path.join(VENDOR, f)).size > 200, `${e.name}: ${f} missing`);
  }
});

test("a built reel and a blank reel load no library that is not vendored", () => {
  for (const html of [project("talk", { source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", takes: [{ a: 0, b: 4 }] }),
    project("blank", { origin: "blank", takes: [] }, false)]) {
    assert.deepEqual(externalRefs(html), [GSAP.url], "the page's one external script is the vendored GSAP");
    assert.deepEqual(unvendored(html), [], "index.html loads a library from the network: vendor it (vendor/manifest.json)");
  }
  // and the check itself flags an unvendored CDN script / stylesheet
  assert.equal(unvendored(`<script src="https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js"></script><link href="//unpkg.com/x.css" rel="stylesheet">`).length, 2);
});

test("the preload serves the page's CDN URL from vendor/ with Node's network refused", () => {
  const out = probe(PRELOAD);
  assert.equal(out.ok, true, out.err + out.stderr);
  assert.equal(out.sha, GSAP.sha256);
  assert.match(out.blocked, /VENDOR_OFFLINE/);
  assert.ok(out.stderr.includes(`${MARK} ${GSAP.url} from vendor/${GSAP.file}`), out.stderr);
});

test("the preload fails closed when the vendored copy is missing or altered", () => {
  // a copy of the preload next to a vendor/ whose GSAP file is altered (the preload reads ../vendor from its own folder)
  const fake = path.join(root, "fake-fork");
  fs.mkdirSync(path.join(fake, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fake, "vendor", path.dirname(GSAP.file)), { recursive: true });
  fs.copyFileSync(PRELOAD, path.join(fake, "scripts", "vendor-offline.cjs"));
  fs.copyFileSync(path.join(VENDOR, "manifest.json"), path.join(fake, "vendor", "manifest.json"));
  fs.writeFileSync(path.join(fake, "vendor", GSAP.file), fs.readFileSync(path.join(VENDOR, GSAP.file), "utf8") + "\n// altered");
  const preload = path.join(fake, "scripts", "vendor-offline.cjs").split(path.sep).join("/");
  // refused: the page gets a script that throws (so Chrome never loads the tag from the CDN either), and no MARK
  const refused = (out) => {
    assert.notEqual(out.sha, GSAP.sha256);
    assert.match(out.body, /^\/\* vendor: REFUSED https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@3\.14\.2\S* \*\/\nthrow new Error\(/);
    assert.match(out.body, /fail closed/);
    assert.ok(!out.stderr.includes(MARK) && out.stderr.includes("vendor: REFUSED"), out.stderr);
  };
  refused(probe(preload));
  fs.rmSync(path.join(fake, "vendor", GSAP.file));
  refused(probe(preload));
});

test("runRender preloads the vendor hook and fails a render the preload did not serve", () => {
  const dir = path.join(root, "talk");
  let seen;
  const stub = (stderr) => (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0, stdout: "", stderr }; };
  let r = runRender(["-o", "out.mp4", "--quiet"], { cwd: dir, spawn: stub(`${MARK} ${GSAP.url} from vendor/${GSAP.file}\n`) });
  assert.equal(r.status, 0, r.error);
  assert.ok(seen.opts.env.NODE_OPTIONS.includes(`--require "${PRELOAD}"`));
  assert.deepEqual(seen.args.slice(-6), ["-y", "hyperframes@0.8.81", "render", "-o", "out.mp4", "--quiet"]);
  assert.equal(seen.opts.cwd, dir);
  // the same render with no MARK on stderr (hyperframes fetched GSAP itself, the preload never loaded, or it refused an
  // altered copy and Chrome loaded the tag): status 1 and the finished output is deleted
  const writes = (stderr) => (cmd, args, opts) => { fs.writeFileSync(path.join(opts.cwd, args[args.indexOf("-o") + 1]), "a complete reel"); return { status: 0, stdout: "", stderr }; };
  for (const stderr of ["[INFO] [Compiler] Inlined CDN script: " + GSAP.url, `vendor: REFUSED ${GSAP.url}: altered`]) {
    r = runRender(["-o", "out.mp4", "--quiet"], { cwd: dir, spawn: writes(stderr) });
    assert.equal(r.status, 1);
    assert.match(r.error, /not served from vendor\/: https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@3\.14\.2/);
    assert.match(r.error, stderr.startsWith("vendor: REFUSED") ? /missing or altered/ : /the CDN was used/);
    assert.match(r.error, /the output .*out\.mp4 was removed/);
    assert.equal(fs.existsSync(path.join(dir, "out.mp4")), false, "a CDN-GSAP reel was left at the output path");
  }
  // a served render keeps its output
  r = runRender(["-o", "out.mp4"], { cwd: dir, spawn: writes(`${MARK} ${GSAP.url} from vendor/${GSAP.file}`) });
  assert.equal(r.status, 0, r.error);
  assert.ok(fs.existsSync(path.join(dir, "out.mp4")));
  fs.rmSync(path.join(dir, "out.mp4"));
  // no page (cwd/index.html, or the -c file): an error, and nothing is run
  let ran = false;
  for (const [args, cwd] of [[["-o", "out.mp4"], root], [["-c", "missing.html", "-o", "out.mp4"], dir], [["-o", "out.mp4", "-c"], dir]]) {
    r = runRender(args, { cwd, spawn: () => { ran = true; return { status: 0, stdout: "", stderr: "" }; } });
    assert.equal(r.status, 1);
    assert.match(r.error, /no page to render/);
  }
  assert.equal(ran, false);
  // a failed render keeps its own status
  r = runRender(["-o", "out.mp4"], { cwd: dir, spawn: () => ({ status: 3, stdout: "", stderr: "boom" }) });
  assert.equal(r.status, 3);
  assert.ok(PRELOAD.endsWith("scripts/vendor-offline.cjs") && !PRELOAD.includes("\\"));
});

// Per FILE, not per line (a call can be split across lines or built from variables): a file under scripts/ whose code
// (comments stripped) names hyperframes anywhere AND has a "render" token is a render caller, and must go through
// runRender() / scripts/render.mjs. Exempt: the helper itself and this test (it holds the shapes as strings).
const RENDER_TOKEN = /["'`]render["'`]|(^|[\s;|&(])render\s+-/m;
const stripComments = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l)).map((l) => l.replace(/\s(\/\/|#)\s.*$/, "")).join("\n");
function rawRenderCallers(dir) {
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "__pycache__" && e.name !== "node_modules") walk(p); continue; }
      const rel = path.relative(path.join(HERE, ".."), p).split(path.sep).join("/");
      if (rel === "scripts/lib/vendor.mjs" || rel === "scripts/vendor.test.mjs") continue;
      const buf = fs.readFileSync(p);
      if (buf.includes(0)) continue;                                   // binary
      const code = stripComments(buf.toString("utf8"));
      if (!/hyperframes/i.test(code) || !RENDER_TOKEN.test(code)) continue;
      if (/\brunRender\b|render\.mjs/.test(code)) continue;            // goes through the helper
      bad.push(rel);
    }
  };
  walk(dir);
  return bad.sort();
}

test("every hyperframes render call under scripts/ goes through runRender (scripts/lib/vendor.mjs)", () => {
  assert.deepEqual(rawRenderCallers(HERE), [], "render through runRender() / scripts/render.mjs so GSAP comes from vendor/ and a CDN fetch fails the render");
});

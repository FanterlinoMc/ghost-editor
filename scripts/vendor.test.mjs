#!/usr/bin/env node
// node --test scripts/vendor.test.mjs
// A render never loads a library from a CDN (vendor/manifest.json, scripts/lib/vendor.mjs, scripts/vendor-offline.cjs):
//   - every vendored file matches its sha256 and has its licence and SOURCES note next to it
//   - a built reel (and a blank one) references no http(s) <script src>/<link href> that is not vendored, and the
//     local copy of each one it does reference is in the project with the right bytes. A new CDN tag in build.mjs
//     (lottie, three, a GSAP plugin, another GSAP version) fails here until it is vendored.
//   - the render preload, with every other network fetch refused (VENDOR_OFFLINE=1), answers the page's CDN URL
//     with the vendored bytes
// The page keeps the CDN URL itself: it is part of every golden reel's hashed index.html (byte-identity.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LIBRARIES, VENDOR, PRELOAD, renderEnv } from "./lib/vendor.mjs";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build.mjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-test-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

// every http(s) URL a <script src> or <link href> on the page points at
const externalRefs = (html) => [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
  .map((m) => m[1].trim()).filter((u) => /^(https?:)?\/\//i.test(u));

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
  return dir;
}

function assertNoCdn(dir) {
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const refs = externalRefs(html);
  assert.ok(refs.length > 0, "expected the page's GSAP <script src> (the test reads it)");
  for (const url of refs) {
    const e = LIBRARIES.find((l) => l.url === url);
    assert.ok(e, `index.html loads ${url} from the network: vendor it (vendor/manifest.json) or reference a local file`);
    const local = path.join(dir, e.project);
    assert.ok(fs.existsSync(local), `build.mjs did not copy ${e.name} into the project (${e.project})`);
    assert.equal(sha(fs.readFileSync(local)), e.sha256, `${e.project} in the project is not the vendored ${e.name} ${e.version}`);
  }
  return refs;
}

test("every vendored file matches its sha256 and carries its licence and SOURCES note", () => {
  assert.ok(LIBRARIES.some((l) => l.name === "gsap"));
  for (const e of LIBRARIES) {
    assert.match(e.version, /^\d+\.\d+\.\d+$/, `${e.name}: pin an exact version`);
    assert.ok(e.url.includes(`@${e.version}/`), `${e.name}: the URL must name the pinned version ${e.version}`);
    assert.equal(sha(fs.readFileSync(path.join(VENDOR, e.file))), e.sha256, `${e.file} was altered`);
    for (const f of [e.license, e.sources]) assert.ok(f && fs.statSync(path.join(VENDOR, f)).size > 200, `${e.name}: ${f} missing`);
  }
});

test("a built reel and a blank reel load no library from a CDN", () => {
  const refs = assertNoCdn(project("talk", { source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json", takes: [{ a: 0, b: 4 }] }));
  assert.deepEqual(refs, ["https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"]);
  assertNoCdn(project("blank", { origin: "blank", takes: [] }, false));
});

test("the check itself flags an unvendored CDN script", () => {
  const html = `<script src="https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js"></script><link href="//unpkg.com/x.css" rel="stylesheet">`;
  const bad = externalRefs(html).filter((u) => !LIBRARIES.some((l) => l.url === u));
  assert.equal(bad.length, 2);
});

test("the render preload serves the page's CDN URL from the vendored bytes with the network refused", () => {
  const dir = path.join(root, "talk");
  const gsap = LIBRARIES.find((l) => l.name === "gsap");
  const probe = `
    const crypto = require("node:crypto");
    (async () => {
      const r = await fetch(${JSON.stringify(gsap.url)}, { signal: AbortSignal.timeout(15000) });
      const b = Buffer.from(await r.arrayBuffer());
      let blocked = "";
      try { await fetch("https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"); } catch (e) { blocked = String(e.message); }
      console.log(JSON.stringify({ ok: r.ok, sha: crypto.createHash("sha256").update(b).digest("hex"), blocked }));
    })();`;
  // the project's copy first; with it gone, the fork's vendor/ copy
  for (const remove of [false, true]) {
    if (remove) fs.rmSync(path.join(dir, gsap.project));
    const r = spawnSync(process.execPath, ["-e", probe], { cwd: dir, encoding: "utf8", env: { ...renderEnv(), VENDOR_OFFLINE: "1" } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(out.ok, true);
    assert.equal(out.sha, gsap.sha256);
    assert.match(out.blocked, /VENDOR_OFFLINE/);
    const from = remove ? path.join(VENDOR, gsap.file) : path.join(fs.realpathSync(dir), gsap.project);   // cwd is the real path (/var -> /private/var)
    assert.ok(r.stderr.includes(`vendor: served ${gsap.url} from ${from}`), r.stderr);
  }
  assert.ok(PRELOAD.endsWith("scripts/vendor-offline.cjs") && !PRELOAD.includes("\\"));
});

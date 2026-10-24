// mac-60: nothing a reel needs comes off the internet, at build time or at render time.
//   - no engine source (build.mjs, scripts/lib) fetches from a remote host, other than the vendored GSAP <script src>
//     that build.mjs writes into the page (answered from vendor/ by scripts/vendor-offline.cjs at render time)
//   - every shipped style builds with the network blocked (curl / wget shimmed to fail, Node fetch() refused, and on
//     macOS the whole build inside sandbox-exec with outbound network denied), and its index.html names no remote host
//     but the vendored URLs: no Google Fonts link, no CDN script, no remote image
//   - icon, logo and auto-logo (toolLogos) beats take their SVGs from vendor/ (lucide-static, simple-icons), byte for byte
//   - the render preload answers fonts.googleapis.com / fonts.gstatic.com (HyperFrames asks them for the faces its
//     bundle lacks behind Georgia, Arial, ...) from vendor/google-fonts, byte for byte, and never the network
//   - a reel RENDERS with the network off (sandbox-exec on macOS, `unshare -rn` on Linux; skipped, with the reason, when
//     neither can cut the network here), the same discipline caption-boxes.mjs uses for measuring
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { LIBRARIES, ICON_SETS, PRELOAD, VENDOR, vendoredIcon } from "./lib/vendor.mjs";
import { silentLibrary } from "./lib/silent-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, "..");
const BUILD = path.join(HERE, "build.mjs");
const VENDORED_URLS = LIBRARIES.map((e) => e.url);
const SECONDS = 3;

// --- the network cut -------------------------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "offline-test-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
// curl / wget shims: a build that shells out to either fails loudly and leaves a mark
const shim = path.join(root, "shim");
fs.mkdirSync(shim);
for (const b of ["curl", "wget"]) {
  fs.writeFileSync(path.join(shim, b), `#!/bin/sh\necho "offline.test: ${b} $*" >> "${path.join(root, "net-attempts.log")}"\necho "offline.test: ${b} is blocked" >&2\nexit 97\n`, { mode: 0o755 });
}
const SB = path.join(root, "net-off.sb");
fs.writeFileSync(SB, '(version 1)\n(allow default)\n(deny network-outbound (remote ip "*:*"))\n(allow network-outbound (remote ip "localhost:*"))\n');
// the wrapper that cuts the network for a whole process tree, or null with the reason
function netCut() {
  const probe = (argv) => spawnSync(argv[0], [...argv.slice(1), process.execPath, "-e", "1"], { encoding: "utf8" }).status === 0;
  if (process.platform === "darwin" && probe(["sandbox-exec", "-f", SB])) return { argv: ["sandbox-exec", "-f", SB], how: "sandbox-exec, outbound network denied but loopback" };
  if (process.platform === "linux" && probe(["unshare", "-rn"])) return { argv: ["unshare", "-rn"], how: "unshare -rn, a network namespace with no interface but lo" };
  return { argv: null, how: `no way to cut the network on ${process.platform} here (sandbox-exec / unshare -rn)` };
}
const CUT = netCut();
const offlineEnv = (extra = {}) => ({ ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, VENDOR_OFFLINE: "1",
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${PRELOAD}"`.trim(), PHANTASIC_LIB: silentLibrary(), ...extra });
const offline = (cmd, args, opts) => {
  const [c, a] = CUT.argv ? [CUT.argv[0], [...CUT.argv.slice(1), cmd, ...args]] : [cmd, args];
  return spawnSync(c, a, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
};

// --- a synthetic project ---------------------------------------------------------------------------------------
const SRC = path.join(root, "talk.mp4");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=360x640:rate=30:duration=${SECONDS}`, "-f", "lavfi", "-i", `sine=frequency=180:duration=${SECONDS}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-shortest", "-y", SRC]);
const TEXT = "Claude and Notion and Zapier save me hours every single week so I can do the work".split(" ");
function project(name, reel) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.copyFileSync(SRC, path.join(dir, "assets", "talk.mp4"));
  const step = (SECONDS - 0.4) / TEXT.length;
  fs.writeFileSync(path.join(dir, "build", "words.whisper.json"), JSON.stringify({ segments: [{ start: 0, end: SECONDS,
    words: TEXT.map((w, i) => ({ word: w, start: +(0.2 + i * step).toFixed(2), end: +(0.2 + i * step + step * 0.8).toFixed(2) })) }] }));
  fs.writeFileSync(path.join(dir, "build", "face.json"), JSON.stringify({ fps: 5, w: 1080, h: 1920, samples: [0, 2, 4].map((t) => [t, 300, 900, 340, 740, 480, 700]) }));
  fs.writeFileSync(path.join(dir, "reel.json"), JSON.stringify({ title: name, source: "assets/talk.mp4", words: "build/words.whisper.json", face: "build/face.json",
    fps: 30, outro: 0, music: null, takes: [{ a: 0, b: SECONDS }], zoom: {}, beats: [], ...reel }, null, 2));
  return dir;
}
const build = (dir) => offline(process.execPath, [BUILD, "."], { cwd: dir, env: offlineEnv() });
// the same, asynchronously (the style sweep runs a few builds at once): resolves { status, stdout, stderr }
function buildAsync(dir) {
  const argv = [...(CUT.argv || []), process.execPath, BUILD, "."];
  return new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { cwd: dir, env: offlineEnv() });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => { stdout += d; });
    c.stderr.on("data", (d) => { stderr += d; });
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const attempts = () => { const f = path.join(root, "net-attempts.log"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : ""; };

// every http(s) reference a page makes (script/link/img src or href, CSS url(), @import), minus the vendored URLs
const SVG_NS = /^https?:\/\/www\.w3\.org\//;
export function remoteRefs(html) {
  const refs = new Set();
  for (const m of html.matchAll(/\b(?:src|href|srcset|poster|data)\s*=\s*["']\s*(https?:\/\/[^"'\s]+)/gi)) refs.add(m[1]);
  for (const m of html.matchAll(/url\(\s*["']?(https?:\/\/[^"')\s]+)/gi)) refs.add(m[1]);
  for (const m of html.matchAll(/@import\s+["'](https?:\/\/[^"']+)/gi)) refs.add(m[1]);
  return [...refs].filter((u) => !VENDORED_URLS.includes(u) && !SVG_NS.test(u));
}

test("remoteRefs finds every kind of remote reference and lets the vendored URLs through", () => {
  const page = `<script src="${VENDORED_URLS[0]}"></script><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">
    <style>@import "https://x.example/a.css"; .a{background:url('https://x.example/b.png')}</style><img src="https://x.example/c.png">
    <svg xmlns="http://www.w3.org/2000/svg"></svg>`;
  assert.deepEqual(remoteRefs(page).sort(), ["https://fonts.googleapis.com/css2?family=Inter", "https://x.example/a.css", "https://x.example/b.png", "https://x.example/c.png"]);
});

test("no engine source fetches from a remote host (the vendored GSAP <script src> aside)", () => {
  const files = [BUILD, ...fs.readdirSync(path.join(HERE, "lib")).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")).map((f) => path.join(HERE, "lib", f))]
    // the graphic sandbox's own probes name remote hosts on purpose: they check that a graphic CANNOT reach them
    .filter((f) => !/graphic-(probe|render)\.mjs$/.test(f));
  const bad = [];
  for (const f of files) {
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      const net = /execFileSync\(\s*["'](curl|wget)["']|\bfetch\(\s*[`"']https?:|https?:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|esm\.sh)/.test(code);
      if (net && !VENDORED_URLS.some((u) => code.includes(u))) bad.push(`${path.relative(SKILL, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("the vendored icon sets are intact and answer by name", () => {
  assert.deepEqual(ICON_SETS.map((e) => e.name).sort(), ["lucide-static", "simple-icons"]);
  for (const e of ICON_SETS) {
    assert.ok(fs.existsSync(path.join(SKILL, "vendor", e.license)), `${e.name}: licence file`);
    assert.ok(fs.existsSync(path.join(SKILL, "vendor", e.sources)), `${e.name}: SOURCES.md`);
  }
  assert.match(vendoredIcon("lucide-static", "signpost"), /^<!-- @license lucide-static v1\.61\.0 - ISC -->\s*<svg[\s\S]*<\/svg>\s*$/);
  assert.match(vendoredIcon("simple-icons", "notion"), /<title>Notion<\/title>/);
  assert.equal(vendoredIcon("lucide-static", "no-such-icon-x"), null);
  assert.equal(vendoredIcon("simple-icons", "constructor"), null);   // a name is looked up as an own key only
  assert.throws(() => vendoredIcon("no-such-set", "x"), /no vendored icon set/);
});

test("icon, logo and auto-logo beats build with the network blocked, their SVGs from vendor/", () => {
  // no face track (the single-source path): the fixture's face would leave no room beside it, and the beats would be skipped
  const dir = project("icons", { style: "keynote-3", face: "build/no-face.json", toolLogos: true, beats: [
    { type: "icon", at: 0.4, to: 1.2, name: "signpost" },
    { type: "logo", at: 1.4, to: 2.2, icon: "zapier" },
  ] });
  const r = build(dir);
  assert.equal(r.status, 0, `build failed:\n${r.stderr.slice(-2000)}`);
  assert.equal(attempts(), "", "the build tried the network");
  assert.equal(fs.readFileSync(path.join(dir, "assets", "icons", "zapier.svg"), "utf8"), vendoredIcon("simple-icons", "zapier"));
  assert.equal(fs.readFileSync(path.join(dir, "assets", "icons", "lucide-signpost.svg"), "utf8"), vendoredIcon("lucide-static", "signpost"));
  // toolLogos: "Claude", "Notion", "Zapier" are named in the words
  for (const s of ["claude", "notion", "zapier"]) assert.equal(fs.readFileSync(path.join(dir, "assets", "logos", `${s}.svg`), "utf8"), vendoredIcon("simple-icons", s), s);
  assert.deepEqual(remoteRefs(fs.readFileSync(path.join(dir, "index.html"), "utf8")), []);
  // an icon the set does not have is still the same hard error, not a network try
  const bad = project("icons-bad", { style: "keynote-3", face: "build/no-face.json", beats: [{ type: "icon", at: 0.4, to: 1.2, name: "no-such-icon-x" }] });
  const rb = build(bad);
  assert.notEqual(rb.status, 0);
  assert.match(rb.stderr + rb.stdout, /no Lucide icon 'no-such-icon-x'/);
  assert.equal(attempts(), "");
});

const GOOGLE_FONTS = JSON.parse(fs.readFileSync(path.join(VENDOR, "manifest.json"), "utf8")).googleFonts;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
test("the vendored Google Fonts are intact: every file the CSS names is vendored, sha256 as recorded", () => {
  assert.deepEqual(GOOGLE_FONTS.map((e) => e.family).sort(), ["EB Garamond", "Inter"]);
  for (const e of GOOGLE_FONTS) {
    const css = fs.readFileSync(path.join(VENDOR, e.css));
    assert.equal(sha(css), e.cssSha256, e.css);
    const urls = [...new Set([...css.toString("utf8").matchAll(/https:\/\/fonts\.gstatic\.com[^)]+/g)].map((m) => m[0]))].sort();
    assert.deepEqual(e.files.map((f) => f.url).sort(), urls, `${e.family}: the CSS and the file list disagree`);
    for (const f of e.files) assert.equal(sha(fs.readFileSync(path.join(VENDOR, f.file))), f.sha256, f.file);
    for (const f of [e.license, e.sources]) assert.ok(fs.statSync(path.join(VENDOR, f)).size > 200, `${e.family}: ${f}`);
  }
});

test("the preload answers Google Fonts from vendor/, with Node's network refused", () => {
  const ebg = GOOGLE_FONTS.find((e) => e.family === "EB Garamond"), file = ebg.files[0];
  // exactly the request HyperFrames 0.8.81 makes (fetchGoogleFont), text= included
  const css = "https://fonts.googleapis.com/css2?family=EB%20Garamond:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700&text=%3C!Dd";
  const PROBE = `const c = require("node:crypto"); (async () => { const o = {};
    for (const [k, u] of Object.entries(${JSON.stringify({ css, file: file.url, unknown: "https://fonts.googleapis.com/css2?family=Montserrat%20Italic:wght@400", stray: "https://fonts.gstatic.com/s/none/v1/x.woff2" })})) {
      try { const r = await fetch(u); const b = Buffer.from(await r.arrayBuffer()); o[k] = { status: r.status, sha: c.createHash("sha256").update(b).digest("hex") }; } catch (e) { o[k] = { err: String(e.message) }; } }
    console.log(JSON.stringify(o)); })();`;
  const r = spawnSync(process.execPath, ["-e", PROBE], { encoding: "utf8", env: { ...process.env, VENDOR_OFFLINE: "1", NODE_OPTIONS: `--require "${PRELOAD}"` } });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual(o.css, { status: 200, sha: ebg.cssSha256 });
  assert.deepEqual(o.file, { status: 200, sha: file.sha256 });
  assert.equal(o.unknown.status, 400);       // what Google answers for a family it does not have
  assert.equal(o.stray.status, 404);
  assert.doesNotMatch(r.stderr, /vendor: blocked/, "a font request reached the network guard");
  assert.match(r.stderr, /vendor: font 'EB Garamond' served from vendor\/google-fonts\/eb-garamond\/v33\/fonts\.css/);
  assert.match(r.stderr, /vendor: font 'Montserrat Italic' is not vendored/);
});

const STYLES = fs.readdirSync(path.join(SKILL, "styles")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
test(`every shipped style (${STYLES.length}) builds with the network blocked and its page names no remote host but vendored ones`, { timeout: 900000 }, async () => {
  const failed = [], remote = [];
  const queue = [...STYLES];
  const worker = async () => {
    for (let style; (style = queue.shift()) !== undefined;) {
      const dir = project(`style-${style}`, { style });
      const r = await buildAsync(dir);
      if (r.status !== 0) { failed.push(`${style}: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`); continue; }
      const refs = remoteRefs(fs.readFileSync(path.join(dir, "index.html"), "utf8"));
      if (refs.length) remote.push(`${style}: ${refs.join(", ")}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))) }, worker));
  failed.sort(); remote.sort();
  assert.equal(attempts(), "", "a build tried the network");
  assert.deepEqual(remote, [], "pages that would fetch at render time");
  assert.deepEqual(failed, [], "styles that do not build offline");
});

test(`a reel renders with the network off (${CUT.how})`, { skip: CUT.argv ? false : CUT.how, timeout: 600000 }, () => {
  // editorial + a script keyword: a "Georgia" italic word, the case that rendered a different face when Google did not answer
  const dir = project("render", { style: "editorial", toolLogos: true, captions: { keywords: { week: "script", hours: "script" } } });
  assert.equal(build(dir).status, 0);
  const out = path.join(dir, "build", "offline.mp4");
  // render.mjs = runRender(): GSAP from vendor/, and it fails the render if the page used a vendored URL the preload did not serve
  const r = offline(process.execPath, [path.join(HERE, "render.mjs"), "-o", out, "--quiet"],
    { cwd: dir, env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, npm_config_offline: "true", VENDOR_OFFLINE: "1" } });
  assert.equal(r.status, 0, `offline render failed:\n${(r.stderr + r.stdout).slice(-2500)}`);
  assert.match(r.stderr, /vendor: served https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@3\.14\.2\/dist\/gsap\.min\.js/);
  assert.match(r.stderr, /vendor: font 'EB Garamond' served/);
  assert.doesNotMatch(r.stderr, /vendor: (blocked|REFUSED)|is not vendored/, "the render asked for something vendor/ does not hold");
  const dur = +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" });
  assert.ok(Math.abs(dur - SECONDS) < 0.1, `rendered ${dur} s, expected ${SECONDS}`);
});

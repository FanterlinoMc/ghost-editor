// The pixel check (references/pixel-check.md section 7): one small synthetic reel (scripts/fixtures/pixel_fixture.py,
// generated into a temp dir, never committed), clean and with ONE planted defect per rule. Each test asserts the rule,
// the severity and the frame of the worst sample. Plus: the clean reel passes with every rule checked, the same
// render checked twice gives the same report_sha256, and the DOM probe measures a real page in headless Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = process.env.PHANTASIC_PYTHON || (process.platform === "win32" ? "python" : "python3");
const CHECK = path.join(HERE, "pixel_check.py"), FIXTURE = path.join(HERE, "fixtures", "pixel_fixture.py");
const deps = spawnSync(PY, ["-c", "import numpy, cv2"], { encoding: "utf8" }).status === 0
  && /libvpx-vp9/.test(spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout || "");
const skip = deps ? false : "needs python3 with numpy + opencv and ffmpeg with libvpx-vp9";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-check-"));
// the network test's reachability check runs before any test is registered (a test's spawnSync blocks the event loop)
const { GSAP_URL, GSAP_SHA256 } = await import("./lib/runtime-libs.mjs");
let online = false;
try { online = (await fetch(GSAP_URL, { method: "HEAD", signal: AbortSignal.timeout(4000) })).ok; } catch {}
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

function check(variant, { dir = path.join(ROOT, variant), make = true } = {}) {
  if (make) {
    const g = spawnSync(PY, [FIXTURE, dir, variant], { encoding: "utf8" });
    assert.equal(g.status, 0, `fixture ${variant}: ${g.stderr}`);
  }
  const r = spawnSync(PY, [CHECK, dir, path.join(dir, "render.mov"), "--probe", "use"], {
    encoding: "utf8", env: { ...process.env, PIXEL_CHECK_TEST_DETECTIONS: path.join(dir, "build", "test_detections.json") } });
  const rep = JSON.parse(fs.readFileSync(path.join(dir, "build", "pixel_check.json"), "utf8"));
  return { code: r.status, out: r.stdout + r.stderr, rep, rule: (id) => rep.rules.find((x) => x.id === id) };
}

test("clean reel: pass, every rule checked, exit 0", { skip }, () => {
  const { code, rep } = check("clean");
  assert.equal(code, 0);
  assert.equal(rep.verdict, "pass");
  assert.deepEqual(rep.rules.map((r) => r.id), Array.from({ length: 17 }, (_, i) => `PX${i}`));
  for (const r of rep.rules) { assert.equal(r.status, "pass", `${r.id}: ${JSON.stringify(r.findings)}`); assert.ok(r.checked > 0, `${r.id} checked nothing`); }
});

test("determinism: the same render checked twice gives the same report_sha256", { skip }, () => {
  const dir = path.join(ROOT, "det");
  const a = check("clean", { dir }).rep, b = check("clean", { dir, make: false }).rep;
  assert.equal(a.report_sha256, b.report_sha256);
  const strip = (r) => { const { timing, ...rest } = r; return JSON.stringify(rest); };
  assert.equal(strip(a), strip(b));
});

// [variant, rule, severity, frame of the worst sample, other rules allowed to fire (a planted defect can be seen twice)]
const CASES = [
  ["px1", "PX1", "error", 30],      // the graphic box moved onto the face
  ["px2", "PX2", "error", 0],       // the face track shifted 100 px (a quarter-size canvas: the spec's 300 px)
  ["px3", "PX3", "error", 0, ["PX2"]],   // the face pushed off the left edge
  ["px4", "PX4", "error", 11],      // a caption block over the eyes
  ["px5", "PX5", "error", 11],      // white captions on a white card
  ["px6", "PX6", "error", 24],      // 30 px text
  ["px7", "PX7", "warn", 48],       // 32 letters in 0.6 s
  ["px8a", "PX8", "error", 53],     // a caption the page shows that the render never drew
  ["px8b", "PX8", "error", 90],     // a caption drawn over an insert inside its hidden window
  ["px9", "PX9", "error", 24],      // the caption drawn 30 px right of centre
  ["px10", "PX10", "error", 0],     // a text layer at x = -50
  ["px11", "PX11", "error", 11],    // a caption in the top UI band
  ["px12", "PX12", "error", 29],    // the graphic shown one frame early
  ["px13", "PX13", "error", 100],   // 3 black frames spliced in
  ["px14", "PX14", "error", 84],    // 1.1 s frozen inside a take
  ["px15", "PX15", "error", 60],    // take 0's b inside a word
  ["px16", "PX16", "error", 0],     // the audio driven into clipping
];
for (const [v, id, sev, frame, also = []] of CASES) {
  test(`${id} fires on its planted defect (${v}) at frame ${frame}, and nothing else does`, { skip }, () => {
    const { code, rep, rule } = check(v);
    const r = rule(id);
    assert.equal(r.status, sev, JSON.stringify(r.findings));
    const f = r.findings.find((x) => x.severity === sev);
    assert.ok(f, `${id}: no ${sev} finding`);
    assert.equal(f.frame, frame, f.message);
    assert.ok(f.message.startsWith(id + " "), f.message);
    for (const o of rep.rules) if (o.id !== id && !also.includes(o.id)) assert.equal(o.status, "pass", `${o.id} also fired: ${JSON.stringify(o.findings)}`);
    assert.equal(code, sev === "error" ? 2 : 0);
  });
}

test("PX11: the right-hand action column counts in the lower half only (safezone.mjs; owner answer 3)", { skip }, () => {
  const up = check("px11g-upper");
  assert.equal(up.rule("PX11").status, "pass", JSON.stringify(up.rule("PX11").findings));
  const low = check("px11g-lower");
  const f = low.rule("PX11").findings[0];
  assert.equal(low.rule("PX11").status, "warn");
  assert.match(f.message, /^PX11 graphic card draws \d+ px in the Instagram Reels UI zone at t=1\.000s/);
  assert.equal(f.frame, 30);
});

test("PX9 regression (CP4): bright blobs in the ink colour beside a centred caption are not the caption", { skip }, () => {
  const { rep, rule } = check("px9-blob");
  assert.equal(rep.verdict, "pass", JSON.stringify(rep.summary));
  assert.equal(rule("PX9").checked, 2);
});

test("PX5 regression (CP4): ink #808080 on a box #6e6e6e is 1.29:1, not 1.00:1", { skip }, () => {
  const { rule } = check("px5-close");
  const f = rule("PX5").findings[0];
  assert.equal(rule("PX5").status, "error");
  assert.ok(f.value >= 1.25 && f.value <= 1.35, f.message);   // truth 1.29 (WCAG on the two colours); the encode moves it a little
});

test("PX14 regression (CP4): a frozen picture over a caption change is PX14 only; caption pixel rules not checked there", { skip }, () => {
  const { rep, rule } = check("px14-caps");
  assert.equal(rule("PX14").status, "error");
  for (const o of rep.rules) if (o.id !== "PX14") assert.equal(o.status, "pass", `${o.id}: ${JSON.stringify(o.findings)}`);
  for (const id of ["PX8", "PX9"]) assert.ok((rule(id).not_checked || []).some((n) => /frame frozen or black/.test(n)), id);
});

test("PX8 clean insert: captions under a full-frame insert stay hidden", { skip }, () => {
  const { rep, rule } = check("insert");
  assert.equal(rep.verdict, "pass", JSON.stringify(rep.summary));
  assert.ok(rule("PX8").checked >= 9);
});

test("PX0: a render resized to 270x478 stops the check (exit 3, every other rule skipped)", { skip }, () => {
  const { code, rep, rule } = check("px0");
  assert.equal(code, 3);
  assert.equal(rule("PX0").status, "error");
  assert.match(rule("PX0").findings[0].message, /^PX0 render 270x478 @ 30 fps/);
  for (const r of rep.rules.slice(1)) assert.equal(r.status, "skipped");
});

test("PX0: unreadable build JSON is a PX0 error, not a crash", { skip }, () => {
  const dir = path.join(ROOT, "badjson");
  check("clean", { dir });
  fs.writeFileSync(path.join(dir, "build", "edit_truth.json"), "{ not json");
  const { code, rule } = check("clean", { dir, make: false });
  assert.equal(code, 3);
  assert.match(rule("PX0").findings[0].message, /^PX0 build\/edit_truth.json is not readable JSON/);
});

test("PX0: a geometry.json the build could not write (its error field) is reported", { skip }, () => {
  const dir = path.join(ROOT, "geoerr");
  check("clean", { dir });
  fs.writeFileSync(path.join(dir, "build", "geometry.json"), JSON.stringify({ v: 1, error: "g.L is undefined" }));
  const { code, rule } = check("clean", { dir, make: false });
  assert.equal(code, 3);
  assert.equal(rule("PX0").findings[0].message, "PX0 build/geometry.json: the build could not write it (g.L is undefined)");
});

test("PX0: a probe made for another geometry.json is stale", { skip }, () => {
  const dir = path.join(ROOT, "stale");
  check("clean", { dir });
  const gp = path.join(dir, "build", "geometry.json");
  fs.writeFileSync(gp, JSON.stringify({ ...JSON.parse(fs.readFileSync(gp, "utf8")), speech: 3.9 }));
  const { code, rule } = check("clean", { dir, make: false });
  assert.equal(code, 3);
  assert.match(rule("PX0").findings[0].message, /stale/);
});

// ---- the DOM probe on a real page in headless Chrome (skipped when the renderer's Chrome is not cached) ----
let chrome = null;
try { const b = await import("./lib/browser.mjs"); b.findPuppeteer(); chrome = b.findChrome(); } catch {}
test("pixel_probe.mjs: caption, word, graphic and text rects as Chrome lays them out, offline", { skip: chrome ? false : "no cached chrome-headless-shell / puppeteer-core" }, () => {
  const dir = path.join(ROOT, "probe");
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  // a stand-in timeline (no GSAP needed: the probe only pauses and seeks it); #g shows from t = 1
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><head><style>
    body{margin:0} #root{position:relative;width:270px;height:480px;overflow:hidden;background:#333}
    #caps{position:absolute;left:0;right:0;top:0;height:0} .cap-group{position:absolute;left:50%;transform:translateX(-50%);width:max-content;font:40px Arial;color:#fff}
    #g{position:absolute;left:20px;top:300px;width:80px;height:60px;background:#08c;visibility:hidden}
    #off{position:absolute;left:-50px;top:200px;font:20px Arial;color:#fff;white-space:nowrap}
    #card{position:absolute;inset:0;background:#000;visibility:hidden}
  </style></head><body><div id="root">
    <div id="b0" class="layer"><div id="b0-in" class="graphic"></div></div><div id="card"></div>
    <div id="off">OFF THE EDGE</div><img src="https://example.invalid/tracker.png" style="width:1px;height:1px">
    <div id="caps"><div id="cg0" class="cap-group clip" style="top:270px" data-start="0.5" data-duration="1"><span id="cg0w0" class="w">HI</span> <span id="cg0w1" class="w">YOU</span></div></div>
  </div><script>
    window.gsap = {};
    window.__timelines.main = { pause() {}, totalTime(t) { document.getElementById("b0-in").style.visibility = t >= 1 ? "visible" : "hidden"; document.getElementById("card").style.visibility = t >= 1.9 ? "visible" : "hidden"; } };
  </script></body></html>`.replace('id="b0-in" class="graphic"', 'id="b0-in" class="graphic" style="position:absolute;left:20px;top:300px;width:80px;height:60px;background:#08c"'));
  fs.writeFileSync(path.join(dir, "build", "geometry.json"), JSON.stringify({ W: 270, H: 480, fps: 30, graphics: [{ id: "card", selector: "#b0-in" }] }));
  fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify({ frames: [0, 30, 45, 60] }));
  const r = spawnSync(process.execPath, [path.join(HERE, "pixel_probe.mjs"), dir, "--frames", path.join(dir, "frames.json")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(fs.readFileSync(path.join(dir, "build", "pixel_probe.json"), "utf8"));
  assert.deepEqual(p.frames, [0, 30, 45, 60]);
  const s = p.samples;
  assert.equal(s[0].groups.length, 0, "the caption's clip is hidden before data-start");
  const g = s[30].groups[0];
  assert.equal(g.id, "cg0"); assert.equal(g.words.length, 2); assert.equal(g.words[0].color, "rgb(255, 255, 255)"); assert.equal(g.words[0].fs, 40);
  assert.ok(Math.abs(g.rect[0] + g.rect[2] / 2 - 135) < 1, `centred group ${g.rect}`);
  assert.equal(s[0].graphics.card.op, 0); assert.equal(s[30].graphics.card.op, 1); assert.deepEqual(s[30].graphics.card.rect, [20, 300, 80, 60]);
  const off = s[0].text.find((t) => t.text === "OFF THE EDGE");
  assert.ok(off && off.lines[0][0] === -50 && !off.cap, JSON.stringify(off));
  assert.ok(s[30].text.some((t) => t.cap && t.text === "HI"));
  assert.deepEqual(s[45].covers, []); assert.deepEqual(s[60].covers, ["#card"]);
  assert.deepEqual(p.refused, ["https://example.invalid/tracker.png"], "an unknown URL is aborted (and recorded)");
});

// ---- GSAP: the URL build.mjs writes, fetched by Node, sha-checked, served to Chrome; nothing else ----
const probeDir = (name, body, geo = { W: 270, H: 480, fps: 30, graphics: [] }) => {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><head><style>body{margin:0}#root{position:relative;width:270px;height:480px;overflow:hidden}</style></head><body><div id="root">${body}</div></body></html>`);
  fs.writeFileSync(path.join(dir, "build", "geometry.json"), JSON.stringify(geo));
  fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify({ frames: [0, 30] }));
  return dir;
};
const gsapPage = `<div id="b0-in" style="position:absolute;left:20px;top:300px;width:80px;height:60px;background:#08c;visibility:hidden"></div>
  <script src="${GSAP_URL}"></script>
  <script>const tl = gsap.timeline({ paused: true }); tl.fromTo("#b0-in", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.001 }, 0.999); window.__timelines.main = tl;</script>`;
const probe = (dir, env = {}) => {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, "pixel_probe.mjs"), dir, "--frames", path.join(dir, "frames.json")], { encoding: "utf8",
    env: { ...process.env, PIXEL_PROBE_VENDOR: "", PIXEL_PROBE_CACHE: fs.mkdtempSync(path.join(ROOT, "cache-")), ...env } });
  return { ...r, ms: Date.now() - t, last: (r.stderr.trim().split("\n").pop() || "") };
};
test("probe: real GSAP through the fetch path (network)", { skip: !chrome ? "no cached Chrome" : !online ? `offline: ${GSAP_URL} not reachable` : false }, () => {
  const dir = probeDir("gsap-real", gsapPage, { W: 270, H: 480, fps: 30, graphics: [{ id: "card", selector: "#b0-in" }] });
  const r = probe(dir);
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(fs.readFileSync(path.join(dir, "build", "pixel_probe.json"), "utf8"));
  assert.equal(p.samples[0].graphics.card.op, 0); assert.equal(p.samples[30].graphics.card.op, 1, "real GSAP ran the timeline");
  assert.deepEqual(p.refused, []);
});
test("probe: GSAP bytes that are not the pinned sha256 fail fast (exit 3), never served", { skip: chrome ? false : "no cached Chrome" }, () => {
  const dir = probeDir("gsap-bad", gsapPage);
  const bad = path.join(dir, "evil.js"); fs.writeFileSync(bad, "window.gsap = {}; /* not gsap */");
  const r = probe(dir, { PIXEL_PROBE_TEST_FETCH: bad });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.last, new RegExp(`fetched bytes have sha256 [0-9a-f]{64}, pinned ${GSAP_SHA256}`));
  assert.ok(r.ms < 3000, `${r.ms} ms`);
  assert.ok(!fs.existsSync(path.join(dir, "build", "pixel_probe.json")));
});
test("probe: GSAP not reachable -> 'probe unavailable' (exit 4) in about a second", { skip: chrome ? false : "no cached Chrome" }, () => {
  const r = probe(probeDir("gsap-down", gsapPage), { PIXEL_PROBE_TEST_FETCH: "fail" });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.last, /^pixel_probe: probe unavailable: https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@3\.14\.2\/dist\/gsap\.min\.js not reachable/);
  assert.ok(r.ms < 3000, `${r.ms} ms`);
});
test("probe: a remote script the probe may not fetch -> exit 4 at once; a local copy must match the sha too", { skip: chrome ? false : "no cached Chrome" }, () => {
  const r = probe(probeDir("other-cdn", `<script src="https://cdn.example.invalid/lib.js"></script>`));
  assert.equal(r.status, 4, r.stderr); assert.match(r.last, /may not fetch/); assert.ok(r.ms < 3000, `${r.ms} ms`);
  const dir = probeDir("vendor-bad", gsapPage), v = path.join(dir, "vendor");
  fs.mkdirSync(v); fs.writeFileSync(path.join(v, "g.js"), "x");
  fs.writeFileSync(path.join(v, "manifest.json"), JSON.stringify({ libraries: [{ url: GSAP_URL, file: "g.js", sha256: GSAP_SHA256 }] }));
  const r2 = probe(dir, { PIXEL_PROBE_VENDOR: v });
  assert.equal(r2.status, 3, r2.stderr); assert.match(r2.last, /PIXEL_PROBE_VENDOR has sha256/);
});
test("checker: probe unavailable -> the pixel-only rules still run, layout rules skipped with the reason", { skip: skip || (chrome ? false : "no cached Chrome") }, () => {
  const dir = path.join(ROOT, "noprobe");
  check("clean", { dir });
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><body><div id="root"></div><script src="${GSAP_URL}"></script></body></html>`);
  const r = spawnSync(PY, [CHECK, dir, path.join(dir, "render.mov")], { encoding: "utf8", env: { ...process.env, PIXEL_PROBE_TEST_FETCH: "fail", PIXEL_PROBE_VENDOR: "",
    PIXEL_PROBE_CACHE: fs.mkdtempSync(path.join(ROOT, "cache-")), PIXEL_CHECK_TEST_DETECTIONS: path.join(dir, "build", "test_detections.json") } });
  const rep = JSON.parse(fs.readFileSync(path.join(dir, "build", "pixel_check.json"), "utf8"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(rep.probe.status, "unavailable"); assert.match(rep.probe.reason, /not reachable/);
  const st = Object.fromEntries(rep.rules.map((x) => [x.id, x.status]));
  for (const id of ["PX4", "PX5", "PX6", "PX8", "PX9", "PX10"]) assert.equal(st[id], "skipped", id);
  for (const id of ["PX0", "PX1", "PX2", "PX3", "PX7", "PX11", "PX12", "PX13", "PX14", "PX15", "PX16"]) assert.equal(st[id], "pass", id);
});

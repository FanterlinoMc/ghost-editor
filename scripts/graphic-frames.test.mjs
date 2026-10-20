// graphic-frames.mjs (the frame preview CLI): real renders of a fixture box (pixels, transparency, determinism, R1),
// and the sandbox order with stubs (static refusals start nothing; root mode: host lock, sweep, home, shim, probe,
// render, release, on every path). The real tests skip where no POSIX shim / cached Chrome / hyperframes exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as GF from "./lib/graphic-frames.mjs";
import * as RR from "./lib/graphic-render.mjs";
import * as G from "./lib/graphic.mjs";
import { fetchAtRender } from "./lib/graphic-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "graphic-frames.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gf-test-"));
// a 400x200 overlay: a 40 px red box at x = round(100 t), y = 80 (so at t it covers x 100t .. 100t+39, y 80 .. 119)
const BOX = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  #box { position: absolute; left: 0; top: 0; width: 40px; height: 40px; background: #ff0000; }
</style>
</head><body>
<div id="box"></div>
<script>
  window.duration = 3;
  window.size = { w: 400, h: 200 };
  window.seek = function (t) {
    document.getElementById("box").style.transform = "translate(" + Math.round(t * 100) + "px,80px)";
  };
</script>
</body></html>
`;
const cli = (args, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 180000, env: { ...process.env, ...env } });
  const lines = String(r.stdout).trim().split("\n");
  return { status: r.status, out: JSON.parse(lines.pop()), lines, stderr: r.stderr };
};
const rgba = (file) => {
  const r = spawnSync(RR.ffmpegBin(), ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
};
const realSkip = (() => {
  if (process.platform === "win32") return "no POSIX shim on Windows";
  let exe = null;
  try { exe = RR.findChrome(); } catch (e) { return e.message; }
  if (!exe) return "no cached chrome-headless-shell";
  if (spawnSync(RR.ffmpegBin(), ["-version"]).status !== 0) return "no ffmpeg";
  try { RR.resolveHyperframes({ timeout: 60000 }); } catch (e) { return e.message; }
  return false;
})();

test("real: three exact times -> three PNGs, the box where seek(t) put it, transparent around it, ~2 s", { skip: realSkip }, () => {
  const d = tmp(), html = path.join(d, "box.html"), out = path.join(d, "out");
  fs.writeFileSync(html, BOX);
  const t0 = Date.now();
  const r = cli([html, "--w", "1080", "--h", "1920", "--at", "0.4,1.5,2.6", "--out", out]);
  const secs = (Date.now() - t0) / 1000;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.lines.length, 0, "exactly one JSON line on stdout");
  assert.deepEqual(r.out, { frames: [0.4, 1.5, 2.6].map((t) => ({ t, file: path.join(out, `f-${t}.png`) })), refused: null });
  assert.deepEqual(fs.readdirSync(out).sort(), ["f-0.4.png", "f-1.5.png", "f-2.6.png"]);
  for (const t of [0.4, 1.5, 2.6]) {
    const b = rgba(path.join(out, `f-${t}.png`)), px = (x, y) => [...b.subarray((y * 400 + x) * 4, (y * 400 + x) * 4 + 4)];
    assert.equal(b.length, 400 * 200 * 4, "rendered at window.size");
    const x0 = Math.round(t * 100);
    assert.deepEqual(px(x0 + 20, 100), [255, 0, 0, 255], `t=${t}: inside the box`);
    assert.deepEqual(px(x0, 80), [255, 0, 0, 255], `t=${t}: the box's top-left pixel`);
    assert.equal(px(x0 - 1, 100)[3], 0, `t=${t}: left of the box is transparent`);
    assert.equal(px(x0 + 40, 100)[3], 0, `t=${t}: right of the box is transparent`);
    assert.deepEqual(px(5, 5), [0, 0, 0, 0], `t=${t}: the background is fully transparent`);
  }
  console.log(`3 frames in ${secs.toFixed(2)} s`);
  assert.ok(secs < 20, `3 frames took ${secs} s`);
  // determinism: the same times again (in another order, plus t = duration) -> byte-identical PNGs
  const out2 = path.join(d, "out2");
  const r2 = cli([html, "--at", "2.6,0.4,1.5,3", "--out", out2]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(r2.out.frames.map((f) => f.t), [2.6, 0.4, 1.5, 3]);
  for (const t of [0.4, 1.5, 2.6]) assert.ok(fs.readFileSync(path.join(out, `f-${t}.png`)).equals(fs.readFileSync(path.join(out2, `f-${t}.png`))), `t=${t}: identical bytes`);
  const end = rgba(path.join(out2, "f-3.png"));
  assert.deepEqual([...end.subarray((100 * 400 + 320) * 4, (100 * 400 + 320) * 4 + 4)], [255, 0, 0, 255], "t = window.duration is rendered (box at 300..339)");
  fs.rmSync(d, { recursive: true, force: true });
});

test("real: a graphic that loads the network at render is refused (R1, renderGraphic's text), exit 2, no PNG", { skip: realSkip }, () => {
  const d = tmp(), html = path.join(d, "fetch.html"), out = path.join(d, "out");
  fs.writeFileSync(html, fetchAtRender());
  const r = cli([html, "--at", "0.5,1", "--out", out]);
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(r.out.frames, []);
  assert.match(r.out.refused, /^R1: graphic tried to load https:\/\/example\.com\/\S+ \(no network\): render refused$/);
  assert.equal(r.out.refused.slice(4), G.reason("R1", { url: r.out.refused.split(" ")[5] }));
  assert.ok(!fs.existsSync(out) || fs.readdirSync(out).length === 0, "no PNG written");
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- stubs: the sandbox order ----------
function rig({ root = false, probeOk = true, renderThrows = false, releaseOk = true, n = 3 } = {}) {
  const calls = [];
  const user = root ? { root: true, uid: 1234, gid: 5678, setpriv: "/x/setpriv" } : { root: false };
  const deps = {
    chromeUser: () => { calls.push("user"); return user; },
    findChrome: () => { calls.push("find"); return "/fake/chrome"; },
    hostLock: async (u) => { calls.push(`lock ${u.uid}`); return { release: () => calls.push("unlock") }; },
    sweepUid: (u) => { calls.push(`sweep ${u.uid}`); return { ok: true, found: [] }; },
    chromeHome: (u) => { calls.push("home"); return u.root ? "/tmp/graphic-chrome-x/home" : null; },
    chromeShim: (dir, exe, o) => { calls.push(`shim ${exe} home=${o.home} setpriv=${o.setpriv}`); return "/fake/shim"; },
    chromeVersion: () => "152.0.7977.30",
    probeNetwork: (o) => { calls.push(`probe root=${o.user.root} shim=${o.shim}`); return probeOk ? { ok: true, lines: [] } : { ok: false, lines: [], refusal: G.reason("R12", { url: "http://1.1.1.1/" }) }; },
    runRender: async (o) => {
      calls.push(`render ${o.format} fps=${o.fps} uid=${o.chromeUid} shim=${o.shim}`);
      if (renderThrows) throw new Error("boom");
      fs.mkdirSync(o.out, { recursive: true });
      for (let i = 0; i < n; i++) fs.writeFileSync(path.join(o.out, `frame_${String(i).padStart(4, "0")}.png`), `png${i}`);
      fs.writeFileSync(o.markFile, "4242\n");
      calls.push(`page ${/data-duration="(\d+)"/.exec(fs.readFileSync(path.join(o.dir, "index.html"), "utf8"))[1]}`);
      return { status: 0, secs: 0.5, log: "[BrowserManager] Browser launched (HeadlessChrome/152.0.7977.30, screenshot)\n" };
    },
    releaseChromeHome: (h, u) => { calls.push(`release ${h}`); return releaseOk ? { ok: true } : { ok: false, error: "1 process(es) of uid 1234 still alive" }; },
    flatten: (a, b) => fs.copyFileSync(a, b),
  };
  return { calls, deps };
}
const run = (deps, extra = {}) => GF.renderFrames({ content: BOX, mode: "overlay", W: 1080, H: 1920, times: [0.4, 1.5, 2.6], outDir: path.join(tmp(), "out"), ...extra }, deps);

test("stubs: a statically refused file (fetch -> G8) or a time outside 0..duration (T1) never starts Chrome", async () => {
  const s = rig();
  const r = await run(s.deps, { content: BOX.replace("window.seek = function (t) {", "window.seek = function (t) { fetch('x');") });
  assert.deepEqual([r.ok, r.frames, r.codes, r.stage], [false, [], ["G8"], "static"]);
  assert.match(r.refused, /^G8: graphic file assets\/graphics\/graphic\.html uses fetch/);
  for (const at of [[3.2], [-1], [NaN]]) {
    const t = await run(s.deps, { times: at });
    assert.deepEqual([t.codes, t.stage, t.refused], [["T1"], "static", GF.timeRefusal(at[0], 3)]);
  }
  assert.deepEqual(s.calls, [], "nothing ran, not even chromeUser");
});

test("stubs: not root -> shim, probe, ONE png-sequence render at 1 fps of N frames; files named f-<t>.png, deduped to the ms", async () => {
  const s = rig({ n: 3 });
  const outDir = path.join(tmp(), "o");
  const r = await run(s.deps, { times: [0.4, 1.5, 2.6, 0.4004], outDir });
  assert.equal(r.ok, true, r.refused);
  assert.deepEqual(r.frames, [0.4, 1.5, 2.6].map((t, i) => ({ t, file: path.join(outDir, `f-${t}.png`) })));
  assert.deepEqual(r.frames.map((f) => fs.readFileSync(f.file, "utf8")), ["png0", "png1", "png2"], "frame i -> the i-th time");
  assert.deepEqual(s.calls, ["user", "find", "home", "shim /fake/chrome home=null setpriv=null", "probe root=false shim=/fake/shim", "render png-sequence fps=1 uid=null shim=/fake/shim", "page 3"]);
});

test("stubs: root -> host lock, sweep, home, shim with home + setpriv, probe as the user, render with the uid, release + unlock on every path", async () => {
  const ok = rig({ root: true });
  assert.equal((await run(ok.deps)).ok, true);
  assert.deepEqual(ok.calls, ["user", "find", "lock 1234", "sweep 1234", "home", "shim /fake/chrome home=/tmp/graphic-chrome-x/home setpriv=/x/setpriv", "probe root=true shim=/fake/shim", "render png-sequence fps=1 uid=1234 shim=/fake/shim", "page 3", "release /tmp/graphic-chrome-x/home", "unlock"]);
  const pr = rig({ root: true, probeOk: false });
  const p = await run(pr.deps);
  assert.deepEqual([p.refused, p.stage], [`R12: ${G.reason("R12", { url: "http://1.1.1.1/" })}`, "probe"]);
  assert.deepEqual(pr.calls.slice(-2), ["release /tmp/graphic-chrome-x/home", "unlock"], "refused by the probe: released");
  assert.ok(!pr.calls.some((c) => c.startsWith("render")), "no render after a failed probe");
  const th = rig({ root: true, renderThrows: true });
  await assert.rejects(run(th.deps), /boom/);
  assert.deepEqual(th.calls.slice(-2), ["release /tmp/graphic-chrome-x/home", "unlock"], "thrown: released");
  const rl = rig({ root: true, releaseOk: false });
  const outDir = path.join(tmp(), "o");
  const u = await run(rl.deps, { outDir });
  assert.deepEqual([u.ok, u.codes, u.stage, u.frames], [false, ["R12"], "release", []]);
  assert.equal(u.refused, `R12: ${G.reason("R12c", { message: "1 process(es) of uid 1234 still alive" })}`);
  assert.deepEqual(fs.existsSync(outDir) ? fs.readdirSync(outDir) : [], [], "an unsafe release keeps no frame");
  const bad = rig();
  bad.deps.chromeUser = () => ({ root: true, error: RR.ROOT_REFUSAL });
  const b = await run(bad.deps);
  assert.deepEqual([b.refused, b.stage], [`R12: ${G.reason("R12n", { message: RR.ROOT_REFUSAL })}`, "setup"]);
});

test("stubs: a wrong frame count, no shim proof, or a failed render refuse (R10 / R13), nothing written", async () => {
  const few = rig({ n: 2 });
  const outDir = path.join(tmp(), "o");
  const r = await run(few.deps, { outDir });
  assert.deepEqual([r.codes, r.refused], [["R10"], `R10: ${G.reason("R10", { code: 0, line: "2 PNG frames for 3 times" })}`]);
  const nomark = rig();
  const orig = nomark.deps.runRender;
  nomark.deps.runRender = async (o) => { const x = await orig(o); fs.writeFileSync(o.markFile, ""); return x; };
  assert.deepEqual((await run(nomark.deps, { outDir })).codes, ["R13"]);
  assert.ok(!fs.existsSync(outDir));
});

test("framesWrapper: the time map is the first script (ahead of the integrity pre-script), the page is N frames long", () => {
  const meta = G.inspectGraphic(BOX, {}).meta;
  const page = GF.framesWrapper({ html: BOX, meta, mode: "overlay", W: 1080, H: 1920, ks: [400, 1500, 2600] });
  const first = page.indexOf("<script>");
  assert.equal(page.indexOf("var K = [400,1500,2600]"), page.indexOf("<script>\n(function () {\n  var K") + "<script>\n(function () {\n  ".length);
  assert.ok(first < page.indexOf('var err = console.error.bind(console)'), "time map before the pre-script");
  assert.match(page, /var FPS = 1000, L = 3001, IN = 0, D = 3001, AFTER = "hold"/);
  assert.match(page, /<div id="graphic-root" [^>]*data-duration="3" data-no-timeline>/);
  assert.equal((page.match(/<script>/g) || []).length, 4, "time map, pre-script, the graphic's, post-script");
});

test("CLI: usage errors exit 1 with one JSON line; refusals exit 2", () => {
  const d = tmp(), html = path.join(d, "box.html");
  fs.writeFileSync(html, BOX);
  const u = cli([html, "--out", path.join(d, "o")]);
  assert.equal(u.status, 1);
  assert.deepEqual([u.out.frames, u.out.refused], [[], null]);
  assert.match(u.out.error, /^usage:/);
  const t = cli([html, "--at", "9", "--out", path.join(d, "o")]);
  assert.deepEqual([t.status, t.out], [2, { frames: [], refused: GF.timeRefusal(9, 3) }]);
});

// Tests only (GRAPHIC_TEST_DEPS=scripts/fixtures/graphic-stub-deps.mjs): renderGraphic's external steps replaced by a
// stub that never opens the graphic. "hyperframes render" becomes an ffmpeg lavfi clip with the asked frame count
// (overlay: a half-transparent VP9 WebM with alpha; insert: an opaque H.264 MP4), 64 px square to stay fast. The
// Chrome version is "0.0.0-stub", so a stubbed file never shares a cache key with a real render. Each stubbed render
// appends one line "<out basename>" to $GRAPHIC_STUB_COUNT when that is set (tests count renders).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const V = "0.0.0-stub";
const frames = (dir) => { const m = /data-duration="([\d.]+)"/.exec(fs.readFileSync(path.join(dir, "index.html"), "utf8")); return m ? +m[1] : 1; };
export const deps = {
  findChrome: () => "/stub/chrome",
  chromeShim: () => "/stub/shim",
  chromeVersion: () => V,
  ffmpegVersion: () => "0.0-stub",
  probeNetwork: () => ({ ok: true, lines: ["probe: stubbed"] }),
  runRender: async ({ dir, out, mode, fps, markFile }) => {
    const L = Math.round(frames(dir) * fps);
    const common = ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x33cc66@0.5:s=64x64:r=${fps}`, "-frames:v", String(L)];
    if (mode === "insert") execFileSync("ffmpeg", [...common, "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
    else execFileSync("ffmpeg", [...common, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-deadline", "realtime", "-cpu-used", "8", "-auto-alt-ref", "0", out]);
    fs.writeFileSync(markFile, "4242\n");
    if (process.env.GRAPHIC_STUB_COUNT) fs.appendFileSync(process.env.GRAPHIC_STUB_COUNT, path.basename(out) + "\n");
    return { status: 0, secs: 0.1, log: `[BrowserManager] Browser launched (HeadlessChrome/${V}, screenshot)\n` };
  },
};

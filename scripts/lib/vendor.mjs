// Vendored runtime libraries (vendor/manifest.json). The page keeps the CDN <script src> (it is part of every golden
// reel's hashed index.html); a render gets the bytes from vendor/ instead:
//   - runRender(): THE way the fork runs `hyperframes render`. It preloads scripts/vendor-offline.cjs (which answers
//     hyperframes' fetch() of a manifest URL with the vendored file, sha256-checked) and FAILS the render when the page
//     references a manifest URL that the preload did not report serving: a render can never quietly use the CDN.
//     Python callers go through scripts/render.mjs, the CLI for it.
//   - serveVendoredInPage(): the same for a puppeteer page the fork drives itself (motion-determinism, motion-cost).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VENDOR = path.join(SKILL, "vendor");
export const HYPERFRAMES = "0.8.81";   // engine/tests/common.py HYPERFRAMES_VERSION
// forward slashes: NODE_OPTIONS reads a backslash inside quotes as an escape (Windows takes either)
export const PRELOAD = path.join(SKILL, "scripts", "vendor-offline.cjs").split(path.sep).join("/");
export const MARK = "vendor: served";
export const LIBRARIES = JSON.parse(fs.readFileSync(path.join(VENDOR, "manifest.json"), "utf8")).libraries;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// the vendored bytes of a manifest entry, sha256-checked; throws when missing or altered (never a silent CDN fallback)
export function vendoredBytes(e) {
  const p = path.join(VENDOR, e.file);
  const b = fs.existsSync(p) ? fs.readFileSync(p) : null;
  if (!b || sha(b) !== e.sha256) throw new Error(`vendored ${e.name} ${e.version} missing or altered: vendor/${e.file} (sha256 must be ${e.sha256})`);
  return b;
}

// env for a `hyperframes render` child: the vendor preload added to NODE_OPTIONS
export const renderEnv = (env = process.env) => ({ ...env, NODE_OPTIONS: `${env.NODE_OPTIONS || ""} --require "${PRELOAD}"`.trim() });

// the manifest URLs the page uses that the render's stderr does not show the preload serving (empty = all local)
export const unservedUrls = (html, stderr) => LIBRARIES.filter((e) => html.includes(e.url) && !stderr.includes(`${MARK} ${e.url}`)).map((e) => e.url);

// Run `npx hyperframes@<pin> render <args>` in cwd with the preload. Returns { status, stdout, stderr, error };
// status is 1 with `error` set when the page (cwd/index.html, or the -c composition) is missing (nothing is run), or
// uses a vendored URL the preload did not serve; then the -o/--output file is deleted. spawn is injectable for tests.
export function runRender(args, { cwd = process.cwd(), version = HYPERFRAMES, env = process.env, spawn = spawnSync } = {}) {
  const ci = args.findIndex((a) => a === "-c" || a === "--composition");
  const page = path.resolve(cwd, ci >= 0 ? args[ci + 1] ?? "" : "index.html");
  if (!fs.existsSync(page) || !fs.statSync(page).isFile()) return { status: 1, stdout: "", stderr: "", error: `no page to render: ${page}` };
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "npx", "-y", `hyperframes@${version}`, "render", ...args]] : ["npx", ["-y", `hyperframes@${version}`, "render", ...args]];
  const r = spawn(cmd[0], cmd[1], { cwd, env: renderEnv(env), encoding: "utf8", maxBuffer: 1 << 28 });
  const out = { status: r.status ?? 1, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), error: r.error ? String(r.error.message || r.error) : "" };
  if (out.status !== 0) return out;
  const html = fs.readFileSync(page, "utf8");
  const missed = unservedUrls(html, out.stderr);
  if (missed.length) {
    // the reel may be complete (Chrome fetched the library from the CDN itself): never leave it where a caller looks
    const oi = args.findIndex((a) => a === "-o" || a === "--output");
    const output = oi >= 0 && args[oi + 1] ? path.resolve(cwd, args[oi + 1]) : null;
    const removed = output && fs.existsSync(output) ? (fs.rmSync(output, { force: true }), true) : false;
    Object.assign(out, { status: 1, error: `not served from vendor/: ${missed.join(", ")} (${out.stderr.includes("vendor: REFUSED") ? "its vendored copy is missing or altered, so the preload refused it" : "the vendor preload (scripts/vendor-offline.cjs) did not serve it: the CDN was used"})${removed ? `; the output ${output} was removed` : ""}` });
  }
  return out;
}

// Puppeteer: answer the page's requests for manifest URLs with the vendored bytes (Chrome would load them from the
// CDN); everything else goes through untouched.
export async function serveVendoredInPage(page) {
  const byUrl = new Map(LIBRARIES.map((e) => [e.url, vendoredBytes(e)]));
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.isInterceptResolutionHandled?.()) return;
    const body = byUrl.get(req.url());
    if (body) req.respond({ status: 200, contentType: "application/javascript; charset=utf-8", body });
    else req.continue();
  });
}

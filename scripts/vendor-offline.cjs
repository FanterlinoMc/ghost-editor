// Preloaded (node --require) into `hyperframes render` so a render never fetches a library from a CDN.
// build.mjs writes <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"> (that exact tag is in
// every golden reel's index.html, so it stays), and hyperframes' compiler downloads each http(s) <script src> with
// the global fetch() and inlines it. This preload answers fetch() for every URL in vendor/manifest.json with the
// vendored bytes: first the copy build.mjs put in the project (assets/vendor/...), then the fork's vendor/ folder,
// each only if its sha256 matches the manifest. Each URL it serves prints MARK on stderr, so a caller can tell.
//   VENDOR_OFFLINE=1  also refuse every other non-loopback http(s) fetch (tests; proving a render needs no network)
// Otherwise an unvendored CDN URL still goes to the network, with a warning on stderr.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MARK = "vendor: served";
const VENDOR = path.join(__dirname, "..", "vendor");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(VENDOR, "manifest.json"), "utf8")).libraries;
const BY_URL = new Map(MANIFEST.map((e) => [e.url, e]));
const CDN = /^https?:\/\/([a-z0-9-]+\.)*(jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|googleapis\.com|gstatic\.com|esm\.sh|skypack\.dev)\//i;
const LOOPBACK = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?\//i;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// the vendored bytes for a manifest entry, or null: the project's copy first, then the fork's, sha256-checked
function resolveLocal(entry, cwd = process.cwd()) {
  for (const p of [path.resolve(cwd, entry.project), path.join(VENDOR, entry.file)]) {
    let b;
    try { b = fs.readFileSync(p); } catch { continue; }
    if (sha(b) === entry.sha256) return { path: p, bytes: b };
    process.stderr.write(`vendor: WARNING ${p} does not match the sha256 in vendor/manifest.json, ignored\n`);
  }
  return null;
}
module.exports = { MARK, MANIFEST, resolveLocal };

const urlOf = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url) || "";
const real = globalThis.fetch;
if (typeof real === "function" && !real.__vendorOffline) {
  const offline = process.env.VENDOR_OFFLINE === "1";
  const patched = async function fetch(input, init) {
    const url = urlOf(input);
    const entry = BY_URL.get(url);
    if (entry) {
      const hit = resolveLocal(entry);
      if (hit) {
        process.stderr.write(`${MARK} ${url} from ${hit.path}\n`);
        return new Response(hit.bytes, { status: 200, headers: { "content-type": "application/javascript; charset=utf-8" } });
      }
      process.stderr.write(`vendor: WARNING no valid local copy of ${url}\n`);
    }
    if (/^https?:/i.test(url) && !LOOPBACK.test(url)) {
      if (offline) {
        process.stderr.write(`vendor: blocked ${url} (VENDOR_OFFLINE=1)\n`);
        throw new TypeError(`VENDOR_OFFLINE: network fetch refused: ${url}`);
      }
      if (CDN.test(url)) process.stderr.write(`vendor: WARNING ${url} is not vendored (vendor/manifest.json), fetching it from the network\n`);
    }
    return real.call(this, input, init);
  };
  patched.__vendorOffline = true;
  globalThis.fetch = patched;
}

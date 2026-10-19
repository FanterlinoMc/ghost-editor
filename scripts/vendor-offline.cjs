// Preloaded (node --require) into `hyperframes render` by scripts/lib/vendor.mjs runRender() (CLI: scripts/render.mjs).
// build.mjs writes <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"> (that exact tag is in every
// golden reel's hashed index.html, so it stays). hyperframes' compiler downloads each http(s) <script src> with the
// global fetch() and inlines it into the page Chrome renders. This preload answers fetch() for every URL in
// vendor/manifest.json with the fork's vendor/ copy, sha256-checked, and prints MARK + the URL on stderr; runRender()
// fails the render when the page uses such a URL and MARK is missing. A manifest URL whose local copy is missing or
// altered is refused (fail closed), never fetched from the network.
//   VENDOR_OFFLINE=1  also refuse every other non-loopback fetch() in this Node process (tests, diagnosis). It covers
//                     Node only: a script tag hyperframes failed to inline would still be loaded by Chrome itself.
// Otherwise an unvendored CDN script URL still goes to the network, with a warning on stderr.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MARK = "vendor: served";
const VENDOR = path.join(__dirname, "..", "vendor");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(VENDOR, "manifest.json"), "utf8")).libraries;
const BY_URL = new Map(MANIFEST.map((e) => [e.url, e]));
const CDN = /^https?:\/\/([a-z0-9-]+\.)*(jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev)\//i;
const LOOPBACK = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?\//i;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
module.exports = { MARK, MANIFEST };

const urlOf = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url) || "";
const real = globalThis.fetch;
if (typeof real === "function" && !real.__vendorOffline) {
  const offline = process.env.VENDOR_OFFLINE === "1";
  const patched = async function fetch(input, init) {
    const url = urlOf(input);
    const entry = BY_URL.get(url);
    if (entry) {
      const p = path.join(VENDOR, entry.file);
      let b = null;
      try { b = fs.readFileSync(p); } catch {}
      if (!b || sha(b) !== entry.sha256) {
        process.stderr.write(`vendor: REFUSED ${url}: ${p} is missing or does not match its sha256 in vendor/manifest.json\n`);
        throw new TypeError(`vendor: no valid local copy of ${url} (fail closed, not fetched from the network)`);
      }
      process.stderr.write(`${MARK} ${url} from vendor/${entry.file}\n`);
      return new Response(b, { status: 200, headers: { "content-type": "application/javascript; charset=utf-8" } });
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

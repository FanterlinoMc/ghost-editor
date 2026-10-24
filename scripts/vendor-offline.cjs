// Preloaded (node --require) into `hyperframes render` by scripts/lib/vendor.mjs runRender() (CLI: scripts/render.mjs).
// build.mjs writes <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"> (that exact tag is in every
// golden reel's hashed index.html, so it stays). hyperframes' compiler downloads each http(s) <script src> with the
// global fetch() and inlines it into the page Chrome renders. This preload answers fetch() for every URL in
// vendor/manifest.json with the fork's vendor/ copy, sha256-checked, and prints MARK + the URL on stderr; runRender()
// fails the render when the page uses such a URL and MARK is missing. A manifest URL whose local copy is missing or
// altered is refused (fail closed): it is answered with a script that throws, so neither Node nor Chrome fetches it.
//   VENDOR_OFFLINE=1  also refuse every other non-loopback fetch() in this Node process (tests, diagnosis). It covers
//                     Node only: a script tag hyperframes failed to inline would still be loaded by Chrome itself.
// Otherwise an unvendored CDN script URL still goes to the network, with a warning on stderr.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MARK = "vendor: served";
const REFUSED = "vendor: REFUSED";
const VENDOR = path.join(__dirname, "..", "vendor");
const MANIFEST_ALL = JSON.parse(fs.readFileSync(path.join(VENDOR, "manifest.json"), "utf8"));
const MANIFEST = MANIFEST_ALL.libraries;
// Google Fonts (mac-60). HyperFrames' compiler maps a system family the page names (Georgia -> EB Garamond, Arial ->
// Inter, ...) onto its bundled fonts and fetch()es fonts.googleapis.com/css2 for the faces its bundle lacks (italics,
// other weights, other scripts), then each fonts.gstatic.com file the CSS names. Measured: every shipped style makes
// that request, and a script keyword ("Georgia" italic) renders a different face and moves its line when Google does
// not answer. So both hosts are answered here, always (not only under VENDOR_OFFLINE): a vendored family gets
// Google's own CSS and woff2 bytes from vendor/google-fonts (sha256-checked), a family that is not vendored gets the
// 400 Google gives an unknown family (the renderer then keeps its bundle), and the network is never asked.
const GF = MANIFEST_ALL.googleFonts || [];
const GF_BY_FAMILY = new Map(GF.map((e) => [e.family.toLowerCase(), e]));
const GF_BY_URL = new Map(GF.flatMap((e) => e.files.map((f) => [f.url, f])));
const GF_CSS = /^https:\/\/fonts\.googleapis\.com\/css2?\?/i, GF_FILE = /^https:\/\/fonts\.gstatic\.com\//i;
const FONT_MARK = "vendor: font";
const BY_URL = new Map(MANIFEST.map((e) => [e.url, e]));
const CDN = /^https?:\/\/([a-z0-9-]+\.)*(jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev)\//i;
const LOOPBACK = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?\//i;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
module.exports = { MARK, MANIFEST, FONT_MARK };

function vendoredFile(rel, want) {
  let b = null;
  try { b = fs.readFileSync(path.join(VENDOR, rel)); } catch {}
  return b && sha(b) === want ? b : null;
}
// fonts.googleapis.com/css2?family=A:...&family=B:... -> one Response, never the network
function googleCss(url) {
  const fams = new URL(url).searchParams.getAll("family").map((f) => f.split(":")[0].replace(/\+/g, " ").trim());
  const parts = [];
  for (const fam of fams) {
    const e = GF_BY_FAMILY.get(fam.toLowerCase());
    const css = e && vendoredFile(e.css, e.cssSha256);
    if (!e) { process.stderr.write(`${FONT_MARK} '${fam}' is not vendored (vendor/google-fonts): answered 400, the renderer keeps its bundled faces\n`); continue; }
    if (!css) { process.stderr.write(`${REFUSED} font '${fam}': vendor/${e.css} is missing or does not match its sha256\n`); continue; }
    process.stderr.write(`${FONT_MARK} '${fam}' served from vendor/${e.css}\n`);
    parts.push(css.toString("utf8"));
  }
  if (!parts.length) return new Response("<!-- vendor-offline: no vendored family -->", { status: 400, headers: { "content-type": "text/html" } });
  return new Response(parts.join("\n"), { status: 200, headers: { "content-type": "text/css; charset=utf-8" } });
}
function googleFile(url) {
  const f = GF_BY_URL.get(url.split("#")[0]);
  const b = f && vendoredFile(f.file, f.sha256);
  if (!b) {
    process.stderr.write(`${REFUSED} font file ${url}: ${f ? `vendor/${f.file} is missing or altered` : "not in vendor/google-fonts"} (never fetched)\n`);
    return new Response("", { status: 404 });
  }
  return new Response(b, { status: 200, headers: { "content-type": "font/woff2" } });
}

const urlOf = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url) || "";
const real = globalThis.fetch;
if (typeof real === "function" && !real.__vendorOffline) {
  const offline = process.env.VENDOR_OFFLINE === "1";
  const patched = async function fetch(input, init) {
    const url = urlOf(input);
    if (GF_CSS.test(url)) return googleCss(url);
    if (GF_FILE.test(url)) return googleFile(url);
    const entry = BY_URL.get(url);
    if (entry) {
      const p = path.join(VENDOR, entry.file);
      let b = null;
      try { b = fs.readFileSync(p); } catch {}
      if (!b || sha(b) !== entry.sha256) {
        process.stderr.write(`${REFUSED} ${url}: ${p} is missing or does not match its sha256 in vendor/manifest.json\n`);
        // Fail closed. Throwing here is not enough: hyperframes would keep the <script src> and Chrome would load it
        // from the CDN itself. So the page gets a script that cannot be satisfied: it throws, the library never loads,
        // and runRender() (no MARK) fails the render and removes its output.
        return new Response(`/* ${REFUSED} ${url} */\nthrow new Error(${JSON.stringify(`${REFUSED} ${url}: no valid local copy (fail closed)`)});\n`,
          { status: 200, headers: { "content-type": "application/javascript; charset=utf-8" } });
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

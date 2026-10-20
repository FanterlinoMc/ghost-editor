#!/usr/bin/env node
// The network lock, measured (PM2; real renders, NOT in the gate):
//   node scripts/graphic-isolation-check.mjs [--baseline] [--no-trap] [--only <route prefix>] [--lock PATH]
// Opens a TCP + UDP listener on this machine's NON-loopback IPv4 address (loopback stays open by design), then renders
// one wrapper page per network route through `hyperframes render` with the Chrome shim (CHROME_FLAGS), the CSP and the
// Node preload, exactly as renderGraphic does, and counts what reaches the listener. The routes bypass the static scan
// on purpose (the scan is hygiene; the lock is what must hold). --baseline also renders each route WITHOUT the shim,
// to show the route is real. Then the R12 probe, with the listener's URL added: through the shim it must fail, through
// the bare Chrome the listener must see it. Exit 0 only if every route had 0 hits through the shim and the probe behaved.
// "Bare" is a shim without the lock flags (chromeShim lock: false): the same launch otherwise, so as root it is the same
// setpriv drop to GRAPHIC_CHROME_UID (a root Chrome would not start at all and the baseline would be vacuous).
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import dgram from "node:dgram";
import path from "node:path";
import { wrapperHtml, graphicFrames } from "./lib/graphic.mjs";
import { holdRenderLock } from "./lib/graphic-lock.mjs";
import { runRender, chromeShim, chromeUser, chromeHome, findChrome, probeNetwork, sandboxLauncher, scanLog, PROBE_URLS } from "./lib/graphic-render.mjs";

holdRenderLock(); // --lock <path> / GRAPHIC_RENDER_LOCK: re-run under lockf / flock (the shared Mac)
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
if (!ip) { console.log("no non-loopback IPv4 address: cannot run"); process.exit(2); }

// the listener: every TCP connection and UDP datagram, from anyone
const hits = [];
const tcp = net.createServer((s) => { let first = ""; s.once("data", (d) => { first = String(d).split("\r\n")[0].slice(0, 80); hits.push(`TCP ${first}`); s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"); }); s.on("error", () => {}); setTimeout(() => { if (!first) hits.push("TCP (connect, no data)"); s.destroy(); }, 1500); });
await new Promise((r) => tcp.listen(0, ip, r));
const port = tcp.address().port;
const udp = dgram.createSocket("udp4");
udp.on("message", (m) => hits.push(`UDP ${m.length} bytes`));
await new Promise((r) => udp.bind(port, ip, r));
const U = `http://${ip}:${port}`;
// a second listener on LOOPBACK (another service on the render host): only HyperFrames' own server may be reachable
const mkTcp = () => net.createServer((s) => { s.once("data", (d) => { hits.push(`LOOPBACK TCP ${String(d).split("\r\n")[0].slice(0, 60)}`); s.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n"); }); s.on("error", () => {}); });
const lo4 = mkTcp();
await new Promise((r) => lo4.listen(0, "127.0.0.1", r));
const lport = lo4.address().port;
const lo6 = mkTcp();
await new Promise((r) => lo6.listen(lport, "::1", r).on("error", () => r()));
const L = `http://localhost:${lport}`;
console.log(`listener ${ip}:${port} (TCP + UDP), loopback listener localhost:${lport} (127.0.0.1 + ::1)`);

const host = `${os.hostname()}`;
const R = (name, code, markup = "") => [name, code, markup];
const ROUTES = [
  R("location= (IP literal)", `location.href = "${U}/nav";`),
  R("location= (host name)", `location.href = "http://${host}:${port}/navhost";`),
  R("script <a> + click", `var a = document.createElement("a"); a.href = "${U}/a"; document.body.appendChild(a); a.click();`),
  R("static <a> + click", `document.getElementById("sa").click();`, `<a id="sa" href="${U}/sa">x</a>`),
  R("open()", `window.open("${U}/open");`),
  R("form POST", `var f = document.createElement("form"); f.method = "post"; f.action = "${U}/form"; document.body.appendChild(f); f.submit();`),
  R("meta refresh inserted", `var m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=${U}/refresh"; document.head.appendChild(m);`),
  R("STUN", `var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:${ip}:${port}" }] }); pc.createDataChannel("x"); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });`),
  R("TURN over UDP", `var pc = new RTCPeerConnection({ iceServers: [{ urls: "turn:${ip}:${port}?transport=udp", username: "u", credential: "p" }] }); pc.createDataChannel("x"); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });`),
  R("TURN over TCP", `var pc = new RTCPeerConnection({ iceServers: [{ urls: "turn:${ip}:${port}?transport=tcp", username: "u", credential: "p" }] }); pc.createDataChannel("x"); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });`),
  R("fetch (LAN IP literal)", `fetch("${U}/fetch", { mode: "no-cors" }).catch(function () {});`),
  R("fetch 169.254.169.254", `fetch("http://169.254.169.254/latest/meta-data/", { mode: "no-cors" }).catch(function () {});`),
  R("new Image (LAN IP literal)", `new Image().src = "${U}/img";`),
  R("innerHTML img", `document.body.insertAdjacentHTML("beforeend", '<img src="${U}/inner">');`),
  R("image-set", `document.body.style.backgroundImage = 'image-set("${U}/iset" 1x)';`),
  R("document.write script", `document.write('<script src="${U}/dw.js"><\\/script>');`),
  R("srcdoc iframe", `var fr = document.createElement("iframe"); fr.srcdoc = '<img src="${U}/srcdoc">'; document.body.appendChild(fr);`),
  R("sendBeacon", `navigator.sendBeacon("${U}/beacon", "x");`),
  R("constructor eval", `[].constructor.constructor('fetch("${U}/ctor")')();`),
  R("@font-face url", `var st = document.createElement("style"); st.textContent = '@font-face { font-family: X; src: url(${U}/font.woff2); } body { font-family: X; }'; document.head.appendChild(st); document.body.insertAdjacentHTML("beforeend", "<p>font</p>");`),
  R("SVG <image>", `document.body.insertAdjacentHTML("beforeend", '<svg><image href="${U}/svgimg" width="10" height="10"/></svg>');`),
  R("prefetch", `var l = document.createElement("link"); l.rel = "prefetch"; l.href = "${U}/prefetch"; document.head.appendChild(l);`),
  R("preload", `var l = document.createElement("link"); l.rel = "preload"; l.as = "image"; l.href = "${U}/preload"; document.head.appendChild(l);`),
  R("WebSocket", `new WebSocket("ws://${ip}:${port}/ws");`),
  R("dns-prefetch", `var l = document.createElement("link"); l.rel = "dns-prefetch"; l.href = "http://${host}:${port}/"; document.head.appendChild(l);`),
  R("CSS @import", `var st = document.createElement("style"); st.textContent = '@import url("${U}/import.css");'; document.head.appendChild(st);`),
  R("loopback: location= localhost", `location.href = "${L}/nav";`),
  R("loopback: location= 127.0.0.1", `location.href = "http://127.0.0.1:${lport}/nav4";`),
  R("loopback: open() localhost", `window.open("${L}/open");`),
  R("loopback: script <a> + click", `var a = document.createElement("a"); a.href = "${L}/a"; document.body.appendChild(a); a.click();`),
  R("loopback: fetch", `fetch("${L}/fetch", { mode: "no-cors" }).catch(function () {});`),
  R("loopback: new Image", `new Image().src = "${L}/img";`),
  R("loopback: WebSocket", `new WebSocket("ws://localhost:${lport}/ws");`),
  R("loopback: TURN over TCP", `var pc = new RTCPeerConnection({ iceServers: [{ urls: "turn:127.0.0.1:${lport}?transport=tcp", username: "u", credential: "p" }] }); pc.createDataChannel("x"); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });`),
].filter(([n]) => !only || n.startsWith(only));

const graphic = (code, markup = "") => `<!doctype html><html><head><meta charset="utf-8"></head><body>${markup}<div id="b" style="position:absolute;width:80px;height:80px;background:#f2c14e"></div>
<script>
  window.duration = 1; window.size = { w: 320, h: 320 };
  var fired = false;
  window.seek = function (t) {
    document.getElementById("b").style.transform = "translateX(" + (t * 200) + "px)";
    if (t >= 0.3 && !fired) { fired = true; try { ${code} } catch (e) {} }
  };
</script></body></html>`;

const user = chromeUser();
if (user.error) { console.log(`GRAPHIC ISOLATION: FAIL  (${user.error})`); process.exit(1); }
console.log(user.root ? `running as root: Chrome dropped to ${user.uid}:${user.gid} with ${user.setpriv}` : "not root: Chrome runs as this user");
let chrome, shim, bareShim, home = null;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-isolation-"));
const dropHome = () => { if (home) fs.rmSync(home, { recursive: true, force: true }); };
try {
  chrome = findChrome();
  home = chromeHome(user); // root: the dropped Chrome's home, under os.tmpdir(); null otherwise
  shim = chromeShim(path.join(work, "shim"), chrome, { home });
  bareShim = chromeShim(path.join(work, "bare"), chrome, { lock: false, home });
} catch (e) { dropHome(); console.log(`GRAPHIC ISOLATION: FAIL  (${e.message})`); process.exit(1); }
if (!shim) { console.log("GRAPHIC ISOLATION: FAIL  (no chrome-headless-shell, or no POSIX shim)"); process.exit(1); }
const launcher = sandboxLauncher();
const fps = 30, meta = { duration: 1, size: { w: 320, h: 320 }, fonts: [], media: [] };
const fr = graphicFrames({ duration: 1, fps });
const settle = () => new Promise((r) => setTimeout(r, 1500));
const rows = [];
let leaks = 0;
for (const [name, code, markup] of ROUTES) {
  const row = { name };
  for (const variant of args.includes("--baseline") ? ["bare", "shim"] : ["shim"]) {
    const dir = path.join(work, `${rows.length}-${variant}`);
    fs.mkdirSync(dir, { recursive: true });
    let page = wrapperHtml({ html: graphic(code, markup), meta, mode: "overlay", fps, L: fr.L, inF: 0, D: fr.D, after: "hold", W: 320, H: 320 });
    // --no-trap: without the bridge's navigation trap (which cancels page-started navigations), so the shim alone is measured
    if (args.includes("--no-trap")) page = page.replace(`add.call(window.navigation, "navigate"`, `(function () {})(window.navigation, "navigate"`);
    fs.writeFileSync(path.join(dir, "index.html"), page);
    hits.length = 0;
    const r = await runRender({ dir, out: path.join(dir, "out.webm"), mode: "overlay", fps, workers: null, launcher, shim: variant === "shim" ? shim : bareShim, logFile: path.join(dir, "render.log") });
    await settle();
    const refused = scanLog(r.log).map((x) => x.code);
    row[variant] = { hits: [...hits], exit: r.status, refused: [...new Set(refused)] };
    if (variant === "shim" && hits.length) leaks++;
  }
  rows.push(row);
  const f = (v) => (v ? `${String(v.hits.length).padStart(2)} hit(s) exit ${v.exit} ${v.refused.join(",") || "-"}${v.hits.length ? "  [" + v.hits.slice(0, 3).join("; ") + "]" : ""}` : "");
  console.log(`${name.padEnd(28)} ${row.bare ? "bare: " + f(row.bare).padEnd(60) : ""} shim: ${f(row.shim)}`);
}

// the R12 probe, with the listener's URL added
const probeUrls = [...PROBE_URLS, `${U}/probe`];
hits.length = 0;
const pShim = probeNetwork({ launcher, shim, urls: probeUrls, user });
await settle();
const shimProbeHits = hits.length;
hits.length = 0;
const pBare = probeNetwork({ launcher, shim: bareShim, urls: probeUrls, user });
await settle();
const bareReached = hits.some((h) => h.startsWith("TCP")); // the listener saw the bare Chrome: the baseline really ran
console.log(`probe through the shim: ${pShim.ok ? "PASS (all failed)" : "REFUSED: " + pShim.refusal}; listener hits ${shimProbeHits}`);
pShim.lines.forEach((l) => console.log("  " + l));
console.log(`probe through the bare Chrome: ${pBare.ok ? "PASS (all failed: the probe would be vacuous here)" : bareReached ? "REFUSED (expected, the listener was reached): " + pBare.refusal : "REFUSED, but the listener was NOT reached (the baseline did not run): " + pBare.refusal}; listener hits ${hits.length}`);
pBare.lines.forEach((l) => console.log("  " + l));
tcp.close(); udp.close(); lo4.close(); lo6.close();
dropHome();
const ok = leaks === 0 && pShim.ok && shimProbeHits === 0 && !pBare.ok && bareReached;
console.log(`routes through the shim with hits: ${leaks} of ${ROUTES.length}`);
console.log(`GRAPHIC ISOLATION: ${ok ? "PASS" : "FAIL"}  (work dir ${work})`);
process.exit(ok ? 0 : 1);

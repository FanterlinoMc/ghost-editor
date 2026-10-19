// Preloaded (node --require, via NODE_OPTIONS) into the `hyperframes render` of a Prompt Motion graphic by
// scripts/lib/graphic-render.mjs. It makes every NON-loopback network call of that Node process fail closed and
// prints one line per attempt on stderr:  vendor: blocked <url>
// The render wrapper reads that line as R1 ("graphic tried to load <url> (no network): render refused").
// Why: HyperFrames' compiler runs in Node before Chrome and downloads remote <img src>, CSS url(), media and
// Google Fonts itself (global fetch, and https.get for its downloader). Chrome's side is closed by the wrapper's CSP.
// Covered: globalThis.fetch, http/https request+get, net.connect/createConnection, net.Socket.prototype.connect (the
// path every TCP client takes, http.ClientRequest's agent sockets included), tls.connect (named ESM imports of the
// builtins are re-synced with syncBuiltinESMExports).
// NOT covered, and why the render path does not need it: dgram (UDP; hyperframes' render opens none), dns lookups
// (resolve only, no payload leaves except the query; Chrome's own DNS is closed by the shim's resolver rule),
// child_process (hyperframes spawns ffmpeg/ffprobe and Chrome: ffmpeg only reads local frames; Chrome is locked by
// the shim; a child node process inherits NODE_OPTIONS and so this preload), worker_threads (inherit the preload via
// NODE_OPTIONS execArgv). The graphic itself never runs in Node: only in Chrome, behind the shim and the CSP. Loopback (127.0.0.0/8, ::1, localhost) and unix sockets stay
// open: HyperFrames serves the page and talks to Chrome over them. GSAP-free: no vendor/ manifest is read.
// npm/npx themselves (package resolution, not render content) are not armed: the preload only arms in the process
// that is not npm's CLI (npx spawns hyperframes as a child node process, which inherits NODE_OPTIONS).
"use strict";
const MARK = "vendor: blocked";
module.exports = { MARK };
const isNpm = /[\\/](npm|npx)-cli\.js$|[\\/]npm[\\/]bin[\\/]|[\\/]bin[\\/]np[mx]$/.test(process.argv[1] || "");
if (!globalThis.__graphicOffline && !isNpm) {
  globalThis.__graphicOffline = true;
  const LOOP_HOST = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0)$/i;
  const say = (url) => { try { process.stderr.write(`${MARK} ${url}\n`); } catch {} };
  const refuse = (url) => { say(url); const e = new Error(`offline-preload: network refused: ${url}`); e.code = "ECONNREFUSED"; return e; };

  // fetch
  const realFetch = globalThis.fetch;
  if (typeof realFetch === "function") {
    globalThis.fetch = async function fetch(input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || String(input);
      let host = "";
      try { const u = new URL(url); if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "file:") return realFetch.call(this, input, init); host = u.hostname; } catch {}
      if (!LOOP_HOST.test(host)) throw new TypeError("fetch failed", { cause: refuse(url) });
      return realFetch.call(this, input, init);
    };
  }

  // http / https
  const urlOfArgs = (proto, a, b) => {
    if (typeof a === "string" || a instanceof URL) { try { const u = new URL(String(a)); return { url: u.href, host: u.hostname }; } catch { return { url: String(a), host: "" }; } }
    const o = a || {};
    if (o.socketPath) return { url: `unix:${o.socketPath}`, host: "localhost" };
    const host = o.hostname || (o.host || "localhost").replace(/:\d+$/, "");
    return { url: `${proto}//${host}${o.port ? ":" + o.port : ""}${o.path || "/"}`, host };
  };
  for (const name of ["http", "https"]) {
    const mod = require(name);
    for (const fn of ["request", "get"]) {
      const real = mod[fn];
      mod[fn] = function (a, b, c) {
        const { url, host } = urlOfArgs(name + ":", a, b);
        if (!LOOP_HOST.test(host)) {
          const err = refuse(url);
          const { EventEmitter } = require("events");
          const fake = new EventEmitter();
          for (const m of ["end", "write", "setTimeout", "setHeader", "setNoDelay", "destroy", "abort"]) fake[m] = () => fake;
          process.nextTick(() => fake.emit("error", err));
          return fake;
        }
        return real.apply(this, arguments);
      };
    }
  }

  // raw sockets (what the above may miss)
  const net = require("net");
  const hostOfNet = (a, b) => {
    if (Array.isArray(a)) a = a[0];
    if (a && typeof a === "object") return a.path ? "localhost" : a.host || "localhost";
    if (typeof a === "string" && !/^\d+$/.test(a)) return "localhost"; // a unix socket path
    return typeof b === "string" ? b : "localhost";
  };
  for (const fn of ["connect", "createConnection"]) {
    const real = net[fn];
    net[fn] = function (a, b) {
      const host = hostOfNet(a, b);
      if (!LOOP_HOST.test(host)) {
        const port = a && typeof a === "object" ? a.port : a;
        const s = new net.Socket();
        process.nextTick(() => s.destroy(refuse(`tcp://${host}:${port}`)));
        return s;
      }
      return real.apply(this, arguments);
    };
  }
  // the socket prototype: catches clients that build a Socket themselves (new net.Socket().connect(...))
  const realSockConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let o = args[0];
    if (Array.isArray(o)) o = o[0];
    let host = "localhost", port, isPath = false;
    if (o && typeof o === "object") { if (o.path) isPath = true; else { host = o.host || "localhost"; port = o.port; } }
    else if (typeof o === "string" && !/^\d+$/.test(o)) isPath = true;
    else { port = o; if (typeof args[1] === "string") host = args[1]; }
    if (!isPath && !LOOP_HOST.test(host)) { process.nextTick(() => this.destroy(refuse(`tcp://${host}:${port}`))); return this; }
    return realSockConnect.apply(this, args);
  };
  const tls = require("tls");
  const realTls = tls.connect;
  tls.connect = function (a, b) {
    const host = a && typeof a === "object" ? a.host || a.servername || "localhost" : typeof b === "string" ? b : "localhost";
    if (a && typeof a === "object" && a.socket) return realTls.apply(this, arguments); // over an already-checked socket
    if (!LOOP_HOST.test(host)) {
      const s = new net.Socket();
      process.nextTick(() => s.destroy(refuse(`tls://${host}:${a && typeof a === "object" ? a.port : a}`)));
      return s;
    }
    return realTls.apply(this, arguments);
  };
  // The render server's origin, for the Chrome shim: HyperFrames serves the page from an EPHEMERAL loopback port it
  // opens before it launches Chrome. Every server this process opens is recorded in GRAPHIC_RENDER_ORIGINS (inherited by
  // the Chrome it spawns); the shim proxies ALL loopback ("<-loopback>") except these origins, so a graphic cannot
  // reach any other service on the host's loopback.
  const realListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function () {
    this.once("listening", () => {
      const a = this.address();
      if (a && typeof a === "object" && a.port) {
        const add = [`localhost:${a.port}`, `127.0.0.1:${a.port}`];
        const cur = (process.env.GRAPHIC_RENDER_ORIGINS || "").split(";").filter(Boolean);
        process.env.GRAPHIC_RENDER_ORIGINS = [...new Set([...cur, ...add])].join(";");
        try { process.stderr.write(`graphic-offline: render server localhost:${a.port}\n`); } catch {}
      }
    });
    return realListen.apply(this, arguments);
  };
  try { require("module").syncBuiltinESMExports(); } catch {}
}

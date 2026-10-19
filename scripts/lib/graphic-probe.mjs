// The R12 network-lock probe, Chrome half (PM2). Launches the render's Chrome (the shim, inside the optional launcher)
// headless with --remote-debugging-pipe, opens a blank page with NO CSP, and fetches each URL (no-cors, 3 s timeout,
// real time). Prints one JSON line: { lines: ["REACHED <url>" | "FAILED <url> <error>"], error? }.
// Run as a child (graphic-render.mjs calls it with spawnSync, so renderGraphic stays synchronous):
//   node scripts/lib/graphic-probe.mjs '{"bin": "<shim>", "launcher": [], "urls": ["http://1.1.1.1/"]}'
// loopback: true also opens a listener on a second localhost port (not the render server's) and fetches it: the
// result then carries loopbackUrl and loopbackHits (connections it saw), which must be 0.
// --dump-dom was not used: with a reachable-but-silent host (169.254.169.254 off a cloud) the page's fetch hangs on
// the TCP connect, virtual time stops while a request is pending, and the dump never comes (measured: >60 s).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function probeChrome({ bin, launcher = [], urls, timeoutMs = 25000, loopback = false }) {
  let lo = null, loopbackHits = 0, loopbackUrl;
  if (loopback) {
    lo = net.createServer((sock) => { loopbackHits++; sock.destroy(); });
    await new Promise((r) => lo.listen(0, "127.0.0.1", r));
    loopbackUrl = `http://localhost:${lo.address().port}/`;
    urls = [...urls, loopbackUrl];
  }
  const res = await probeOnce({ bin, launcher, urls, timeoutMs });
  if (lo) { await new Promise((r) => setTimeout(r, 200)); lo.close(); Object.assign(res, { loopbackUrl, loopbackHits }); }
  return res;
}
function probeOnce({ bin, launcher, urls, timeoutMs }) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-probe-"));
    const argv = [...launcher, bin, "--headless", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"];
    const cp = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    let done = false, buf = "", id = 0, sessionId = null;
    const pending = new Map();
    const finish = (res) => {
      if (done) return; done = true;
      try { cp.stdio[3].write(JSON.stringify({ id: ++id, method: "Browser.close" }) + "\0"); } catch {}
      setTimeout(() => { try { cp.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} resolve(res); }, 300);
    };
    const timer = setTimeout(() => finish({ lines: [], error: `no answer in ${timeoutMs} ms` }), timeoutMs);
    const send = (method, params = {}, sid) => new Promise((ok, ko) => {
      const m = { id: ++id, method, params };
      if (sid) m.sessionId = sid;
      pending.set(m.id, { ok, ko });
      cp.stdio[3].write(JSON.stringify(m) + "\0");
    });
    cp.on("error", (e) => finish({ lines: [], error: e.message }));
    cp.on("exit", (c) => finish({ lines: [], error: `Chrome exited ${c}` }));
    cp.stdio[3].on("error", () => {});
    cp.stdio[4].on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\0")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const p = msg.id && pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.ko(new Error(msg.error.message)) : p.ok(msg.result); }
      }
    });
    (async () => {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
      const expression = `Promise.all(${JSON.stringify(urls)}.map(function (u) {
        return fetch(u, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(3000) })
          .then(function () { return "REACHED " + u; }, function (e) { return "FAILED " + u + " " + e.name; });
      })).then(function (r) { return r.join("|"); })`;
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      clearTimeout(timer);
      finish({ lines: String(r.result.value || "").split("|").filter(Boolean) });
    })().catch((e) => { clearTimeout(timer); finish({ lines: [], error: e.message }); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await probeChrome(JSON.parse(process.argv[2]));
  process.stdout.write(JSON.stringify(res) + "\n");
  process.exit(0);
}

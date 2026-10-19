// Preloaded (node --require) into `hyperframes remove-background` by build.mjs when MATTE_THREADS is set: gives
// onnxruntime a fixed intra-op thread count with spinning off. hyperframes creates its session with onnxruntime's
// defaults, which size the pool from the machine's visible cores and spin while idle: in a container with 48 visible
// cores and an 8-CPU quota that burns the quota and gets the whole process throttled (a 10 s clip: 520 s -> 70 s).
// The matte was measured identical (every frame, every VP9 packet) on hyperframes 0.8.81 / onnxruntime-node 1.21.1;
// not guaranteed across versions. When the patch takes effect it prints MARK on stderr, so the build can tell.
const Module = require("node:module");

const MARK = "matte: onnxruntime";
// MATTE_THREADS: an integer >= 1, anything else is ignored (0). The one place it is parsed; build.mjs uses this too.
const matteThreads = (v = process.env.MATTE_THREADS) => (/^\s*\d+\s*$/.test(String(v ?? "")) && Number(v) >= 1 ? Number(v) : 0);
module.exports = { MARK, matteThreads };

const n = matteThreads();
if (n > 0 && !Module._load.__matteThreads) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    const m = load.call(this, request, ...rest);
    if (request === "onnxruntime-node" && m?.InferenceSession && !m.InferenceSession.__matteThreads) {
      const create = m.InferenceSession.create.bind(m.InferenceSession);
      m.InferenceSession.create = (p, o = {}, ...r) => {
        process.stderr.write(`${MARK} ${n} threads, spinning off\n`);
        return create(p, {
          ...o, intraOpNumThreads: n, interOpNumThreads: 1,
          extra: { ...(o.extra || {}), session: { ...(o.extra?.session || {}), intra_op: { allow_spinning: "0" }, inter_op: { allow_spinning: "0" } } },
        }, ...r);
      };
      m.InferenceSession.__matteThreads = n;
    }
    return m;
  };
  Module._load.__matteThreads = n;
}

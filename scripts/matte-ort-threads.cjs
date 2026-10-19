// Preloaded into `hyperframes remove-background` (node --require) by scripts/matte.mjs when MATTE_THREADS is set:
// gives onnxruntime a fixed intra-op thread count with spinning off. hyperframes 0.8.81 creates its session with
// onnxruntime's defaults, which size the pool from the machine's visible cores and spin while idle: in a container
// with 48 visible cores and an 8-CPU quota that burns the quota and gets the whole process throttled.
// Opt-in only. Changing the thread count can change float summation order, so the mask may differ from a default
// run by rounding (measured and reported in the hand-off, not assumed).
const Module = require("node:module");
const n = parseInt(process.env.MATTE_THREADS, 10);
if (n > 0) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    const m = load.call(this, request, ...rest);
    if (request === "onnxruntime-node" && m?.InferenceSession && !m.InferenceSession.__matteThreads) {
      const create = m.InferenceSession.create.bind(m.InferenceSession);
      m.InferenceSession.create = (p, o = {}, ...r) => create(p, {
        ...o, intraOpNumThreads: n, interOpNumThreads: 1,
        extra: { ...(o.extra || {}), session: { ...(o.extra?.session || {}), intra_op: { allow_spinning: "0" }, inter_op: { allow_spinning: "0" } } },
      }, ...r);
      m.InferenceSession.__matteThreads = n;
    }
    return m;
  };
}

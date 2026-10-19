// Tests only (build-graphic.test.mjs): the stub claiming the REAL pinned Chrome (152.0.7977.30), as a module that keeps a
// real runRender would. testDeps forces chromeVersion to 0.0.0-stub, so the launch line no longer matches the key and
// R13 refuses: such a render is never cached under a real Chrome's key.
import { deps as stub } from "./graphic-stub-deps.mjs";
const REAL = "152.0.7977.30";
export const deps = {
  ...stub,
  chromeVersion: () => REAL,
  runRender: async (o) => { const r = await stub.runRender(o); return { ...r, log: r.log.replace("HeadlessChrome/0.0.0-stub", `HeadlessChrome/${REAL}`) }; },
};

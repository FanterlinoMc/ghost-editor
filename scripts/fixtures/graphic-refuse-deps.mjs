// Tests only (build-graphic.test.mjs): the stub, with the network-lock probe refusing (R12).
import { deps as stub } from "./graphic-stub-deps.mjs";
export const deps = { ...stub, probeNetwork: () => ({ ok: false, lines: [], refusal: "network lock is not in place (http://1.1.1.1/ was reachable from the render browser): graphic renders refused" }) };

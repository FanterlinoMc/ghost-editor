// Runtime libraries a built index.html loads from a CDN, as build.mjs writes them. One constant, so the pixel probe
// (scripts/pixel_probe.mjs) allows and verifies exactly the URL the page asks for, and nothing else.
// sha256 of the exact bytes (jsdelivr = the npm package's dist/gsap.min.js).
export const GSAP_VERSION = "3.14.2";
export const GSAP_URL = `https://cdn.jsdelivr.net/npm/gsap@${GSAP_VERSION}/dist/gsap.min.js`;
export const GSAP_SHA256 = "c174bfce53a729418d57a8ad8625e7247c793a22fef8e2851e3cfa3de9cd8280";
// url -> sha256 of every runtime library the probe may fetch for a page
export const RUNTIME_LIBS = { [GSAP_URL]: GSAP_SHA256 };

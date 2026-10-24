// mac-65: tests that read a built page compare the REEL's markup, not the tween runtime every page now inlines
// (scripts/lib/tween-runtime.js, in place of GSAP's <script src>).
//   stripRuntime(html)  the page with the runtime's <script> emptied (needle searches: the runtime's own source names
//                       transformOrigin, filter, ... and is the same in every page)
//   asGsapPage(html)    the page as the GSAP-era engine wrote it: the runtime back to the GSAP <script src> and
//                       tween.timeline( to gsap.timeline( (byte comparisons against an older engine's build)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "tween-runtime.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const TAG = `<script>${RUNTIME}</script>`;
export const GSAP_TAG = '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>';
export const stripRuntime = (html) => html.split(TAG).join("<script></script>");
export const asGsapPage = (html) => html.split(TAG).join(GSAP_TAG).replace(/\btween\.timeline\(/g, "gsap.timeline(");

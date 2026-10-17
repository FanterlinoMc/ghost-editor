#!/usr/bin/env node
// node scripts/gm_bounds.mjs [dir]   -> writes <dir>/bounds.json (default library/gm-objects)
// The non-transparent bounding box of every PNG, from its alpha channel, as fractions of the image: {top, bottom, left, right,
// w, h}. gadzhi.mjs reads it so a gm-object's text and a gm-nodes pill sit relative to the object's real edges instead of to
// its (transparent-padded) image box. Asset preparation only: the build never runs this; re-run it when an object is added.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const dir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "library", "gm-objects"));
function alphaBox(file, thr = 24) {
  const b = fs.readFileSync(file);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), depth = b[24], ctype = b[25];
  if (depth !== 8 || ![4, 6].includes(ctype)) throw new Error(`${file}: only 8-bit grey+alpha / RGBA PNGs are supported (depth ${depth}, type ${ctype})`);
  const bpp = ctype === 6 ? 4 : 2;
  const idat = []; let p = 8;
  while (p < b.length) { const len = b.readUInt32BE(p), type = b.toString("ascii", p + 4, p + 8); if (type === "IDAT") idat.push(b.subarray(p + 8, p + 8 + len)); p += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp;
  let prev = Buffer.alloc(stride), top = h, bottom = -1, left = w, right = -1;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      line[i] = (line[i] + (f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : (() => { const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c); return pa <= pb && pa <= pc ? a : pb <= pc ? up : c; })())) & 255;
    }
    for (let x = 0; x < w; x++) if (line[x * bpp + bpp - 1] > thr) { if (y < top) top = y; if (y > bottom) bottom = y; if (x < left) left = x; if (x > right) right = x; }
    prev = line;
  }
  const r = (v) => Math.round(v * 1000) / 1000;
  return { top: r(top / h), bottom: r((bottom + 1) / h), left: r(left / w), right: r((right + 1) / w), w, h };
}
const out = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort()) out[f.replace(/\.png$/, "")] = alphaBox(path.join(dir, f));
fs.writeFileSync(path.join(dir, "bounds.json"), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out));

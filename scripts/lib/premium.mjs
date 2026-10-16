// Premium kit for build.mjs, the part Noir needs (hand port of phantasic engine/core/scripts/lib/premium.mjs, 1c15911).
// Everything here is OPT-IN per style / reel.json: a spec that sets none of these keys builds byte-identical.
// Not ported (see references/reel-json.md "Premium kit"): speed ramps, spec.transitions (overlaps the fork's take-join
// transitions), the SFX design pass and drop (need library/sfx/timing.json and a populated sfx library).
import fs from "node:fs";

// ---------- grade presets ----------
// presets/grades.json: per preset an SVG tone curve per channel (feComponentTransfer tables = a 1D LUT per channel),
// an optional saturation, an optional "keep" mask (noir: everything goes mono except warm gold/amber hues), CSS after
// the SVG filter (contrast/brightness), optional sharpen, and vignette/grain/tint defaults. look.* keys set on the
// style or reel win over the preset's own vignette/grain/tint.
export function gradePreset(look, presetsFile) {
  const all = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
  const p = all[look.preset];
  if (!p || look.preset.startsWith("_")) {
    return { error: `unknown look.preset '${look.preset}' (have ${Object.keys(all).filter((k) => !k.startsWith("_")).join(", ")})` };
  }
  const id = `pk-grade-${look.preset}`;
  const tbl = (a) => a.map((x) => x.toFixed(3)).join(" ");
  const steps = [];
  let last = "SourceGraphic";
  const put = (s, res) => { steps.push(s.replace("__IN__", last).replace("__OUT__", res)); last = res; };
  if (p.keep) {
    // mono base + the kept hues composited back over it through a mask (alpha = kR*R + kG*G + kB*B + off)
    const [kr, kg, kb, off] = p.keep.mask;
    steps.push(`<feColorMatrix in="SourceGraphic" type="saturate" values="${p.keep.baseSat ?? 0}" result="mono"/>`);
    steps.push(`<feColorMatrix in="SourceGraphic" type="saturate" values="${p.keep.sat ?? 1.1}" result="kept"/>`);
    steps.push(`<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${kr} ${kg} ${kb} 0 ${off}" result="mask"/>`);
    steps.push(`<feComposite in="kept" in2="mask" operator="in" result="keptm"/>`);
    steps.push(`<feComposite in="keptm" in2="mono" operator="over" result="kmix"/>`);
    last = "kmix";
  }
  if (p.curves) put(`<feComponentTransfer in="__IN__" result="__OUT__"><feFuncR type="table" tableValues="${tbl(p.curves.r)}"/><feFuncG type="table" tableValues="${tbl(p.curves.g)}"/><feFuncB type="table" tableValues="${tbl(p.curves.b)}"/></feComponentTransfer>`, "curves");
  if (p.saturate != null && !p.keep) put(`<feColorMatrix in="__IN__" type="saturate" values="${p.saturate}" result="__OUT__"/>`, "sat");
  if (p.sharpen) { const k = p.sharpen; put(`<feConvolveMatrix in="__IN__" order="3" preserveAlpha="true" kernelMatrix="0 ${-k} 0 ${-k} ${1 + 4 * k} ${-k} 0 ${-k} 0" result="__OUT__"/>`, "sharp"); }
  const svg = `<svg width="0" height="0" style="position:absolute;width:0;height:0" aria-hidden="true"><filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${steps.join("")}</filter></svg>`;
  const grade = `url(#${id})${p.css ? " " + p.css : ""}`;
  const merged = { vignette: p.vignette, grain: p.grain, tint: p.tint, ...look, grade: look.grade && look.grade !== "none" ? `${grade} ${look.grade}` : grade };
  for (const k of Object.keys(merged)) if (merged[k] == null) delete merged[k];
  return { look: merged, svg, brollGrade: p.broll === false ? null : grade, resolved: p };
}

// Hormozi (studied from Alex Hormozi's own 2026 Shorts, 12 Oct 2026, ~/reels/focus-refs/hormozi): clean authority
// edit. Beats:
//   hz-title  red rounded box, white heavy caps title (1-2 lines) under the caption for the hook
//   hz-name   white lower-third bar: round avatar (a still of the speaker), bold name, small title, red top edge
//   hz-list   split screen: the bottom half goes black and a numbered list builds item by item
//             (red number, bold white title, grey line under it); items [{title, sub, at}]
//   hz-note   a small grey parenthetical under the caption ("(marketing)")
// (hand port of phantasic engine/core/scripts/lib/hormozi.mjs; build.mjs writes this css only when a reel has an hz-* beat)
// Captions: style "hormozi" in build.mjs (white sentence case, keyword in heavy weight).
// the accent (title box, list numbers, name-card edge) is --hz-accent, set from brand.accent in build.mjs
const RED = "var(--hz-accent, #E5121B)";

export const HZ_CSS = `
  .hz-title { position: absolute; left: 50%; transform: translateX(-50%); width: max-content; max-width: 900px; padding: 14px 30px 16px; border-radius: 18px;
    background: ${RED}; color: #fff; font-family: Montserrat, Inter, system-ui, sans-serif; font-weight: 800; text-transform: uppercase;
    text-align: center; line-height: 1.08; letter-spacing: -.5px; box-shadow: 0 10px 30px rgba(0,0,0,.35); white-space: pre-line; }
  .hz-name { position: absolute; left: 0; right: 0; height: 168px; background: #fff; border-top: 8px solid ${RED};
    display: flex; align-items: center; gap: 26px; padding: 0 56px; box-shadow: 0 -10px 40px rgba(0,0,0,.25); }
  .hz-name img { width: 112px; height: 112px; border-radius: 50%; object-fit: cover; border: 4px solid #eee; }
  .hz-name .n { font-family: Montserrat, Inter, system-ui, sans-serif; font-weight: 800; font-size: 48px; color: #111; letter-spacing: -.5px; text-transform: uppercase; line-height: 1; }
  .hz-name .t { font-family: Inter, system-ui, sans-serif; font-weight: 500; font-size: 30px; color: #6b6b6b; margin-top: 8px; }
  .hz-panel { position: absolute; left: 0; right: 0; bottom: 0; height: 960px; background: #000; padding: 70px 70px 0 70px; }
  .hz-panel::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: rgba(255,255,255,.08); }
  .hz-item { display: grid; grid-template-columns: 70px 1fr; column-gap: 18px; margin-bottom: 46px; }
  .hz-item .k { font-family: Montserrat, Inter, system-ui, sans-serif; font-weight: 800; font-size: 60px; color: ${RED}; line-height: 1; }
  .hz-item .h { font-family: Montserrat, Inter, system-ui, sans-serif; font-weight: 800; font-size: 56px; color: #fff; line-height: 1.05; letter-spacing: -.5px; }
  .hz-item .s { font-family: Inter, system-ui, sans-serif; font-weight: 400; font-size: 38px; color: #9a9a9a; line-height: 1.25; margin-top: 8px; }
  .hz-note { position: absolute; left: 50%; transform: translateX(-50%); font-family: Inter, system-ui, sans-serif; font-weight: 500; font-size: 32px; color: rgba(255,255,255,.72); text-shadow: 0 2px 8px rgba(0,0,0,.6); white-space: nowrap; }
`;

export function hzBeat(b, id, t0, t1, ctx) {
  const { tl, r3, esc, E, addSfx } = ctx;
  if (b.type === "hz-title") {
    const size = b.size ?? 58;
    tl.push(`ft("#${id}-in", { autoAlpha: 0, scale: 0.85, y: 24 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.32, ease: "back.out(1.8)" }, ${t0});`);
    addSfx(t0, "whoosh-2", "hz title", { db: -10 });
    return `<div id="${id}-in" class="ov hz-title" style="top:${b.y ?? 1290}px;font-size:${size}px">${esc(b.text)}</div>`;
  }
  if (b.type === "hz-name") {
    const y = b.y ?? 1920 - 168 - 150;
    tl.push(`ft("#${id}-in", { autoAlpha: 0, y: 60 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: "power3.out" }, ${t0});`);
    addSfx(t0, "whoosh-1", "hz name card", { db: -14 });
    return `<div id="${id}-in" class="ov hz-name" style="top:${y}px">${b.avatar ? `<img src="${b.avatar}" />` : ""}<div><div class="n">${esc(b.name)}</div>${b.title ? `<div class="t">${esc(b.title)}</div>` : ""}</div></div>`;
  }
  if (b.type === "hz-list") {
    const items = (b.items ?? []).map((it, i) => {
      const at = r3(Math.max(t0 + 0.05, E(it.at, "hz list item") - 0.03));
      tl.push(`ft("#${id}-i${i}", { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.26, ease: "power3.out" }, ${at});`);
      addSfx(at, "click-1", "hz list item", { db: -10 });
      return `<div id="${id}-i${i}" class="hz-item"><div class="k">${esc(String(it.n ?? i + 1))}</div><div><div class="h">${esc(it.title)}</div>${it.sub ? `<div class="s">${esc(it.sub)}</div>` : ""}</div></div>`;
    }).join("");
    // the footage slides up so the face sits in the top half while the panel holds the bottom half
    const lift = b.lift ?? 280;
    tl.push(`tl.fromTo("#base", { y: 0 }, { y: -${lift}, duration: 0.3, ease: "power3.out", immediateRender: false }, ${t0});`);
    tl.push(`tl.to("#base", { y: 0, duration: 0.25, ease: "power3.inOut" }, ${r3(t1 - 0.02)});`);
    tl.push(`ft("#${id}-in", { clipPath: "inset(100% 0 0 0)" }, { clipPath: "inset(0% 0 0 0)", duration: 0.3, ease: "power3.out" }, ${t0});`);
    return `<div id="${id}-in" class="ov hz-panel">${items}</div>`;
  }
  if (b.type === "hz-note") {
    tl.push(`ft("#${id}-in", { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.2 }, ${t0});`);
    return `<div id="${id}-in" class="ov hz-note" style="top:${b.y ?? 1225}px">${esc(b.text)}</div>`;
  }
  return null;
}

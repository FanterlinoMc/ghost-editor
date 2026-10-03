// Motion layer for build.mjs: full-screen graphic scenes, scene transitions,
// the editorial caption style and the music bed. Everything here emits HTML
// strings plus GSAP lines into ctx.tl, the same way build.mjs does, so the
// composition stays one paused timeline.
//
// Scenes replace the PICTURE while the voice continues (the take audio keeps
// playing underneath). Kinds:
//   card      white card: text lines + a pill word + an optional cursor click
//   stats     accent gradient: glass ring badges that land as heroes, then
//             shrink into a row with their label; rows re-center as they stack
//   fly3d     grey depth field: words placed in 3D, a camera dolly moves
//             through them, blur and brightness follow the distance to focus
//   image     a still (e.g. AI B-roll) with a slow push; captions stay on
//   sentence  kinetic sentence: words ink in as they are spoken, then a big
//             accent hero word lands and a "not X" line gets a hand-drawn X
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// Transitions in/out: blur (0.2 s dissolve through blur), expand (rounded
// panel grows from the centre), wipe (left to right), cut.

export const MOTION_CSS = (brand, rtl) => `
  .scene { position: absolute; inset: 0; overflow: hidden; }
  .scene .col { position: absolute; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; }
  .sc-line { font-weight: 400; letter-spacing: -1px; line-height: 1.05; white-space: nowrap; }
  .sc-pill { display: inline-block; background: ${brand.accent}; color: #fff; font-weight: 700; border-radius: 999px; padding: 6px 34px 12px; white-space: nowrap; box-shadow: 0 10px 24px rgba(0,0,0,.18); }
  .sc-ring { position: absolute; border: 7px solid ${brand.accent}; border-radius: 50%; opacity: 0; }
  .sc-cursor { position: absolute; width: 86px; height: 86px; filter: drop-shadow(0 6px 10px rgba(0,0,0,.3)); }
  .badge { position: absolute; left: 0; top: 0; width: 330px; height: 330px; margin: -165px 0 0 -165px; border-radius: 50%;
    border: 3px solid rgba(255,255,255,.62); box-shadow: 0 0 34px rgba(255,255,255,.28), inset 0 0 44px rgba(255,255,255,.14);
    background: radial-gradient(circle at 35% 28%, rgba(255,255,255,.2), rgba(255,255,255,.03) 62%);
    display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; text-align: center; }
  .badge .v { font-size: 104px; font-weight: 700; letter-spacing: -3px; line-height: .95; }
  .badge .s { font-size: 50px; font-weight: 600; line-height: 1; margin-top: 4px; }
  .badge-label { position: absolute; left: 0; top: 0; color: #fff; font-size: 52px; font-weight: 300; white-space: nowrap; letter-spacing: -1px; }
  .badge-label b { font-weight: 600; }
  .badge-label span { display: inline-block; margin-right: 0.28em; }
  .fly-stage { position: absolute; inset: 0; perspective: 900px; perspective-origin: 50% 45%; }
  .fly-item { position: absolute; left: 50%; top: 45%; color: #fff; text-align: center; white-space: nowrap; will-change: transform, filter; }
  .fly-item .t { font-weight: 600; letter-spacing: -2px; line-height: .95; }
  .fly-item .u { font-weight: 400; letter-spacing: -1px; margin-top: 6px; }
  .img-fill { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform-origin: 50% 45%; }
  /* paper / tv / window scenes (ported from main: The Keynote, Alif) */
  .paper-bg { position: absolute; inset: 0; background-color: #eeede8; background-image: linear-gradient(rgba(60,60,70,.09) 1px, transparent 1px), linear-gradient(90deg, rgba(60,60,70,.09) 1px, transparent 1px); background-size: 38px 38px; box-shadow: inset 0 0 220px rgba(80,70,50,.22); }
  .win-frame { position: absolute; left: 70px; width: 940px; height: 860px; border-radius: 46px; overflow: hidden; box-shadow: 0 30px 90px rgba(0,0,0,.8); }
  .tv-room { position: absolute; inset: 0; background: radial-gradient(ellipse 80% 55% at 50% 42%, #3a2a1f 0%, #1c140f 55%, #0b0806 100%); }
  .tv-side { position: absolute; width: 250px; height: 190px; border-radius: 26px; background: linear-gradient(160deg, #3b3632, #1d1a18); box-shadow: 0 20px 50px rgba(0,0,0,.6); filter: blur(3px); opacity: .7; }
  .tv-side i { position: absolute; inset: 22px 60px 22px 22px; border-radius: 22px/16px; background: repeating-linear-gradient(0deg, rgba(255,255,255,.18) 0 2px, rgba(0,0,0,.25) 2px 4px), #8a9aa0; }
  .tv-main { position: absolute; left: 40px; top: 360px; width: 1000px; height: 780px; border-radius: 60px; background: linear-gradient(165deg, #4a443e 0%, #2b2724 45%, #171513 100%); box-shadow: 0 60px 120px rgba(0,0,0,.75), inset 0 2px 0 rgba(255,255,255,.12); }
  .tv-screen { position: absolute; left: 52px; top: 56px; width: 720px; height: 600px; border-radius: 70px/52px; overflow: hidden; background: #0c0f10; box-shadow: inset 0 0 60px rgba(0,0,0,.9), 0 0 0 10px #151311; }
  .tv-screen img, .tv-screen video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: saturate(1.15) contrast(1.08); }
  .tv-scan { position: absolute; inset: 0; pointer-events: none; background: repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 2px, rgba(0,0,0,0) 2px 4px), radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,.65) 100%); mix-blend-mode: multiply; }
  .tv-glare { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(160deg, rgba(255,255,255,.14) 0%, rgba(255,255,255,0) 35%); }
  .tv-knobs { position: absolute; right: 52px; top: 90px; width: 130px; display: flex; flex-direction: column; align-items: center; gap: 38px; }
  .tv-knobs b { width: 92px; height: 92px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #6d665f, #1f1c1a 70%); box-shadow: 0 8px 18px rgba(0,0,0,.6); }
  .tv-knobs s { width: 100px; height: 130px; border-radius: 10px; background: repeating-linear-gradient(0deg, #1a1816 0 6px, #3a3531 6px 9px); }
  .sent-lines { position: absolute; left: 0; right: 0; top: 800px; text-align: center; }
  .sent-line { font-size: 64px; font-weight: 500; color: ${brand.ink}; letter-spacing: -1.5px; line-height: 1.08; white-space: nowrap; }
  .sent-line span { display: inline-block; margin: 0 0.12em; }
  .sent-hero { position: absolute; left: 0; right: 0; top: 880px; text-align: center; font-size: 168px; font-weight: 800; color: ${brand.accent}; letter-spacing: -6px; line-height: 1; }
  .sent-sub { position: absolute; left: 0; right: 0; top: 1080px; text-align: center; font-size: 54px; font-weight: 600; color: ${brand.ink}; letter-spacing: -1px; }
  .xw { position: relative; display: inline-block; }
  .xw svg { position: absolute; left: 50%; top: 50%; width: 120px; height: 90px; margin: -45px 0 0 -60px; overflow: visible; }
  /* ui window (launch) */
  .ui-win { position: absolute; left: 70px; right: 70px; border-radius: 30px; background: #15151b; border: 1.5px solid rgba(255,255,255,.1); box-shadow: 0 40px 90px rgba(0,0,0,.55), 0 0 120px ${brand.accent}33; overflow: hidden; }
  .ui-bar { height: 64px; display: flex; align-items: center; gap: 12px; padding: 0 26px; border-bottom: 1px solid rgba(255,255,255,.08); color: rgba(255,255,255,.55); font-family: ${brand.mono ? `"${brand.mono}", ` : ""}ui-monospace, monospace; font-size: 24px; }
  .ui-bar i { width: 16px; height: 16px; border-radius: 50%; background: #3a3a44; display: inline-block; }
  .ui-bar b { margin-left: 14px; font-weight: 500; }
  .ui-body { padding: 34px 40px 40px; }
  .ui-prompt { font-family: ${brand.mono ? `"${brand.mono}", ` : ""}ui-monospace, monospace; font-size: 42px; line-height: 1.3; color: #fff; white-space: pre-wrap; min-height: 60px; }
  .ui-prompt .pr { color: ${brand.accent}; margin-right: 18px; }
  .ui-caret { display: inline-block; width: 20px; height: 46px; background: ${brand.accent}; vertical-align: -8px; margin-left: 4px; }
  .ui-line { font-size: 40px; color: rgba(255,255,255,.88); margin-top: 22px; display: flex; gap: 18px; align-items: center; }
  .ui-line .ck { width: 40px; height: 40px; border-radius: 50%; background: ${brand.accent}; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: 800; flex: none; }
  .ui-label { position: absolute; left: 0; right: 0; text-align: center; font-family: ${brand.mono ? `"${brand.mono}", ` : ""}ui-monospace, monospace; font-size: 30px; letter-spacing: 6px; text-transform: uppercase; color: ${brand.accent}; }
  /* device (launch) */
  .dev { position: absolute; left: 50%; width: 480px; height: 980px; margin-left: -240px; border-radius: 72px; background: #0b0b0e; border: 14px solid #1d1d22; box-shadow: 0 50px 110px rgba(0,0,0,.55), inset 0 0 0 2px #2c2c33; overflow: hidden; }
  .dev::before { content: ""; position: absolute; top: 18px; left: 50%; width: 130px; height: 36px; margin-left: -65px; border-radius: 20px; background: #000; z-index: 2; }
  .dev img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .dev .scr { position: absolute; inset: 0; padding: 110px 34px 40px; color: #fff; }
  .dev .scr div { font-size: 34px; line-height: 1.25; margin-bottom: 18px; padding: 18px 22px; border-radius: 22px; background: rgba(255,255,255,.08); }
  .dev .scr div.me { background: ${brand.accent}; margin-left: 60px; }
  /* kinetic type */
  .kin-world { position: absolute; left: 0; top: 0; width: 960px; transform-origin: 0 0; }
  .kin-text { position: absolute; left: 0; top: 0; width: 960px; text-align: center; line-height: 1.12; letter-spacing: -2px; font-weight: 800; }
  .kin-text span { display: inline-block; margin: 0 0.14em; }
  .kin-text .em { color: ${brand.accent}; }
  .kin-text .it { font-style: italic; font-weight: 400; }
  /* per-word keyword treatments in editorial captions (captions.keywords, The Keynote) */
  .eline:has(.ebold) { white-space: normal; max-width: 960px; margin: 0 auto; text-align: center; }
  .ew.ebold { font-size: ${brand.boldScale ?? 1.9}em; font-weight: 900; line-height: .92; letter-spacing: -2px; color: ${brand.accent}; text-shadow: 0 6px 24px rgba(0,0,0,.45); }
  .ew.ealarm { color: ${brand.alarm ?? "#E23B3B"}; font-weight: 800; text-shadow: 0 4px 18px rgba(0,0,0,.5); }
  .ew.eser { display: inline-block; margin: 0 0.13em; font-family: "${brand.serif || "Georgia"}", "EB Garamond", "Noto Sans Arabic", Georgia, serif; font-style: italic; font-weight: 500; font-size: ${brand.serifScale ?? 1}em; line-height: .9; color: ${brand.accent}; text-shadow: 0 0 22px ${brand.accent}99, 0 2px 12px rgba(0,0,0,.4); letter-spacing: 0; }
  /* editorial captions */
  #ecaps { position: absolute; left: 0; right: 0; top: 0; height: 0; }
  .eblock { position: absolute; left: 130px; right: 130px; text-align: center; }
  .ebacked { background: rgba(8,8,10,.5); border-radius: 26px; padding: 10px 0 14px; }
  .eline { display: block; font-size: ${brand.capSize}px; line-height: 1.08; letter-spacing: -1px; white-space: nowrap; }
  .ew { display: inline-block; margin: 0 0.13em; color: #fff; font-weight: 700; text-shadow: 0 3px 14px rgba(0,0,0,.35); }
  .etag { display: inline-block; background: ${brand.accent}; color: #fff; font-weight: 700; border-radius: 16px; padding: 2px 18px 8px; margin-bottom: 6px; box-shadow: 0 6px 18px rgba(0,0,0,.25); font-size: ${Math.round(brand.capSize * 0.95)}px; }
  .ehl { position: relative; display: inline-block; margin: 0 0.13em; }
  .ehl i { position: absolute; left: -8px; right: -8px; top: 12%; bottom: 2%; background: ${brand.accent}; transform-origin: ${rtl ? "100% 50%" : "0 50%"}; }
  .ehl .ew { position: relative; margin: 0; }
  ${rtl ? `#ecaps, .eline { direction: rtl; unicode-bidi: plaintext; }` : ""}

  /* ported from origin/main bd7ae09: the stylesheet for the scene kinds ported at b060367.
     Missed on the first pass - the kinds rendered unstyled, keys cut off at the frame edge and
     tails jammed together, which is what a stack page looks like with no CSS. */
  .wp-word { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); text-align: center; font-family: Inter, system-ui, sans-serif; font-weight: 600; letter-spacing: -0.05em; line-height: 1; white-space: nowrap; }
  .wp-word.ser { font-family: "Instrument Serif", Georgia, serif; font-style: italic; font-weight: 400; letter-spacing: -0.02em; }
  .hl-col { position: absolute; left: 50%; width: max-content; transform: translateX(-50%); display: flex; flex-direction: column; align-items: flex-start; }
  .hl-line { font-family: Inter, system-ui, sans-serif; font-weight: 600; letter-spacing: -0.05em; line-height: 1.12; white-space: nowrap; }
  .hl-w { display: inline-block; margin-right: 0.24em; }
  .hl-boxw { display: inline-block; color: #fff; padding: 0 0.12em 0.08em; margin: 0 -1px 0 0; }
  .cp-stage { position: absolute; left: 0; right: 0; display: flex; align-items: center; justify-content: center; }
  .cp-card { position: absolute; left: 50%; top: 50%; margin: 0; transform: translate(-50%, -50%); border: 9px solid #fff; border-radius: 6px; box-shadow: 0 22px 50px rgba(0,0,0,.22); max-height: 100%; object-fit: cover; }
  .cp-labs { position: absolute; left: 0; right: 0; }
  .cp-logo { background: #fff; display: flex; align-items: center; justify-content: center; border-radius: 28px; border: 0; }
  .cp-logo img { width: 58%; height: 58%; object-fit: contain; }
  .cp-lab { position: absolute; left: 0; right: 0; text-align: center; font-family: Inter, system-ui, sans-serif; font-weight: 600; letter-spacing: -0.05em; line-height: 1; white-space: nowrap; }
  .ui-card { zoom: 1.18; background: #fff; border-radius: 28px; box-shadow: 0 30px 70px rgba(0,0,0,.45); font-family: Inter, system-ui, sans-serif; color: #111; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; }
  .ui-kicker { font-size: 34px; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 22px; align-self: flex-start; }
  .ui-toks { display: flex; flex-wrap: wrap; gap: 8px 6px; font-size: 44px; font-weight: 500; letter-spacing: -0.02em; }
  .ui-tok { display: inline-block; border-radius: 8px; padding: 2px 8px 6px; }
  .ui-count { margin-top: 26px; align-self: flex-start; font-size: 40px; font-weight: 700; color: #111; }
  .ui-cal { display: grid; grid-template-columns: repeat(7, 62px); gap: 8px; }
  .ui-dh { text-align: center; font-size: 26px; font-weight: 600; color: #8a8f9c; }
  .ui-day { width: 62px; height: 62px; border-radius: 12px; background: #f1f2f6; display: flex; align-items: center; justify-content: center; }
  .ui-day i { width: 46px; height: 46px; border-radius: 50%; color: #fff; font-style: normal; font-size: 30px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
  .ui-bars { display: flex; align-items: flex-end; gap: 60px; height: 290px; }
  .ui-bar-col { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
  .ui-bl { margin-top: 14px; font-size: 30px; font-weight: 600; color: #555; }
  .cc-words { position: absolute; left: 0; right: 0; top: 330px; height: 200px; }
  .cc-word { position: absolute; left: 0; right: 0; text-align: center; color: #111; line-height: 1; white-space: nowrap; }
  .cc-imgs { position: absolute; left: 140px; right: 140px; top: 640px; height: 900px; }
  .cc-img { position: absolute; left: 50%; top: 0; transform: translateX(-50%); max-width: 800px; max-height: 860px; object-fit: contain; mix-blend-mode: multiply; }
  .mn-ink { position: absolute; inset: 0; color: var(--ink); }
  .mn-col { position: absolute; left: 40px; right: 40px; display: flex; flex-direction: column; align-items: center; text-align: center; }
  .mn-lead { font-family: Inter, system-ui, sans-serif; font-weight: 400; font-size: ${brand.leadSize ?? 54}px; letter-spacing: -0.04em; line-height: 1.05; margin-bottom: -6px; }
  .mn-ring { position: absolute; left: -14%; right: -14%; top: -12%; bottom: -18%; width: 128%; height: 130%; overflow: visible; transform: rotate(-3deg); pointer-events: none; }
  .mn-ring ellipse { fill: none; stroke: currentColor; stroke-width: 0.9; vector-effect: non-scaling-stroke; stroke-width: 3px; }
  .mn-key { position: relative; font-family: ${brand.keyFont ?? "Inter, system-ui, sans-serif"}; font-weight: 900; letter-spacing: -0.065em; line-height: .9; white-space: nowrap; padding: 0 .06em; }
  .mn-mid { font-family: Inter, system-ui, sans-serif; font-weight: 700; font-size: ${brand.midSize ?? 96}px; letter-spacing: -0.055em; line-height: 1.02; max-width: 900px; }
  .mn-tail { font-family: Inter, system-ui, sans-serif; font-weight: 400; font-style: italic; font-size: ${brand.tailSize ?? 46}px; letter-spacing: -0.04em; margin-top: 10px; }
  .mn-w { display: none; margin: 0 0.12em; }
  .mn-ic { background: var(--ink); margin-bottom: 8px; }
  .mn-on-footage .mn-key, .mn-on-footage .mn-lead, .mn-on-footage .mn-tail { text-shadow: 0 6px 30px rgba(0,0,0,.55); }
  .mn-on-footage .mn-key { color: ${brand.footKey ?? "#fff"}; }
  .mn-card { position: absolute; left: 70px; right: 70px; top: 330px; height: 900px; border-radius: 44px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,.35); }
  .mn-film { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: ${brand.film ?? "none"}; }
  .mn-full { transform-origin: 50% 38%; }
  .mn-letter { display: inline-block; }
  .mn-pulse { position: absolute; left: 50%; top: 50%; width: 1.4em; height: 1.4em; margin: -0.7em 0 0 -0.7em; border-radius: 50%; border: 0.04em solid currentColor; opacity: 0; pointer-events: none; }
  .mn-phone { position: absolute; left: 50%; top: 360px; width: 560px; height: 1060px; margin-left: -280px; border-radius: 54px; overflow: hidden; background: #000; border: 10px solid #0d0d0d; box-shadow: 0 40px 90px rgba(0,0,0,.45); }
  .mn-ui i { position: absolute; font-style: normal; color: #fff; font-family: Inter, system-ui, sans-serif; text-shadow: 0 2px 8px rgba(0,0,0,.6); }
  .mn-top { top: 26px; left: 28px; right: 28px; display: flex; justify-content: space-between; font-size: 34px; }
  .mn-top b { font-size: 28px; font-weight: 700; }
  .mn-rail { right: 22px; bottom: 210px; font-size: 40px; line-height: 1.7; text-align: center; }
  .mn-user { left: 26px; bottom: 120px; font-size: 24px; font-weight: 600; display: flex; align-items: center; gap: 12px; }
  .mn-user s { width: 44px; height: 44px; border-radius: 50%; background: #ddd; display: inline-block; }
  .mn-nav { left: 0; right: 0; bottom: 0; height: 90px; background: rgba(0,0,0,.85); font-size: 34px; display: flex !important; justify-content: space-around; align-items: center; }
  .mn-tile { padding: 22px; border-radius: 44px; background: rgba(255,255,255,.94); box-shadow: 0 20px 50px rgba(0,0,0,.4); --ink: ${brand.accent}; }
  .mn-tile .mn-ic { margin: 0; }
  .mn-phic { position: absolute; left: 0; right: 0; top: 60%; display: flex; justify-content: center; }
`;

const CURSOR_SVG = `<svg viewBox="0 0 64 64"><path d="M22 6c-2.8 0-5 2.2-5 5v25l-4.6-4.3c-2-1.9-5.2-1.7-7 .4-1.7 2-1.5 5 .3 6.8l13.8 13.8C23.6 56.9 28.4 59 33.5 59H38c9.4 0 17-7.6 17-17V30c0-2.8-2.2-5-5-5-.9 0-1.8.3-2.5.7-.6-2.2-2.6-3.7-4.9-3.7-1.2 0-2.3.4-3.2 1.1-.8-1.9-2.7-3.1-4.8-3.1-.9 0-1.8.2-2.6.7V11c0-2.8-2.2-5-5-5z" fill="#fff" stroke="#111" stroke-width="3" stroke-linejoin="round"/></svg>`;
const X_SVG = (color, id) => `<svg viewBox="0 0 120 90"><path id="${id}a" d="M8 12 Q60 50 112 80" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/><path id="${id}b" d="M110 8 Q58 42 10 84" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg>`;

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, "");

// transitions ----------------------------------------------------------------
function transIn(ctx, sel, kind, t0) {
  const { tl } = ctx;
  if (kind === "cut" || !kind) return;
  if (kind === "blur") tl.push(`ft("${sel}", { autoAlpha: 0, filter: "blur(28px)", scale: 1.05 }, { autoAlpha: 1, filter: "blur(0px)", scale: 1, duration: 0.22, ease: "power2.out" }, ${t0});`);
  if (kind === "expand") tl.push(`ft("${sel}", { clipPath: "inset(40% 26% 40% 26% round 120px)" }, { clipPath: "inset(0% 0% 0% 0% round 0px)", duration: 0.42, ease: "expo.inOut" }, ${t0});`);
  if (kind === "wipe") tl.push(`ft("${sel}", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.3, ease: "power3.inOut" }, ${t0});`);
  // slide: a sheet of paper slapped down from the right, a little rotated, settling flat (Broadsheet) (R1b port)
  if (kind === "slide") tl.push(`ft("${sel}", { xPercent: 105, rotation: 5, transformOrigin: "100% 100%" }, { xPercent: 0, rotation: 0, duration: 0.26, ease: "power3.out" }, ${t0});`);
  if (kind === "glitch") {
    // six stepped frames of slice + RGB-ish shift, then clean: deterministic, no random
    const { r3 } = ctx;
    const steps = [[-26, "inset(18% 0% 52% 0%)", 120], [18, "inset(55% 0% 12% 0%)", 250], [-10, "inset(0% 0% 70% 0%)", 60], [14, "inset(30% 0% 30% 0%)", 300], [-6, "inset(62% 0% 4% 0%)", 180], [0, "inset(0% 0% 0% 0%)", 0]];
    tl.push(`tl.set("${sel}", { autoAlpha: 0 }, 0);`);
    steps.forEach(([x, clip, hue], i) => tl.push(`tl.set("${sel}", { autoAlpha: 1, x: ${x}, clipPath: "${clip}", filter: "hue-rotate(${hue}deg) saturate(${hue ? 2.2 : 1})" }, ${r3(t0 + i * 0.035)});`));
  }
}
function transOut(ctx, sel, kind, t1) {
  const { tl, r3 } = ctx;
  // Each out mirrors its in and runs a little faster - the ratio blur already uses (0.18 out
  // against 0.22 in). An exit as slow as its entrance reads as hesitation.
  // No SFX here by design: the expand/wipe whoosh is added once in buildScene, so a second on the
  // way out would double up - and would make every out-transition depend on the SFX library.
  if (kind === "blur") tl.push(`tl.to("${sel}", { autoAlpha: 0, filter: "blur(28px)", duration: 0.18, ease: "power2.in" }, ${r3(t1 - 0.18)});`);
  if (kind === "expand") tl.push(`tl.to("${sel}", { clipPath: "inset(40% 26% 40% 26% round 120px)", autoAlpha: 0, duration: 0.34, ease: "expo.inOut" }, ${r3(t1 - 0.34)});`);
  // in opens the right edge (revealing left to right); out keeps travelling the same way by closing
  // the left edge, so a wipe in/out pair reads as one gesture rather than a bounce.
  if (kind === "wipe") tl.push(`tl.to("${sel}", { clipPath: "inset(0% 0% 0% 100%)", duration: 0.25, ease: "power3.inOut" }, ${r3(t1 - 0.25)});`);
  if (kind === "slide") tl.push(`tl.to("${sel}", { xPercent: -105, rotation: -4, transformOrigin: "0% 100%", duration: 0.2, ease: "power3.in" }, ${r3(t1 - 0.2)});`);  // R1b port
  if (kind === "glitch") {
    // the in-transition's stepped frames, reversed, then gone. Deterministic: no random.
    const steps = [[-6, "inset(62% 0% 4% 0%)", 180], [14, "inset(30% 0% 30% 0%)", 300],
                   [-10, "inset(0% 0% 70% 0%)", 60], [18, "inset(55% 0% 12% 0%)", 250],
                   [-26, "inset(18% 0% 52% 0%)", 120]];
    const span = 0.035 * steps.length;
    steps.forEach(([x, clip, hue], i) => tl.push(`tl.set("${sel}", { x: ${x}, clipPath: "${clip}", filter: "hue-rotate(${hue}deg) saturate(2.2)" }, ${r3(t1 - span + i * 0.035)});`));
    tl.push(`tl.set("${sel}", { autoAlpha: 0, x: 0 }, ${r3(t1)});`);
  }
}

// object sounds (Alif rule: a sound says what the object IS; plain text lands silently) ----------
// concept -> [sfx, hero]; hero sounds (money) sit near the voice, the rest ~10 dB under it
export const OBJECT_SFX = {
  moneybag: ["kaching-1", true], coins: ["kaching-1", true], money: ["kaching-1", true],
  watch: ["tick-1", false], clock: ["tick-1", false], hourglass: ["tick-1", false],
  lightbulb: ["ding-1", false], brain: ["ding-1", false],
  gears: ["click-1", false], typewriter: ["typing-1", false], robot: ["tech-ui-confirm", false],
  magnifier: ["whoosh-2", false], hand: ["whoosh-1", false], ladder: ["whoosh-3", false],
  chess: ["impact-2", false], trophy: ["ding-1", false], rocket: ["riser-1", false],
  chart: ["riser-1", false], check: ["tick-1", false], phone: ["tech-notification-2", false], mail: ["tech-notification-2", false],
};
const soundOf = (ctx) => ctx.sound || {};
const objectSfx = (ctx, at, key, why) => {
  const snd = soundOf(ctx);
  if (snd.objects === false) return;
  const concept = String(key).replace(/-\d+$/, "").replace(/^.*[\\/]/, "").replace(/\.png$/, "");
  const [id, hero] = OBJECT_SFX[concept] || [null, false];
  if (id) ctx.addSfx(at + (snd.objectLead ?? 0.04), id, `${why}: ${concept}`, { db: hero ? (snd.heroDb ?? -2) : (snd.objectDb ?? -8) });
};
const lineSfx = (ctx, at, id, why, opts) => { if (soundOf(ctx).lines !== false) ctx.addSfx(at, id, why, opts); };
// Alif's paper-texture layer: quiet (~15-20 dB under the voice) and bright, so it reads over lo-fi music
const PAPER_IN = ["paper-quick", "paper-page-turn", "paper-pages"];
let paperN = 0, penN = 0;
const penTick = (ctx, at, style, why) => {
  const snd = soundOf(ctx);
  if (!snd.pen) return;
  const id = style === "marker" ? (penN++ % 2 ? "pen-scribble-2" : "pen-scribble") : (penN++ % 2 ? "pen-letters" : "pen-short");
  ctx.addSfx(at, id, why, { db: snd.penDb ?? -4 });
};

// a paper page with an engraving -> a laid-out collage page (the director plans words + picture; this places them)
// (R1b port)
const BASE = { serif: 150, box: 140, dark: 160, caps: 64 }, LINE_H = { serif: 0.9, box: 1.25, dark: 1.2, caps: 1.2 };
const pngSize = (file) => { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
export function pageToCollage(b, ctx) {
  const items = [];
  let y = 300, n = 0;
  const lines = b.lines || [];
  const lead = lines[0]?.style === "marker" ? 1 : 0;
  if (lead) { items.push({ type: "text", style: "marker", text: lines[0].text, x: 90, y: y - 40, size: 120, rotate: -4, at: lines[0].at }); y += 110; }
  for (const l of lines.slice(lead).filter((l) => l.style !== "marker")) {
    let st = l.style || "serif";
    if (st === "serif" && n % 2 && l.text.length > 8) st = "caps";
    const size = st === "caps" || l.text.length <= 10 ? BASE[st] : Math.round(BASE[st] * 10 / l.text.length * 1.2);
    items.push({ type: "text", style: st, text: l.text, x: 80 + (n % 2) * 90, y, size, at: l.at });
    y += Math.round(size * LINE_H[st] * (st === "caps" ? 1.25 : 1)) + 10; n++;
  }
  const marks = lines.slice(lead).filter((l) => l.style === "marker");
  const bottom = marks.length ? 1400 : 1560;
  const file = path.join(ctx.LIB, "engravings", "png", `${b.engraving}.png`);
  const [iw, ih] = fs.existsSync(file) ? pngSize(file) : [1, 1];
  const w = Math.round(Math.min(860, (bottom - (y + 10)) * iw / ih));
  items.push({ type: "image", src: b.engraving, x: Math.round((1080 - w) / 2), y: y + 10, w, at: (lines[0]?.at ?? b.at) + 0.25 });
  let my = bottom + 30;
  for (const l of marks) { const size = l.text.length <= 12 ? 120 : 92; items.push({ type: "text", style: "marker", text: l.text, x: 120, y: my, size, rotate: -4, at: l.at }); my += size; }
  const map = ctx.pageMap || {};
  const H = { headline: 1.0, kicker: 1.5, deck: 1.05 };
  for (const it of items) {
    if (it.type !== "text" || !map[it.style]) continue;
    it.style = map[it.style];
    if (it.style === "headline") it.size = Math.min(150, Math.round(1380 / Math.max(6, it.text.length)));
    if (it.style === "kicker") { it.size = 40; it.rotate = 0; }
    if (it.style === "deck") it.size = Math.min(96, it.size ?? 96);
  }
  if (ctx.pageMap) {
    // restack the text column with the new sizes, then the picture under it, like a newspaper column
    let y = 250;
    const texts = items.filter((it) => it.type === "text"), img = items.find((it) => it.type === "image");
    for (const it of texts) { it.x = 80; it.y = y; y += Math.round((it.size ?? 90) * (H[it.style] ?? 1.1)) + 14; }
    if (img) { const [iw, ih] = fs.existsSync(path.join(ctx.LIB, "engravings", "png", `${img.src}.png`)) ? pngSize(path.join(ctx.LIB, "engravings", "png", `${img.src}.png`)) : [1, 1]; img.y = y + 20; img.w = Math.round(Math.min(860, (1560 - img.y) * iw / ih)); img.x = Math.round((1080 - img.w) / 2); }
  }
  return { ...b, kind: "collage", paper: b.paper ?? ctx.pagePaper ?? "grid", screen: b.screen ?? ctx.pageScreen ?? false, items };
}

// scenes ---------------------------------------------------------------------
export function buildScene(b, id, t0, t1, ctx) {
  if (b.kind === "paper" && b.engraving) b = pageToCollage(b, ctx);  // R1b port
  const { tl, E, r3, esc, addSfx, brand, userAsset, words } = ctx;
  const sid = `${id}-sc`;
  let body = "";
  const bg = b.bg === "accent" ? `linear-gradient(135deg, ${brand.accentDark} 0%, ${brand.accent} 55%, ${brand.accentDark} 100%)` : (b.bg || "#fff");
  const inKind = b.in ?? ctx.sceneIn ?? "blur", outKind = b.out ?? ctx.sceneOut ?? "blur";
  let customBg = null;

  if (b.kind === "card") {
    const lines = (b.lines || []).map((l, i) => {
      const at = E(l.at, "card line");
      tl.push(`ft("#${id}-l${i}", { autoAlpha: 0, y: 20, filter: "blur(8px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.3, ease: "power3.out" }, ${at});`);
      return `<div id="${id}-l${i}" class="sc-line" style="font-size:${l.size ?? 96}px;color:${l.color ?? brand.accentDark}">${esc(l.text)}</div>`;
    }).join("");
    let pill = "", extra = "";
    if (b.pill) {
      const pa = E(b.pill.at, "card pill");
      pill = `<div id="${id}-p" class="sc-pill" style="font-size:${b.pill.size ?? 92}px;margin-top:${b.pill.gap ?? 18}px">${esc(b.pill.text)}</div>`;
      tl.push(`ft("#${id}-p", { autoAlpha: 0, scale: 0.5, rotation: -16 }, { autoAlpha: 1, scale: 1, rotation: -6, duration: 0.34, ease: "back.out(1.7)" }, ${pa});`);
      addSfx(pa, "pop", "card pill");
    }
    if (b.cursor && b.pill) {
      const ca = E(b.cursor.clickAt, "cursor click");
      const cx = 540 + (b.cursor.dx ?? 40), cy = (b.y ?? 860) + (b.cursor.dy ?? 150);
      extra = `<div id="${id}-ring" class="sc-ring" style="left:${cx - 120}px;top:${cy - 120}px;width:240px;height:240px"></div><div id="${id}-cur" class="sc-cursor" style="left:${cx - 20}px;top:${cy - 10}px">${CURSOR_SVG}</div>`;
      tl.push(`ft("#${id}-cur", { autoAlpha: 0, x: 280, y: 420, rotation: 14 }, { autoAlpha: 1, x: 0, y: 0, rotation: 0, duration: 0.55, ease: "power3.out" }, ${r3(ca - 0.6)});`);
      tl.push(`tl.to("#${id}-cur", { scale: 0.82, duration: 0.07, yoyo: true, repeat: 1, ease: "power1.inOut" }, ${ca});`);
      tl.push(`tl.to("#${id}-p", { scale: 0.93, duration: 0.07, yoyo: true, repeat: 1, ease: "power1.inOut" }, ${ca});`);
      tl.push(`ft("#${id}-ring", { autoAlpha: 0.9, scale: 0.35 }, { autoAlpha: 0, scale: 1.25, duration: 0.5, ease: "power2.out" }, ${ca});`);
      addSfx(ca, "click-1", "cursor click", { db: 4 });
    }
    body = `<div class="col" style="top:${b.y ?? 860}px">${lines}${pill}</div>${extra}`;
  }

  else if (b.kind === "stats") {
    const CY = b.centerY ?? 930, GAP = b.gap ?? 440, ROWX = 250, HERO_S = 1, ROW_S = 0.42;
    const rowY = (k, j) => CY + (j - (k - 1) / 2) * GAP;
    const n = b.badges.length;
    body = b.badges.map((bd, i) => {
      const at = E(bd.at, "badge");
      const heroY = i === 0 ? CY - 330 : rowY(i + 1, i) + 60;
      tl.push(`tl.set("#${id}-b${i}", { x: 540, y: ${heroY}, scale: ${HERO_S} }, 0);`);
      tl.push(`ft("#${id}-b${i}", { autoAlpha: 0, scale: 0.2, filter: "blur(12px)" }, { autoAlpha: 1, scale: ${HERO_S}, filter: "blur(0px)", duration: 0.45, ease: "back.out(1.6)" }, ${at});`);
      addSfx(at, "whoosh", "badge in");
      let lab = "";
      if (bd.label) {
        const la = E(bd.labelAt ?? bd.at, "badge label");
        // this badge and every row above it move into the k = i+1 row layout
        for (let j = 0; j <= i; j++) tl.push(`tl.to("#${id}-b${j}", { x: ${ROWX}, y: ${rowY(i + 1, j)}, scale: ${ROW_S}, duration: 0.55, ease: "power3.inOut" }, ${r3(la - 0.35)});`);
        for (let j = 0; j < i; j++) tl.push(`tl.to("#${id}-lab${j}", { y: ${rowY(i + 1, j) - 34}, duration: 0.55, ease: "power3.inOut" }, ${r3(la - 0.35)});`);
        const parts = bd.label.split(/(\*\*[^*]+\*\*)/).filter(Boolean).flatMap((p) => p.startsWith("**") ? p.slice(2, -2).split(" ").map((w) => `<span><b>${esc(w)}</b></span>`) : p.trim().split(/\s+/).filter(Boolean).map((w) => `<span>${esc(w)}</span>`));
        lab = `<div id="${id}-lab${i}" class="badge-label">${parts.join("")}</div>`;
        tl.push(`tl.set("#${id}-lab${i}", { x: ${ROWX + 110}, y: ${rowY(i + 1, i) - 34} }, 0);`);
        tl.push(`ft("#${id}-lab${i} span", { autoAlpha: 0, x: -14, filter: "blur(6px)" }, { autoAlpha: 1, x: 0, filter: "blur(0px)", duration: 0.28, ease: "power3.out", stagger: 0.07 }, ${r3(la + 0.1)});`);
      }
      return `<div id="${id}-b${i}" class="badge"><div class="v">${esc(bd.value)}</div>${bd.sub ? `<div class="s">${esc(bd.sub)}</div>` : ""}</div>${lab}`;
    }).join("");
    if (n && b.drift !== false) tl.push(`ft("#${sid}", { backgroundPosition: "0% 0%" }, { backgroundPosition: "100% 100%", duration: ${r3(t1 - t0)}, ease: "none" }, ${t0});`);
  }

  else if (b.kind === "fly3d") {
    const items = b.items.map((it, i) => ({ ...it, i, at: E(it.at, "fly3d item") }));
    body = `<div class="fly-stage">${items.map((it) => `<div id="${id}-f${it.i}" class="fly-item"><div class="t" style="font-size:${it.size ?? 120}px">${esc(it.text)}</div>${it.sub ? `<div class="u" style="font-size:${Math.round((it.size ?? 120) * 0.3)}px">${esc(it.sub)}</div>` : ""}</div>`).join("")}</div>`;
    const cam = b.cam ?? { from: 0, to: 900 }, focus = b.focus ?? 0;
    const data = JSON.stringify(items.map((it) => ({ id: `${id}-f${it.i}`, x: it.x ?? 0, y: it.y ?? 0, z: it.z ?? 0, at: it.at })));
    // one painter: every item's transform, blur, opacity and grey level is a
    // pure function of (camera z, timeline time), so any frame can be sought
    tl.push(`(() => { const items = ${data}; const els = items.map((o) => document.getElementById(o.id)); const P = { z: ${cam.from} };
    const paint = () => { const t = tl.time(); items.forEach((o, k) => { const el = els[k]; const z = o.z + P.z; const d = Math.abs(z - ${focus});
      const appear = Math.min(1, Math.max(0, (t - o.at) / 0.3)); const past = Math.min(1, Math.max(0, (z - 420) / 160));
      el.style.transform = "translate(-50%,-50%) translate3d(" + o.x + "px," + o.y + "px," + z + "px)";
      el.style.filter = "blur(" + Math.min(14, d / 55).toFixed(2) + "px)"; el.style.opacity = (appear * (1 - past)).toFixed(3);
      const g = Math.round(255 - Math.min(110, d / 5)); el.style.color = "rgb(" + g + "," + g + "," + g + ")"; }); };
    tl.fromTo(P, { z: ${cam.from} }, { z: ${cam.to}, duration: ${r3(t1 - t0)}, ease: "${b.ease ?? "sine.inOut"}", onUpdate: paint, immediateRender: false }, ${t0}); })();`);
    addSfx(t0, "riser-1", "fly3d riser", { db: -2 });
    for (const it of items.slice(1)) addSfx(it.at, "whoosh", "fly3d word", { db: -6 });
  }

  else if (b.kind === "image" || b.kind === "window") {
    // image: full-screen B-roll. window: the same inside a rounded vintage frame on black.
    // src can be a still or a video clip; { self: <source seconds> } uses the speaker's own footage.
    const [z0, z1] = b.zoom ?? [1.0, 1.12];
    const grade = b.grade ?? (b.kind === "window" ? "sepia(.18) contrast(1.06) saturate(.9)" : "");
    const media = b.self !== undefined ? ctx.source : userAsset(b.src);
    const isVideo = b.self !== undefined || /\.(mp4|mov|webm)$/i.test(media);
    const tag = isVideo
      ? `<video id="${id}-img" class="img-fill" src="${media}" data-start="${t0}" data-duration="${r3(t1 - t0)}" data-media-start="${b.self ?? b.media ?? 0}" data-track-index="19" muted playsinline style="${grade ? `filter:${grade};` : ""}"></video>`
      : `<img id="${id}-img" class="img-fill" src="${media}" style="${grade ? `filter:${grade};` : ""}" />`;
    body = b.kind === "window" ? `<div class="win-frame" style="top:${b.y ?? 330}px">${tag}<div class="tv-scan" style="opacity:.35"></div></div>` : tag;
    if (b.kind === "window") customBg = "#000";
    tl.push(`ft("#${id}-img", { scale: ${z0} }, { scale: ${z1}, duration: ${r3(t1 - t0)}, ease: "none" }, ${t0});`);
  }

  else if (b.kind === "clip") {
    // Cut to a video the user supplies - a screen recording, B-roll, a second angle - full frame.
    // `image` is the same idea for stills. `meme` also renders video, but only from the library,
    // and draws a tilted overlay with a pop-in rather than a straight cut.
    // Muted by default: B-roll normally runs under the speaker's continuing voice, and silence
    // keeps this feature independent of the SFX library.
    const src = userAsset(b.src);
    const fit = b.fit === "contain" ? "contain" : "cover";
    body = `<video id="${id}-v" class="img-fill" style="object-fit:${fit}${b.grade ? `;filter:${b.grade}` : ""}"`
      + ` src="${src}" data-start="${r3(t0)}" data-duration="${r3(t1 - t0)}" data-media-start="${b.in ?? 0}"`
      + `${b.audio === true ? "" : " muted"} playsinline></video>`;
    if (b.zoom) {
      const [z0, z1] = b.zoom;
      tl.push(`ft("#${id}-v", { scale: ${z0} }, { scale: ${z1}, duration: ${r3(t1 - t0)}, ease: "none" }, ${t0});`);
    }
  }

  else if (b.kind === "sentence") {
    // align the scene's line words to the spoken words inside [t0, t1]
    const spoken = words.filter((w) => w.start >= t0 - 0.05 && w.start < t1);
    let si = 0;
    const lines = (b.lines || []).map((line, li) => `<div class="sent-line">${line.split(/\s+/).map((w, wi) => {
      let at = null;
      for (let k = si; k < spoken.length; k++) if (norm(spoken[k].word) === norm(w)) { at = spoken[k].start; si = k + 1; break; }
      if (at === null) at = t0 + 0.15 * (li * 4 + wi);
      const onAccent = b.bg === "accent";
      tl.push(`ft("#${id}-s${li}-${wi}", { autoAlpha: 0, filter: "blur(6px)", color: "${onAccent ? "rgba(255,255,255,0.5)" : "#c9c9c9"}" }, { autoAlpha: 1, filter: "blur(0px)", color: "${onAccent ? "#fff" : brand.ink}", duration: 0.26, ease: "power2.out" }, ${r3(at - 0.02)});`);
      addSfx(at, "tick-1", "type tick", { db: -4 });
      return `<span id="${id}-s${li}-${wi}">${esc(w)}</span>`;
    }).join("")}</div>`).join("");
    let hero = "", sub = "";
    if (b.hero) {
      const ha = E(b.hero.at, "hero");
      const heroColor = b.hero.color ?? (b.bg === "accent" ? "#fff" : null); // accent on accent is invisible
      hero = `<div id="${id}-hero" class="sent-hero" style="${b.hero.size ? `font-size:${b.hero.size}px;letter-spacing:${-Math.round(b.hero.size / 28)}px;` : ""}${heroColor ? `color:${heroColor};` : ""}">${esc(b.hero.text)}</div>`;
      tl.push(`tl.to("#${id}-lines", { y: -330, scale: 0.72, duration: 0.5, ease: "power3.inOut" }, ${r3(ha - 0.3)});`);
      tl.push(`ft("#${id}-hero", { autoAlpha: 0, scale: 0.55, filter: "blur(14px)" }, { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: 0.42, ease: "expo.out" }, ${ha});`);
      addSfx(ha, "impact", "hero word");
    }
    if (b.sub) {
      const sa = E(b.sub.at, "sub");
      const parts = b.sub.text.split(/\s+/).map((w) => (b.sub.cross && norm(w) === norm(b.sub.cross)) ? `<span class="xw">${esc(w)}${X_SVG(brand.accent, `${id}-x`)}</span>` : esc(w)).join(" ");
      sub = `<div id="${id}-sub" class="sent-sub">${parts}</div>`;
      tl.push(`ft("#${id}-sub", { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: "power3.out" }, ${sa});`);
      if (b.sub.cross) {
        const xa = E(b.sub.crossAt ?? b.sub.at, "cross");
        tl.push(`ft("#${id}-xa", { attr: { "stroke-dashoffset": 1 } }, { attr: { "stroke-dashoffset": 0 }, duration: 0.16, ease: "power2.out" }, ${xa});`);
        tl.push(`ft("#${id}-xb", { attr: { "stroke-dashoffset": 1 } }, { attr: { "stroke-dashoffset": 0 }, duration: 0.16, ease: "power2.out" }, ${r3(xa + 0.14)});`);
        addSfx(xa, "whoosh", "cross out", { db: -4 });
      }
    }
    body = `<div id="${id}-lines" class="sent-lines">${lines}</div>${hero}${sub}`;
  }

  else if (b.kind === "ui") {
    // a dark app/terminal window: the prompt types in, result lines tick in
    const ta = E(b.prompt?.at ?? b.at, "ui prompt");
    const text = b.prompt?.text ?? "";
    const cps = b.prompt?.cps ?? 28;
    const typeEnd = ta + text.length / cps;
    const chars = [...text].map((c, i) => `<span id="${id}-c${i}" style="opacity:0">${esc(c)}</span>`).join("");
    const lines = (b.lines || []).map((l, i) => {
      const at = E(l.at, "ui line");
      tl.push(`ft("#${id}-u${i}", { autoAlpha: 0, x: -30 }, { autoAlpha: 1, x: 0, duration: 0.3, ease: "power3.out" }, ${at});`);
      addSfx(at, "ding-1", "ui line", { db: -8 });
      return `<div id="${id}-u${i}" class="ui-line"><span class="ck">✓</span><span>${esc(l.text)}</span></div>`;
    }).join("");
    // typed characters: one set per char at its time; caret blinks in steps
    [...text].forEach((_, i) => tl.push(`tl.set("#${id}-c${i}", { opacity: 1 }, ${r3(ta + i / cps)});`));
    const blinkEnd = t1;
    for (let t = ta, k = 0; t < blinkEnd; t += 0.45, k++) tl.push(`tl.set("#${id}-caret", { opacity: ${k % 2 ? 0 : 1} }, ${r3(t)});`);
    if (text) addSfx(ta, "typing-1", "ui typing", { db: -6 });
    const y = b.y ?? 620;
    body = `${b.label ? `<div class="ui-label" style="top:${y - 90}px">${esc(b.label)}</div>` : ""}<div id="${id}-win" class="ui-win" style="top:${y}px"><div class="ui-bar"><i></i><i></i><i></i><b>${esc(b.title || "")}</b></div><div class="ui-body"><div class="ui-prompt"><span class="pr">›</span>${chars}<span id="${id}-caret" class="ui-caret"></span></div>${lines}</div></div>`;
    tl.push(`ft("#${id}-win", { autoAlpha: 0, y: 60, scale: 0.94 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: "expo.out" }, ${t0});`);
  }

  else if (b.kind === "device") {
    // a phone frame rising into the scene: an image, or a mini chat of lines
    const src = b.src ? userAsset(b.src) : null;
    const screen = src ? `<img src="${src}" />` : `<div class="scr">${(b.lines || []).map((l, i) => {
      const at = E(l.at, "device line");
      tl.push(`ft("#${id}-m${i}", { autoAlpha: 0, y: 24, scale: 0.92 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: "back.out(1.6)" }, ${at});`);
      addSfx(at, "pop", "device line", { db: -4 });
      return `<div id="${id}-m${i}" class="${l.me ? "me" : ""}">${esc(l.text)}</div>`;
    }).join("")}</div>`;
    const y = b.y ?? 470;
    body = `${b.label ? `<div class="ui-label" style="top:${y - 100}px">${esc(b.label)}</div>` : ""}<div id="${id}-dev" class="dev" style="top:${y}px">${screen}</div>`;
    tl.push(`ft("#${id}-dev", { autoAlpha: 0, y: 380, rotation: 8, scale: 0.9 }, { autoAlpha: 1, y: 0, rotation: -3, scale: 1, duration: 0.6, ease: "expo.out" }, ${t0});`);
    tl.push(`tl.to("#${id}-dev", { rotation: 2, y: -18, duration: ${r3(Math.max(0.3, t1 - t0 - 0.6))}, ease: "sine.inOut" }, ${r3(t0 + 0.6)});`);
    addSfx(t0, "whoosh", "device in");
  }

  else if (b.kind === "kinetic") {
    // words land one by one as they are spoken; a camera glides from word to
    // word, then pulls back to show the whole phrase. *word* = accent keyword,
    // _word_ = light italic filler. Optional pip: the speaker shrinks into a circle.
    const spoken = words.filter((w) => w.start >= t0 - 0.05 && w.start < t1);
    let si = 0;
    const toks = b.text.split(/\s+/).map((raw, i) => {
      const em = /^\*.*\*[.,!?]?$/.test(raw), it = /^_.*_[.,!?]?$/.test(raw);
      const txt = raw.replace(/^[*_]|[*_](?=[.,!?]?$)/g, "");
      let at = null;
      for (let k = si; k < spoken.length; k++) if (norm(spoken[k].word) === norm(txt)) { at = spoken[k].start; si = k + 1; break; }
      if (at === null) at = t0 + 0.3 * i;
      return { txt, em, it, at, i };
    });
    const size = b.size ?? 118;
    const kbg = b.bg ?? brand.kineticBg ?? "#FFE14D";
    const spans = toks.map((k) => `<span id="${id}-k${k.i}" class="${k.em ? "em" : ""}${k.it ? " it" : ""}" style="font-size:${k.em ? Math.round(size * 1.45) : size}px">${esc(k.txt)}</span>`).join(" ");
    body = `<div id="${id}-world" class="kin-world"><div id="${id}-txt" class="kin-text" style="color:${b.ink ?? brand.ink}">${spans}</div></div>`;
    const data = JSON.stringify(toks.map((k) => ({ id: `${id}-k${k.i}`, at: k.at })));
    const S = b.zoom ?? 2.1, outAt = r3(t1 - (b.pullback ?? 1.0));
    tl.push(`(() => { const ks = ${data}; const els = ks.map((k) => document.getElementById(k.id)); const world = document.getElementById("${id}-world"); const P = { u: 0 };
    const ease = (x) => x < 0 ? 0 : x > 1 ? 1 : 1 - Math.pow(1 - x, 3);
    const paint = () => { const t = tl.time(); let cur = 0; ks.forEach((k, i) => { if (t >= k.at - 0.02) cur = i; const a = ease((t - k.at + 0.02) / 0.22); els[i].style.opacity = a.toFixed(3); els[i].style.transform = "translateY(" + ((1 - a) * 40).toFixed(1) + "px) scale(" + (0.8 + 0.2 * a).toFixed(3) + ")"; });
      const c = (el) => [el.offsetLeft + el.offsetWidth / 2, el.offsetTop + el.offsetHeight / 2];
      const prevI = Math.max(0, cur - 1); const m = ease((t - ks[cur].at) / 0.38); const [x0, y0] = c(els[prevI]); const [x1, y1] = c(els[cur]);
      let cx = x0 + (x1 - x0) * m, cy = y0 + (y1 - y0) * m, s = ${S};
      const txt = document.getElementById("${id}-txt"); const po = ease((t - ${outAt}) / 0.7);
      if (po > 0) { cx += (txt.offsetWidth / 2 - cx) * po; cy += (txt.offsetHeight / 2 - cy) * po; s += (Math.min(1, 900 / txt.offsetWidth) - s) * po; }
      world.style.transform = "translate(" + (540 - s * cx).toFixed(1) + "px," + (${b.cy ?? 860} - s * cy).toFixed(1) + "px) scale(" + s.toFixed(3) + ")"; };
    tl.fromTo(P, { u: 0 }, { u: 1, duration: ${r3(t1 - t0)}, ease: "none", onUpdate: paint, immediateRender: false }, ${t0}); })();`);
    for (const k of toks.slice(1)) if (k.em) addSfx(k.at, "whoosh", "kinetic keyword", { db: -6 });
    if (b.pip) {
      // the speaker plate shrinks into a round window, above the type. MULTIANGLE Gap 6: this
      // beat has a time (t0), so the take that owns it (and therefore its source) is knowable -
      // `faceYAt(t0)` centres the circle on THAT source's own face median, falling back to the
      // primary's (`ctx.faceY`) for a single-source reel or a source with no track of its own.
      // Unlike `#pip`'s baked CSS transform-origin, this value is read fresh per beat, so it needs
      // no animation to vary by source.
      const fx = 540, fy = ctx.faceYAt ? ctx.faceYAt(t0) : (ctx.faceY ?? 700), R = 560, sc = 0.34, tx = b.pipX ?? 820, ty = b.pipY ?? 1330;
      tl.push(`tl.set("#pip", { zIndex: 7 }, ${t0});`);
      tl.push(`ft("#pip", { x: 0, y: 0, scale: 1, clipPath: "circle(2400px at ${fx}px ${fy}px)" }, { x: ${tx - fx}, y: ${ty - fy}, scale: ${sc}, clipPath: "circle(${R}px at ${fx}px ${fy}px)", duration: 0.5, ease: "power3.inOut" }, ${t0});`);
      tl.push(`tl.to("#pip", { x: 0, y: 0, scale: 1, clipPath: "circle(2400px at ${fx}px ${fy}px)", duration: 0.45, ease: "power3.inOut" }, ${r3(t1 - 0.45)});`);
      tl.push(`tl.set("#pip", { zIndex: 1 }, ${t1});`);
    }
    customBg = kbg;
  }

  else if (b.kind === "paper") {
    // Editorial collage on grid paper: lines in serif, an accent box (italic serif, white) or marker handwriting.
    // lines: [{ text, style: "serif"|"box"|"marker", at?, size?, rotate? }], optional arrow: true
    const lines = (b.lines || []).map((ln, i) => {
      // the first line is on the paper from the scene's first frame: never open on blank paper
      const at = i === 0 ? t0 : (ln.at !== undefined ? Math.max(t0, E(ln.at, "paper line")) : r3(t0 + 0.15 + i * 0.35));
      const sid2 = `${id}-p${i}`;
      const size = ln.size ?? (ln.style === "box" ? 132 : ln.style === "marker" ? 96 : 118);
      const css = ln.style === "box"
        ? `display:inline-block;background:${brand.accent};color:#fff;font-family:'Instrument Serif',Georgia,serif;font-style:italic;padding:0 20px 10px;line-height:1`
        : ln.style === "marker"
        ? `color:#1e1e1e;font-family:'Caveat Brush',cursive;line-height:.9`
        : `color:#1b1b1d;font-family:'Instrument Serif',Georgia,serif;letter-spacing:-2px;line-height:.92`;
      tl.push(`ft("#${sid2}", { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.1, ease: "power2.out" }, ${r3(at - 0.03)});`);
      if (ln.style !== "serif") lineSfx(ctx, at, ln.style === "marker" ? "pop" : "whoosh", "paper line", { db: -10 });
      if (i > 0) penTick(ctx, at, ln.style, "pen tick (paper line)");
      return `<div id="${sid2}" style="font-size:${size}px;${css};transform:rotate(${ln.rotate ?? (ln.style === "marker" ? -4 : 0)}deg);margin:${ln.style === "marker" ? "-10px 0 -6px 30px" : "0"}">${esc(ln.text)}</div>`;
    }).join("");
    body = `<div class="paper-bg"></div><div class="col" style="top:${b.y ?? 700}px;align-items:${b.align ?? "center"}">${lines}</div>`;
    customBg = "#eeede8";
  }

  else if (b.kind === "tv") {
    // A vintage CRT in a dark room; the screen flips through clips or stills (a montage for "distraction",
    // "noise", "everyone else"). Items: { src } image or video, or { self: <source seconds> } for the
    // speaker's own footage (rights-clean by default). Each item holds for dur (default: an even split).
    const items = (b.items || []).length ? b.items : [{ self: 0 }];
    const span = t1 - t0 - 0.1;
    const each = Math.max(0.12, Math.min(0.8, span / items.length));
    const screens = items.map((it, i) => {
      const s0 = r3(t0 + 0.05 + i * each), d = r3(Math.min(it.dur ?? each, t1 - s0));
      if (d <= 0) return "";
      const style = `style="visibility:hidden"`;
      tl.push(`tl.set("#${id}-tv${i}", { visibility: "visible" }, ${s0}); tl.set("#${id}-tv${i}", { visibility: "hidden" }, ${r3(s0 + d)});`);
      if (i > 0) addSfx(s0, b.flipSfx ?? "tick-1", "tv channel flip", { db: -8 });
      if (it.self !== undefined) return `<video id="${id}-tv${i}" src="${ctx.source}" data-start="${s0}" data-duration="${d}" data-media-start="${it.self}" data-track-index="${20 + (i % 6)}" muted playsinline ${style}></video>`;
      const src = userAsset(it.src);
      if (/\.(mp4|mov|webm)$/i.test(src)) return `<video id="${id}-tv${i}" src="${src}" data-start="${s0}" data-duration="${d}" data-media-start="${it.media ?? 0}" data-track-index="${20 + (i % 6)}" muted playsinline ${style}></video>`;
      return `<img id="${id}-tv${i}" src="${src}" ${style} />`;
    }).join("");
    // a light flicker on the tube, stepped so any frame can be sought
    for (let t = t0, k = 0; t < t1; t += 1 / 12, k++) tl.push(`tl.set("#${id}-scr", { opacity: ${(0.9 + ((k * 37) % 10) / 100).toFixed(2)} }, ${r3(t)});`);
    body = `<div class="tv-room"></div>
      <div class="tv-side" style="left:40px;top:250px"><i></i></div><div class="tv-side" style="right:30px;top:180px"><i></i></div>
      <div class="tv-main" id="${id}-set"><div class="tv-screen" id="${id}-scr">${screens}<div class="tv-scan"></div><div class="tv-glare"></div></div>
      <div class="tv-knobs"><b></b><b></b><s></s></div></div>`;
    tl.push(`ft("#${id}-set", { scale: 0.94 }, { scale: 1.02, duration: ${r3(t1 - t0)}, ease: "none" }, ${t0});`);
    customBg = "#0b0806";
  }

  else if (b.kind === "collage") {
    // Vintage editorial collage (the "old school" look): public-domain engravings multiplied onto paper, mixed
    // type (lowercase serif, tiny condensed caps, a dark box word, marker, huge italic caps), app-style stickers,
    // all seen through a screen: RGB fringe, pixel mesh, a slight fisheye bulge.
    // items: [{ type: "text"|"image"|"sticker"|"glasses", at?, x, y, ... }]  (x/y in px, top-left of the item)
    const paper = b.paper ?? "grid";
    const fringe = b.screen === false ? "" : "text-shadow:2.5px 0 0 rgba(230,40,60,.38),-2.5px 0 0 rgba(20,170,230,.38);";
    const imgFringe = b.screen === false ? "" : "drop-shadow(2.5px 0 0 rgba(230,40,60,.35)) drop-shadow(-2.5px 0 0 rgba(20,170,230,.35))";
    const TEXT = {
      serif: (sz) => `font-family:'Instrument Serif',Georgia,serif;font-size:${sz ?? 150}px;color:#1b1b1d;letter-spacing:-4px;line-height:.9`,
      caps: (sz) => `font-family:Oswald,'Arial Narrow',sans-serif;font-weight:300;text-transform:uppercase;font-size:${sz ?? 64}px;color:#2a2a2c;letter-spacing:-1px;line-height:.9;transform:scaleY(1.25);transform-origin:0 0`,
      dark: (sz) => `font-family:'Instrument Serif',Georgia,serif;font-size:${sz ?? 170}px;color:#f1efe8;background:#1d1d22;padding:0 18px 12px;letter-spacing:-5px;line-height:1`,
      box: (sz) => `font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:${sz ?? 150}px;color:#fff;background:${brand.accent};padding:0 22px 12px;letter-spacing:-3px;line-height:1`,
      marker: (sz) => `font-family:'Caveat Brush',cursive;font-size:${sz ?? 130}px;color:#1e1e22;line-height:.8`,
      italic: (sz) => `font-family:'Instrument Serif',Georgia,serif;font-style:italic;text-transform:uppercase;font-size:${sz ?? 210}px;color:#26302a;letter-spacing:-6px;line-height:.9`,
      // Broadsheet (newsprint): a heavy display headline, a small kicker in the brand colour, an italic deck (R1b port)
      headline: (sz) => `font-family:Gloock,Georgia,serif;text-transform:uppercase;font-size:${sz ?? 120}px;color:#15130f;letter-spacing:-0.02em;line-height:.92`,
      kicker: (sz) => `font-family:Inter,system-ui,sans-serif;font-weight:800;text-transform:uppercase;font-size:${sz ?? 40}px;color:${brand.accent};letter-spacing:.14em;line-height:1`,
      deck: (sz) => `font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:${sz ?? 88}px;color:#2a2620;letter-spacing:-0.02em;line-height:.95`,
    };
    const items = (b.items || []).map((it, i) => {
      const iid = `${id}-c${i}`;
      // the first item is on the paper from the scene's first frame: never open on blank paper
      const at = i === 0 ? t0 : it.at !== undefined ? Math.max(t0, E(it.at, "collage item")) : r3(t0 + 0.12 * i);
      const pos = `position:absolute;left:${it.x ?? 120}px;top:${it.y ?? 600}px;transform:rotate(${it.rotate ?? 0}deg)`;
      let html = "";
      if (it.type === "image") {
        const key = it.src || "";
        const file = /[\/.]/.test(key) ? key : path.join(ctx.LIB, "engravings", "png", `${key}.png`);
        html = `<img src="${userAsset(file)}" style="display:block;width:${it.w ?? 760}px;filter:contrast(1.15) ${imgFringe}" />`;
        tl.push(`ft("#${iid}", { autoAlpha: 0, scale: 0.92 }, { autoAlpha: 1, scale: 1, duration: 0.18, ease: "back.out(2)" }, ${r3(at)});`);
        if (soundOf(ctx).lines === false) objectSfx(ctx, at, it.src, "collage object");
        else addSfx(at, "pop", "collage image", { db: -12 });
      } else if (it.type === "glasses") {
        // bold black frames dropped onto an engraving (a modern prop on a vintage cut-out)
        const w = it.w ?? 640;
        html = `<svg width="${w}" viewBox="0 0 640 200" style="display:block;filter:drop-shadow(0 8px 10px rgba(0,0,0,.35))"><g fill="none" stroke="#111" stroke-width="30" stroke-linejoin="round"><path d="M44 70 Q46 36 100 36 H236 Q284 36 282 80 Q278 150 236 168 Q200 180 120 176 Q62 172 52 128 Z"/><path d="M358 80 Q356 36 404 36 H540 Q594 36 596 70 L588 128 Q578 172 520 176 Q440 180 404 168 Q362 150 358 80 Z"/><path d="M284 72 Q320 52 356 72"/><path d="M40 62 L4 48 M600 62 L636 48"/></g></svg>`;
        tl.push(`ft("#${iid}", { autoAlpha: 0, y: -160, rotation: -8 }, { autoAlpha: 1, y: 0, rotation: ${it.rotate ?? -4}, duration: 0.26, ease: "bounce.out" }, ${r3(at)});`);
        lineSfx(ctx, at, "whoosh", "collage glasses", { db: -10 });
      } else if (it.type === "sticker") {
        // app-icon sticker: rounded square, white speech bubble, a number or a word inside
        const sz = it.size ?? 420, col = it.color ?? "#5ccf5a";
        html = `<div style="width:${sz}px;height:${sz}px;border-radius:${sz * 0.2}px;background:linear-gradient(180deg, ${col}, ${col}dd);box-shadow:0 18px 40px rgba(0,0,0,.25);position:relative">
          <div style="position:absolute;left:12%;top:16%;width:76%;height:58%;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif;font-weight:800;font-style:italic;font-size:${sz * 0.26}px;color:#111;letter-spacing:-4px">${esc(it.text ?? "")}</div>
          <div style="position:absolute;left:24%;top:66%;width:0;height:0;border-left:${sz * 0.04}px solid transparent;border-right:${sz * 0.1}px solid transparent;border-top:${sz * 0.12}px solid #fff;transform:rotate(18deg)"></div></div>`;
        tl.push(`ft("#${iid}", { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.24, ease: "back.out(2.2)" }, ${r3(at)});`);
        if (soundOf(ctx).lines === false) objectSfx(ctx, at, "phone", "collage sticker");
        else addSfx(at, "pop", "collage sticker", { db: -8 });
      } else {
        const style = (TEXT[it.style ?? "serif"] || TEXT.serif)(it.size);
        html = `<div style="${style};white-space:nowrap;${it.style === "dark" || it.style === "box" ? "" : fringe}">${esc(it.text ?? "")}</div>`;
        tl.push(`ft("#${iid}", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.06 }, ${r3(at)});`);
        if (it.style === "marker" || it.style === "dark" || it.style === "box") lineSfx(ctx, at, it.style === "marker" ? "pop" : "whoosh", "collage word", { db: -12 });
        if (i > 0) penTick(ctx, at, it.style, "pen tick (collage word)");
      }
      // engravings are ink-only PNGs (alpha from darkness), so they layer like any sticker
      const layer = `z-index:${it.z ?? (it.type === "glasses" ? 5 : it.type === "image" ? 1 : 3)}`;
      return `<div id="${iid}" style="${pos};${layer}">${html}</div>`;
    }).join("");
    const paperBg = paper === "newsprint"
      // R1b port (Broadsheet)
      ? `<div class="paper-bg" style="background-color:#ebe4d4;background-image:radial-gradient(rgba(30,25,15,.13) 1.1px, transparent 1.4px), linear-gradient(90deg, transparent 49.6%, rgba(40,30,20,.10) 50%, transparent 50.4%);background-size:9px 9px, 100% 100%;box-shadow:inset 0 0 160px rgba(90,70,40,.30)"></div>
         <div style="position:absolute;left:60px;right:60px;top:170px;border-top:4px double rgba(20,18,14,.75)"></div>
         <div style="position:absolute;left:60px;right:60px;bottom:170px;border-top:2px solid rgba(20,18,14,.55)"></div>`
      : paper === "grid"
      ? `<div class="paper-bg" style="background-color:#ecebe4;background-image:linear-gradient(rgba(40,40,50,.28) 2px, transparent 2px), linear-gradient(90deg, rgba(40,40,50,.28) 2px, transparent 2px);background-size:96px 96px"></div>`
      : `<div class="paper-bg" style="background-color:#e9e6dc;background-image:none"></div>`;
    const screenFx = b.screen === false ? "" : `<div style="position:absolute;inset:0;pointer-events:none;z-index:9;background:repeating-linear-gradient(0deg, rgba(0,0,0,.07) 0 1px, transparent 1px 4px), repeating-linear-gradient(90deg, rgba(255,0,0,.035) 0 1px, rgba(0,255,0,.035) 1px 2px, rgba(0,0,255,.035) 2px 3px);mix-blend-mode:multiply"></div>
      <div style="position:absolute;inset:0;pointer-events:none;z-index:9;box-shadow:inset 0 0 180px rgba(40,30,20,.45)"></div>`;
    body = `<div id="${id}-cw" style="position:absolute;inset:0;${b.screen === false ? "" : "filter:url(#phx-bulge) blur(0.5px)"}">${paperBg}${items}</div>${screenFx}
      <svg width="0" height="0" style="position:absolute"><filter id="phx-bulge" x="0" y="0" width="100%" height="100%"><feImage href="${userAsset(path.join(ctx.LIB, "engravings", "bulge.png"))}" result="m" preserveAspectRatio="none" x="0" y="0" width="1080" height="1920"/><feDisplacementMap in="SourceGraphic" in2="m" scale="${b.bulge ?? 70}" xChannelSelector="R" yChannelSelector="G"/></filter></svg>`;
    tl.push(`ft("#${id}-cw", { scale: 1 }, { scale: ${b.zoom ?? 1.06}, duration: ${r3(t1 - t0)}, ease: "none" }, ${t0});`);
    customBg = "#e9e6dc";
  }

  // --- ported from origin/main (Ahmedmkarrar/phantasic) bd7ae09, 1 Oct: the five scene kinds the
  // mono / pitch / monologue templates need. Additive by decision: our own `clip` kind above and
  // every existing kind are untouched, and main's changes to caption construction, the nametag,
  // `behind` and the page DOM were deliberately NOT taken - see PLAN-COMPARISON.md and decision 6.
  else if (b.kind === "wordpage") {
    // one spoken word at a time on a flat field: accent with white words, or paper with accent words.
    // b.big: words drawn 1.5x (the payoff of the line); b.serif: words in the italic display serif
    const onAccent = (b.bg ?? "accent") === "accent";
    customBg = onAccent ? brand.accent : (b.paper ?? "#F3F3F3");
    const spoken = words.filter((w) => w.start >= t0 - 0.05 && w.start < t1);
    const serif = new Set((b.serif || []).map(norm)), big = new Set((b.big || []).map(norm));
    body = spoken.map((w, i) => {
      const s = r3(Math.max(t0, w.start - 0.03)), e = r3(i + 1 < spoken.length ? spoken[i + 1].start - 0.03 : t1);
      const ser = serif.has(norm(w.word)), size = Math.round((b.size ?? 118) * (big.has(norm(w.word)) ? 1.5 : 1) * (ser ? 1.2 : 1));
      tl.push(`ft("#${id}-w${i}", { autoAlpha: 0, filter: "blur(8px)" }, { autoAlpha: 1, filter: "blur(0px)", duration: 0.1, ease: "power2.out" }, ${s});`);
      if (i + 1 < spoken.length) tl.push(`tl.set("#${id}-w${i}", { autoAlpha: 0 }, ${e});`);
      return `<div id="${id}-w${i}" class="wp-word${ser ? " ser" : ""}" style="font-size:${size}px;color:${onAccent ? "#fff" : brand.accent}">${esc(w.word.replace(/,$/, ""))}</div>`;
    }).join("");
  }

  else if (b.kind === "highlight") {
    // white page: plain lines in the accent colour ink in word by word as spoken; the box line grows its
    // accent box one word at a time under white type ("comes down" / [to 3 things])
    customBg = b.paper ?? "#F3F3F3";
    const spoken = words.filter((w) => w.start >= t0 - 0.05 && w.start < t1);
    let si = 0;
    const lines = (b.lines || []).map((l, li) => {
      const la = E(l.at, "highlight line");
      const ws = l.text.split(/\s+/).map((w, wi) => {
        let at = null;
        for (let k = si; k < spoken.length; k++) if (norm(spoken[k].word) === norm(w)) { at = spoken[k].start; si = k + 1; break; }
        at = r3(Math.max(t0, (at ?? la + wi * 0.14) - 0.02));
        const wid = `${id}-h${li}-${wi}`;
        if (l.box) tl.push(`ft("#${wid}", { autoAlpha: 1, clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.14, ease: "power2.out" }, ${at});`);
        else tl.push(`ft("#${wid}", { autoAlpha: 0, filter: "blur(6px)" }, { autoAlpha: 1, filter: "blur(0px)", duration: 0.1, ease: "power2.out" }, ${at});`);
        if (l.box && wi === 0) addSfx(at, "click-1", "highlight box", { db: -6 });
        return `<span id="${wid}" class="${l.box ? "hl-boxw" : "hl-w"}"${l.box ? ` style="background:${brand.accent}"` : ` style="color:${brand.accent}"`}>${esc(w)}</span>`;
      }).join("");
      return `<div class="hl-line" style="font-size:${l.size ?? b.size ?? 104}px">${ws}</div>`;
    }).join("");
    body = `<div class="hl-col" style="top:${b.y ?? 800}px">${lines}</div>`;
  }

  else if (b.kind === "cardpage") {
    // white page, one small framed picture in the middle that swaps (stop-motion) on b.items[].at, and the
    // spoken words one at a time in the accent colour under it
    customBg = b.paper ?? "#F3F3F3";
    const items = (b.items || []).map((it, i) => ({ ...it, i, t: r3(Math.max(t0, E(it.at, "cardpage item"))) }));
    const w = b.w ?? 380;
    const cards = items.map((it, i) => {
      const end = i + 1 < items.length ? items[i + 1].t : t1;
      if (i > 0) tl.push(`tl.set("#${id}-c${i}", { autoAlpha: 0 }, 0);`);
      tl.push(`tl.set("#${id}-c${i}", { autoAlpha: 1 }, ${it.t});`);
      tl.push(`ft("#${id}-c${i}", { xPercent: -50, yPercent: -50, scale: ${i ? 1.06 : 0.8}, rotation: ${i % 2 ? 2 : -2} }, { xPercent: -50, yPercent: -50, scale: 1, rotation: 0, duration: 0.16, ease: "power3.out" }, ${it.t});`);
      if (i + 1 < items.length) tl.push(`tl.set("#${id}-c${i}", { autoAlpha: 0 }, ${end});`);
      addSfx(it.t, "click-1", "card swap", { db: -8 });
      // a tool logo (Simple Icons slug) sits on a white tile; a painting fills its frame
      if (it.logo) return `<div id="${id}-c${i}" class="cp-card cp-logo" style="width:${w}px;height:${w}px"><img src="${ctx.icon(it.logo)}" /></div>`;
      return `<img id="${id}-c${i}" class="cp-card" src="${ctx.artAsset(it.art)}" style="width:${w}px" />`;
    }).join("");
    const spoken = words.filter((w) => w.start >= t0 - 0.05 && w.start < t1);
    const labs = spoken.map((wd, i) => {
      const s0 = r3(Math.max(t0, wd.start - 0.03)), e0 = r3(i + 1 < spoken.length ? spoken[i + 1].start - 0.03 : t1);
      tl.push(`ft("#${id}-l${i}", { autoAlpha: 0, filter: "blur(6px)" }, { autoAlpha: 1, filter: "blur(0px)", duration: 0.08, ease: "power2.out" }, ${s0});`);
      if (i + 1 < spoken.length) tl.push(`tl.set("#${id}-l${i}", { autoAlpha: 0 }, ${e0});`);
      return `<div id="${id}-l${i}" class="cp-lab" style="color:${brand.accent};font-size:${b.labelSize ?? 86}px">${esc(wd.word.replace(/,$/, ""))}</div>`;
    }).join("");
    body = `<div class="cp-stage" style="top:${b.y ?? 560}px;height:${Math.round(w * 1.3)}px">${cards}</div><div class="cp-labs" style="top:${(b.y ?? 560) + Math.round(w * 1.3) + 40}px">${labs}</div>`;
  }

  else if (b.kind === "concept") {
    // a key word on a white-to-grey card, its typeface cycling every ~0.22 s, over engravings that swap on the beat
    customBg = b.bg ?? "linear-gradient(180deg, #ffffff 0%, #f1f1f1 45%, #bdbdbd 100%)";
    const fonts = b.fonts ?? [["Instrument Serif", "normal", 400], ["Yellowtail", "normal", 400], ["JetBrains Mono", "normal", 500], ["Inter", "normal", 800], ["EB Garamond", "italic", 500], ["Gloock", "normal", 400]];
    const step = b.step ?? 0.22, n = Math.max(1, Math.floor((t1 - t0) / step));
    const word = b.word ?? "";
    const faces = Array.from({ length: n }, (_, k) => {
      const [fam, st, wt] = fonts[k % fonts.length], at = r3(t0 + k * step);
      if (k > 0) tl.push(`tl.set("#${id}-f${k}", { autoAlpha: 0 }, 0);`);
      tl.push(`tl.set("#${id}-f${k}", { autoAlpha: 1 }, ${at});`);
      if (k + 1 < n) tl.push(`tl.set("#${id}-f${k}", { autoAlpha: 0 }, ${r3(at + step)});`);
      return `<div id="${id}-f${k}" class="cc-word" style="font-family:'${fam}',serif;font-style:${st};font-weight:${wt};font-size:${b.size ?? 120}px">${esc(word)}</div>`;
    }).join("");
    const imgs = (b.engravings || []).map((eng, i, arr) => {
      const src = path.join(ctx.LIB, "engravings", "png", `${eng}.png`);
      const dst = path.join(ctx.proj, "assets", `${eng}.png`);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
      const at = r3(t0 + i * ((t1 - t0) / arr.length));
      if (i > 0) tl.push(`tl.set("#${id}-e${i}", { autoAlpha: 0 }, 0);`);
      tl.push(`tl.set("#${id}-e${i}", { autoAlpha: 1 }, ${at});`);
      tl.push(`ft("#${id}-e${i}", { scale: 1.06 }, { scale: 1, duration: 0.2, ease: "power2.out" }, ${at});`);
      if (i + 1 < arr.length) tl.push(`tl.set("#${id}-e${i}", { autoAlpha: 0 }, ${r3(t0 + (i + 1) * ((t1 - t0) / arr.length))});`);
      return `<img id="${id}-e${i}" class="cc-img" src="assets/${eng}.png" />`;
    }).join("");
    body = `<div class="cc-words">${faces}</div><div class="cc-imgs">${imgs}</div>`;
  }

  else if (b.kind === "stack") {
    // Mono: a three-tier statement. A small lead line types on word by word, the KEY word lands huge out of a
    // ghosted blur, a small italic tail lands under it. Ground: accent, paper, the speaker's grayscale footage
    // (transparent page), the footage in a rounded card, or the footage in a phone with a reels UI. Icons
    // (engraving or brand logo) pop above the key; flips swap accent <-> paper on the beat.
    const ground = b.bg ?? "accent", bgIsPhone = ground === "phone";
    const spoken = words.filter((w) => w.start >= t0 - 0.05 && w.start < t1);
    let si = 0;
    const timeOf = (text, fallback) => {
      // the start of the spoken word matching the first token of text, searched forward from the last match
      const first = norm(String(text).split(/\s+/)[0] || "");
      for (let k = si; k < spoken.length; k++) if (norm(spoken[k].word) === first) { si = k + 1; return spoken[k].start; }
      return fallback;
    };
    const wordsIn = (text, cls, ink, fallbackAt) => String(text || "").split(/\s+/).filter(Boolean).map((w, i) => {
      const at = r3(Math.max(t0, (timeOf(w, null) ?? fallbackAt + i * 0.12) - 0.03));
      const wid = `${id}-${cls}${i}-${Math.round(at * 1000)}`;
      // words join the line as spoken (display none -> inline) so a line grows from its centre
      tl.push(`tl.set("#${wid}", { display: "inline-block" }, ${at});`);
      tl.push(`ft("#${wid}", { autoAlpha: 0, filter: "blur(6px)" }, { autoAlpha: 1, filter: "blur(0px)", duration: 0.12, ease: "power2.out" }, ${at});`);
      return `<span id="${wid}" class="mn-w">${esc(w)}</span>`;
    }).join("");
    // lines: the stack grows top-down as it is spoken. role s = small regular, k = HUGE key, t = small italic tail.
    // (lead/key/tail is the short form: one of each.)
    const lines = b.lines ?? [b.lead && { text: b.lead, role: "s" }, { text: b.key, role: "k", say: b.keySay, size: b.keySize, color: b.keyColor, ring: b.ring, enter: b.enter }, b.tail && { text: b.tail, role: "t" }].filter(Boolean);
    let firstKeyAt = null;
    const lineHtml = lines.map((l, li) => {
      if (l.role !== "k") {
        const fb = li === 0 ? t0 : (firstKeyAt ?? t0) + 0.3;
        const cls = l.role === "t" ? "mn-tail" : l.role === "m" ? "mn-mid" : "mn-lead";
        return `<div class="${cls}"${l.size ? ` style="font-size:${l.size}px"` : ""}>${wordsIn(l.text, `l${li}-`, null, fb)}</div>`;
      }
      // a key line: a pale ghost on its first word, solid as it finishes (reference: 'wanna be', 'idea')
      const sayWords = String(l.say ?? l.text).split(/\s+/).filter(Boolean);
      const startSi = si;
      const s0 = timeOf(sayWords[0], null);
      let last = s0;
      for (const w of sayWords.slice(1)) last = timeOf(w, last) ?? last;
      if (s0 == null) si = startSi;
      const ka = r3(Math.max(t0, l.at != null ? E(l.at, "stack key") : (s0 ?? t0 + 0.05) - 0.04));
      const solid = r3(Math.min(ka + 0.5, Math.max(ka + 0.16, (last ?? ka) - 0.02)));
      firstKeyAt ??= ka;
      const size = l.size ?? Math.min(b.keyMax ?? 240, Math.round(1640 / Math.max(4, String(l.text).length)));
      const kid = `${id}-k${li}`;
      let label = esc(l.text);
      if (l.enter === "letters") {
        // hook: the key builds letter by letter, each one rising out of a blur
        const chars = [...String(l.text)];
        label = chars.map((c, ci) => `<span id="${kid}c${ci}" class="mn-letter">${c === " " ? "&nbsp;" : esc(c)}</span>`).join("");
        const step = Math.min(0.045, Math.max(0.02, (solid - ka + 0.12) / Math.max(1, chars.length)));
        tl.push(`tl.set("#${kid}", { autoAlpha: 1 }, ${ka});`);
        chars.forEach((_, ci) => tl.push(`ft("#${kid}c${ci}", { autoAlpha: 0, y: 90, rotation: ${ci % 2 ? 8 : -8}, filter: "blur(10px)" }, { autoAlpha: 1, y: 0, rotation: 0, filter: "blur(0px)", duration: 0.22, ease: "back.out(2)" }, ${r3(ka + ci * step)});`));
      } else if (l.enter === "rise") {
        tl.push(`ft("#${kid}", { autoAlpha: 0, y: 140, scaleY: 1.5, filter: "blur(16px)" }, { autoAlpha: 0.5, y: 40, scaleY: 1.2, filter: "blur(10px)", duration: ${r3(Math.max(0.08, solid - ka))}, ease: "power1.out" }, ${ka});`);
        tl.push(`tl.to("#${kid}", { autoAlpha: 1, y: 0, scaleY: 1, filter: "blur(0px)", duration: 0.14, ease: "power3.out" }, ${solid});`);
      } else if (l.enter !== "letters") {
        tl.push(`ft("#${kid}", { autoAlpha: 0, scale: 1.06, filter: "blur(10px)" }, { autoAlpha: 0.32, scale: 1.02, filter: "blur(2px)", duration: 0.08, ease: "none" }, ${ka});`);
        tl.push(`tl.to("#${kid}", { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: 0.14, ease: "power3.out" }, ${solid});`);
      }
      addSfx(solid, b.sfx ?? "click-1", "stack key", { db: -10 });
      let ring = "";
      if (l.ring) {
        ring = `<svg class="mn-ring" viewBox="0 0 100 40" preserveAspectRatio="none"><ellipse id="${kid}r" cx="50" cy="20" rx="48" ry="17" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg>`;
        tl.push(`ft("#${kid}r", { attr: { "stroke-dashoffset": 1 } }, { attr: { "stroke-dashoffset": 0 }, duration: 0.4, ease: "power2.inOut" }, ${r3(solid + 0.05)});`);
      }
      let pulse = "";
      if (l.pulse) {
        // a ring bursts out from behind the key as it lands
        pulse = `<i id="${kid}p" class="mn-pulse"></i>`;
        tl.push(`tl.set("#${kid}p", { autoAlpha: 0.7, scale: 0.4 }, ${solid}); tl.to("#${kid}p", { autoAlpha: 0, scale: 2.4, duration: 0.5, ease: "power2.out" }, ${solid});`);
        tl.push(`tl.to("#${kid}", { keyframes: [{ scale: 1.18, duration: 0.06 }, { scale: 1, duration: 0.22, ease: "back.out(3)" }] }, ${solid});`);
      }
      return `<div id="${kid}" class="mn-key" style="font-size:${size}px${l.color ? `;color:${l.color}` : ""}">${pulse}${ring}${label}</div>`;
    });
    const keyAt = firstKeyAt ?? t0;
    const firstK = lines.findIndex((l) => l.role === "k");
    const lead = lineHtml.slice(0, Math.max(0, firstK)).join("");
    const rest = lineHtml.slice(Math.max(0, firstK)).join("");

    let iconHtml = "";
    if (b.icon || b.logo) {
      const ia = r3(Math.max(t0, b.iconAt != null ? E(b.iconAt, "stack icon") : keyAt + 0.08));
      const size = b.iconSize ?? (b.logo ? 150 : bgIsPhone ? 150 : 230);
      if (b.logo) {
        const fill = b.logoFill ?? "#fff";
        iconHtml = `<div id="${id}-ic" class="mn-ic" style="width:${size}px;height:${size}px;background:${fill};-webkit-mask:url(${ctx.icon(b.logo)}) center/contain no-repeat;mask:url(${ctx.icon(b.logo)}) center/contain no-repeat"></div>`;
      } else {
        const src = ctx.userAsset(path.join(ctx.LIB, "engravings", "png", `${b.icon}.png`));
        iconHtml = `<div id="${id}-ic" class="mn-ic mn-eng" style="width:${size}px;height:${size}px;-webkit-mask:url(${src}) center/contain no-repeat;mask:url(${src}) center/contain no-repeat"></div>`;
      }
      tl.push(`ft("#${id}-icw", { autoAlpha: 0, scale: 0.4, y: 30 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.26, ease: "back.out(2.4)" }, ${ia});`);
      addSfx(ia, "pop-whoosh-light", "stack icon", { db: -4 });
      iconHtml = `<div id="${id}-icw">${bgIsPhone ? `<div class="mn-tile">${iconHtml}</div>` : iconHtml}</div>`;
    }
    // the block's height, so tall stacks centre on pages and stay inside the safe area on footage
    const est = lines.reduce((h, l) => h + (l.role === "k" ? (l.size ?? Math.min(b.keyMax ?? 240, Math.round(1640 / Math.max(4, String(l.text).length)))) * 0.92
      : l.role === "m" ? (brand.midSize ?? 96) * 1.04 : l.role === "t" ? (brand.tailSize ?? 46) * 1.4 : (l.size ?? brand.leadSize ?? 56) * 1.08), 0) + (iconHtml ? 240 : 0);
    const column = (top) => `<div class="mn-col" style="top:${top}px">${iconHtml}${lead}${rest}</div>`;
    const selfAt = b.self ?? b.at;
    const film = (cls) => `<video class="${cls}" src="${ctx.source}" data-start="${t0}" data-duration="${r3(t1 - t0)}" data-media-start="${selfAt}" data-track-index="19" muted playsinline></video>`;
    if (ground === "footage") {
      body = column(b.y ?? Math.round(Math.max(760, Math.min(1080, 1460 - est))));
      if (b.punch) {
        // hook: the camera punches in on the key, then drifts (a full-bleed copy of the footage, matched to #base)
        const base = ctx.zoomBase ?? 1;
        body = `<div id="${id}-fw" class="mn-full" style="position:absolute;inset:0">${film("mn-film")}</div>` + body;
        tl.push(`tl.set("#${id}-fw", { scale: ${base} }, ${t0});`);
        tl.push(`tl.to("#${id}-fw", { scale: ${r3(base * (b.punch === true ? 1.22 : b.punch))}, rotation: ${b.tilt ?? 0}, duration: 0.14, ease: "power3.out" }, ${keyAt});`);
        tl.push(`tl.to("#${id}-fw", { scale: ${r3(base * (b.punch === true ? 1.28 : b.punch + 0.06))}, duration: ${r3(Math.max(0.2, t1 - keyAt - 0.14))}, ease: "none" }, ${r3(keyAt + 0.14)});`);
      }
      customBg = "transparent";
    } else if (ground === "card") {
      // a tall stack shrinks the card so the last line still ends inside the safe area (~1500)
      const cardH = Math.round(Math.max(560, Math.min(900, 1500 - est - 280)));
      body = `<div id="${id}-card" class="mn-card" style="height:${cardH}px">${film("mn-film")}</div>${column(b.y ?? 330 + cardH - 60)}`;
      tl.push(`ft("#${id}-card", { scale: 0.9, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.24, ease: "expo.out" }, ${t0});`);
      customBg = brand.accent;
    } else if (ground === "phone") {
      const ui = `<div class="mn-ui"><i class="mn-top">‹<b>Reels</b>◎</i><i class="mn-rail">♡<br>◯<br>➤<br>⋯</i><i class="mn-user"><s></s>${esc(b.handle ?? "yourname")} · Follow</i><i class="mn-nav">⌂ ⌕ ⊕ ▷ ◯</i></div>`;
      body = `${lead ? `<div class="mn-col" style="top:${b.leadY ?? 230}px">${lead}</div>` : ""}<div id="${id}-ph" class="mn-phone">${film("mn-film")}${ui}${iconHtml ? `<div class="mn-phic">${iconHtml}</div>` : ""}</div><div class="mn-col" style="top:${b.y ?? 1480}px">${rest}</div>`;
      tl.push(`ft("#${id}-ph", { y: 120, autoAlpha: 0, scale: 0.92 }, { y: 0, autoAlpha: 1, scale: 1, duration: 0.32, ease: "expo.out" }, ${t0});`);
      tl.push(`tl.to("#${id}-ph", { scale: 1.04, duration: ${r3(Math.max(0.2, t1 - t0 - 0.32))}, ease: "none" }, ${r3(t0 + 0.32)});`);
      customBg = brand.accent;
    } else {
      body = column(b.y ?? Math.round(Math.max(260, 900 - est / 2)));
      customBg = ground === "paper" ? (brand.paper ?? "#FEFEFE") : brand.accent;
    }
    if (b.push) tl.push(`ft("#${id}-ink", { scale: 1.25, filter: "blur(8px)" }, { scale: 1, filter: "blur(0px)", duration: 0.3, ease: "expo.out" }, ${t0});`);
    const inkOf = (g) => (g === "paper" ? brand.accent : "#fff");
    body = `<div id="${id}-ink" class="mn-ink mn-on-${ground}" style="--ink:${inkOf(ground)}">${body}</div>`;
    // flips: the page swaps accent <-> paper (and the ink swaps with it) on a beat, a hard cut like the reference
    if (ground === "accent" || ground === "paper") {
      let g = ground;
      for (const f of b.flips || []) {
        const ft0 = r3(Math.max(t0, E(f, "stack flip")));
        g = g === "paper" ? "accent" : "paper";
        tl.push(`tl.set("#${sid}", { backgroundColor: "${g === "paper" ? (brand.paper ?? "#FEFEFE") : brand.accent}" }, ${ft0});`);
        tl.push(`tl.set("#${id}-ink", { "--ink": "${inkOf(g)}" }, ${ft0});`);
      }
    }
  }

  else throw new Error(`unknown scene kind '${b.kind}'`);

  transIn(ctx, `#${sid}`, inKind, t0);
  if (soundOf(ctx).paperIn && (b.kind === "paper" || b.kind === "collage")) ctx.addSfx(Math.max(0, t0 - 0.06), PAPER_IN[paperN++ % PAPER_IN.length], "paper in (page arrives)", { db: soundOf(ctx).paperDb ?? -2 });
  if (inKind === "expand" || inKind === "wipe") addSfx(t0, "whoosh", `scene in (${inKind})`);
  transOut(ctx, `#${sid}`, outKind, t1);
  return `<div id="${sid}" class="scene" style="background:${customBg ?? bg};background-size:220% 220%">${body}</div>`;
}

// editorial captions ------------------------------------------------------------
// Lines of <= group words (or up to punctuation); a block holds two lines. The
// word being spoken resolves out of blur in bold white; when the next line
// starts, the previous one relaxes to a light weight. Tag phrases become a
// tilted accent pill on their own line; highlight words get an accent box wipe.

// --- ported from origin/main bd7ae09, 1 Oct (pitch 5's pop cards) ---
// Literal pictures of tech/business ideas, drawn in HTML (no assets): the director picks one when a word means a
// concrete thing in THIS video's context ("tokens" in an AI video = text split into model tokens, not coins).
// Each returns { html, w, h } and pushes its own animation, starting at t0. Numbers are never invented: a card
// only shows counts it computes itself (e.g. its own token chips) or values the plan passes in.
const UI_COLORS = ["#c9d7ff", "#ffd9b8", "#c6f0d4", "#f6c8e6", "#fff0a8", "#d6ccff"];
export function uiCard(ui, id, t0, t1, ctx) {
  const { tl, r3, esc, brand } = ctx;
  const A = brand.accent;
  const card = (inner, w, h, pad = 34) => `<div class="ui-card" style="width:${w}px;min-height:${h}px;padding:${pad}px">${inner}</div>`;
  if (ui.type === "tokens") {
    // a sentence breaks into model tokens (words, sub-word pieces, punctuation), chips pop in, the count ticks up
    const text = ui.text || "How many tokens does this prompt use?";
    // like a real BPE tokenizer: common words stay whole, long words split into a stem + a suffix piece,
    // clitics ('s, 're) and punctuation are their own tokens
    const toks = (text.match(/[A-Za-z]+|'[a-z]+|\d+|[^\sA-Za-z\d']/g) || []).flatMap((t) => {
      if (!/^[A-Za-z]{8,}$/.test(t)) return [t];
      const m = /(ization|ation|tion|ing|ize|ise|ment|ness|able|ally|ed|er|ly|s)$/i.exec(t);
      const cut = m && t.length - m[0].length >= 4 ? t.length - m[0].length : t.length - 3;
      return [t.slice(0, cut), t.slice(cut)];
    });
    const chips = toks.map((t, i) => `<span id="${id}-t${i}" class="ui-tok" style="background:${UI_COLORS[i % UI_COLORS.length]}">${esc(t)}</span>`).join("");
    const step = Math.min(0.06, Math.max(0.025, (t1 - t0 - 0.5) / toks.length));
    tl.push(`ft("#${id}-t", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.1 }, ${r3(t0 + 0.1)});`);
    toks.forEach((t, i) => tl.push(`ft("#${id}-t${i}", { autoAlpha: 0, scale: 0.6, y: 10 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.16, ease: "back.out(2.5)" }, ${r3(t0 + 0.12 + i * step)});`));
    tl.push(`(() => { const o = { v: 0 }, el = document.getElementById("${id}-n"); tl.to(o, { v: ${toks.length}, duration: ${r3(toks.length * step)}, ease: "none", onUpdate: () => { el.textContent = Math.round(o.v) + " tokens"; } }, ${r3(t0 + 0.12)}); })();`);
    return { html: card(`<div class="ui-kicker" style="color:${A}">${esc(ui.title ?? "Tokenizer")}</div><div class="ui-toks">${chips}</div><div id="${id}-t" class="ui-count"><span id="${id}-n">0 tokens</span></div>`, 640, 300) };
  }
  if (ui.type === "calendar") {
    // a month grid; checks land on the repeating days one after another (how often a task happens)
    const days = ui.days ?? [1, 3, 5];   // Mon, Wed, Fri
    const cells = [];
    let k = 0;
    for (let wk = 0; wk < 4; wk++) for (let d = 0; d < 7; d++) {
      const on = days.includes(d);
      cells.push(`<div class="ui-day${on ? " on" : ""}">${on ? `<i id="${id}-c${k}" style="background:${A}">✓</i>` : ""}</div>`);
      if (on) { tl.push(`ft("#${id}-c${k}", { autoAlpha: 0, scale: 0.3 }, { autoAlpha: 1, scale: 1, duration: 0.14, ease: "back.out(3)" }, ${r3(t0 + 0.15 + k * 0.05)});`); k++; }
    }
    const head = ["M", "T", "W", "T", "F", "S", "S"].map((d) => `<div class="ui-dh">${d}</div>`).join("");
    return { html: card(`<div class="ui-kicker" style="color:${A}">${esc(ui.title ?? "Every week")}</div><div class="ui-cal">${head}${cells.join("")}</div>`, 560, 420) };
  }
  if (ui.type === "stopwatch") {
    // a stopwatch ring sweeps once: the time one run of a task costs
    const C = 2 * Math.PI * 120;
    tl.push(`ft("#${id}-arc", { strokeDashoffset: ${C} }, { strokeDashoffset: 0, duration: ${r3(Math.max(0.5, t1 - t0 - 0.25))}, ease: "none" }, ${r3(t0 + 0.1)});`);
    tl.push(`ft("#${id}-hand", { rotation: 0, svgOrigin: "150 165" }, { rotation: 360, svgOrigin: "150 165", duration: ${r3(Math.max(0.5, t1 - t0 - 0.25))}, ease: "none" }, ${r3(t0 + 0.1)});`);
    return { html: card(`<div class="ui-kicker" style="color:${A}">${esc(ui.title ?? "Time per run")}</div><svg viewBox="0 0 300 310" width="300" height="310"><rect x="135" y="8" width="30" height="22" rx="6" fill="#222"/><circle cx="150" cy="165" r="120" fill="#f4f5f8" stroke="#e1e3ea" stroke-width="16"/><circle id="${id}-arc" cx="150" cy="165" r="120" fill="none" stroke="${A}" stroke-width="16" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" transform="rotate(-90 150 165)"/><line id="${id}-hand" x1="150" y1="165" x2="150" y2="70" stroke="#111" stroke-width="7" stroke-linecap="round"/><circle cx="150" cy="165" r="10" fill="#111"/></svg>`, 420, 420) };
  }
  if (ui.type === "bars") {
    // before/after bars, the after bar grows past the before bar (relative, no numbers unless the plan gives them)
    const [l0, l1] = ui.labels ?? ["Before", "After"];
    tl.push(`ft("#${id}-b0", { scaleY: 0 }, { scaleY: 1, duration: 0.3, ease: "power3.out" }, ${r3(t0 + 0.12)});`);
    tl.push(`ft("#${id}-b1", { scaleY: 0 }, { scaleY: 1, duration: 0.45, ease: "power3.out" }, ${r3(t0 + 0.32)});`);
    return { html: card(`<div class="ui-kicker" style="color:${A}">${esc(ui.title ?? "Improvement")}</div><div class="ui-bars"><div class="ui-bar-col"><div id="${id}-b0" class="ui-bar" style="height:${ui.before ?? 110}px;background:#c9ccd6"></div><div class="ui-bl">${esc(l0)}</div></div><div class="ui-bar-col"><div id="${id}-b1" class="ui-bar" style="height:${ui.after ?? 250}px;background:${A}"></div><div class="ui-bl">${esc(l1)}</div></div></div>`, 520, 420) };
  }
  if (ui.type === "loop") {
    // two arrows chasing each other round a circle: something that repeats every single time
    tl.push(`ft("#${id}-rot", { rotation: 0, svgOrigin: "130 130" }, { rotation: 360, svgOrigin: "130 130", duration: ${r3(Math.max(0.6, t1 - t0))}, ease: "power1.inOut" }, ${r3(t0)});`);
    const arc = (r) => `<path d="M130 ${130 - r} A ${r} ${r} 0 0 1 ${130 + r} 130" fill="none" stroke="${A}" stroke-width="18" stroke-linecap="round"/><path d="M${130 + r - 16} 112 L${130 + r} 138 L${130 + r + 18} 112" fill="${A}"/>`;
    return { html: card(`<div class="ui-kicker" style="color:${A}">${esc(ui.title ?? "Every time")}</div><svg viewBox="0 0 260 260" width="260" height="260"><g id="${id}-rot">${arc(90)}<g transform="rotate(180 130 130)">${arc(90)}</g></g></svg>`, 400, 380) };
  }
  if (ui.type === "target") {
    // crosshair rings lock onto the centre: focus
    tl.push(`ft("#${id}-ring", { scale: 1.8, autoAlpha: 0, svgOrigin: "130 130" }, { scale: 1, autoAlpha: 1, svgOrigin: "130 130", duration: 0.35, ease: "expo.out" }, ${r3(t0 + 0.08)});`);
    tl.push(`ft("#${id}-dot", { scale: 0, svgOrigin: "130 130" }, { scale: 1, svgOrigin: "130 130", duration: 0.2, ease: "back.out(3)" }, ${r3(t0 + 0.38)});`);
    return { html: card(`<div class="ui-kicker" style="color:${A}">${esc(ui.title ?? "Focus")}</div><svg viewBox="0 0 260 260" width="260" height="260"><g id="${id}-ring" fill="none" stroke="#111" stroke-width="6"><circle cx="130" cy="130" r="100"/><circle cx="130" cy="130" r="60" stroke="${A}"/><line x1="130" y1="10" x2="130" y2="60"/><line x1="130" y1="200" x2="130" y2="250"/><line x1="10" y1="130" x2="60" y2="130"/><line x1="200" y1="130" x2="250" y2="130"/></g><circle id="${id}-dot" cx="130" cy="130" r="16" fill="${A}"/></svg>`, 400, 380) };
  }
  throw new Error(`unknown ui card '${ui.type}' (tokens, calendar, stopwatch, bars, loop, target)`);
}

// editorial captions ------------------------------------------------------------
// Lines of <= group words (or up to punctuation); a block holds two lines. The
// word being spoken resolves out of blur in bold white; when the next line
// starts, the previous one relaxes to a light weight. Tag phrases become a
// tilted accent pill on their own line; highlight words get an accent box wipe.

export function buildEditorialCaptions(words, cap, ctx, hidden) {
  const { tl, r3, esc, brand, rtl } = ctx;
  const tags = (cap.tags || []).map((p) => p.split(/\s+/).map(norm));
  const hl = new Set((cap.highlight || []).map(norm));
  const lines = [];
  let cur = null;
  const push = (l) => { if (l && l.words.length) lines.push(l); };
  for (let i = 0; i < words.length; i++) {
    const tag = tags.find((tw) => tw.every((x, k) => words[i + k] && norm(words[i + k].word) === x));
    if (tag) { push(cur); cur = null; lines.push({ tag: true, words: words.slice(i, i + tag.length) }); i += tag.length - 1; continue; }
    const w = words[i];
    if (!cur || cur.words.length >= (cap.group ?? 3) || (w.start - cur.words.at(-1).end > 0.6)) { push(cur); cur = { words: [] }; }
    cur.words.push(w);
    if (/[.?!,]$/.test(w.word)) { push(cur); cur = null; }
  }
  push(cur);
  // blocks: a tag line + the next line, or two plain lines
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    // a tag pill heads a block of up to two lines; plain blocks hold two lines
    let take = 1;
    while (take < (lines[i].tag ? 3 : 2) && lines[i + take] && !lines[i + take].tag) take++;
    blocks.push(lines.slice(i, i + take));
    i += take;
  }
  const html = blocks.map((bl, bi) => {
    const s = bl[0].words[0].start - 0.05;
    const nextS = bi + 1 < blocks.length ? blocks[bi + 1][0].words[0].start - 0.05 : ctx.SPEECH;
    // maxHold: never keep a finished block up longer than this after its last word
    const e = Math.min(bl.at(-1).words.at(-1).end + Math.min(0.5, cap.maxHold ?? 0.5), nextS, bl.at(-1).words.at(-1).end + (cap.maxHold ?? 99));
    const h = bl.reduce((n, ln) => n + (ln.tag ? brand.capSize * 1.35 : brand.capSize * 1.1), 0);
    const pl = ctx.placeCaption ? ctx.placeCaption(Math.max(0, s), e, h) : { y: cap.y ?? 1150, mode: "fixed" };
    const y = pl.y;
    const inner = bl.map((ln, li) => {
      const lid = `eb${bi}l${li}`;
      if (ln.tag) {
        const t = ln.words[0].start - 0.04;
        tl.push(`ft("#${lid}", { autoAlpha: 0, scale: 0.5, rotation: -16 }, { autoAlpha: 1, scale: 1, rotation: -6, duration: 0.3, ease: "back.out(1.7)" }, ${r3(t)});`);
        return `<span class="eline"><span id="${lid}" class="etag">${esc(ln.words.map((w) => w.word.replace(/[.,!?]$/, "")).join(" "))}</span></span>`;
      }
      if (li > 0 && !bl[li - 1].tag && bl[li - 1].words) tl.push(`tl.to("#eb${bi}l${li - 1} .ew:not(.eser):not(.ebold):not(.ealarm)", { fontWeight: 300, color: "rgba(255,255,255,0.86)", duration: 0.2, ease: "power2.out" }, ${r3(ln.words[0].start - 0.03)});`);
      return `<span id="${lid}" class="eline">${ln.words.map((w, wi) => {
        const wid = `${lid}w${wi}`;
        tl.push(`ft("#${wid}", { autoAlpha: 0, y: 10, filter: "blur(10px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.26, ease: "power3.out" }, ${r3(w.start - 0.03)});`);
        const txt = cap.upper ? w.word.toUpperCase() : cap.lowercase === false ? w.word : w.word.toLowerCase();
        // per-word treatments (captions.keywords): script = gold handwritten, bold = huge accent sans,
        // alarm = red while the frame drains to black and white
        const kw = (cap.keywords || {})[norm(w.word)];
        if (kw === "script" || (!kw && hl.has(norm(w.word)) && cap.keywordStyle === "serif")) {
          // handwriting: the script word writes itself on, in reading direction (left to right
          // normally; mirrored for rtl scripts so the reveal still tracks how the word is read)
          const clipFrom = rtl ? "inset(0% 0% 0% 100%)" : "inset(0% 100% 0% 0%)";
          const clipTo = rtl ? "inset(0% 0% 0% -10%)" : "inset(0% -10% 0% 0%)";
          tl.push(`ft("#${wid}", { clipPath: "${clipFrom}" }, { clipPath: "${clipTo}", duration: ${r3(Math.max(0.35, Math.min(0.7, w.end - w.start + 0.2)))}, ease: "power1.inOut" }, ${r3(w.start - 0.02)});`);
          if (cap.keywordSfx !== false && ctx.addSfx) ctx.addSfx(w.start, "whoosh", "keyword script", { db: -8 });
          return `<span id="${wid}" class="ew eser">${esc(txt)}</span>`;
        }
        if (kw === "bold") {
          tl.push(`ft("#${wid}", { scale: 0.6 }, { scale: 1, duration: 0.3, ease: "back.out(2)" }, ${r3(w.start - 0.02)});`);
          if (cap.keywordSfx !== false && ctx.addSfx) ctx.addSfx(w.start, "impact", "keyword bold", { db: -6 });
          return `<span id="${wid}" class="ew ebold">${esc(txt)}</span>`;
        }
        if (kw === "alarm") {
          const hold = Math.max(0.9, (w.end - w.start) + 0.8);
          tl.push(`tl.to("#base", { filter: "grayscale(1) contrast(1.1)", duration: 0.12, ease: "none" }, ${r3(w.start - 0.05)});`);
          tl.push(`tl.to("#base", { filter: "grayscale(0) contrast(1)", duration: 0.25, ease: "power1.out" }, ${r3(w.start + hold)});`);
          if (cap.keywordSfx !== false && ctx.addSfx) ctx.addSfx(w.start, "impact", "keyword alarm", { db: -4 });
          return `<span id="${wid}" class="ew ealarm">${esc(txt)}</span>`;
        }
        if (hl.has(norm(w.word))) {
          tl.push(`ft("#${wid}b", { scaleX: 0 }, { scaleX: 1, duration: 0.28, ease: "power3.out" }, ${r3(w.start)});`);
          return `<span class="ehl"><i id="${wid}b"></i><span id="${wid}" class="ew">${esc(txt)}</span></span>`;
        }
        return `<span id="${wid}" class="ew">${esc(txt)}</span>`;
      }).join("")}</span>`;
    }).join("");
    return `<div id="eb${bi}" class="eblock clip${pl.mode === "lower-face" ? " ebacked" : ""}" style="top:${y}px${pl.scale && pl.scale < 1 ? `;transform:scale(${pl.scale});transform-origin:50% 0` : ""}" data-start="${r3(Math.max(0, s))}" data-duration="${r3(Math.max(0.1, e - s))}" data-track-index="5">${inner}</div>`;
  }).join("\n      ");
  // hide the captions under full-screen scenes that don't want them
  tl.push(`tl.set("#ecaps", { autoAlpha: 1 }, 0);`);
  // merge overlapping windows first, or one window's "show" fires inside the next
  const merged = [];
  for (const [a, b] of [...hidden].sort((x, y) => x[0] - y[0])) {
    if (merged.length && a <= merged.at(-1)[1] + 0.05) merged.at(-1)[1] = Math.max(merged.at(-1)[1], b);
    else merged.push([a, b]);
  }
  for (const [a, b] of merged) { tl.push(`tl.to("#ecaps", { autoAlpha: 0, duration: 0.08 }, ${r3(a)});`); tl.push(`tl.to("#ecaps", { autoAlpha: 1, duration: 0.12 }, ${r3(b - 0.05)});`); }
  return { html: `<div id="ecaps">${html}</div>`, count: blocks.length };
}

// music bed -------------------------------------------------------------------
// Level = voice (-16 LUFS after prep.sh) + db, measured against the track's own
// integrated loudness, with fades. Returns an <audio> tag.
export function buildMusic(m, ctx, execFileSync, path, fs) {
  const { r3, proj, LIB, TOTAL } = ctx;
  let src = m.src;
  const manifestPath = path.join(LIB, "music", "manifest.json");
  if (m.id) {
    const man = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!man[m.id]) throw new Error(`music '${m.id}' not in library/music/manifest.json`);
    const musicSrc = path.join(LIB, "music", man[m.id].file);
    // manifest entries can outlive the audio: library/music/ ships no files at all today (the
    // Mixkit catalogue is kept for its licence record, not for playback - BRANCH-AUDIT decision
    // 4). Fail with the id and the missing path instead of a raw copyFileSync ENOENT.
    if (!fs.existsSync(musicSrc)) throw new Error(`music '${m.id}' is in library/music/manifest.json but library/music/${man[m.id].file} is not on disk; set "music": null (or supply "src" to your own track) instead of an id with no shipped file`);
    fs.mkdirSync(path.join(proj, "assets", "music"), { recursive: true });
    fs.copyFileSync(musicSrc, path.join(proj, "assets", "music", man[m.id].file));
    src = `assets/music/${man[m.id].file}`;
  }
  // the reveal: the bed plays muffled (low-pass, a touch quieter) through the hook, then opens to full on the turn
  // ("but...", "here's exactly how"). Pre-rendered so any player hears it the same way.
  // (R1b port)
  if (m.revealAt > 0.5) {
    const U = m.revealAt, R = m.revealRamp ?? 0.45, hz = m.revealHz ?? 650;
    const out = path.join(proj, "assets", "music", "score.wav");
    const f = `[0:a]atrim=start=${m.start ?? 0},asetpts=PTS-STARTPTS,asplit=2[d][w];` +
      `[w]lowpass=f=${hz},lowpass=f=${hz},volume=1.6,volume='if(lt(t,${U}),1,if(lt(t,${U + R}),1-(t-${U})/${R},0))':eval=frame[wet];` +
      `[d]volume='if(lt(t,${U}),0,if(lt(t,${U + R}),(t-${U})/${R},1))':eval=frame[dry];[wet][dry]amix=inputs=2:normalize=0,atrim=0:${TOTAL + 0.5}`;
    const r = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", path.resolve(proj, src), "-filter_complex", f, "-ar", "44100", out], { encoding: "utf8" });
    if (r.status === 0) { src = "assets/music/score.wav"; m = { ...m, start: 0 }; }
  }
  const err = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", path.resolve(proj, src), "-t", "60", "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const I = parseFloat((err.match(/I:\s+(-?[\d.]+) LUFS/g) || ["I: -14"]).at(-1).split(/\s+/).at(-2));
  const target = -16 + (m.db ?? -20);
  const vol = r3(Math.min(3.98, Math.pow(10, (target - I) / 20)));
  const fi = m.fadeIn ?? 0.6, fo = m.fadeOut ?? 1.2;
  // drops: the beat stops for ~0.5 s right before a payoff line and comes back ON it (Alif: 1-2 per reel)
  const pts = [{ t: 0, v: fi > 0.02 ? 0 : vol }, { t: Math.max(0.01, fi), v: vol }];
  for (const d of [...(m.dropTimes || [])].sort((a, b) => a - b)) {
    const len = m.dropLen ?? 0.5;
    if (d - len < fi + 0.2 || d > TOTAL - fo - 0.1) continue;
    pts.push({ t: r3(d - len - 0.03), v: vol }, { t: r3(d - len), v: 0 }, { t: r3(d - 0.02), v: 0 }, { t: r3(d), v: vol });
  }
  pts.push({ t: r3(TOTAL - Math.max(0.02, fo)), v: vol }, { t: r3(TOTAL), v: fo > 0.02 ? 0 : vol });
  const lane = JSON.stringify({ version: 1, lanes: [{ target: "volume", points: pts }] });
  return { html: `<audio id="music-bed" src="${src}" data-start="0" data-duration="${TOTAL}" data-media-start="${m.start ?? 0}" data-track-index="20" data-automation='${lane}'></audio>`, vol, I };
}

// Prompt Motion graphic fixtures (PM2): one good graphic and the deliberately bad ones the render proofs refuse.
// Used by graphic.test.mjs (static rules, no render) and graphic-render-check.mjs (real renders, not in the gate).
export const RNG = `window.rng = window.rng || function (seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0; var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };`;

// a moving shape + text (an engine font) + seeded particles; every style from t alone
export function goodGraphic({ duration = 2, w = 1080, h = 1080, extraHead = "", extraScript = "", seekExtra = "" } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  #stage { position: absolute; inset: 0; }
  #disc { position: absolute; width: 220px; height: 220px; border-radius: 50%; background: #f2c14e; }
  #count { position: absolute; left: 0; right: 0; top: ${Math.round(h * 0.62)}px; text-align: center; color: #ffffff;
    font-family: 'Montserrat', sans-serif; font-weight: 800; font-size: 120px; }
  .spark { position: absolute; width: 14px; height: 14px; border-radius: 50%; background: #ff6b3d; }
</style>${extraHead}
</head><body>
<div id="stage"><div id="disc"></div><div id="count">10,000</div></div>
<script>
  window.duration = ${duration};
  window.size = { w: ${w}, h: ${h} };
  ${RNG}
  var r = window.rng(42), sparks = [], stage = document.getElementById("stage");
  for (var i = 0; i < 40; i++) {
    var el = document.createElement("div"); el.className = "spark"; stage.appendChild(el);
    sparks.push({ el: el, x: r() * ${w}, y: r() * ${h}, v: 0.5 + r(), a: r() * 6.283 });
  }
  ${extraScript}
  window.seek = function (t) {
    var p = Math.min(1, t / ${(duration * 0.6).toFixed(2)}), e = 1 - Math.pow(1 - p, 3);
    var n = Math.round(10000 + 70000 * e);
    document.getElementById("count").textContent = n.toLocaleString("en-US");
    var d = document.getElementById("disc");
    d.style.transform = "translate(" + (80 + e * ${w - 380}) + "px," + (120 + Math.sin(t * 3) * 60) + "px) scale(" + (0.6 + 0.4 * e) + ")";
    for (var i = 0; i < sparks.length; i++) {
      var s = sparks[i], dist = 160 * s.v * t;
      s.el.style.transform = "translate(" + (s.x + Math.cos(s.a) * dist) + "px," + (s.y + Math.sin(s.a) * dist) + "px)";
      s.el.style.opacity = String(Math.max(0, 1 - t / ${duration}));
    }
    ${seekExtra}
  };
</script>
</body></html>
`;
}
// R1: passes the static scan (a dynamic load, as the spec lists) but asks for the network at render
export const fetchAtRender = () => goodGraphic({
  extraScript: `var im = new Image(); im.src = "https://example.com/spark.png"; stage.appendChild(im);
  stage.insertAdjacentHTML("beforeend", '<img src="https://example.com/b.png">');`,
});
// R4: throws inside seek from t >= 1
export const throwsInSeek = () => goodGraphic({ seekExtra: `if (t >= 1) { throw new Error("boom at " + t.toFixed(2)); }` });
// an insert: full frame 1080x1920
export const insertGraphic = () => goodGraphic({ w: 1080, h: 1920 });
// R6: not deterministic. Math.random and Date are refused statically (G11, G12), so this one carries state from one
// seek to the next (allowed by the scan, forbidden by the contract): the frame a worker draws depends on what it drew before
export const statefulSeek = () => goodGraphic({ extraScript: "var calls = 0;", seekExtra: `calls++; d.style.borderRadius = (calls % 7) * 6 + "px";` });
// R9: renders, deterministic, but nothing is ever visible
export const invisible = () => goodGraphic({ seekExtra: `document.getElementById("stage").style.opacity = "0";` });

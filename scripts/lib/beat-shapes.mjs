// Beat shapes the build checks before it draws (mac-72): a shape a model can plausibly write must never reach the screen as
// "undefined" or crash with a native-code error. checkShape(b) returns
//   { fatal }                      the build stops with this line (it names the field and the shape it wanted), or
//   { skip }                       the whole beat is left out, with this warning (and a graphics-dropped.json record), or
//   { warnings: [...] }            the beat is drawn, minus the parts named here (b is fixed in place), or {} when it is fine.
const isStr = (x) => typeof x === "string" && x.trim() !== "";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const got = (x) => (x === undefined ? "nothing" : Array.isArray(x) ? "a list" : isObj(x) ? `an object with ${Object.keys(x).join(", ") || "no keys"}` : `${typeof x} ${JSON.stringify(x)}`.slice(0, 60));

export function checkShape(b) {
  const where = b.type === "scene" ? `scene ${b.kind} at ${b.at}` : `${b.type} at ${b.at}`;
  if (b.type === "scene" && (b.kind === "gm-nodes" || b.kind === "card") && b.pill !== undefined && !(isObj(b.pill) && isStr(b.pill.text) && isNum(b.pill.at)))
    return { fatal: `${where}: \`pill\` must be {text: string, at: number} (got ${got(b.pill)})` };
  if (b.type === "scene" && b.kind === "gm-nodes" && b.nodes !== undefined) {
    if (!Array.isArray(b.nodes)) return { fatal: `${where}: \`nodes\` must be a list of {n?, at: number} (got ${got(b.nodes)})` };
    const bad = b.nodes.findIndex((nd) => !isObj(nd) || !isNum(nd.at));
    if (bad >= 0) return { fatal: `${where}: nodes[${bad}] must be {n?, at: number} (got ${got(b.nodes[bad])})` };
  }
  const need = { "hz-title": "text", "hz-note": "text", "hz-name": "name" }[b.type];
  if (need && !isStr(b[need])) return { skip: `${where}: \`${need}\` must be a non-empty string (got ${got(b[need])}): skipped, nothing drawn` };
  if (b.type === "hz-list") {
    if (!Array.isArray(b.items)) return { skip: `${where}: \`items\` must be a list of {title, sub?, at} (got ${got(b.items)}): skipped` };
    const warnings = [], keep = [];
    b.items.forEach((it, i) => {
      if (isObj(it) && isStr(it.title) && (it.sub === undefined || isStr(it.sub))) keep.push(it);
      else warnings.push(`${where}: items[${i}] needs a \`title\` string (items are {title, sub?, at}; got ${got(it)}): item skipped`);
    });
    if (!keep.length) return { skip: `${where}: no item has a \`title\` (items are {title, sub?, at}): skipped, nothing drawn` };
    b.items = keep;
    return { warnings };
  }
  return {};
}

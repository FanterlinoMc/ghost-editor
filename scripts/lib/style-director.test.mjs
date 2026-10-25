// node --test scripts/lib/style-director.test.mjs
// The `director` block of every style, resolved through `extends` (references/styles.md, "The director block"):
// its shape, podcast's keyword cap, and that closer and its variants stay free (no block = no paid director call).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "styles");
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = isObj(v) && isObj(o[k]) ? merge(o[k], v) : v; return o; };
const raw = (id) => JSON.parse(fs.readFileSync(path.join(STYLES, `${id}.json`), "utf8"));
const resolve = (id, seen = []) => { const s = raw(id); return s.extends && !seen.includes(s.extends) ? merge(resolve(s.extends, [...seen, id]), s) : s; };
// every style, styles/library/ included (ids are paths relative to styles/, as `extends` names them)
const walk = (d, pre = "") => fs.readdirSync(path.join(STYLES, pre)).flatMap((f) => fs.statSync(path.join(STYLES, pre, f)).isDirectory()
  ? walk(d, path.join(pre, f)) : f.endsWith(".json") ? [path.join(pre, f.slice(0, -5))] : []);
const ids = walk(STYLES);
// the limits keys DOCUMENTED in references/styles.md ("The director block" table), parsed from the doc rather than
// listed here, so a style cannot set a key the doc does not explain (which says which are enforced and which are not)
const DOC = fs.readFileSync(path.join(STYLES, "..", "references", "styles.md"), "utf8");
const DIRECTOR_DOC = DOC.slice(DOC.indexOf("## The `director` block"), DOC.indexOf("\n## ", DOC.indexOf("## The `director` block") + 5));
const LIMIT_KEYS = new Set([...DIRECTOR_DOC.matchAll(/`limits\.([a-z_]+)`/g)].map((m) => m[1]));

test("every resolved director block: an object, with a well-formed `limits`", () => {
  let blocks = 0;
  for (const id of ids) {
    const d = resolve(id).director;
    if (d === undefined) continue;
    blocks++;
    assert.ok(isObj(d), `${id}: director must be an object`);
    for (const [k, v] of Object.entries(d)) {
      if (k === "limits") {
        assert.ok(isObj(v), `${id}: limits must be an object`);
        for (const [lk, lv] of Object.entries(v)) {
          assert.ok(LIMIT_KEYS.has(lk), `${id}: limits.${lk} is not in references/styles.md "The director block" table (document it there first, enforced or not)`);
          assert.ok(typeof lv === "number" && lv >= 0, `${id}: limits.${lk} must be a number >= 0`);
        }
      }
    }
  }
  assert.ok(blocks >= 10, `expected the adopted director blocks, found ${blocks}`);
  assert.ok(LIMIT_KEYS.size >= 8 && LIMIT_KEYS.has("keywords_per_min"), `parsed the doc table: ${[...LIMIT_KEYS]}`);
});

test("podcast's keyword cap is 24 per minute (the director's default is 6)", () => {
  assert.equal(resolve("podcast").director.limits.keywords_per_min, 24);
});

test("closer and every style extending it have NO director block (a block = a paid director call per reel)", () => {
  const chain = (id) => { const out = [id]; let s = raw(id); while (s.extends && !out.includes(s.extends)) { out.push(s.extends); s = raw(s.extends); } return out; };
  const closers = ids.filter((id) => chain(id).includes("closer"));
  assert.ok(closers.length >= 7, closers.join(","));
  for (const id of closers) assert.equal(resolve(id).director, undefined, id);
});

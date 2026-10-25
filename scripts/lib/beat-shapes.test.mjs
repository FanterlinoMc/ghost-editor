// node --test scripts/lib/beat-shapes.test.mjs
// lib/beat-shapes.mjs: the shapes a model can plausibly write wrong never draw "undefined" and never crash natively.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkShape } from "./beat-shapes.mjs";

test("a gm-nodes / card pill that is not {text, at} is fatal, and the line names the field and the shape", () => {
  for (const kind of ["gm-nodes", "card"]) {
    for (const pill of ["English", { text: "English" }, { at: 31 }, { text: "", at: 31 }, ["English"]]) {
      const r = checkShape({ type: "scene", kind, at: 30, pill });
      assert.match(r.fatal ?? "", /`pill` must be \{text: string, at: number\}/, `${kind} ${JSON.stringify(pill)}`);
    }
    assert.deepEqual(checkShape({ type: "scene", kind, at: 30, pill: { text: "English", at: 31.3 } }), {});
  }
  assert.match(checkShape({ type: "scene", kind: "gm-nodes", at: 30, nodes: [{ n: 1 }] }).fatal, /nodes\[0\] must be \{n\?, at: number\}/);
});

test("hz-list items without a title are skipped with a warning; none left skips the beat", () => {
  const b = { type: "hz-list", at: 30, items: [{ title: "Sheffield", at: 30.2 }, { text: "France", at: 31 }] };
  const r = checkShape(b);
  assert.equal(b.items.length, 1);
  assert.match(r.warnings[0], /items\[1\] needs a `title` string/);
  assert.match(checkShape({ type: "hz-list", at: 30, items: [{ text: "a", at: 30.2 }] }).skip, /no item has a `title`/);
  assert.match(checkShape({ type: "hz-list", at: 30 }).skip, /`items` must be a list/);
  assert.deepEqual(checkShape({ type: "hz-list", at: 30, items: [{ title: "a", sub: "b", at: 30.2 }] }), { warnings: [] });
});

test("hz-title / hz-note / hz-name without their text are skipped, never drawn", () => {
  assert.match(checkShape({ type: "hz-title", at: 30 }).skip, /`text` must be a non-empty string/);
  assert.match(checkShape({ type: "hz-note", at: 30, text: 7 }).skip, /`text`/);
  assert.match(checkShape({ type: "hz-name", at: 30, title: "Student" }).skip, /`name`/);
  assert.deepEqual(checkShape({ type: "hz-name", at: 30, name: "James" }), {});
});

test("every other beat passes through untouched", () => {
  for (const b of [{ type: "big", text: "3x" }, { type: "scene", kind: "stats" }, { type: "emoji", emoji: "x" }]) assert.deepEqual(checkShape(b), {});
});

// node --test scripts/lib/style-path.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStyleName, resolveStylePath, loadStyleChain, checkBrandName } from "./style-path.mjs";

const deepMerge = (a, b) => {
  if (b === undefined) return a;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const o = { ...a };
    for (const k of Object.keys(b)) o[k] = deepMerge(a[k], b[k]);
    return o;
  }
  return b;
};
// resolveStylePath falls back to process.env.USER_STYLES_DIR when the option is undefined; the studio container sets it
// (/data/templates), which made "missing USER_STYLES_DIR dies" fail on Linux. These tests pass the folder explicitly.
delete process.env.USER_STYLES_DIR;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "style-path-"));
const stylesDir = path.join(tmp, "styles"), userDir = path.join(tmp, "user");
fs.mkdirSync(stylesDir); fs.mkdirSync(userDir);
const put = (dir, rel, obj) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
put(stylesDir, "base.json", { _about: "x", brand: { accent: "#111111", ink: "#000000" }, captions: { size: 50 } });
put(stylesDir, "mid.json", { extends: "base", captions: { size: 60 } });
put(stylesDir, "loop-a.json", { extends: "loop-b" });
put(stylesDir, "loop-b.json", { extends: "loop-a" });
put(stylesDir, "kitted.json", { brandKit: "acme", brand: { accent: "#222222" } });
put(userDir, "mine/style.json", { extends: "mid", brand: { accent: "#ff0000" }, brandKit: "acme" });
put(userDir, "chain/style.json", { extends: "user:mine" });
put(userDir, "over-kitted/style.json", { extends: "kitted" });
put(userDir, "bad-ext/style.json", { extends: "../base" });
const opts = { stylesDir, userStylesDir: userDir, deepMerge };

test("built-in names resolve into stylesDir", () => {
  assert.deepEqual(resolveStylePath("keynote-3", { stylesDir }), { user: false, id: "keynote-3", file: path.join(stylesDir, "keynote-3.json") });
  for (const n of ["a", "0abc", "a-b-c", "a".repeat(64)]) assert.equal(parseStyleName(n).user, false);
});
test("user names resolve into USER_STYLES_DIR/<id>/style.json", () => {
  const r = resolveStylePath("user:my-look", { stylesDir, userStylesDir: userDir });
  assert.deepEqual(r, { user: true, id: "my-look", file: path.join(userDir, "my-look", "style.json") });
});
test("bad names are refused", () => {
  const bads = ["../x", "user:../x", "a/b", "a\\b", "user:a/b", "/etc/passwd", "C:\\x", "C:/x", "", "user:", "Upper", "user:Upper", "-lead", "user:-lead",
    "caf\u00e9", "user:caf\u00e9", "\u0430bc", "a.b", "a b", "a\0b", "a".repeat(65), "user:user:x", "USER:x", " x", "x\n", ".", ".."];
  for (const n of bads) assert.throws(() => resolveStylePath(n, { stylesDir, userStylesDir: userDir }), /bad style name/, JSON.stringify(n));
  for (const n of [null, undefined, 5, {}, ["a"]]) assert.throws(() => parseStyleName(n), /bad style name/);
});
test("missing USER_STYLES_DIR dies with a clear message", () => {
  assert.throws(() => resolveStylePath("user:mine", { stylesDir, userStylesDir: "" }), /USER_STYLES_DIR is not set/);
  assert.throws(() => loadStyleChain("user:mine", { stylesDir, userStylesDir: undefined, deepMerge }), /USER_STYLES_DIR|not set/);
});
test("built-in extends chain merges", () => {
  const { style } = loadStyleChain("mid", opts);
  assert.deepEqual(style, { brand: { accent: "#111111", ink: "#000000" }, captions: { size: 60 } });
});
test("a user style extends a built-in; brandKit in it is dropped with a warning", () => {
  const { style, warnings } = loadStyleChain("user:mine", opts);
  assert.equal(style.brand.accent, "#ff0000");
  assert.equal(style.brand.ink, "#000000");
  assert.equal(style.captions.size, 60);
  assert.ok(!("brandKit" in style) && !("extends" in style));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /brandKit/);
});
test("brandKit inherited from a built-in base is kept", () => {
  assert.equal(loadStyleChain("user:over-kitted", opts).style.brandKit, "acme");
});
test("a user style extending a user style is refused", () => {
  assert.throws(() => loadStyleChain("user:chain", opts), /only a built-in/);
});
test("a user style extending a traversal name is refused", () => {
  assert.throws(() => loadStyleChain("user:bad-ext", opts), /bad style name/);
});
test("cycles are caught", () => {
  assert.throws(() => loadStyleChain("loop-a", opts), /extends itself/);
});
test("unknown styles say so", () => {
  assert.throws(() => loadStyleChain("nope", opts), /unknown style 'nope'; have: .*base/);
  assert.throws(() => loadStyleChain("user:nope", opts), /unknown user style/);
});
test("brand kit names", () => {
  assert.equal(checkBrandName("acme-2"), "acme-2");
  for (const n of ["../x", "a/b", "", "Acme", "a.b", "caf\u00e9", 5]) assert.throws(() => checkBrandName(n), /bad brand kit name/);
});
test("a user style with broken JSON fails readably", () => {
  fs.mkdirSync(path.join(userDir, "broken")); fs.writeFileSync(path.join(userDir, "broken", "style.json"), "{nope");
  assert.throws(() => loadStyleChain("user:broken", opts), /not valid JSON/);
});

test("library/<id> resolves into styles/library and chains to a built-in", () => {
  put(stylesDir, "library/lib-a.json", { extends: "mid", captions: { size: 70 } });
  put(stylesDir, "library/lib-b.json", { extends: "library/lib-a", brand: { accent: "#0000ff" } });
  assert.deepEqual(resolveStylePath("library/lib-a", { stylesDir }), { user: false, id: "lib-a", library: true, file: path.join(stylesDir, "library", "lib-a.json") });
  const { style } = loadStyleChain("library/lib-b", opts);
  assert.equal(style.captions.size, 70);
  assert.equal(style.brand.accent, "#0000ff");
  assert.equal(style.brand.ink, "#000000");
  assert.throws(() => loadStyleChain("library/nope", opts), /unknown library style/);
  for (const n of ["library/", "library/../x", "library/a/b", "user:library/x", "library//x", "Library/x", "library/Upper"]) assert.throws(() => parseStyleName(n), /bad style name/, n);
});

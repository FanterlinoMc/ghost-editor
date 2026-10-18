// Style-name resolver. The ONE place a style or brand-kit name becomes a path.
//
//   "keynote-3"      -> <stylesDir>/keynote-3.json                 (built-in, shipped in the fork)
//   "library/podcast-punch--19" -> <stylesDir>/library/podcast-punch--19.json  (Ahmed's trained library, a sub-folder of styles/)
//   "user:my-look"   -> $USER_STYLES_DIR/my-look/style.json        (a saved user template)
//
// Ids must match ^[a-z0-9][a-z0-9-]{0,63}$ (optionally prefixed "user:"). Anything else is refused with
// "bad style name" before any path is built, so a name can never carry "..", a separator, a drive letter or
// an absolute path. A user style's `extends` may name ONLY a built-in (no "user:" chains).
// Spec: ASSISTANT-EDITS-AND-TEMPLATES-SPEC.md B2.
import fs from "node:fs";
import path from "node:path";

export const STYLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const BRAND_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
export const USER_PREFIX = "user:";
export const LIBRARY_PREFIX = "library/";

const bad = (name, why) => new Error(`bad style name ${JSON.stringify(name)}: ${why}`);

// -> { user: boolean, id: string, library?: true }; throws "bad style name" on anything unsafe.
// "library/<id>" is the ONLY name with a separator: the literal prefix, then an id that passes the same check.
export function parseStyleName(name) {
  if (typeof name !== "string") throw bad(name, "must be a string");
  const user = name.startsWith(USER_PREFIX);
  const library = !user && name.startsWith(LIBRARY_PREFIX);
  const id = user ? name.slice(USER_PREFIX.length) : library ? name.slice(LIBRARY_PREFIX.length) : name;
  if (!STYLE_ID_RE.test(id)) throw bad(name, `id must match ${STYLE_ID_RE} (optionally prefixed "user:" or "library/")`);
  return library ? { user, id, library } : { user, id };
}

export function checkBrandName(id) {
  if (typeof id !== "string" || !BRAND_ID_RE.test(id)) throw new Error(`bad brand kit name ${JSON.stringify(id)}: must match ${BRAND_ID_RE}`);
  return id;
}

// -> { user, id, file }. Does not touch the disk. A "user:" name with no userStylesDir throws.
export function resolveStylePath(name, { stylesDir, userStylesDir = process.env.USER_STYLES_DIR } = {}) {
  const { user, id, library } = parseStyleName(name);
  if (library) return { user, id, library, file: path.join(stylesDir, "library", `${id}.json`) };
  if (!user) return { user, id, file: path.join(stylesDir, `${id}.json`) };
  if (!userStylesDir) throw new Error(`style ${JSON.stringify(name)} is a user style but USER_STYLES_DIR is not set`);
  return { user, id, file: path.join(userStylesDir, id, "style.json") };
}

// Loads a style with its `extends` chain. A built-in may extend a built-in; a user style may extend a built-in only.
// -> { style, warnings }. Throws Error with a readable message (callers die()).
export function loadStyleChain(name, { stylesDir, userStylesDir = process.env.USER_STYLES_DIR, deepMerge }, seen = [], warnings = []) {
  const { user, id, library, file } = resolveStylePath(name, { stylesDir, userStylesDir });
  if (!fs.existsSync(file)) {
    if (library) throw new Error(`unknown library style '${name}'; have ${fs.readdirSync(path.join(stylesDir, "library")).length} under styles/library/`);
    if (user) throw new Error(`unknown user style '${name}'`);
    throw new Error(`unknown style '${name}'; have: ${fs.readdirSync(stylesDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).join(", ")}`);
  }
  if (seen.includes(name)) throw new Error(`style '${name}' extends itself`);
  let own;
  try { own = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`style '${name}' is not valid JSON: ${e.message}`); }
  if (!own || typeof own !== "object" || Array.isArray(own)) throw new Error(`style '${name}' must be a JSON object`);
  delete own._about;
  if (user && "brandKit" in own) {
    warnings.push(`user style '${name}': brandKit is not allowed in a user style and was ignored`);
    delete own.brandKit;
  }
  let base = {};
  if (own.extends != null) {
    if (typeof own.extends !== "string") throw new Error(`style '${name}': extends must be a string`);
    if (own.extends.startsWith(USER_PREFIX)) throw new Error(`style '${name}': extends may name only a built-in style, not '${own.extends}'`);
    base = loadStyleChain(own.extends, { stylesDir, userStylesDir, deepMerge }, [...seen, name], warnings).style;
  }
  delete own.extends;
  return { style: deepMerge(base, own), warnings };
}

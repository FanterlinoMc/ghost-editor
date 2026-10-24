// mac-56: CAPTION_EMOJI_EM is used only with a matching stamp, at or above the host's measured advance; else 1.5.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { resolveEmojiEm } from "./lib/emoji-em.mjs";
import { clippingExtent, EMOJI_EM } from "./lib/caption-metrics.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emojiem-"));
const font = path.join(dir, "emoji.ttf"); fs.writeFileSync(font, "not really a font, only its bytes are hashed");
const sha = crypto.createHash("sha256").update(fs.readFileSync(font)).digest("hex");
const stamp = (o = {}) => { const f = path.join(dir, `s${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify({ advance: 1.248, font, sha256: sha, chrome: "x", ...o })); return f; };

test("unset: 1.5, silently (every existing deployment builds as before)", () => {
  assert.deepEqual(resolveEmojiEm({}), { em: EMOJI_EM, source: "default", warning: null });
  assert.deepEqual(resolveEmojiEm({ CAPTION_EMOJI_EM: " " }), { em: EMOJI_EM, source: "default", warning: null });
});

test("a measured host value is used when every guard holds", () => {
  assert.deepEqual(resolveEmojiEm({ CAPTION_EMOJI_EM: "1.248", CAPTION_EMOJI_STAMP: stamp() }), { em: 1.248, source: "host", warning: null });
  assert.equal(resolveEmojiEm({ CAPTION_EMOJI_EM: "1.3", CAPTION_EMOJI_STAMP: stamp() }).em, 1.3, "above the advance is fine");
});

test("every failed guard falls back to 1.5 with a warning that says why", () => {
  const why = (env) => { const r = resolveEmojiEm(env); assert.equal(r.em, 1.5); assert.equal(r.source, "default"); return r.warning; };
  assert.match(why({ CAPTION_EMOJI_EM: "1.2", CAPTION_EMOJI_STAMP: stamp() }), /below this host's measured advance 1\.248 em/);
  assert.match(why({ CAPTION_EMOJI_EM: "abc", CAPTION_EMOJI_STAMP: stamp() }), /not a positive number/);
  assert.match(why({ CAPTION_EMOJI_EM: "1.248" }), /CAPTION_EMOJI_STAMP is not set/);
  assert.match(why({ CAPTION_EMOJI_EM: "1.248", CAPTION_EMOJI_STAMP: path.join(dir, "missing.json") }), /cannot be read/);
  assert.match(why({ CAPTION_EMOJI_EM: "1.248", CAPTION_EMOJI_STAMP: stamp({ sha256: "0".repeat(64) }) }), /changed since it was measured/);
  assert.match(why({ CAPTION_EMOJI_EM: "1.248", CAPTION_EMOJI_STAMP: stamp({ font: path.join(dir, "gone.ttf") }) }), /is gone/);
  assert.match(why({ CAPTION_EMOJI_EM: "1.248", CAPTION_EMOJI_STAMP: stamp({ advance: "x" }) }), /has no advance, font and sha256/);
  assert.match(why({ CAPTION_EMOJI_EM: "1.2", CAPTION_EMOJI_STAMP: stamp() }), /measure this host: node scripts\/emoji-advance\.mjs --write <stamp>/);
});

test("the tighter value reserves less: an emoji-heavy group models fewer lines at Noto's 1.248 than at 1.5", () => {
  const ws = ["what", "\"👍😂🇺🇸😂😂", "photographers👍🏽🇺🇸💯🎉👍👍🏽”", "👍"];
  assert.ok(clippingExtent(ws, { size: 58, maxWidth: 820, emojiEm: 1.248 }).lines <= clippingExtent(ws, { size: 58, maxWidth: 820 }).lines);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

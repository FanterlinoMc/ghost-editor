#!/usr/bin/env node
// node --test scripts/face-track-model.test.mjs
// face_track.py's model fetch (ensure_model): the URL is pinned to one opencv_zoo commit, a download is checked by size
// and sha256 before it is renamed into place, a bad download leaves no file (and no .part) behind and fails with a clear
// message, and a present file that does not verify is downloaded again once. No network: the download is replaced by a
// stub that writes chosen bytes. Needs any python 3 (stdlib only; face_track.py imports OpenCV only when it runs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const python = ["python3", "py", "python"].find((c) => spawnSync(c, ["-c", "import sys; assert sys.version_info >= (3, 8)"], { stdio: "ignore" }).status === 0);

const HARNESS = String.raw`
import hashlib, importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("face_track", sys.argv[1])
ft = importlib.util.module_from_spec(spec); spec.loader.exec_module(ft)
d = sys.argv[2]
GOOD = b"pinned-model-bytes" * 100
SIZE, SHA = len(GOOD), hashlib.sha256(GOOD).hexdigest()
calls = []
def stub(payloads):
    def dl(url, dest):
        calls.append(url)
        p = payloads.pop(0)
        if isinstance(p, Exception):
            open(dest, "wb").write(b"half")
            raise p
        open(dest, "wb").write(p)
    ft._download = dl
def run(name, present, payloads):
    path = os.path.join(d, name, "model.onnx")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if present is not None:
        open(path, "wb").write(present)
    calls.clear(); stub(list(payloads))
    try:
        ft.ensure_model(path, url="https://example.invalid/model.onnx", size=SIZE, sha256=SHA); err = None
    except ft.ModelError as e:
        err = str(e)
    data = open(path, "rb").read() if os.path.exists(path) else None
    return {"err": err, "ok": data == GOOD, "exists": data is not None, "downloads": len(calls),
            "left": sorted(os.listdir(os.path.dirname(path)))}
out = {
    "url": ft.MODEL_URL, "sha": ft.MODEL_SHA256, "size": ft.MODEL_SIZE,
    "fresh": run("fresh", None, [GOOD]),
    "bad_download": run("bad_download", None, [GOOD[:-1] + b"X"]),
    "short_download": run("short_download", None, [GOOD[:10]]),
    "raises": run("raises", None, [OSError("network down")]),
    "present_ok": run("present_ok", GOOD, []),
    "present_bad_redownload": run("present_bad_redownload", b"corrupt", [GOOD]),
    "present_bad_twice": run("present_bad_twice", b"corrupt", [b"still corrupt"]),
}
print(json.dumps(out))
`;

test("face_track.py ensure_model: pinned URL, verified download, atomic rename, one retry for a bad file", { skip: !python && "no python 3" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "face-model-"));
  try {
    const r = spawnSync(python, ["-c", HARNESS, path.join(HERE, "face_track.py"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout.trim().split("\n").at(-1));
    assert.equal(o.url, "https://github.com/opencv/opencv_zoo/raw/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx");
    assert.equal(o.sha, "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4");
    assert.equal(o.size, 232589);
    assert.deepEqual(o.fresh, { err: null, ok: true, exists: true, downloads: 1, left: ["model.onnx"] });
    for (const k of ["bad_download", "short_download"]) {
      assert.equal(o[k].exists, false, `${k}: a download that does not verify must not be left in place`);
      assert.deepEqual(o[k].left, [], `${k}: no partial file left behind`);
      assert.match(o[k].err, /not the pinned file \((sha256|size) /, k);
    }
    assert.deepEqual({ ...o.raises, err: !!o.raises.err }, { err: true, ok: false, exists: false, downloads: 1, left: [] });
    assert.match(o.raises.err, /download failed .*network down/);
    assert.deepEqual(o.present_ok, { err: null, ok: true, exists: true, downloads: 0, left: ["model.onnx"] });
    assert.deepEqual(o.present_bad_redownload, { err: null, ok: true, exists: true, downloads: 1, left: ["model.onnx"] });
    assert.equal(o.present_bad_twice.downloads, 1, "a bad file is downloaded again once, not in a loop");
    assert.equal(o.present_bad_twice.exists, false);
    assert.deepEqual(o.present_bad_twice.left, []);
    assert.match(o.present_bad_twice.err, /not the pinned file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

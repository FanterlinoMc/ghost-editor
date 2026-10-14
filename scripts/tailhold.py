#!/usr/bin/env python3
"""Hold the last styled frame over the outro, so a reel never ends on raw footage.

    tailhold.py reel.mp4 build/tail.json

build.mjs writes build/tail.json {speech, total, fps, hold} only when an outro exists and nothing full-frame is
drawn over it. The outro (total - speech) is otherwise drawn from a still of the RAW source (assets/outro.jpg): with
no end card on top, the last 0.2-0.4 s of a reel fell back to the unstyled, ungraded camera frame after the last page
or grade ended at the end of speech. When `hold` is true the rendered video is cut at `speech` and its last frame is
cloned to `total` (audio untouched, same length). No tail.json, or hold false: the file is left as rendered.
Ported from engine/review-fixes a30d106 (phantasic).
"""
import json, os, subprocess, sys


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, meta_path = sys.argv[1], sys.argv[2]
    if not os.path.exists(meta_path):
        return
    meta = json.load(open(meta_path))
    if not meta.get("hold"):
        return
    speech, total, fps = float(meta["speech"]), float(meta["total"]), int(meta.get("fps", 30))
    pad = round(total - speech, 3)
    if pad < 0.5 / fps:
        return
    tmp = src + ".tail.mp4"
    vf = f"trim=end_frame={int(round(speech * fps))},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={pad}"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src, "-filter_complex", f"[0:v]{vf}[v]", "-map", "[v]", "-map", "0:a?",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", str(fps), "-c:a", "copy",
                    "-t", f"{total:.3f}", "-movflags", "+faststart", tmp], check=True)
    os.replace(tmp, src)
    print(f"tail: held the last styled frame ({speech:.2f}s) over the {pad:.2f}s outro")


if __name__ == "__main__":
    main()

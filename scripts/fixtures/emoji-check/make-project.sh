#!/usr/bin/env bash
# Builds a throwaway project for the emoji check:  bash scripts/fixtures/emoji-check/make-project.sh <dir>
# The clip is synthetic (ffmpeg testsrc2 + a sine tone, like scripts/byte-identity.mjs): no media is committed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="${1:?usage: make-project.sh <dir>}"
mkdir -p "$dir/assets" "$dir/build"
ffmpeg -v error -f lavfi -i testsrc2=size=360x640:rate=30:duration=8 -f lavfi -i sine=frequency=180:duration=8 \
  -c:v libx264 -pix_fmt yuv420p -g 30 -keyint_min 30 -c:a aac -shortest -movflags +faststart -y "$dir/assets/talk.mp4"
cp "$here/reel.json" "$dir/reel.json"
cp "$here/words.whisper.json" "$dir/build/words.whisper.json"
cp "$here/face.json" "$dir/build/face.json"
echo "project ready: $dir"

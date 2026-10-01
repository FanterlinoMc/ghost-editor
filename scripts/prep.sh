#!/usr/bin/env bash
# Transcode a phone recording into a reel source, H.264, 30 fps, with the VOICE
# loudness-normalized to -16 LUFS (two-pass loudnorm) -- identical normalisation
# regardless of which output format is chosen, so a later join (I-16) is never
# audible.
#
#   prep.sh <recording> <project-dir> [9:16|4:5|1:1|16:9]   (default 9:16)
#
#   9:16 -> 1080x1920 (Reels/TikTok/Shorts)  -> assets/talk.mp4
#   4:5  -> 1080x1350 (IG/FB feed)           -> assets/talk-4x5.mp4
#   1:1  -> 1080x1080 (feed square)          -> assets/talk-1x1.mp4
#   16:9 -> 1920x1080 (YouTube/X landscape)  -> assets/talk-16x9.mp4
#
# The default format keeps writing assets/talk.mp4 so every existing
# project/reel.json that already points there is untouched; a non-default
# format gets its own suffixed file so one project can hold more than one
# format's source side by side (I-19: "one plan renders in all four").
#
# Normalizing the voice here, before any SFX is mixed, is what keeps the SFX
# levels in build.mjs meaningful: the kit's role levels assume a -16 LUFS
# voice. The old pipeline lifted the finished mix instead, so every SFX got
# +10 dB and hit the limiter.
#
# Target W:H and target aspect ratio must match scripts/lib/safezone.mjs's
# FORMATS map exactly (prep.sh is bash, safezone.mjs is Node -- duplicated by
# hand rather than shelling out to node just to read a constant; see the
# python3 note below for why a cross-runtime call here is exactly the kind of
# fragility this script has already paid for once).
set -euo pipefail
[ "$#" -ge 2 ] && [ "$#" -le 3 ] || { echo "usage: prep.sh <recording> <project-dir> [9:16|4:5|1:1|16:9]" >&2; exit 2; }
src="$1"; proj="$2"; fmt="${3:-9:16}"
case "$fmt" in
  9:16) tw=1080; th=1920 ;;
  4:5)  tw=1080; th=1350 ;;
  1:1)  tw=1080; th=1080 ;;
  16:9) tw=1920; th=1080 ;;
  *) echo "unknown format '$fmt' (want 9:16, 4:5, 1:1 or 16:9)" >&2; exit 2 ;;
esac
if [ "$fmt" = "9:16" ]; then out="$proj/assets/talk.mp4"
else out="$proj/assets/talk-$(printf '%s' "$fmt" | tr ':' 'x').mp4"; fi
mkdir -p "$proj/assets"

# tr -d '\r': ffprobe writes CRLF on Windows. This no longer feeds a branch that picks the crop
# filter (see vf= below -- one filter now covers every source orientation and every target
# format), but $w/$h are still printed in the log line right after, and a stray \r there is worth
# stripping on principle: it has cost real time once already in a comparison, and there is no
# reason to leave a known-dirty value sitting in a variable just because today's use is cosmetic.
read -r w h < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$src" | tr ',' ' ' | tr -d '\r')
# '-' must be first or last in a tr set: ',- ' reads as the range ',' to ' ', which GNU tr rejects
# as reversed ("range-endpoints ... in reverse collating sequence order"). BSD tr tolerates it.
rot=$(ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation -of csv=p=0 "$src" | head -1 | tr -d ' ,-')
if [ "${rot:-0}" = "90" ] || [ "${rot:-0}" = "270" ]; then t=$w; w=$h; h=$t; fi
echo "source ${w}x${h} (rotation ${rot:-none}), $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src") s -> target ${tw}x${th} ($fmt)"

# One filter for every source orientation and every target aspect: scale up (preserving the
# source's own aspect ratio) until the frame covers tw:th on both axes, then centre-crop to
# exactly tw:th. This replaces the old w<h branch (portrait: scale-then-crop; landscape:
# crop-then-scale) with a single formula that needs neither $w nor $h to pick the filter --
# which also means the CRLF bug that silently centre-cropped a portrait phone video as 16:9
# (because the now-dead w<h test errored on "720\r") cannot recur here: there is no integer
# comparison left in the decision.
vf="scale=$tw:$th:force_original_aspect_ratio=increase,crop=$tw:$th,fps=30"

echo "== measuring voice loudness"
stats=$(ffmpeg -hide_banner -nostats -i "$src" -vn -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
# loudnorm's JSON is flat and every value is a quoted string, so sed reads it directly. This used to
# shell out to `python3`, which fails on Windows: there `python3` is the Microsoft Store stub, and a
# venv provides python.exe but no python3.exe, so even an activated venv does not help. prep.sh now
# needs nothing but ffmpeg.
g() { printf '%s' "$stats" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }
echo "input: $(g input_i) LUFS, true peak $(g input_tp) dBTP"
af="loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$(g input_i):measured_TP=$(g input_tp):measured_LRA=$(g input_lra):measured_thresh=$(g input_thresh):offset=$(g target_offset):linear=true,aresample=48000"

enc=(-c:v h264_videotoolbox -b:v 14M)
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox || enc=(-c:v libx264 -crf 17 -preset fast)
ffmpeg -v error -y -i "$src" -vf "$vf" "${enc[@]}" -pix_fmt yuv420p -g 30 \
  -af "$af" -c:a aac -b:a 192k -ac 2 -movflags +faststart "$out"
echo "-> $out"
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -of csv=p=0 "$out"
ffmpeg -hide_banner -nostats -i "$out" -af ebur128 -f null - 2>&1 | grep -E "^\s+I:" | sed 's/^/output voice /'

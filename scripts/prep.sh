#!/usr/bin/env bash
# Transcode a phone recording into the reel's source: 1080x1920, 30 fps,
# H.264, with the VOICE loudness-normalized to -16 LUFS (two-pass loudnorm).
#
#   prep.sh <recording> <project-dir>        -> <project>/assets/talk.mp4
#
# Normalizing the voice here, before any SFX is mixed, is what keeps the SFX
# levels in build.mjs meaningful: the kit's role levels assume a -16 LUFS
# voice. The old pipeline lifted the finished mix instead, so every SFX got
# +10 dB and hit the limiter.
#
# A portrait phone file is a landscape HEVC stream with a rotation tag;
# ffmpeg rotates before the filter graph, so the target is 1080:1920. A
# landscape source is centre-cropped to 9:16.
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: prep.sh <recording> <project-dir>" >&2; exit 2; }
src="$1"; proj="$2"; out="$proj/assets/talk.mp4"
mkdir -p "$proj/assets"

# tr -d '\r': ffprobe writes CRLF on Windows, so without this $h is "720\r", the -lt test below
# fails with "integer expression expected", and a PORTRAIT phone video silently takes the landscape
# branch and gets centre-cropped as though it were 16:9.
read -r w h < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$src" | tr ',' ' ' | tr -d '\r')
# '-' must be first or last in a tr set: ',- ' reads as the range ',' to ' ', which GNU tr rejects
# as reversed ("range-endpoints ... in reverse collating sequence order"). BSD tr tolerates it.
rot=$(ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation -of csv=p=0 "$src" | head -1 | tr -d ' ,-')
if [ "${rot:-0}" = "90" ] || [ "${rot:-0}" = "270" ]; then t=$w; w=$h; h=$t; fi
echo "source ${w}x${h} (rotation ${rot:-none}), $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src") s"
if [ "$w" -lt "$h" ]; then vf="scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30"
else vf="crop=ih*9/16:ih,scale=1080:1920,fps=30"; echo "landscape source: centre-cropping to 9:16"; fi

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

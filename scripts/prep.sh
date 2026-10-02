#!/usr/bin/env bash
# Transcode a phone recording into a reel source, H.264, 30 fps, with the VOICE
# loudness-normalized to -16 LUFS (two-pass loudnorm) -- identical normalisation
# regardless of which output format is chosen, so a later join (I-16) is never
# audible.
#
#   prep.sh <recording> <project-dir> [9:16|4:5|1:1|16:9] [source-index]   (default 9:16, no index)
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
# I-16 (multi-source, engine/MULTIANGLE.md gap 3): a 4th argument, a small
# integer, is the source index -- run prep.sh once per distinct recording
# that will appear in the same reel, passing 0, 1, 2, ... so each lands at
# its own name instead of overwriting the last one:
#
#   prep.sh a.mp4 proj 9:16 0   -> assets/talk-0.mp4, build/crop-0-9x16.json
#   prep.sh b.mp4 proj 9:16 1   -> assets/talk-1.mp4, build/crop-1-9x16.json
#   prep.sh b.mp4 proj 4:5  1   -> assets/talk-1-4x5.mp4, build/crop-1-4x5.json
#
# Omitting the index is still the single-source path and is byte-identical to
# before (same names, same filters, same loudnorm target) -- an index is
# purely additive. Every invocation, indexed or not, measures and targets the
# SAME -16 LUFS / 30 fps / yuv420p regardless of what the source itself
# measured at, which is what makes two sources join without an audible
# loudness jump (see the "what still jumps" note near the bottom of this
# file for what that target does NOT cover). face_track.py and transcribe.py
# take an explicit --out, so they need no changes to run per source -- just
# point --out at build/face-<i>.json / build/words-<i>.whisper.json; see
# transcribe.py --merge for turning N of those into one list the planner
# can read.
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
[ "$#" -ge 2 ] && [ "$#" -le 4 ] || { echo "usage: prep.sh <recording> <project-dir> [9:16|4:5|1:1|16:9] [source-index]" >&2; exit 2; }
src="$1"; proj="$2"; fmt="${3:-9:16}"; idx="${4:-}"
case "$fmt" in
  9:16) tw=1080; th=1920 ;;
  4:5)  tw=1080; th=1350 ;;
  1:1)  tw=1080; th=1080 ;;
  16:9) tw=1920; th=1080 ;;
  *) echo "unknown format '$fmt' (want 9:16, 4:5, 1:1 or 16:9)" >&2; exit 2 ;;
esac
if [ -n "$idx" ]; then
  case "$idx" in
    ''|*[!0-9]*) echo "source-index must be a non-negative integer, got '$idx'" >&2; exit 2 ;;
  esac
fi
fmtdash=$(printf '%s' "$fmt" | tr ':' 'x')
# No index: unchanged single-source names (talk.mp4 / talk-<fmt>.mp4). An index inserts
# "-<idx>" right after "talk", before any format suffix, matching face-<idx>.json /
# words-<idx>.whisper.json below -- one source id, consistently spelled across every file
# ingest produces for it.
if [ -n "$idx" ]; then base="talk-$idx"; else base="talk"; fi
if [ "$fmt" = "9:16" ]; then out="$proj/assets/$base.mp4"
else out="$proj/assets/$base-$fmtdash.mp4"; fi
mkdir -p "$proj/assets" "$proj/build"

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
# source's own aspect ratio) until the frame covers tw:th on both axes, then crop to exactly
# tw:th. This replaces the old w<h branch (portrait: scale-then-crop; landscape:
# crop-then-scale) with a single formula that needs neither $w nor $h to pick the filter --
# which also means the CRLF bug that silently centre-cropped a portrait phone video as 16:9
# (because the now-dead w<h test errored on "720\r") cannot recur here: there is no integer
# comparison left in the decision.
#
# A15: a plain CENTRED crop here cuts the speaker's head off on 4:5/1:1/16:9 -- shrinking only
# the height (the common case for a portrait phone source) always removes the same slice off
# the top and the bottom, with no idea where the face actually is. When this project already has
# a build/face.json (face_track.py's output, written in the pixel space of the untouched/9:16
# frame -- see that script's header), use it to choose a single static vertical offset for the
# whole reel instead of the centred one:
#   - robust span: the 5th percentile of the face's top edge and the 90th percentile of its
#     bottom edge across every sample, not the true min/max, so one noisy detector frame can't
#     swing the whole crop.
#   - if that span fits inside the window this format's crop actually has (in the SOURCE's pixel
#     space, i.e. the crop height divided by the scale factor below), centre the crop window on
#     the span's midpoint. That's a static offset -- not a per-frame track, so the crop doesn't
#     swim -- and centring (rather than anchoring to the top edge) leaves headroom on both ends
#     when there's slack, so the head isn't flush against the frame.
#   - if the span does NOT fit (true for 16:9 against a portrait source: a 1080-wide cover crop
#     to 16:9 is only ~607px tall in source pixels, well under a ~900px head -- no offset fixes
#     that), cropping is the wrong tool: scale the WHOLE frame down to fit instead, padded with a
#     blurred, cropped copy of itself so the head survives and there's no hard letterbox bar.
# No face.json, or no detections in it: fall back to exactly today's centred crop. This is kept
# python-free on purpose -- prep.sh parses the JSON itself with sed/awk/sort rather than shelling
# out to a python face_track.py helper, which is exactly the kind of cross-runtime dependency
# that bit this script once already (see the loudnorm/python3 note below).
scale=$(awk -v w="$w" -v h="$h" -v tw="$tw" -v th="$th" 'BEGIN{s1=tw/w; s2=th/h; printf "%.6f", (s1>s2)?s1:s2}')
sw=$(awk -v w="$w" -v s="$scale" 'BEGIN{printf "%d", w*s+0.5}')
sh=$(awk -v h="$h" -v s="$scale" 'BEGIN{printf "%d", h*s+0.5}')
xoff=$(awk -v sw="$sw" -v tw="$tw" 'BEGIN{v=(sw-tw)/2; if(v<0)v=0; printf "%d", v}')
yoff=$(awk -v sh="$sh" -v th="$th" 'BEGIN{v=(sh-th)/2; if(v<0)v=0; printf "%d", v}')  # centred default
mode="centre"
# I-16: a source index looks for ITS OWN face track (face_track.py run against this same
# source's talk-<idx>.mp4), never the single-source build/face.json -- using another
# source's face positions to pick this one's crop offset would be worse than the plain
# centred fallback.
if [ -n "$idx" ]; then facejson="$proj/build/face-$idx.json"; else facejson="$proj/build/face.json"; fi
if [ -s "$facejson" ] && [ "$sh" -gt "$th" ]; then
  FH=$(sed -nE 's/.*"h":[[:space:]]*([0-9]+).*/\1/p' "$facejson" | head -1)
  tops=$(tr -d ' ' < "$facejson" | sed 's/\[/\n[/g' | sed -nE 's/^\[[0-9.]+,([0-9]+),.*/\1/p')
  bottoms=$(tr -d ' ' < "$facejson" | sed 's/\[/\n[/g' | sed -nE 's/^\[[0-9.]+,[0-9]+,([0-9]+),.*/\1/p')
  n=$(printf '%s\n' "$tops" | sed '/^$/d' | wc -l | tr -d ' ')
  if [ "${FH:-0}" -gt 0 ] && [ "${n:-0}" -gt 0 ]; then
    top_p5=$(printf '%s\n' "$tops" | sed '/^$/d' | sort -n | awk -v n="$n" 'NR==((int(n*0.05)+1>n)?n:int(n*0.05)+1){print; exit}')
    bottom_p90=$(printf '%s\n' "$bottoms" | sed '/^$/d' | sort -n | awk -v n="$n" 'NR==((int(n*0.90)+1>n)?n:int(n*0.90)+1){print; exit}')
    window_fs=$(awk -v th="$th" -v s="$scale" 'BEGIN{printf "%.2f", th/s}')
    span_fs=$(awk -v t="$top_p5" -v b="$bottom_p90" 'BEGIN{printf "%.2f", b-t}')
    if awk -v a="$span_fs" -v b="$window_fs" 'BEGIN{exit !(a<=b)}'; then
      yoff=$(awk -v t="$top_p5" -v b="$bottom_p90" -v s="$scale" -v th="$th" -v sh="$sh" 'BEGIN{
        mid=(t+b)/2*s; y=mid-th/2; if(y<0)y=0; maxy=sh-th; if(maxy<0)maxy=0; if(y>maxy)y=maxy; printf "%d", y
      }')
      mode="face"
      echo "crop: face-aware offset y=$yoff of ${sh}px scaled frame (top p5=$top_p5, bottom p90=$bottom_p90 over $n samples)"
    else
      mode="pad"
      echo "crop: face span (~${span_fs}px) exceeds the $fmt crop window (~${window_fs}px in source pixels) -- letterboxing instead of cropping"
    fi
  else
    echo "crop: centred ($facejson has no detections)"
  fi
elif [ -s "$facejson" ]; then
  echo "crop: centred ($fmt needs no vertical crop)"
else
  echo "crop: centred (no $facejson yet)"
fi

if [ "$mode" = "pad" ]; then
  # contain (scale to fit, no crop) over a blurred cover-cropped copy of the same frame
  vf="split=2[bg][fg];[bg]scale=$tw:$th:force_original_aspect_ratio=increase,crop=$tw:$th,gblur=sigma=20[bg];[fg]scale=$tw:$th:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,fps=30"
  scale_c=$(awk -v w="$w" -v h="$h" -v tw="$tw" -v th="$th" 'BEGIN{s1=tw/w; s2=th/h; printf "%.6f", (s1<s2)?s1:s2}')
  sw_c=$(awk -v w="$w" -v s="$scale_c" 'BEGIN{printf "%d", w*s+0.5}')
  sh_c=$(awk -v h="$h" -v s="$scale_c" 'BEGIN{printf "%d", h*s+0.5}')
  planScale="$scale_c"
  planOffX=$(awk -v tw="$tw" -v sw="$sw_c" 'BEGIN{printf "%d", (tw-sw)/2}')
  planOffY=$(awk -v th="$th" -v sh="$sh_c" 'BEGIN{printf "%d", (th-sh)/2}')
else
  # Explicit x/y (rather than relying on crop's own default centring) so the face-aware case can
  # override y alone. y is clamped against the REAL runtime frame height (in_h), not just our own
  # estimate of it above, in case ffmpeg's internal scale-filter rounding differs from awk's by a
  # pixel or two -- cheap insurance against a crop filter rejecting an off-by-one y.
  vf="scale=$tw:$th:force_original_aspect_ratio=increase,crop=$tw:$th:(in_w-out_w)/2:max(0\,min($yoff\,in_h-out_h)),fps=30"
  planScale="$scale"
  planOffX=$(awk -v x="$xoff" 'BEGIN{printf "%d", -x}')
  planOffY=$(awk -v y="$yoff" 'BEGIN{printf "%d", -y}')
fi

# Crop plan for build.mjs / safezone.mjs (I-19's build.mjs half, not wired up on the ingest side):
# face.json's original-frame pixel coordinates map onto THIS format's canvas as
# canvasCoord = rawCoord * scale + offset, for both axes alike, in crop mode (offset <= 0, a
# cropped-away margin) and pad mode (offset >= 0, a letterboxed-in margin) both.
if [ -n "$idx" ]; then cropfile="$proj/build/crop-$idx-$fmtdash.json"; else cropfile="$proj/build/crop-$fmtdash.json"; fi
printf '{"format":"%s","W":%s,"H":%s,"mode":"%s","scale":%s,"offsetX":%s,"offsetY":%s}\n' \
  "$fmt" "$tw" "$th" "$mode" "$planScale" "$planOffX" "$planOffY" > "$cropfile"
echo "-> $cropfile (mode=$mode, for safezone.mjs's cropScale/cropOffsetX/cropOffsetY)"

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

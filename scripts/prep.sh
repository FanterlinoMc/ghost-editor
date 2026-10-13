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
[ "$#" -ge 2 ] && [ "$#" -le 4 ] || { echo "usage: prep.sh <recording> <project-dir> [9:16|4:5|1:1|16:9] [source-index]" >&2; exit 2; }
src="$1"; proj="$2"; fmt="${3:-9:16}"; idx="${4:-0}"
case "$idx" in ''|*[!0-9]*) echo "source index must be a non-negative integer, got '$idx'" >&2; exit 2 ;; esac
case "$fmt" in
  9:16) tw=1080; th=1920 ;;
  4:5)  tw=1080; th=1350 ;;
  1:1)  tw=1080; th=1080 ;;
  16:9) tw=1920; th=1080 ;;
  *) echo "unknown format '$fmt' (want 9:16, 4:5, 1:1 or 16:9)" >&2; exit 2 ;;
esac
fmtdash=$(printf '%s' "$fmt" | tr ':' 'x')
# I-16 / MULTIANGLE Gap 3 (ingest half): a project can hold several RECORDINGS, not just several
# formats of one. Source 0 keeps every name it already has - exactly as the 9:16 default keeps
# writing assets/talk.mp4 - so no existing project or reel.json moves. Source N gets "-N", and it
# goes BEFORE the format token so build.mjs can strip the format and read the index back
# (scripts/lib/sources.mjs, which is the consumer of this naming and has the tests for it):
#
#   idx 0, 9:16 -> assets/talk.mp4          idx 1, 9:16 -> assets/talk-1.mp4
#   idx 0, 16:9 -> assets/talk-16x9.mp4     idx 1, 16:9 -> assets/talk-1-16x9.mp4
#
# Each run normalises its own source to -16 LUFS independently, which is what makes a join between
# two recordings inaudible - the requirement Gap 3 states and the reason this is one script run
# per source rather than a batch mode with shared gain.
sfx=""
[ "$idx" -ne 0 ] && sfx="-$idx"
if [ "$fmt" = "9:16" ]; then out="$proj/assets/talk$sfx.mp4"
else out="$proj/assets/talk$sfx-$fmtdash.mp4"; fi
mkdir -p "$proj/assets" "$proj/build"

# ---- blank timeline (BLANK-TIMELINE-SPEC.md, Stage 1): any file can become a source ----
# Every source ends up as a 9:16-or-chosen-format H.264 + stereo AAC mp4 with an audio track, so
# build.mjs never has to ask "does this source have sound". What kind of input it was is recorded
# in a sidecar assets/talk[-N].json (written for every kind, a normal video included):
#
#   (hasAudio = the ORIGINAL had an audio stream; the output always does)
#   { "kind": "video"|"silent"|"image", "duration": <s>, "hasAudio": bool, "speechLikely": bool }
#
#   video   has video and an audio stream: today's path, untouched (two-pass loudnorm to -16 LUFS)
#   silent  video with NO audio stream: a silent stereo AAC track of the same length is added
#   image   a still (jpg png webp heic bmp tiff avif): a 30 s still clip, 30 fps, silent audio.
#           Its aspect decides the fit, with the same two looks the video path already has:
#           cover-crop when the picture is within 1.34x of the target aspect, otherwise the
#           blurred-fill letterbox (the "pad" mode the face-aware crop uses for wide footage).
#
# speechLikely is a CHEAP pre-check (one ffmpeg volumedetect + silencedetect pass over the source
# audio, before loudnorm) so the studio can skip transcription and face tracking where there is
# nothing to find. It is true when ALL of:
#     mean volume  >= -45 dB   (volumedetect mean_volume; below that it is near-silence/room tone)
#     max volume   >= -25 dB   (some real peak - a mic hiss floor never gets there)
#     non-silent   >= 25 %     (share of the file ABOVE -35 dB, silencedetect d=0.3 s)
# It cannot tell speech from music (that is transcription's job - an empty transcript is a fine
# answer), so it errs toward true. A source with no audio, and every image, is always false.
kind=video
case "$(printf '%s' "${src##*.}" | tr 'A-Z' 'a-z')" in
  jpg|jpeg|png|webp|heic|heif|bmp|tif|tiff|avif|jfif) kind=image ;;
esac
if [ "$kind" = video ]; then
  # an image with an unexpected extension still shows up as an image2/*_pipe demuxer
  case "$(ffprobe -v error -show_entries format=format_name -of csv=p=0 "$src" | tr -d '\r')" in
    image2|*_pipe|png_pipe|webp_pipe|tiff_pipe) kind=image ;;
  esac
fi
hasAudio=false
if [ -n "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$src" | tr -d '\r')" ]; then hasAudio=true; fi
[ "$kind" = video ] && [ "$hasAudio" = false ] && kind=silent
[ "$kind" = image ] && hasAudio=false
sidecar="$proj/assets/talk$sfx.json"
IMG_SECONDS="${PREP_IMAGE_SECONDS:-30}"   # env override exists for tests only; the contract is 30

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
# This source's OWN face track, never another recording's: face coordinates are in the pixel
# space of the file face_track.py ran on, so consulting face.json while prepping source 1 would
# offset the crop by a face that is not in this footage.
facejson="$proj/build/face$sfx.json"
# a still image has no face track to consult (and a stale one from an earlier file at this index
# must not steer it)
[ "$kind" = image ] && facejson=""
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
elif [ "$kind" = image ]; then
  # cover-crop loses the part of the picture outside the target aspect; past 1.34x either way
  # that is too much of a landscape photo (or a very tall screenshot), so fall back to the
  # blurred-fill letterbox, the same "pad" look a wide video gets
  if awk -v w="$w" -v h="$h" -v tw="$tw" -v th="$th" 'BEGIN{a=w/h; t=tw/th; r=(a>t)?a/t:t/a; exit !(r>1.34)}'; then
    mode="pad"
    echo "crop: image aspect ${w}x${h} is more than 1.34x off $fmt -- blurred-fill letterbox"
  else
    echo "crop: image cover-crop (aspect within 1.34x of $fmt)"
  fi
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

# Crop plan for build.mjs / safezone.mjs (I-19; build.mjs consumes this as of the commit that
# added srcW/srcH below). face.json's original-frame pixel coordinates map onto THIS format's
# canvas as canvasCoord = rawCoord * scale + offset, for both axes alike, in crop mode
# (offset <= 0, a cropped-away margin) and pad mode (offset >= 0, a letterboxed-in margin) both.
#
# srcW/srcH are the dimensions the scale and offsets were computed FROM ($w/$h above, after the
# rotation swap) - the pixel space a coordinate must already be in for this plan to map it
# correctly. They are recorded because the consumer cannot otherwise tell whether it is applying
# the plan to the right space: face.json holds whatever face_track.py measured, and that is the
# same space as this plan's input only when prep.sh was fed the same file face_track.py ran on.
# Prep the 1:1 from an original 4K recording while face.json was tracked on the 1080x1920 output,
# and every mapped coordinate is wrong by the 9:16 scale factor, with nothing to notice it. With
# these two fields build.mjs can refuse the plan instead of placing captions against the wrong
# pixel space - the same failure class its own face.w/h canvas check already guards.
# Per source as well as per format: the sidecar carries srcW/srcH from THIS recording, and two
# cameras of different dimensions need different plans. build.mjs reading the right one per source
# is MULTIANGLE Gap 6.
cropfile="$proj/build/crop$sfx-$fmtdash.json"
printf '{"format":"%s","W":%s,"H":%s,"srcW":%s,"srcH":%s,"mode":"%s","scale":%s,"offsetX":%s,"offsetY":%s}\n' \
  "$fmt" "$tw" "$th" "$w" "$h" "$mode" "$planScale" "$planOffX" "$planOffY" > "$cropfile"
echo "-> $cropfile (mode=$mode, for safezone.mjs's cropScale/cropOffsetX/cropOffsetY)"

if [ "$kind" = video ]; then
  echo "== measuring voice loudness"
  stats=$(ffmpeg -hide_banner -nostats -i "$src" -vn -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
  # loudnorm's JSON is flat and every value is a quoted string, so sed reads it directly. This used to
  # shell out to `python3`, which fails on Windows: there `python3` is the Microsoft Store stub, and a
  # venv provides python.exe but no python3.exe, so even an activated venv does not help. prep.sh now
  # needs nothing but ffmpeg.
  g() { printf '%s' "$stats" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }
  echo "input: $(g input_i) LUFS, true peak $(g input_tp) dBTP"
  af="loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$(g input_i):measured_TP=$(g input_tp):measured_LRA=$(g input_lra):measured_thresh=$(g input_thresh):offset=$(g target_offset):linear=true,aresample=48000"
  # An audio track that is (nearly) digital silence has no loudness to normalise: loudnorm reports
  # -inf/-70 and then rejects its own numbers ("measured_I ... out of range"), which used to abort
  # the whole prep. Screen recordings with a muted mic do this. Keep the track, resample only.
  case "$(g input_i)" in
    ''|*inf*|-[6-9][0-9]*) af="aresample=48000"; echo "input is silent (no loudness to normalise): resampling only" ;;
  esac

  enc=(-c:v h264_videotoolbox -b:v 14M)
  ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox || enc=(-c:v libx264 -crf 17 -preset fast)
  ffmpeg -v error -y -i "$src" -vf "$vf" "${enc[@]}" -pix_fmt yuv420p -g 30 \
    -af "$af" -c:a aac -b:a 192k -ac 2 -movflags +faststart "$out"
  echo "-> $out"
  ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -of csv=p=0 "$out"
  ffmpeg -hide_banner -nostats -i "$out" -af ebur128 -f null - 2>&1 | grep -E "^\s+I:" | sed 's/^/output voice /'
else
  # silent video or still image: no voice to normalise, so no loudnorm. Add a silent stereo 48 kHz
  # AAC track instead (anullsrc), trimmed to the picture's length with -shortest (a clip) or -t (a
  # looped still), so every source has audio and the mixer never meets a file without one.
  enc=(-c:v h264_videotoolbox -b:v 14M)
  ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox || enc=(-c:v libx264 -crf 17 -preset fast)
  if [ "$kind" = image ]; then
    # fit the picture ONCE to a canvas-sized PNG (the blurred-fill filter is the expensive part and a
    # still does not change), then loop that PNG: 900 frames of a static image encode in seconds
    stillpng="$proj/build/talk$sfx-still.png"
    # The trailing fps=30 is dropped for the still: on a single frame it is a no-op, but after the
    # split/overlay of the pad path ffmpeg 5.1 (Debian bookworm) emits NO frame through it, exits 0
    # and writes no PNG. -update 1 names the single-image output explicitly for older muxers. The
    # video below is timed to 30 fps by -framerate anyway.
    stillvf="${vf%,fps=30}"
    ffmpeg -v error -y -i "$src" -vf "$stillvf" -frames:v 1 -update 1 "$stillpng"
    [ -s "$stillpng" ] || { echo "prep.sh: step 1 (fit still image to canvas) wrote no $stillpng although ffmpeg exited 0" >&2; exit 1; }
    ffmpeg -v error -y -loop 1 -framerate 30 -t "$IMG_SECONDS" -i "$stillpng" -f lavfi -i "anullsrc=r=48000:cl=stereo" -t "$IMG_SECONDS"       "${enc[@]}" -pix_fmt yuv420p -g 30 -c:a aac -b:a 192k -ac 2 -shortest -movflags +faststart "$out"
    [ -s "$out" ] || { echo "prep.sh: step 2 (encode still image to mp4) wrote no $out" >&2; exit 1; }
    rm -f "$stillpng"
  else
    ffmpeg -v error -y -i "$src" -f lavfi -i "anullsrc=r=48000:cl=stereo" -map 0:v:0 -map 1:a:0       -vf "$vf" "${enc[@]}" -pix_fmt yuv420p -g 30 -c:a aac -b:a 192k -ac 2 -shortest -movflags +faststart "$out"
  fi
  echo "-> $out ($kind: silent audio track added)"
  ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -of csv=p=0 "$out"
fi

# ---- sidecar (see the kind/speechLikely notes near the top) ----
speech=false
if [ "$hasAudio" = true ]; then
  # one pass over the SOURCE audio (before loudnorm, which would raise a quiet room to -16 LUFS)
  ad=$(ffmpeg -hide_banner -nostats -i "$src" -vn -af "volumedetect,silencedetect=noise=-35dB:d=0.3" -f null - 2>&1 | tr -d '\r' || true)
  srcdur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src" | tr -d '\r')
  speech=$(printf '%s\n' "$ad" | awk -v dur="${srcdur:-0}" '
    /mean_volume:/ { mean=$(NF-1) }
    /max_volume:/  { mx=$(NF-1) }
    /silence_start:/ { ss=$NF; open=1 }
    /silence_duration:/ { sil+=$NF; open=0 }
    END {
      if (open && dur>ss) sil+=dur-ss
      ns=(dur>0)?(dur-sil)/dur:0
      print (mean!="" && mean>=-45 && mx>=-25 && ns>=0.25) ? "true" : "false"
    }')
  echo "speech check: mean/max volume and non-silent share say speechLikely=$speech"
fi
dur_out=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out" | tr -d '\r')
printf '{"kind":"%s","duration":%s,"hasAudio":%s,"speechLikely":%s}\n' "$kind" "$(awk -v d="${dur_out:-0}" 'BEGIN{printf "%.3f", d}')" "$hasAudio" "$speech" > "$sidecar"
echo "-> $sidecar"

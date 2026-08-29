#!/usr/bin/env bash
set -euo pipefail

# PROTOTYPE ONLY. The archive is intentionally external and is never copied
# into git. Frames 000–137 come from the supplied 1280×720 archive; frames
# 138–149 are explicitly upscaled from the standard 900×507 sequence.
FFMPEG="${FFMPEG:-/tmp/tmp.JLJwrzhDGG/package/ffmpeg}"
HQ_ARCHIVE="${HQ_ARCHIVE:-../Portfolio/hero-frames-1280x720-partial.zip}"
OUTPUT_DIR="public/video-prototype"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ ! -x "$FFMPEG" ]]; then
  echo "ffmpeg executable not found: $FFMPEG" >&2
  exit 1
fi
if [[ ! -f "$HQ_ARCHIVE" ]]; then
  echo "HQ archive not found: $HQ_ARCHIVE" >&2
  exit 1
fi

mkdir -p "$TMP_DIR/archive" "$TMP_DIR/frames" "$TMP_DIR/upscaled" "$OUTPUT_DIR"
unzip -q "$HQ_ARCHIVE" -d "$TMP_DIR/archive"
HQ_FRAME_DIR="$(find "$TMP_DIR/archive" -type f -name 'frame_000_delay-0.067s.webp' -printf '%h\n' | head -1)"
if [[ -z "$HQ_FRAME_DIR" ]]; then
  echo "archive does not contain frame_000_delay-0.067s.webp" >&2
  exit 1
fi

for frame in $(seq -w 0 137); do
  cp "$HQ_FRAME_DIR/frame_${frame}_delay-0.067s.webp" "$TMP_DIR/frames/frame_${frame}.webp"
done

# ffmpeg numbers this output from 001 even though the input starts at 138.
"$FFMPEG" -y -hide_banner -loglevel warning -threads 1 \
  -framerate 15 -start_number 138 -i 'Кадры/frame_%03d_delay-0.067s.webp' \
  -frames:v 12 -vf 'scale=1280:720:flags=lanczos' -c:v libwebp -q:v 85 \
  "$TMP_DIR/upscaled/frame_%03d.webp"
for index in $(seq 1 12); do
  frame=$((137 + index))
  source="$(printf '%03d' "$index")"
  target="$(printf '%03d' "$frame")"
  cp "$TMP_DIR/upscaled/frame_${source}.webp" "$TMP_DIR/frames/frame_${target}.webp"
done

for crf in 21 24; do
  "$FFMPEG" -y -hide_banner -loglevel warning -threads 1 \
    -framerate 15 -i "$TMP_DIR/frames/frame_%03d.webp" \
    -filter_complex '[0:v]format=rgba,split=2[colorin][alphain];[colorin]format=rgb24[color];[alphain]alphaextract,format=gray[matte];[color][matte]hstack=inputs=2,format=yuv420p[packed]' \
    -map '[packed]' -an -c:v libx264 -profile:v high -preset medium -crf "$crf" \
    -g 15 -keyint_min 15 -sc_threshold 0 \
    -movflags +faststart "$TMP_DIR/hq-hero-color-matte-crf${crf}.mp4"
  candidate="$TMP_DIR/hq-hero-color-matte-crf${crf}.mp4"
  candidate_size="$(stat -c '%s' "$candidate")"
  printf 'HQ CRF %s: %s (%s bytes)\n' "$crf" "$candidate" "$candidate_size"
done

CRF21_SIZE="$(stat -c '%s' "$TMP_DIR/hq-hero-color-matte-crf21.mp4")"
CRF24_SIZE="$(stat -c '%s' "$TMP_DIR/hq-hero-color-matte-crf24.mp4")"
if (( CRF24_SIZE > CRF21_SIZE )); then
  echo "CRF24 was not the smaller measured candidate; refusing implicit choice" >&2
  exit 1
fi
cp "$TMP_DIR/hq-hero-color-matte-crf24.mp4" "$OUTPUT_DIR/hq-hero-color-matte.mp4"
stat -c 'selected HQ packed H.264: %n (%s bytes)' "$OUTPUT_DIR/hq-hero-color-matte.mp4"

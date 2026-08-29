#!/usr/bin/env bash
set -euo pipefail

# PROTOTYPE ONLY. The checked-in outputs make the route runnable without
# requiring ffmpeg. Set FFMPEG to a newer binary when regenerating elsewhere.
FFMPEG="${FFMPEG:-/tmp/tmp.JLJwrzhDGG/package/ffmpeg}"
OUTPUT_DIR="public/video-prototype"

if [[ ! -x "$FFMPEG" ]]; then
  echo "ffmpeg executable not found: $FFMPEG" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

"$FFMPEG" -y -hide_banner -loglevel warning \
  -framerate 15 -i 'Кадры/frame_%03d_delay-0.067s.webp' \
  -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 -row-mt 1 -g 15 \
  "$OUTPUT_DIR/hero-alpha-vp9.webm"

"$FFMPEG" -y -hide_banner -loglevel warning -threads 1 \
  -framerate 15 -i 'Кадры/frame_%03d_delay-0.067s.webp' \
  -filter_complex '[0:v]format=rgba,split=2[rgba][alpha];[rgba]format=rgb24,pad=iw:508:0:0:color=black[color];[alpha]alphaextract,format=gray,pad=iw:508:0:0:color=black[matte];[color][matte]hstack=inputs=2,format=yuv420p[packed]' \
  -map '[packed]' -an -c:v libx264 -profile:v high -preset medium -crf 21 \
  -g 15 -keyint_min 15 -sc_threshold 0 -movflags +faststart \
  "$OUTPUT_DIR/hero-color-matte.mp4"

stat -c '%n %s bytes' "$OUTPUT_DIR"/*

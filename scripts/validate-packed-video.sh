#!/usr/bin/env bash
set -euo pipefail

# PROTOTYPE ONLY. Validate the committed packed streams without requiring a
# browser: left RGB/right matte geometry, transparent corners, and an opaque
# center pixel are deterministic inputs to the WebGL shader.
FFMPEG="${FFMPEG:-/tmp/tmp.JLJwrzhDGG/package/ffmpeg}"
if [[ ! -x "$FFMPEG" ]]; then
  echo "ffmpeg executable not found: $FFMPEG" >&2
  exit 1
fi
if ! command -v identify >/dev/null 2>&1; then
  echo "ImageMagick identify is required" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

check_stream() {
  local source="$1"
  local expected_width="$2"
  local expected_height="$3"
  local label
  label="$(basename "$source" .mp4)"
  local matte="$tmp_dir/${label}-matte.png"
  "$FFMPEG" -y -hide_banner -loglevel error \
    -i "$source" -frames:v 1 \
    -vf 'crop=iw/2:ih:iw/2:0,format=gray' "$matte"

  local geometry
  geometry="$(identify -format '%wx%h' "$matte")"
  [[ "$geometry" == "${expected_width}x${expected_height}" ]] || {
    echo "$source matte geometry $geometry (expected ${expected_width}x${expected_height})" >&2
    return 1
  }

  local corner_values
  local center_value
  local max_x=$((expected_width - 1))
  local max_y=$((expected_height - 1))
  corner_values="$(identify -format "%[fx:p{0,0}] %[fx:p{${max_x},0}] %[fx:p{0,${max_y}}] %[fx:p{${max_x},${max_y}}]" "$matte")"
  center_value="$(identify -format "%[fx:p{$((expected_width / 2)),$((expected_height / 2))}]" "$matte")"
  echo "$label: matte ${geometry}; corners=${corner_values}; center=${center_value}"
  awk -v values="$corner_values" 'BEGIN { n = split(values, a, " "); for (i = 1; i <= n; i++) if (a[i] > 0.25) exit 1 }' || {
    echo "$source has an opaque matte corner" >&2
    return 1
  }
  awk -v center="$center_value" 'BEGIN { exit !(center >= 0.75) }' || {
    echo "$source center matte is not opaque" >&2
    return 1
  }

  local keyframe_count
  keyframe_count="$($FFMPEG -hide_banner -i "$source" -vf showinfo -f null - 2>&1 | grep -c 'iskey:1' || true)"
  if (( keyframe_count < 10 )); then
    echo "$source has only $keyframe_count keyframes; cold seeking requires at least one per second" >&2
    return 1
  fi
}

check_stream "public/video-prototype/hero-color-matte.mp4" 900 508
check_stream "public/video-prototype/hq-hero-color-matte.mp4" 1280 720
alpha_keyframes="$($FFMPEG -hide_banner -i public/video-prototype/hero-alpha-vp9.webm -vf showinfo -f null - 2>&1 | grep -c 'iskey:1' || true)"
if (( alpha_keyframes < 10 )); then
  echo "hero-alpha-vp9.webm has only $alpha_keyframes keyframes; cold seeking requires at least one per second" >&2
  exit 1
fi
echo "packed alpha validation passed"

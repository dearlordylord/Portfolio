#!/usr/bin/env bash
set -euo pipefail

# PROTOTYPE ONLY. Apple is the source of truth for the auxiliary alpha layer;
# this wrapper intentionally refuses to run on non-macOS hosts and has no
# ffmpeg/Homebrew fallback.
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "HEVC-with-alpha encoding requires macOS Xcode (xcrun swift); no output was written." >&2
  exit 64
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "xcrun was not found; install Xcode or select its command-line tools." >&2
  exit 64
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(cd -- "$script_dir/.." && pwd -P)"
swift_encoder="$script_dir/hevc-alpha-encoder.swift"

if [[ ! -f "$swift_encoder" ]]; then
  echo "Swift encoder source is missing: $swift_encoder" >&2
  exit 1
fi

staging_dir="${HEVC_ALPHA_OUTPUT_DIR:-$project_root/motion-artifacts/hevc-alpha}"
output_path="${HEVC_ALPHA_OUTPUT:-$staging_dir/hero-hevc-alpha.mp4}"

# The Swift tool creates parent directories and enforces the tracked-output
# guard. The default is already covered by the repository's motion-artifacts/
# ignore rule; callers must opt in before writing a production-tree path.
exec xcrun swift "$swift_encoder" \
  --input "$project_root/Кадры" \
  --output "$output_path" \
  --repo-root "$project_root" \
  "$@"

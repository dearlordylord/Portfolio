# HEVC-with-alpha import gate (prototype)

The H variant is intentionally a candidate, not a checked-in production codec
asset. A normal HEVC encoder produces an opaque stream; it is not a substitute
for Apple’s paired auxiliary alpha layer. The repository therefore includes a
macOS/Xcode-only AVFoundation authoring command, but keeps its output in the
ignored `motion-artifacts/hevc-alpha/` staging directory until it has passed
the real-device gate.

## One-command Apple export

On macOS with Xcode selected (`xcode-select --install` is not enough without
the Xcode SDK), run the dry-run first:

```sh
npm run prototype:encode:hevc-alpha -- --dry-run
```

The dry-run decodes all 150 `Кадры/frame_%03d_delay-0.067s.webp` images with
ImageIO, requires a real alpha channel and both transparent and visible pixels,
checks their fixed `900×507` dimensions, and asks AVAssetWriter whether it can
apply `AVVideoCodecType.hevcWithAlpha` plus the configured alpha properties. It
writes no media or manifest. The actual export is:

```sh
npm run prototype:encode:hevc-alpha -- --force
```

The command uses `AVAssetWriter` directly, with premultiplied alpha, target
alpha quality `1.0` (VideoToolbox's highest quality), temporal compression,
frame reordering disabled, open GOP disabled, and a maximum keyframe interval
of 15 frames (one second at 15 fps), with the explicit average bitrate and
expected frame rate held inside `AVVideoCompressionPropertiesKey`. Override
only the staging quality or seek trade-off when deliberately testing a
candidate:

```sh
npm run prototype:encode:hevc-alpha -- --alpha-quality 0.95 --keyframe-interval 15 --force
```

It has no ffmpeg, Homebrew, or Compressor dependency. On non-macOS hosts the
wrapper exits with an explicit error and writes nothing. It also refuses a
non-staging repository path unless `--allow-tracked-output` is supplied. A
successful export is validated again through AVFoundation for one HEVC video
track, `900×507`, 150 samples, 15 fps, 10 seconds, and the selected track's
`containsAlphaChannel` characteristic. It then decodes every sample through
`AVAssetReaderTrackOutput` as BGRA and requires the decoded alpha range to
contain both transparent and visible values; the measured minimum and maximum
are recorded in the manifest. A writer rejection, missing/opaque input alpha,
failed sample/decoded-alpha validation, or manifest/SHA failure deletes the
partial staging output and exits nonzero.

The command emits a deterministic JSON sidecar beside the MP4 containing the
source/encode settings, average bitrate, ordered source-set SHA-256 (each
filename + NUL + file bytes in ascending frame order), measured output facts,
decoded alpha range, byte count, and output SHA-256. It also prints exact copy
instructions. The intended handoff is:

1. Keep the MP4 and manifest under ignored staging while reviewing the
   transparent edges and seek checkpoints on macOS Safari and iOS Safari.
2. After that review, copy the exact staged file to
   `public/video-prototype/hero-hevc-alpha.mp4`.
3. Add a checked-in manifest binding the immutable URL and printed SHA-256 to
   real-device alpha evidence. The prototype query parameters are an untrusted
   manual override and do not replace this production manifest.
4. Run `npm run build`, `npm run verify:dist`, and the supported Safari/iOS
   matrix before deployment.

The Linux-testable `src/motion/hevc-encoder-config.ts` validator checks the
sidecar shape and fixed source/output contract. It intentionally cannot certify
Apple encoding or browser alpha behavior; only AVFoundation validation plus the
real-device evidence can do that.

The supplied archive is exactly `900×507`; its odd height is an explicit Apple
hardware/profile capability uncertainty. The command and dry-run retain that
geometry and fail closed if the selected Mac encoder rejects it. We will add a
transparent-row padding step only after an actual hardware rejection is
observed, with a corresponding geometry decision; the encoder never silently
changes the source dimensions.

## Required authoring pipeline

Create the source from an RGBA/ProRes 4444 master, then export with Apple’s
HEVC-with-alpha encoder through AVFoundation (the command above is the
reproducible path; Compressor is not required). The export must use
the codec type `AVVideoCodecType.hevcWithAlpha` and the alpha mode appropriate
to the master (`AVVideoAlphaChannelModePremultiplied` is Apple’s preferred GPU
rendering form). The resulting ISO-BMFF/MOV/MP4 must satisfy Apple’s
[HEVC Video with Alpha Interoperability Profile](https://developer.apple.com/av-foundation/HEVC-Video-with-Alpha-Interoperability-Profile.pdf):

- one HEVC video track containing paired base-color and auxiliary-alpha
  layers;
- matching dimensions and frame timing for both layers;
- `hvc1` signaling and the profile/level required by the target devices;
- video-range base color and full-range alpha samples with the alpha-channel
  SEI metadata; and
- a valid base/alpha frame pair for every presentation timestamp.

Validate the export in Apple’s AVFoundation/QuickTime playback before using it
on the web. Keep the file at a same-origin URL (or pass a same-origin
`hevcSrc=/path/file.mp4` plus matching `hevcAssetId=asset-id` query override in
this prototype). The H renderer
downloads a Blob in the prototype because Pages currently answers static
video range requests with `200`; the Blob gives the hidden candidate a local
seekable timeline.

## Runtime gate

H measures `canPlayType()` only as an initial decoder claim. In this throwaway
prototype it accepts an untrusted manual asset/device evidence override (for
example `asset:hero-v1|device:macos-safari`) plus `hevcAssetId=hero-v1` before
it requests the candidate at all. The query token is not production trust:
shipping H requires a checked-in manifest that binds an immutable asset URL and
hash to the real-device alpha evidence.
Once qualified, it keeps the direct-DOM video hidden while seekable delivery is
prepared and shows only one lightweight static WebP frame-0 poster; it does not
start C's frame scheduler during this runway. The prototype uses a measured
4,000 ms preparation deadline (`HEVC_PREPARATION_DEADLINE_MS`), derived from a
~1.1 s observed random video seek plus the existing 2,000 ms playback
observation budget and additional Blob/decode headroom. At the deadline it
aborts the Blob request and falls back to C, so a stalled candidate cannot leave
the hero blank indefinitely. The gate opens only after capability,
qualification, delivery, and `loadeddata`/`canplay` readiness all pass. A
missing asset, unsupported codec, missing/failed qualification, media error, or
non-seekable URL falls back to C before the base layer is visible. H is never
uploaded to WebGL or reconstructed through a matte shader.

Do not draw HEVC-with-alpha into canvas to “prove” transparency. WebKit bug
[273006](https://bugs.webkit.org/show_bug.cgi?format=multiple&id=273006) shows
that Safari may preserve alpha in a DOM video while losing it on a WebGL/canvas
upload; canvas readback would therefore be a false negative for the path we
intend to ship. Alpha/edge proof belongs to the external real-device evidence
recorded in the release gate.

The release gate remains manual: macOS Safari and iOS Safari edge screenshots,
autoplay/resume, scrub checkpoints, reduced motion, seekable delivery, and
opaque-fallback evidence all must be recorded on representative devices.
`metric-real-device-gate` therefore stays `manual gate` until that evidence is
provided; a headless browser or a codec support string cannot turn it into a
release pass.

The prototype diagnostics also keep C's decoded-cache occupancy separate from
its transfer estimate. The transfer estimate is based on unique successfully
loaded frame IDs, so cache eviction does not make bytes decrease and a later
reload does not double-count a frame.

## Local verification performed

The available encoder list was inspected with:

```sh
/tmp/tmp.JLJwrzhDGG/package/ffmpeg -hide_banner -encoders
```

It includes `libx265`, `hevc_vaapi`, and ProRes encoders, but no
`hevcWithAlpha`/auxiliary-alpha writer. The existing packed H.264 file remains
variant B and is not a compliant HEVC-alpha substitute.

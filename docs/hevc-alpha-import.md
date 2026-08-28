# HEVC-with-alpha import gate (prototype)

The H variant is intentionally a candidate, not a checked-in production codec
asset. A normal HEVC encoder produces an opaque stream; it is not a substitute
for Apple’s paired auxiliary alpha layer. The repository therefore includes a
macOS/Xcode-only AVFoundation authoring command, but keeps its output in the
ignored `motion-artifacts/hevc-alpha-hq/` staging directory until it has passed
the real-device gate. The canonical candidate is deliberately distinct from
the earlier reduced asset: `hero-hevc-alpha-hq-v1`.

## One-command Apple export

Materialize the canonical unreduced source from repository history into ignored
staging once per worktree:

```sh
mkdir -p motion-artifacts/hevc-alpha-source-hq
git archive ed50e2b -- Кадры | tar -x -C motion-artifacts/hevc-alpha-source-hq
```

The encoder rejects any other byte count or ordered source-set hash.

The current AVFoundation-validated candidate is
`hero-hevc-alpha-hq.mov` (11,151,391 bytes), SHA-256
`54ef6d6139d8690f0ea5bd8ab7c5dcfebe3176c6f462af7dc9b093fc3cb1a14c`.
It reports `hvc1`, `containsAlphaChannel=true`, 150 samples at 15 fps,
decoded content alpha `0...255`, and 1280×720 source/coded geometry. This is
authoring evidence, not yet Safari promotion evidence.

On macOS with Xcode selected (`xcode-select --install` is not enough without
the Xcode SDK), run the dry-run first:

```sh
npm run prototype:encode:hevc-alpha -- --dry-run
```

The dry-run decodes all 150 `motion-artifacts/hevc-alpha-source-hq/Кадры/frame_%03d_delay-0.067s.webp`
images with ImageIO, requires a real alpha channel and both transparent and
visible pixels, and checks their fixed source/display `1280×720` dimensions.
It also verifies the ordered source-set SHA-256 is
`1b0887fb70487d7abd0de6e1de5ed2c154ff140a645d8393e4111cf7d3807a66` (the
unreduced archive is 20,046,600 bytes across 150 frames) before asking
AVAssetWriter whether it can apply `AVVideoCodecType.hevcWithAlpha` plus the
configured alpha properties. The coded MOV is also `1280×720`: its
`contentRect` covers the complete surface, with zero padding rows and no clean
aperture. No source pixel is cropped or resized. The dry-run writes no media or
manifest. The actual export is:

```sh
npm run prototype:encode:hevc-alpha -- --force
```

The command uses `AVAssetWriter` directly to write a QuickTime MOV, with premultiplied alpha, target
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
track, coded `1280×720` with the source content contract above, 150 samples,
15 fps, 10 seconds, and the selected track's `containsAlphaChannel`
characteristic. It then decodes every sample through `AVAssetReaderTrackOutput`
as BGRA at `1280×720`, checks the full coded/content alpha range, and records
the not-applicable padding range as `0...0` without scanning an empty row
range. A writer rejection, missing/opaque input alpha, failed
sample/decoded-alpha validation, or manifest/SHA failure deletes the partial
staging output and exits nonzero.

The command also cleans AVAssetWriter sidecars only when their names begin with
the exact requested MOV basename plus `.sb-` in that MOV's immediate staging
directory. It performs that narrow cleanup at startup, after a failed write,
and after success; unrelated `.sb-` files and nested paths are left untouched.

The command emits a deterministic JSON sidecar beside the MOV containing the
source/encode settings, average bitrate, ordered source-set SHA-256 (each
filename + NUL + file bytes in ascending frame order), measured output facts,
decoded alpha range, byte count, and output SHA-256. It also prints exact copy
instructions. The intended handoff is:

1. Keep the MOV and manifest under ignored staging while reviewing the
   transparent edges and seek checkpoints on macOS Safari and iOS Safari.
2. After that review, copy the exact staged file to
   `public/video-prototype/hero-hevc-alpha-hq.mov`.
3. Add a checked-in manifest binding the immutable URL and printed SHA-256 to
   real-device alpha evidence. The prototype query parameters are an untrusted
   manual override and do not replace this production manifest.
4. Run `npm run build`, `npm run verify:dist`, and the supported Safari/iOS
   matrix before deployment.

The Linux-testable `src/motion/hevc-encoder-config.ts` validator checks the
sidecar shape and fixed source/output contract. It intentionally cannot certify
Apple encoding or browser alpha behavior; only AVFoundation validation plus the
real-device evidence can do that.

The canonical supplied archive is exactly `1280×720`, 150 frames, and
20,046,600 bytes. The HQ geometry decision is to preserve every source pixel
directly in a `1280×720` coded surface: `contentRect` is the complete surface,
`paddingRowCount=0`, `paddingRowEdge=none`, `paddingAlpha=not-applicable`, and
`cleanAperture=none`. The encoder does not crop, silently rescale, or add a
clean aperture. Other Macs/SDKs must pass the AVFoundation and decoded-alpha
checks; a capability failure is reported rather than changing the contract.

The earlier `900×507` source and `900×508` padded MOV remain historical
candidate evidence only. That workaround was needed for one odd-height
authoring path and is not the HQ input, output, or runtime asset.

## Required authoring pipeline

Create the source from an RGBA/ProRes 4444 master, then export with Apple’s
HEVC-with-alpha encoder through AVFoundation (the command above is the
reproducible path; Compressor is not required) to a QuickTime `.mov`. The export must use
the codec type `AVVideoCodecType.hevcWithAlpha` and the alpha mode appropriate
to the master (`AVVideoAlphaChannelModePremultiplied` is Apple’s preferred GPU
rendering form). The resulting QuickTime MOV must satisfy Apple’s
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
`hevcSrc=/path/file.mov` plus matching `hevcAssetId=asset-id` query override in
this prototype). The H renderer
downloads a Blob in the prototype because Pages currently answers static
video range requests with `200`; the Blob gives the hidden candidate a local
seekable timeline.

The H DOM element is laid out in the existing definite-size hero stage with
`object-fit: cover`; its intrinsic coded height therefore does not size the
stage. The HQ diagnostic resolution reports `1280×720 content · coded
1280×720`, and the visible artwork contract uses `aspect-ratio: 1280 / 720`.
C's canvas remains the independent reduced source contract until the runtime
promotion decision is made.

## Runtime gate

H measures `canPlayType()` only as an initial decoder claim. In this throwaway
prototype it accepts an untrusted manual asset/device evidence override (for
example `asset:hero-hevc-alpha-hq-v1|device:macos-safari`) plus the matching
`hevcAssetId` before it requests the candidate at all. The query token is not
production trust: shipping H requires a checked-in manifest that binds an
immutable asset URL and hash to the real-device alpha evidence.
Once qualified, it keeps the direct-DOM video hidden while seekable delivery is
prepared and shows only one lightweight static WebP frame-0 poster; it does not
start C's frame scheduler during this runway. The prototype uses a measured
15,000 ms preparation deadline (`HEVC_PREPARATION_DEADLINE_MS`) for this manual
device test. Cloudflare Pages currently answers the staged MOV with `200`
instead of a verified byte-range response, so the prototype must prepare the
11.2 MB file as a locally seekable Blob behind frame 0. At the deadline it
aborts the Blob request and falls back to C, so a stalled candidate cannot leave
the hero blank indefinitely. Production should move the qualified MOV to a
range-capable media origin instead of extending this deadline. The gate opens
only after capability,
qualification, delivery, and `loadeddata`/`canplay` readiness all pass. A
missing asset, unsupported codec, missing/failed qualification, media error, or
non-seekable URL falls back to C before the base layer is visible. H is never
uploaded to WebGL or reconstructed through a matte shader.

The candidate MOV remains deliberately ignored. A staging deployment must be
built from an artifact-bearing worktree and independently verify the deployed
file's byte count and SHA-256. A clean clone intentionally omits H and falls to
C until real-device evidence promotes the asset to durable media storage.

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

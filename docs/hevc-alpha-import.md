# HEVC-with-alpha import gate (prototype)

The H variant is intentionally a candidate, not a generated codec asset. The
workspace FFmpeg build exposes `libx265` and ProRes encoders, but it does not
write Apple’s HEVC auxiliary alpha layer. Encoding the RGBA frames with plain
`libx265` would produce an opaque HEVC stream and would make the prototype
claim a capability it does not have. No HEVC file is checked in until an
Apple-compliant export is supplied.

## Required authoring pipeline

Create the source from an RGBA/ProRes 4444 master, then export with Apple’s
HEVC-with-alpha encoder through Compressor/AVFoundation. The export must use
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

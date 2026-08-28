# Transparent, scrub-driven hero media research

**Checked:** 2026-08-28  
**Status:** temporary decision note; no production code changed  
**Scope:** a transparent moving subject driven by scroll/pointer input on macOS Safari, iOS Safari, and Chromium.

## Decision in brief

The prototype has enough evidence to choose **C (individual RGBA WebP frames drawn to a canvas) as the current universal baseline**. It is the only tested route that is visually clean on the reported macOS/iOS Safari targets and it gives the application an exact, deterministic frame address. Its main risks—decode memory, CPU, and request count—are engineering risks that can be bounded with a small decode cache and chunking.

There is also a credible **separate Safari optimization**: Apple HEVC-with-alpha in an ordinary DOM `<video>`, composited by Safari, not uploaded to WebGL. Apple documents this format and Safari’s web support, but WebKit has an open bug for losing alpha when transparent video is uploaded to WebGL. This option must therefore remain a platform branch with a real-device alpha/edge-quality gate; it is not a reason to replace C before that gate passes. A good production hierarchy is:

1. C for all browsers initially (and as the universal fallback).
2. Optionally, Safari HEVC-with-alpha direct DOM video after proof on the exact macOS/iOS support matrix.
3. Optionally, VP9A WebM direct DOM video for Chromium if its visual and scrub tests pass; do not use it as Safari’s alpha path.
4. Keep packed H.264 + matte/WebGL only as an experiment or last-resort fallback. The current B artifacts are consistent with lossy color/matte edge contamination and are not fixed by changing playback controls.

This is an evidence-based recommendation, not a claim that C is the only technically possible implementation. In particular, the HEVC branch is preserved below with an exact pipeline, trade-offs, and acceptance gates so it can be evaluated independently.

## What was actually observed

The local prototype currently compares:

- **A:** one VP9-alpha WebM (`hero-alpha-vp9.webm`).
- **B:** one packed H.264 video with RGB and a matte side by side, reconstructed in WebGL.
- **C:** 150 individual 900×507 RGBA WebP frames drawn to a 2D canvas.
- **FB3:** the packed-video route falling back to the C frame sequence.

The measured compressed C sequence is about **4.58 MB** (`du -cb` over the 150 frames). One fully decoded 900×507 RGBA frame is 1,825,200 bytes; retaining all 150 as raw RGBA would be about **261 MiB** (binary), before browser/canvas overhead. Those numbers are local measurements and the memory estimate is an inference; browsers may retain compressed images or evict surfaces differently. They argue for a bounded decoded cache, not against the format.

The reported device result is consistent across the current review: C and FB3 are clean on macOS/iOS Safari, while A and B show a moving/pixelated fringe around the subject. A browser claiming it can play a file is not evidence that its alpha survives the whole compositor/WebGL path.

## Format and browser evidence

| Path | What the primary documentation supports | Consequence here |
| --- | --- | --- |
| Individual or animated WebP | Google’s WebP documentation describes lossy/lossless WebP with alpha and animation; Safari 14+ supports alpha and animation. The WebP container specification defines VP8X alpha and ANIM/ANMF frames. ([WebP FAQ](https://developers.google.com/speed/webp/faq), [WebP container](https://developers.google.com/speed/webp/docs/riff_container)) | C has broad alpha support and explicit frame addressing. Animated WebP is a possible request-count optimization, but individual files are easier to scrub exactly. |
| VP9A WebM | Chromium’s own media test data and pipeline tests include VP9 video with alpha (`VP9A`, including an alpha pixel format). ([Chromium test data](https://chromium.googlesource.com/chromium/src/+/lkgr/media/test/data/README.md), [Chromium pipeline test](https://chromium.googlesource.com/chromium/src/+/2de69291f6f930174f948cf3/media/test/pipeline_integration_test.cc)) Chromium also added VP9 alpha plumbing for 4:2:2 and 4:4:4 in 2026, which is worth testing when edge quality matters. ([Chromium VP9 alpha 4:2:2/4:4:4 change](https://chromium.googlesource.com/chromium/src/media/+/a4f1b39859a6a4e80c9413ef74d5b5986051a02d)) MDN’s current codec guidance records alpha as unsupported in Safari for VP8/VP9. ([MDN video codecs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)) | A can be a Chromium branch only if its edge quality is clean there; a 4:4:4 encode may be an experiment for reducing chroma-edge damage, subject to hardware support. A Safari `canPlayType()` result must not select it as an alpha implementation. |
| AV1 WebM/MP4 video | WebKit added AV1 playback on hardware-supported Apple devices, and MDN documents AV1 as a web video codec. ([WebKit Safari 17](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/), [MDN video codecs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)) Neither source establishes a portable alpha-enabled AV1 `<video>` path; the AOM alpha definition cited below is for AVIF image items/sequences. That distinction is an inference from the respective specifications. | AV1 is a good opaque-video candidate, not a demonstrated transparent-video replacement for C. Adding a second matte returns to B’s composition problem. |
| HEVC with alpha | Apple defines HEVC-with-alpha as a single track containing base color and an auxiliary alpha layer, with premultiplied and straight-alpha forms; the interoperability profile specifies `hvc1`, matching dimensions, alpha range/SEI, and paired base/alpha frames. Apple documents Safari web playback from iOS 13 and macOS Catalina and recommends premultiplied alpha for GPU rendering. ([Apple WWDC19](https://developer.apple.com/kr/videos/play/wwdc2019/506/), [Apple interoperability profile](https://developer.apple.com/av-foundation/HEVC-Video-with-Alpha-Interoperability-Profile.pdf), [Apple codec type](https://developer.apple.com/documentation/avfoundation/avvideocodectype/hevcwithalpha)) | This is the strongest credible alpha-video alternative, but it should stay as a direct DOM `<video>` path. It is not a portable Chromium alpha contract and is not safe to upload to WebGL on Safari. |
| Packed H.264 + matte | H.264 carries no native alpha channel. B’s reconstruction is an application-defined two-image shader pipeline. The current prototype’s packed stream uses ordinary lossy H.264; this is an inference from the asset/renderer and the observed fringe, not a browser guarantee. | Color subsampling/quantization, matte compression, filtering across the packed seam, and RGB/matte edge-color mismatch can all create dancing halos. A control-state fix cannot remove those encoded pixels. |
| Animated AVIF | WebKit documents animated AVIF support from Safari 16.1/16.4. ([Safari 16.1](https://webkit.org/blog/13399/webkit-features-in-safari-16-1/), [Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)) AOM’s AVIF specification defines alpha as an auxiliary image item/sequence, not as a general alpha-enabled AV1 video contract. ([AOM AVIF specification](https://aomediacodec.github.io/av1-avif/)) | It is an interesting compressed sequence candidate, but Safari has had animation/transparency regressions, including an open blank-animated-AVIF report in August 2026. ([WebKit bug 275906](https://bugs.webkit.org/show_bug.cgi?id=275906), [WebKit bug 322274](https://bugs.webkit.org/show_bug.cgi?id=322274)) Do not make it the baseline without a versioned device gate. |
| WebCodecs/ImageDecoder | The WebCodecs specification exposes per-frame image decoding and alpha-capable video-frame formats, but support is deliberately user-agent/resource dependent. `VideoFrame.close()` is required for timely resource release. ([W3C WebCodecs](https://www.w3.org/TR/webcodecs/)) MDN marks `ImageDecoder` as limited availability and secure-context/worker oriented. ([MDN ImageDecoder](https://developer.mozilla.org/en-US/docs/Web/API/ImageDecoder)) | Useful for a future custom decoder/worker path when the sequence becomes too large, not a cross-browser baseline. It does not repair artifacts already present in an encoded stream. |

### Why Safari A and B fail differently from C

Safari has had broad WebM playback improvements—WebM VP8/VP9 support arrived on iOS/iPadOS in Safari 17.4 and on macOS in 14.1—but playback support is not the same as VP9 alpha support. ([WebKit Safari 17.4](https://webkit.org/blog/15063/webkit-features-in-safari-17-4/), [MDN video codecs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)) The user’s A result is therefore expected to fail the alpha requirement even when the video itself plays.

The WebKit bug “texImage2D loses alpha from transparent video” reports that Safari can display transparent HEVC/ProRes video through HTML DOM, while uploading the same transparent video frame to a WebGL texture makes it opaque. The bug is still open/new. ([WebKit bug 273006](https://bugs.webkit.org/show_bug.cgi?format=multiple&id=273006)) This is direct evidence against treating WebGL as a transparent-video compatibility layer on Safari. It also explains why a future HEVC path must remain a DOM layer, not a replacement for C’s canvas pixels.

B has an additional source of risk: it compresses both color and matte into a normal video and asks a shader to reconstruct an edge that was never encoded as native alpha. Even with correct shader math, a lossy seam can be visibly unstable against changing backgrounds. This diagnosis is an inference from the packed representation and the reported screenshots; it should be confirmed by an edge-patch comparison against a lossless reference.

## Option 1 — C as the universal production baseline

### Exact pipeline

```text
RGBA source frames
  -> individual lossless/lossy WebP files with alpha
  -> latest requested frame index from scroll/pointer
  -> decode only a bounded neighborhood
  -> draw the ready frame to a 2D canvas
  -> hold the last ready frame while a newer target decodes
```

`HTMLImageElement.decode()` resolves when an image is decoded and safe to use; `createImageBitmap()` can crop from a sprite/atlas, resize, and choose alpha premultiplication behavior. `ImageBitmap.close()` releases its graphical resources. ([MDN `decode()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode), [MDN `createImageBitmap()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap), [MDN `ImageBitmap.close()`](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap/close))

The practical implementation should keep `targetFrame`, `displayedFrame`, and `renderedFrame` separate. A decode completion must never move the target backward or restart playback. Only the latest target matters during a fast scroll; stale requests can be cancelled/deprioritized. A small ahead/behind window (or chunked atlas) should be selected from real-device memory/frame-time measurements, not hard-coded as a universal number. A giant atlas lowers request count but can force a very large decode surface; chunked atlases or individual files are safer.

The C sequence is particularly compatible with Cloudflare Pages: each image is an ordinary full request and does not require byte-range seeking. Immutable hashed frame URLs can be cached independently. The current 4.58 MB compressed total is small enough for this prototype, although request overhead and decode CPU still need profiling.

### Costs and mitigations

- **Decoded memory:** do not decode/retain all 150 frames. Use a bounded cache; close evicted `ImageBitmap`s; retain only the current frame plus a small neighborhood/chunk.
- **CPU/decode latency:** decode a few frames ahead of the target and hold the last ready frame rather than showing a blank. `requestAnimationFrame` should commit at most one latest ready frame per visual tick.
- **Requests:** individual images are the most deterministic. If request count is material, pack 8–16 frames per atlas as an experiment, measure atlas decode/memory, and keep the individual-frame fallback. The chunk size is a hypothesis, not an industry guarantee.
- **Canvas work:** OffscreenCanvas can move 2D work to a worker where supported; Safari added 2D OffscreenCanvas in 16.4 and WebGL in a worker in Safari 17. ([WebKit Safari 17](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/), [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)) This is a performance optimization only; it does not fix encoded alpha.

## Option 2 — Safari HEVC-with-alpha as a separate viable path

This is the credible way to preserve native alpha video without the B shader composition. It should be evaluated separately, not silently substituted into C.

### Authoring and delivery pipeline

```text
RGBA / ProRes 4444 master
  -> Apple AVFoundation/Compressor HEVC-with-alpha export
     (premultiplied alpha preferred; `hvc1`; one base + one alpha layer)
  -> ISO-BMFF MP4/MOV with matching base/alpha frame timing
  -> direct HTML <video> element over the page background
  -> Safari capability check + transparent-corner/edge smoke test
  -> HEVC branch only on a passing device; otherwise C
```

The Apple interoperability profile is the authoritative encoding contract: one video track, two Main Profile layers, equal dimensions, video-range base, full-range alpha, alpha-channel SEI, and a base sequence followed by its alpha sequence for every frame. Apple recommends premultiplied alpha for GPU rendering and documents that a decoder which ignores alpha may display only the base layer. ([Apple interoperability profile](https://developer.apple.com/av-foundation/HEVC-Video-with-Alpha-Interoperability-Profile.pdf), [Apple WWDC19](https://developer.apple.com/kr/videos/play/wwdc2019/506/))

Render it as a normal, transparent `<video autoplay muted playsinline loop>` in the DOM. Do **not** send the Safari HEVC video through `texImage2D`, WebGL, or a canvas readback path; WebKit’s open bug specifically reports alpha loss in that route. ([WebKit bug 273006](https://bugs.webkit.org/show_bug.cgi?format=multiple&id=273006)) Use `navigator.mediaCapabilities.decodingInfo()`/the optional alpha capability query where exposed, then verify with a tiny known-transparent test clip. `canPlayType()` alone is insufficient because it says little about alpha preservation, hardware decode, or compositor behavior. WebKit documents Media Capabilities checks for codec features including alpha transparency. ([WebKit Safari 13](https://webkit.org/blog/9674/new-webkit-features-in-safari-13/))

For a scroll-driven version, pause while scrubbing and set `video.currentTime = targetFrame / fps`; treat seeking as asynchronous. Use `requestVideoFrameCallback()` to observe the presented media time, not as the target state. ([MDN `currentTime`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime), [MDN `requestVideoFrameCallback()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)) A short GOP/keyframe interval reduces seek latency, but exact arbitrary-frame presentation is still less deterministic than C. If the product requires exact frame `62` immediately after a drag, keep C for that interaction or prove the HEVC seek behavior on the target devices.

### Why this option is worth testing

Hardware video decode can reduce CPU/battery cost, and one compressed stream avoids 150 image requests. Apple’s documentation explicitly describes alpha as part of the HEVC track rather than a shader reconstruction. Those are advantages over B. The costs are equally real: Apple-oriented authoring/tooling and licensing considerations, browser/device-dependent HEVC decode, asynchronous/keyframe-dependent seeking, and the requirement to avoid Safari’s WebGL upload path. Chromium’s media documentation treats HEVC as platform/hardware dependent and does not establish a cross-browser HEVC-alpha web contract. ([Chromium audio/video](https://www.chromium.org/audio-video/))

### Proof required before shipping

The HEVC branch is viable only if all of these pass on the actual release matrix:

- macOS Safari versions in scope: transparent corners reveal both light and dark page backgrounds; no moving halo or matte pixels at the recorded edge patches;
- iOS Safari versions/devices in scope: same alpha and edge checks, with `muted`/`playsinline` autoplay behavior;
- first paint, continuous playback, visibility/resume, reduced motion, and explicit pause/resume;
- target seeks around frames 0, 31, 38, 62, 70, and the terminal frame, with observed presented frame recorded separately from requested frame;
- direct DOM rendering remains transparent; a test that uploads the video to WebGL is explicitly not a pass criterion;
- the delivery URL supplies correct `206 Partial Content`, `Accept-Ranges`, `Content-Range`, and a nonzero `seekable` range, or the application deliberately accepts a full Blob download;
- a non-HEVC/alpha failure selects C without a flash of an opaque base layer.

Cloudflare Pages currently documents that it returns `200` for HTTP range requests and says spec-compliant `206` support is still being worked on. ([Cloudflare Pages serving](https://developers.cloudflare.com/pages/configuration/serving-pages/)) That is why the current prototype fetches a Blob before seeking. For a production HEVC stream, use an origin/storage path with verified range support (for example, an R2/custom delivery route) or knowingly pay the full-download cost. Pages’ single-asset limit is 25 MiB, so the current prototype files are below that limit, but range semantics—not just file size—determine video behavior. ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/))

## Option 3 — VP9A for Chromium, C for Safari

Chromium’s own tests make VP9A a legitimate alpha-video route for Chromium. A direct DOM `<video>` avoids the Safari-specific WebGL upload issue, but Safari’s alpha support is still not available for VP8/VP9 according to current browser guidance. Therefore the safe selection is:

```text
Chromium/Firefox with a passing VP9A probe -> VP9A DOM video
Safari or unknown / probe failure          -> C
```

This can reduce frame requests and provide smooth ordinary playback. It is a poor choice for an exact scroll scrub unless short GOPs and device seek behavior are proven. It also creates a second encode and two different visual paths to maintain. Given the user’s current macOS Safari result, A must not be the Safari default merely because WebM playback itself succeeds.

## Option 4 — packed color + matte/WebGL (B) and what a salvage attempt would require

The current B result should be considered **failed for the Safari visual requirement**. If it must remain available for a constrained platform, a serious re-encode experiment would need:

- full-resolution matte, with alpha edges authored against the intended premultiplied representation;
- no ordinary 4:2:0 color subsampling at the edge if the target decoder can actually support a higher chroma format;
- enough bitrate/quality for both the color and matte halves, or a separately encoded high-quality matte;
- shader sampling at correct texel centers, no interpolation across the packed seam, and explicit premultiplication/edge-color handling;
- comparison against the original RGBA frames on light/dark/high-contrast backgrounds, not merely a playback-success check.

This raises bytes and decoder-compatibility risk and still depends on browser GPU behavior. It is not a documented alpha guarantee. The more defensible native-alpha alternative is HEVC-with-alpha in the DOM; the more defensible cross-browser exact-scrub alternative is C.

## Deterministic scroll/scrub architecture

CSS scroll-driven animations are useful for ordinary CSS properties, but the current CSS scroll timeline API is not Baseline and has incomplete browser coverage. ([W3C Scroll Animations](https://www.w3.org/TR/scroll-animations-1/), [MDN scroll-driven animations](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll-driven_animations), [MDN `scroll()` timeline](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-timeline/scroll)) The frame decoder should therefore retain a JavaScript input path with feature detection.

Use one state flow:

```text
trusted scroll/pointer input
  -> normalized progress
  -> latest targetFrame (source of truth)
  -> one scheduler chooses/requests that frame
  -> decoded/presented frame commits as displayedFrame
  -> renderer records renderedFrame
```

For C, the commit is a decoded image draw. For video, the commit is asynchronous: `currentTime` is a requested media position, while `requestVideoFrameCallback()`/the media timeline reports what was presented. The HTML media specification allows a current-time update before the corresponding frame is rendered. ([WHATWG media](https://html.spec.whatwg.org/multipage/media.html), [MDN `requestVideoFrameCallback()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)) Never use a playback callback to overwrite the user’s target frame; it is observation, not intent.

During a fast drag, discard stale decode work and hold the last ready frame. On release, request the latest target again and only resume continuous looping if the product explicitly wants playback to resume. A static first/last frame is the reduced-motion and failure fallback. This model explains the user’s “intended frame is always 62” observation: intent and presentation must be logged independently rather than described as “converging.”

## Deployment and performance recommendation

For the current Cloudflare Pages deployment, keep C’s frame files as immutable assets and use a bounded decode window. If request count becomes a measurable problem, compare chunked atlases against individual frames using real Safari/Chromium memory and frame-time traces. Do not retain all raw RGBA surfaces by default.

If the hero grows beyond what image delivery can tolerate, test HEVC-alpha DOM on Safari and VP9A on Chromium as optional playback branches, with C as the fallback. A video branch should be hosted where byte ranges are verified; a Pages `200` response means the application may need to download the whole asset before seeking. Cloudflare documents ranged reads for R2 and `206` partial content for streaming responses. ([R2 range API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [Cloudflare HTTP 206](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/2xx-success/))

## Release gate / test matrix

Before declaring an alternate media path production-ready, record a matrix rather than relying on `canPlayType()`:

| Gate | macOS Safari | iOS Safari | Chromium desktop/mobile |
| --- | --- | --- | --- |
| transparent-corner probe over light/dark backgrounds | required | required | required |
| edge-patch screenshot: no dancing halo/matte pixels | required | required | required |
| continuous autoplay and visibility resume | required | required (`muted`, `playsinline`) | required |
| exact target seeks and observed-vs-requested frame trace | required | required | required |
| reduced-motion/static fallback | required | required | required |
| delivery `206`/seekable check, or documented full-Blob cost | required for video | required for video | required for video |
| bounded decoded memory and frame-time profile | required | required | required |

The alternate path should be enabled only after it passes twice on representative devices and after comparison with C at the same checkpoints. Headless Chromium or a codec support string is not a substitute for the Safari visual gate. The existing prototype’s frame checkpoints (including 31, 38, 62, 70, and terminal) should remain in that matrix because they exercise both the reported stop point and the user’s drag/click cases.

## Sources

The links above are the sources used for the claims in this note. They are limited to Apple/AVFoundation, WebKit, Chromium, W3C/WHATWG, MDN, Google WebP, AOM, and Cloudflare documentation or issue trackers. Browser support and WebKit bugs are time-sensitive; re-run the device gate when Safari/Chromium versions or the encoding pipeline changes.

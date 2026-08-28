# Mobile hero stall observability

**Checked:** 2026-08-28  
**Status:** delivery acceptance foundation; product playback is unchanged
**Scope:** the reported iPhone-on-cellular case where the first-screen hero appears to stop before its terminal frame.

## Conclusion

This is a normal-sized foundation task, not a large rewrite. A focused
diagnostics-only observer, a small pure trace classifier, and three deterministic
browser fixtures should take roughly one implementation session (about 0.5–1
day), followed by a short real-iPhone capture. It is worth doing before changing
playback: one screenshot or one final `currentTime` cannot tell a real stall from
the intentional frame-31 checkpoint.

The recommended RED/GREEN seam is the existing loopback/dev-only
`window.__portfolioMotion.snapshot()` surface. Extend its hidden hero snapshot
with a bounded, serializable media trace; do not add an on-page diagnostic
window. The same trace schema should be usable by a pure classifier and by the
real-device importer.

## Reported context to preserve

The user tested the current Cloudflare Pages staging build on a real iPhone
over a mobile network. Two related symptoms must remain separate in future
work:

1. **Slow initial loading.** The qualified iPhone Safari path (H) currently
   fetches and SHA-256 verifies the complete 11,151,391-byte HQ HEVC-alpha MOV
   before assigning a Blob URL to the hidden video. The preparation deadline is
   four seconds. On a cellular connection, H can therefore time out before the
   full file arrives and fall directly to C.
2. **An apparent freeze before the animation finishes.** After the long load,
   the animation appeared to stop around the middle. We do not yet know whether
   this was the intentional frame-31 checkpoint, H-to-C fallback followed by C
   frame starvation, or a genuine native presented-frame stall. Do not label
   or fix it from appearance alone; capture the trace proposed below first.

The slow-loading observation and the freeze may share a cause, but that is not
yet proven. In particular, H and A play from a complete local Blob once they
are exposed, so cellular buffering cannot explain a native mid-playback stall
after Blob preparation. Cellular speed can still cause the earlier H timeout
and make the subsequent demand-loaded C renderer visibly wait for frames.

On 2026-08-28 the deployed Pages asset was probed with
`Range: bytes=0-1023`. Pages returned `HTTP 200`,
`Content-Length: 11151391`, and the complete `video/quicktime` object rather
than `206 Partial Content`. This measured behavior is why the runtime currently
uses a full Blob; it is also the delivery constraint the next migration must
remove.

## Proposed streaming-origin migration

Use **Cloudflare R2 Standard storage behind a custom media domain** for the
exact authored MOV. Do not use Cloudflare Stream: Stream automatically
re-encodes uploads for H.264 adaptive playback, while this asset depends on its
original HEVC auxiliary-alpha track and exact bytes. Cloudflare also states
that the exact uploaded Stream file is not the downloadable playback asset.
([Cloudflare Stream overview](https://developers.cloudflare.com/stream/),
[Stream uploads](https://developers.cloudflare.com/stream/uploading-videos/),
[Stream FAQ](https://developers.cloudflare.com/stream/faq/))

Recommended rollout:

1. Create an R2 Standard bucket and upload the validated MOV plus its manifest
   under a versioned immutable key such as
   `hero/hero-hevc-alpha-hq-v1-54ef6d61.mov`. Preserve
   `Content-Type: video/quicktime`, the asset SHA-256 in deployment metadata,
   and a long immutable cache policy.
   ([R2 object uploads and HTTP metadata](https://developers.cloudflare.com/r2/objects/upload-objects/))
2. Attach a custom media domain. Cloudflare documents custom domains as the
   production path for public R2 objects and the path that enables Cloudflare
   Cache; `r2.dev` is rate-limited and intended only for development.
   ([R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/),
   [R2 cache setup](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/))
   Add an explicit cache rule for the versioned `.mov` path: MOV is not in
   Cloudflare's default cached-extension list, unlike MP4 and WebM.
   ([Cloudflare default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/))
3. Configure CORS for the portfolio origin and expose the headers needed to
   verify delivery (`Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`,
   and cache status). Purge cached objects after changing CORS.
   ([R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/))
4. Before changing the site, gate the origin with automated requests for the
   startup metadata range, first, middle, suffix, Safari-style nonzero
   open-ended (`bytes=N-`), invalid, and full ranges. A valid single range must return
   `206`, the exact `Content-Range` and byte count, stable identity, and the
   correct bytes; an invalid range must return `416`. Require no
   `Content-Encoding` transformation and stable `Content-Length`/`ETag`, but do
   not treat an R2 multipart ETag as the file SHA-256. Independently verify that
   the MOV metadata needed to start decoding (the `moov` atom) is available
   without fetching the whole file and that the HEVC auxiliary-alpha track is
   unchanged.

   The probe makes the startup range the first media request and records its
   observed cache status, `Age`, latency, and bytes before the full-object
   cache observation. It does **not** call that request “cold”: an immutable key
   may already be cached, and the probe cannot purge another cache. To obtain a
   genuinely fresh-cache observation, upload the same bytes under a new
   versioned key (or explicitly purge the custom-domain URL), run once, then
   run again against that same key for the warm observation. The normal gate
   requires the second full response to be `CF-Cache-Status: HIT` with numeric
   `Age`; the first request's cache state is evidence to record, not a pass/fail
   assumption. Range support alone does not guarantee fast media startup, so
   the final cellular performance gate remains a real-iPhone test.
5. If the direct R2 custom-domain response does not satisfy that contract, put
   a small Worker in front of the bucket. The R2 Workers API accepts byte-range
   reads, and Cloudflare's cache can answer client Range requests from a cached
   full response as `206`. For the cacheable design, the Worker must return the
   full `200` object with its known length and let Cloudflare slice it; a
   Worker-generated `206` is not cached. Keep this as a fallback adapter, not
   the first layer of infrastructure.
   ([R2 Workers ranged reads](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
   [Workers cache Range behavior](https://developers.cloudflare.com/workers/cache/configuration/#range-requests))
6. Only after the origin passes the gate, point H directly at the versioned
   media URL and remove the client-side full-Blob download. Keep H hidden until
   media readiness, retain the four-second fail-open during rollout, and keep C
   as the correctness fallback. Replace per-client whole-file hashing with
   deployment-time SHA-256 verification plus the immutable URL/ETag; otherwise
   streaming would be defeated by downloading the entire file again.

The acceptance probe for step 4 is deliberately a command-line check, not a
browser diagnostic window. After the R2/custom-domain object is available,
run it with the exact media URL:

```sh
npm run probe:media-origin -- \
  --url https://media.example.com/hero/hero-hevc-alpha-hq-v1-54ef6d61.mov \
  --origin https://portfolio.example \
  # optionally enforce an origin-only startup latency budget:
  # --startup-range-max-ms 750
# or: MEDIA_ORIGIN_URL=https://media.example.com/... \
#     MEDIA_SITE_ORIGIN=https://portfolio.example npm run probe:media-origin
```

[`scripts/probe-media-origin.ts`](../scripts/probe-media-origin.ts) reads the
checked-in MOV and first performs a startup `GET` through the complete
top-level `moov` box, before any full-object request. It then performs `HEAD`,
a complete cache-prime observation, a second warm `GET`, and warm metadata/
first/middle/suffix/open-ended (`bytes=N-`, bounded near the tail) and invalid ranges. It requires the expected
`200`/`206`/`416` statuses, exact `Content-Length` and `Content-Range`,
`video/quicktime`, `Accept-Ranges: bytes`, no `Content-Encoding`, one stable
non-empty `ETag`, explicit CORS for the supplied site Origin, all range/
identity/cache headers exposed, and `public, max-age=31536000, immutable`
cache semantics. The second full response must report Cloudflare
`CF-Cache-Status: HIT` with a numeric `Age`, proving that the prime request was
cacheable and the next request was served warm. The startup request's cache
state is reported but is never required to be `MISS`, because a true cold
claim needs a new/purged URL. Every request reports elapsed time, status, cache
state, and response bytes when a response is available; `--startup-range-max-ms`
can turn an origin-only startup latency budget into an explicit RED check. The
default final label is deliberately **protocol-only GREEN**, not cellular
performance evidence. The probe follows no redirects, has both per-request
and total deadlines (including response-body reads), bounds each response
before buffering it, prints a RED report on any mismatch, and writes no files.
A Pages URL is an intentional RED fixture: its range request currently returns
`200` and the complete object, so it must not be used as evidence for streaming.

R2 is proportionate for this asset: Standard storage currently includes a
10 GB-month free tier, 10 million monthly Class B reads, and free Internet
egress. The trade-off is operational rather than financial: one bucket, one
custom hostname/CORS policy, an upload-and-hash step, and possibly a very small
range Worker. ([R2 pricing](https://developers.cloudflare.com/r2/pricing/))

This migration should be a separate RED/GREEN slice from stall recovery. Its
protocol RED test is the current Pages `200` response to a Range request;
protocol GREEN is the new origin returning correct `206`/`416` responses,
including `bytes=N-`, with byte identity and a warm cache observation. That
label does not claim that cellular startup is fast. The performance GREEN gate
is a fresh real-iPhone Safari run over cellular (with the request timing and
media trace), followed by a warm run; the stall trace remains necessary even
after streaming, because correct delivery does not prove that frames continue
to be presented.

## What the current implementation can and cannot prove

Production chooses H (direct DOM HEVC alpha) only for the qualified iPhone
Safari profile, A (direct DOM VP9 alpha) for a qualified non-Safari browser, and
C (the bounded WebP sequence) otherwise. H/A are fetched into a Blob, shown only
after the hidden candidate is ready, and currently observe
`loadedmetadata`/`loadeddata`/`canplay`/`playing`/`timeupdate`/`error` plus
`requestVideoFrameCallback()`'s `mediaTime`. C exposes target, display, and
rendered frames plus image readiness counts. Those fields are useful, but there
is no event history or media-buffer state, so a single snapshot cannot establish
why progress stopped.

The shared contract makes the likely false positive explicit: frame **31** is
the end of the automatic intro (`1,400 ms`) and the `ready` checkpoint. The
hero is expected to pause there until the next downward gesture. Frame **149**
is the terminal frame after the 3,500 ms playing phase;
`complete`/`playbackCompleted` and a terminal presented/rendered frame are
the success condition. The observer must label those states rather than calling
either one a stall.

## Facts to record

For every media event and at a bounded sampling interval (50–100 ms while the
hero is expected to move), record one sample with:

```text
t, app phase, playbackCompleted, target/display/rendered frame,
renderer requested/active, document visibility, scene active,
native: currentTime, duration, playbackRate, paused, ended, seeking,
       readyState, networkState, buffered ranges, seekable ranges,
       last media event,
rVFC: mediaTime, presentedFrames, presentationTime, expectedDisplayTime,
      processingDuration,
C queue: requested, active requests, pending/failed, last frame selection
```

Keep the ring buffer bounded (for example, the last 512 samples/events) and
enable it only behind the existing diagnostics gate. `timeupdate` is not a
frame proof: the HTML Standard rate-limits it, whereas
`requestVideoFrameCallback` reports a frame sent for composition. Its
`mediaTime` is the presented frame's media timestamp, and `presentedFrames`
can reveal missed frames; the API is best-effort and may be one v-sync late, so
it is evidence, not a replacement for the app's target state. ([WHATWG
media](https://html.spec.whatwg.org/multipage/media.html),
[requestVideoFrameCallback proposal](https://wicg.github.io/video-rvfc/))

Add `waiting`, `stalled`, `progress`, `suspend`, `pause`, `play`,
`seeking`, `seeked`, `ended`, `durationchange`, and `emptied` to the
event tape. The standard distinguishes them: `waiting` means the next frame
is unavailable while the element is not paused; `stalled` means fetching is
unexpectedly not bringing data; `ended` means the media timeline reached its
end (when not looping). `readyState`, `networkState`, and `buffered` must
be sampled alongside events: a browser may discard buffered ranges, and
`canplaythrough` is only an estimate. ([HTML network states and
events](https://html.spec.whatwg.org/multipage/media.html#network-states),
[HTML ready states](https://html.spec.whatwg.org/multipage/media.html#ready-states),
[HTML buffered ranges](https://html.spec.whatwg.org/multipage/media.html#dom-media-buffered))

Because H/A are downloaded by `fetch()` before the Blob URL is attached, also
record candidate preparation start/end, response status, Blob bytes, and the
four-second deadline/fallback event. `video.networkState` alone cannot
describe that earlier fetch. C needs per-frame load start/end/failure times in
addition to its existing queue counts.

## Deterministic classification

The pure classifier should accept a trace and return one of these mutually
exclusive outcomes, with the first matching reason retained:

| Outcome | Required evidence |
| --- | --- |
| `intentional-intro-checkpoint` | `phase=ready`, an `intro-complete` transition, frame 31 (within one frame), no `playbackCompleted`; this is expected waiting for input. |
| `slow-preparation` | H/A remains `preparation=hidden` while `phase=loading`, then records its deadline/delivery failure and falls to C; no native surface was exposed before that decision. |
| `playback-underflow` | `phase=intro` or `playing`, motion expected, `paused=false`, not seeking/hidden/ended, and a `waiting` or corroborating `stalled` state with no presented-frame advance for at least three 15-fps frame periods (~200 ms). `buffered` ending at/near current time supports the diagnosis; an isolated `stalled` event does not prove visible interruption. |
| `permanent-stop-before-terminal` | `phase=playing` and not complete, while the presented frame (H/A) or rendered frame (C) remains unchanged for a bounded recovery window (suggested 1,000 ms), or `pause`/`ended` occurs below frame 149 without an app transition. Exclude visibility changes, an explicit pause, a pending seek, and a C frame still loading; those are separate causes. |
| `intentional-terminal` | `playbackCompleted=true`, `phase=complete`/`exit-hold`, target and presented/rendered frame at 149 (±1), followed by the expected pause/hold. |

For C, a target that advances while `renderedFrame` stays behind is a decode or
request starvation case, not HTML media underflow. The trace should name it as
`sequence-readiness-gap` if the queue remains pending, and as
`sequence-permanent-stop` only after the same bounded no-progress window with
no pending work. This keeps “the animation stopped” tied to observed state,
not to a visually plausible guess.

## RED → GREEN procedure

1. **RED baseline:** run the unchanged page with the diagnostics query, clean
   cache, and capture the same fixed scenario for H, A, and C: load through
   frame 31, perform the next gesture, let the phase run past frame 100, and
   capture through terminal/return. Save only an ignored trace plus a screenshot
   at the reported stop point.
2. **Controlled fault fixtures:** use a local HTTP server that delays first byte,
   sends bounded chunks, and cuts the response at a known point. This can prove
   preparation timeout and recovery logic. Chromium can additionally use the
   Chrome DevTools Protocol network emulation, but its legacy command is now
   deprecated and it is not WebKit/iPhone evidence. Playwright routing can
   intercept/mock requests, but it is not a Safari media-pipeline simulator.
   ([Playwright network routing](https://playwright.dev/docs/network),
   [Chrome DevTools Protocol network
   emulation](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-emulateNetworkConditions))
3. **GREEN gate:** rerun the byte-for-byte same scenarios and require the
   classifier to report the expected checkpoint, recovery, or terminal outcome;
   require frame progress to be monotonic during expected motion and no
   `permanent-stop-before-terminal`. Keep the pure fixtures for the event-order
   edge cases; they do not claim to reproduce a device decoder.
4. **Real-device lane:** open the dev build on the actual iPhone over LAN,
   connect Safari Web Inspector, clear the site cache, and repeat on cellular
   and Wi-Fi. Export the trace with device/OS/Safari/viewport and timestamps.
   Apple supports inspecting iOS Safari over cable or network; Web Inspector's
   Network and Timelines panels expose request, rendering, CPU, and memory
   activity. Safari release notes also document per-page network throttling, but
   a physical cellular run remains the release evidence. ([Apple iOS Web
   Inspector](https://developer.apple.com/documentation/safari-developer-tools/inspecting-ios),
   [Safari web development tools](https://developer.apple.com/safari/tools/),
   [Safari 16.4 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes))

Playwright device emulation changes viewport, user agent, screen size, and touch
behavior; it does not turn Chromium/WebKit into the user's physical iPhone or
replicate cellular radio, Safari's compositor, address-bar lifecycle, hardware
decoder, memory pressure, or cache history. Treat it as a deterministic lab
lane, never as proof that iPhone Safari did or did not stall. ([Playwright
emulation](https://playwright.dev/docs/emulation))

## Recommended next step and effort

Implement only the diagnostics seam and pure classifier first: one bounded media
observer in the browser adapter, one serializable trace type/classifier in
`src/motion/`, and fixtures for frame-31 checkpoint, waiting-underflow,
terminal, and C queue starvation. No visible UI, no production telemetry, and
no behavior change are needed. This is approximately 0.5–1 day plus a real
device capture; it is a reasonable next step. Once the user supplies a trace
that is classified as a genuine pre-terminal stop, fix that cause in a separate
RED/GREEN change. Delete this note after the durable classifier and acceptance
contract are moved into the project index/tests.

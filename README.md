# Portfolio

Static portfolio site with a canvas-based hero sequence and interactive motion.

## Video hero prototype (throwaway)

This branch also contains a standalone architecture comparison. Start it with:

```sh
npm ci
npm run prototype:serve
```

Open [`/prototype-video.html?variant=a`](http://127.0.0.1:4173/prototype-video.html?variant=a). The fixed bottom switcher and the `variant=` query parameter select:

- `a` — native VP9-alpha WebM (`hero-alpha-vp9.webm`),
- `b` — packed H.264 MP4 (`RGB | alpha matte`) reconstructed by a small WebGL shader, or
- `c` — the existing 150-frame RGBA WebP sequence drawn to a 2D canvas.

The default segmented mode pauses at frame 31, resumes at the visible segment button, and pauses at frame 149 (`149 / 15 = 9.933s`, leaving the final PTS before the 10s container duration). Use `mode=loop` to compare uninterrupted sequential playback. The diagnostics panel exposes the selected and active renderer, both `canPlayType` results, alpha path, exact segment-pause state, media/WebGL errors, first-visible and ready timings, explicit seek latency, duration/resolution, loaded-frame count, scrub-held frame, fallback reason, and an encoded-byte estimate. It also shows the renderer-independent playback gauges: intended frame, media `currentTime`/frame, confirmed presented frame, confirmation source, frame delta, expected motion, actual paused/playing state, reason, last-progress age, and the bounded event tape. A scrub captures every `input` value, pauses only while seeking, and resumes automatically after the requested frame is actually presented; a stale `pointerup`/`change` value cannot reset the target. Explicit Pause is the only user pause. `requestVideoFrameCallback` is labelled confirmed; `timeupdate`/RAF currentTime paths are labelled estimated, while WebGL/2D draws are labelled by their draw source. A cached resource can report zero transfer bytes; the panel therefore falls back to the committed asset size and labels the number as approximate.

Use `quality=hq` to select the measured HQ packed H.264 candidate for B. It is a 2,560×720 packed stream made from HQ archive frames 000–137 plus explicitly upscaled standard frames 138–149; the mixed-source boundary is called out in the page diagnostics. A and C intentionally stay on the standard assets in this iteration because no HQ alpha WebM or 150-frame HQ sequence was justified. `quality=standard` is the default.

Failure injection is deterministic and lazy: `?variant=a&forceFail=a` exercises A → B, `?variant=a&forceFail=a,b` exercises A → B → C, `?variant=b&forceFail=b` exercises B → C before opening the MP4, and `?variant=b&forceFail=webgl` opens B's MP4 attempt then forces its shader boundary to C. Repeated `forceFail` parameters and comma-separated values are accepted. Dormant fallback assets are not requested until the preceding renderer actually fails.

Committed encoded asset sizes:

| Asset | Bytes | Shape |
| --- | ---: | --- |
| `hero-alpha-vp9.webm` | 2,011,506 | 900×507, 15 fps, 10 s, VP9 with `alpha_mode=1` |
| `hero-color-matte.mp4` | 1,706,162 | 1,800×508, 15 fps, 10 s, H.264 High; left RGB/right matte |
| `hq-hero-color-matte.mp4` | 1,553,124 | 2,560×720, 15 fps, 10 s, H.264 High; HQ RGB + matte |
| Existing WebP sequence | 4,578,812 | 150 × 900×507 RGBA frames |

Regenerate the standard videos with `scripts/generate-video-prototype-assets.sh`. Regenerate the HQ packed candidate with `scripts/generate-hq-packed-video.sh`; it reads `HQ_ARCHIVE` (default `../Portfolio/hero-frames-1280x720-partial.zip`) without copying the archive into this branch, compares CRF 21 (2,195,437 bytes) with CRF 24 (1,553,124 bytes), and selects CRF 24. Both scripts default to the temporary ffmpeg binary used for this prototype; set `FFMPEG` on another machine. This is an experiment, not production media infrastructure. `canPlayType` cannot prove that a particular iOS release will composite VP9 alpha correctly, and the WebGL path still needs a real-device Safari review for color-edge quality, decode power, and autoplay policy.

## Project work

The canonical index of completed research, active implementation, decisions, artifacts, and planned work is [docs/README.md](./docs/README.md).

Start there before changing animation timing, responsive geometry, canvas behavior, or mobile input handling.

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

The default segmented mode pauses at frame 31, resumes on the visible button, and pauses at frame 149. Use `mode=loop` to compare uninterrupted sequential playback. The diagnostics panel exposes the selected and active renderer, both `canPlayType` results, alpha path, exact segment-pause state, media/WebGL errors, first-visible and ready timings, explicit seek latency, duration/resolution, loaded-frame count, scrub-held frame, fallback reason, and an encoded-byte estimate. A scrub pauses the active renderer on its first `input`, captures each input value, holds the final frame through `pointerup`/`change`, and resumes only when the visible Play control is pressed. A cached resource can report zero transfer bytes; the panel therefore falls back to the committed asset size and labels the number as approximate.

Failure injection is deterministic and lazy: `?variant=a&forceFail=a` exercises A → B, `?variant=a&forceFail=a,b` exercises A → B → C, `?variant=b&forceFail=b` exercises B → C before opening the MP4, and `?variant=b&forceFail=webgl` opens B's MP4 attempt then forces its shader boundary to C. Repeated `forceFail` parameters and comma-separated values are accepted. Dormant fallback assets are not requested until the preceding renderer actually fails.

Committed encoded asset sizes:

| Asset | Bytes | Shape |
| --- | ---: | --- |
| `hero-alpha-vp9.webm` | 2,011,506 | 900×507, 15 fps, 10 s, VP9 with `alpha_mode=1` |
| `hero-color-matte.mp4` | 1,706,162 | 1,800×508, 15 fps, 10 s, H.264 High; left RGB/right matte |
| Existing WebP sequence | 4,578,812 | 150 × 900×507 RGBA frames |

Regenerate the checked-in videos with `scripts/generate-video-prototype-assets.sh` (the default points at the temporary ffmpeg binary used for this prototype; set `FFMPEG` on another machine). This is an experiment, not production media infrastructure. `canPlayType` cannot prove that a particular iOS release will composite VP9 alpha correctly, and the WebGL path still needs a real-device Safari review for color-edge quality, decode power, and autoplay policy.

## Project work

The canonical index of completed research, active implementation, decisions, artifacts, and planned work is [docs/README.md](./docs/README.md).

Start there before changing animation timing, responsive geometry, canvas behavior, or mobile input handling.

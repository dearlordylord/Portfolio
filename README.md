# Portfolio

Static portfolio site with a canvas-based hero sequence and interactive motion.

## Production hero media

The real site uses one explicit, correctness-first ladder:

1. **H — Safari HEVC alpha:** on an exact, user-confirmed iPhone Safari
   profile at or above the iOS 17 evidence floor, only when the checked-in
   `hero-hevc-alpha-hq.mov` identity and SHA-256 match. It stays a hidden
   direct-DOM `<video>` until a verified Blob, `loadeddata`, `canplay`, and the
   existing timeline handoff pass. The iOS 17 floor limits the branch to the
   versions represented by our evidence; it is not a claim that older iOS
   releases cannot decode HEVC alpha.
2. **A — Chromium VP9 alpha:** on non-Safari browsers that claim VP9 alpha and
   pass the decoded transparent-corner proof. It is also direct DOM.
3. **C — WebP frames:** the existing bounded 150-frame RGBA WebP sequence is
   the deterministic fallback for every unsupported, unqualified, failed, or
   slow native path.

The page has no renderer selector or debug panel. Diagnostics remain a
loopback-only test facility (`?motionDiagnostics=1`); production URLs do not
expose it. H currently downloads its 11.2 MB MOV as a Blob because Cloudflare
Pages does not provide verified byte-range delivery for this file. A 4-second
fail-open deadline keeps a slow native candidate from holding the hero blank;
range-capable delivery is a separate deferred improvement.

Checked-in runtime media is small enough for the Pages per-file limit: H is
11,151,391 bytes, A is 2,238,324 bytes, and the compressed C sequence is about
4.58 MB. The packed H.264 + matte experiments (B), their generation scripts,
and `prototype-video.html` remain tracked drafts for later comparison. They
are intentionally excluded from the production bundle and `verify:dist` fails
if any of them leak into `dist/`.

Use `npm run check` for type checks, unit tests, a production build, and the
exact runtime-asset/package verification. Use `npm run test:browser` for the
production preview. The retained draft comparison has its own source-serving
gate: `npm run test:browser:prototype` (or `npm run prototype:serve` and open
`/prototype-video.html`). It is not emitted by `npm run build` and is not part
of the production browser gate.

## Project work

The canonical index of completed research, active implementation, decisions, artifacts, and planned work is [docs/README.md](./docs/README.md).

Start there before changing animation timing, responsive geometry, canvas behavior, or mobile input handling.

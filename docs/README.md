# Motion and responsive-layout index

Last updated: 2026-08-28

This is the canonical project note for motion work. Load this file before changing animation timing, responsive geometry, canvas behavior, or mobile input. Historical research was removed after its durable conclusions moved into the implementation and tests.

## Current media decision

- Production uses **H → A → C**: checked-in HEVC-with-alpha in a direct DOM
  video for the exact, user-confirmed iPhone Safari profile; VP9-alpha in a
  direct DOM video for qualified non-Safari browsers; and the bounded WebP
  sequence as the universal deterministic fallback.
- H is selected only after the pure gate in
  [`src/motion/hevc-alpha.ts`](../src/motion/hevc-alpha.ts) confirms the Apple
  iPhone Safari profile at or above the conservative iOS 17 evidence floor,
  the checked-in HQ asset ID/SHA-256, and the recorded real-device evidence.
  `canPlayType()` is never sufficient by itself. The version floor is an
  evidence boundary, not a general statement about older Safari decoders.
- H assigns the immutable 11.2 MB HQ MOV directly to the native video so R2
  can satisfy byte-range requests; it never builds a client-side Blob. A still
  uses a Blob because its VP9 alpha delivery path has no qualified streaming
  origin. Both candidates have a four-second fail-open preparation deadline.
- The packed H.264 + matte/WebGL route (B) and `prototype-video.html` remain
  draft-only source material. Vite removes them from production output, and
  `npm run verify:dist` rejects any leaked B asset or debug page.

The detailed [transparent hero media research](./transparent-video-hero-research.md)
is retained as a short-lived reference while the draft alternatives remain in
the repository. Delete or archive it after the next media-delivery decision;
the selected behavior and its gates now live in source and tests.

## Product contracts

- **M1 — stable mobile hero:** capture one stable first-screen height; place the animation stage in its lower `38%–85%` region; recompute only for a real orientation or breakpoint change.
- **M2 — mobile copy sequence:** show the role and experience groups sequentially in one centered slot entirely above the animation. They have zero visual overlap while replacing one another. Desktop retains its lateral composition; reduced motion uses one compact static combined group in that slot.
- **M3 — persistent Explore work:** availability is explicit and latched; the control remains visible, actionable, and at least 44×44 CSS px after it becomes available.
- **M4 — reliable Tools & Skills:** startup, pause, resize, reduced motion, breakpoint changes, and failed icons are named deterministic states; canvas text and semantic HTML remain available when icons fail.

## Implemented architecture

- Vite serves and builds the site, allowing production to import the same TypeScript modules used by tests.
- `src/motion/` contains browser-independent contracts and deterministic simulations for hero layout/timing, asset readiness/fallback, Skills, particles, seeded randomness, and the shared scheduler.
- `src/browser/` contains shallow DOM/canvas adapters and one `main.ts` entry. `index.html` contains structure and styles, not animation implementations.
- One lifecycle scheduler owns animation frames, visibility, reduced motion, scene activation, and runnable-work metrics. Scenes do not self-schedule.
- Hero frames and skill icons have pending/ready/failed state, named failures, deterministic fallback, and degraded diagnostics.
- The production hero keeps C’s decoded WebP neighborhood bounded with an explicit target → displayed → rendered coordinator. Native A/H remain compositor-active under a poster until an actual rVFC frame-0 proof; after acceptance, rVFC media time is the only native timeline clock and RAF only paints/watchdogs. H requires the checked-in HQ asset/hash plus user-confirmed iPhone Safari evidence before it can request or reveal media. A requires decoded-alpha proof. Unsupported, unqualified, failed, or slow native candidates fall directly to C with the last presented frame preserved. See [HEVC alpha import and release gate](./hevc-alpha-import.md).
- Skills and particles use seeded fixed-step simulations. Mobile particles are disabled; desktop neighbor work is bounded rather than all-pairs.
- Reduced motion exposes essential content immediately and schedules no decorative work.
- Diagnostics require both a loopback host and `?motionDiagnostics=1`. `motionDisable=hero,particles,skills,timeline,contact` isolates named scenes for tests.

## Verification

Run:

```sh
npm run check
npm run test:browser
npm run test:browser:prototype # optional draft-only media comparison
```

`npm run check` performs strict type checking, unit/property tests, a production build, and an exact runtime-asset inventory/size check. The browser suite builds and previews `dist` rather than using Vite's source-serving development mode, so missing deployment assets fail before release. It covers Chromium mobile and desktop scenarios for M1–M4, scheduler lifecycle, reduced motion, asset degradation, breakpoint changes, native scrolling, diagnostics isolation, narrow-width containment, and the case dialog.

The optional prototype suite is intentionally separate: it uses Vite's
source-serving development mode and targets only
`tests/browser/video-prototype.spec.ts`. The production suite ignores that
spec because `prototype-video.html` is a tracked draft and is deliberately
absent from `dist`.

Mobile WebKit is configured as an opt-in project, but this workstation lacks its required host libraries. Run `npm run test:browser:webkit` in CI or on a host with those libraries before release. Headless Chromium evidence is not a substitute for final real-device performance and visual review.

## Visual convergence workflow

No animation or responsive-layout fix starts from a screenshot alone. Before implementation:

1. define a named checkpoint and numerical acceptance metric in `src/motion/visual-inspection.ts`;
2. capture the current state with `npm run inspect:motion`;
3. review `motion-artifacts/inspection-current/mobile-390x844/index.html` and its JSON observations;
4. classify each claim as `met`, `unmet`, or `inconclusive`—never convert unavailable evidence into a pass;
5. run a read-only methodology review before using the metric as a fix gate; and
6. after implementation, rerun the identical checkpoints and require the intended metric to converge without regressing the others.

The capture sequence is fixed: role → experience → terminal → below hero → timeline → return to hero. C scenarios seek times derived from the shared hero contract; native scenarios feed deterministic rVFC media-time fixtures or use real presentation callbacks. Assertions name the phase and presented/rendered frame; no test relies on a synthetic ready plateau. CSS-only transitions are fast-forwarded at screenshot time; JavaScript animation state remains at the recorded checkpoint. R2 samples eight fixed named edge points (top, upper, middle, and lower pairs) from the actual unmasked rendered composite at role, experience, and terminal. Points stay above the overlapping About surface; the 36px patches are centered on canonical normalized coordinates and reject known foreground controls/text while retaining structural `#scrolly`/canvas ownership. Each completed run has a unique manifest (commit, working-tree hash, browser, viewport, fonts, and configuration) and is promoted atomically to `inspection-current`; failed runs cannot replace it.

Before accepting a metric as a fix gate, capture it twice. The normalized observations and findings must match; screenshots are review aids and may only differ within an explicitly understood raster tolerance. Generated artifacts are disposable and ignored. Once an issue is closed, preserve its contract in source/tests and delete obsolete runs.

### Space/time foundation for the next five reports

The next cycle is indexed here before any product behavior changes. `src/motion/convergence-observation.ts` defines two reusable evidence lanes:

- a temporal trace records each trusted wheel/touch input beside paused-clock time, event disposition, hero phase/progress/target/display/rendered frames, document scroll, observed `scrollTo` calls, and visual-viewport position;
- a spatial observation records named rendered anchors, their bounding rectangles/computed corner radii/overflow, ancestor clipping separately from visual-viewport intersection, and independent height-ratio, vertical-offset, and horizontal-gap relationships.

The browser probe collects facts only when the existing diagnostics gate is enabled. Playwright injects the input observer and supplies trusted input; the production page gets no new listeners or behavior. `tests/browser/convergence-foundation.spec.ts` attaches an end-to-end wheel trace, an isolated trusted-touch tracer trace, and the spatial observation to the ignored Playwright result. Its assertions verify that the instrumentation is present, trusted, finite, and sensitive; they intentionally do not make the current UI satisfy the new requests. Chromium DevTools supplies trusted touch movement; the opt-in WebKit project skips that Chromium-only input driver instead of pretending a constructed DOM event is equivalent. WebKit touch convergence therefore remains a supported-host/real-device lane.

| ID | Requirement | Evidence and convergence criterion | Status |
| --- | --- | --- | --- |
| N1 | Hold real page scrolling during the first part of the hero, then hand off toward About | Repeated trusted-input trace spanning the possible handoff. For every sample before frame `58` (`experience.fadeIn`, where UX/UI is replaced by 14+): hero progress changes while document `scrollY` does not; at/after frame `58`, a trusted downward input is native. A test-side `scrollTo` wrapper separates observed scripted movement from input-driven movement. Synthetic `dispatchEvent` is never input proof. The handoff is explicitly next-gesture: browser default prevention is decided per dispatched touch event, so a touch already consumed before frame 58 is not retroactively released. | Implemented; the intro now enters continuous `playing` at frame 31 without a ready/pointer plateau. Chromium trusted wheel and CDP touch traces must prove pre-frame-58 cancellation, then native displacement on the next trusted downward input at/after frame 58. |
| N2 | Increase the hero “head” animation area by 40% | Compare rendered non-transparent content height against the recorded former mobile fit (`0.55`) at the same viewport/frame/fonts/assets: target ratio is baseline × 1.4, subject to the available stage and no page overflow or alpha-bound clipping. The test derives alpha>8 bounds at early/mid/terminal checkpoints and maps them through the runtime's actual canvas destination rectangle; the durable envelope is the union x=`166..756` of all 150 source frames. Canvas size alone is context, not proof. | Implemented; the mobile fit is `0.77` (`0.55 × 1.4`), and placement centers the measured all-frame alpha envelope at `(166 + 756) / (2 × 900) ≈ 0.512222`. Chromium checks 390px and 360px widths at early, midpoint, and terminal frames. |
| N3 | Move the hero type block slightly down | Compare role and experience copy top offsets from the stable hero stage at every semantic copy checkpoint; both must move by the same agreed delta and remain visible/unclipped. | Implemented with an explicit `24px` mobile offset added to the former `9%` anchor when space permits. At 320×480, the requested shift is capped against the measured 124.9px experience-copy height plus 3px clearance; this preserves a small downward move (~11px) without placing the group inside the stage. No reference screenshots were available. |
| N4 | Remove About background corner rounding | All four computed radii on `aboutSurface` equal `0px` at mobile checkpoints, without changing unrelated card radii. | Implemented; browser computed-style check passes. |
| N5 | Make date→spine and spine→text Journey gaps 16px | For every timeline row, rendered edge-to-edge gaps are 16 CSS px (±1px layout tolerance), with no overlap, clipping, or horizontal overflow. Row enumeration is exhaustive and retained beside the existing readable-content gutter evidence. | Implemented with the shared `--timeline-gap: 16px` token across desktop and mobile. Browser geometry checks cover every row. |

The expert rejection check for each future metric is: would a motion specialist reject endpoint-only evidence, would a layout specialist reject inferred CSS instead of rendered boxes, or would a browser specialist reject synthetic events as native scrolling? If yes, the metric cannot gate a fix.

Trade-offs are explicit. Playwright can deterministically prove page behavior in its emulated viewport, but not physical browser chrome; that remains a real-device lane. The generic evidence records stay after this cycle. Requirement-specific N1–N5 rows and disposable captures should be deleted once their durable acceptance contracts have moved into product tests and the reports are closed.

“Input-driven” here means displacement after a trusted browser input before any page `scrollTo` call has been observed in that trace. Once a scripted smooth scroll begins, later displacement remains conservatively unattributed because call initiation does not reveal when compositor motion settles. This is stronger than correlating a wheel event with `scrollY`, but it is not a claim about compositor internals; real-device input remains the final mobile validation lane.

Alpha bounds are inspected on a maximum-512px raster and mapped back through natural-image and rendered-canvas coordinates. This trades source-pixel exactness for bounded browser memory; at the mobile rendered size the uncertainty is below one CSS pixel, far tighter than a 40% size decision. A source-pixel art audit would require a separate full-resolution tool and is outside this layout gate.

Use `npm run inspect:motion:compare` to make that repeatability check explicit. It compares the default `inspection-current/mobile-390x844` directory with its `.previous` promotion (or accepts current and previous directories as the first and second arguments). `findings.json` must be byte-identical and parsed findings must also be semantically identical. For `observations.json`, object keys are sorted, array order is preserved, geometry fields named `left`, `right`, `top`, `bottom`, `x`, `y`, `width`, or `height` are rounded to the nearest `1/64` CSS pixel (Chromium's layout quantum), and all other finite numbers are rounded to the nearest `0.001`; non-finite values are left unchanged. The command prints JSON paths for up to 20 differences and exits nonzero on a missing file, findings byte/semantic difference, or normalized observation difference.

### Real mobile browser chrome

Address-bar/tool-bar behavior is not emulated evidence. R1 therefore remains `inconclusive` in Chromium until a real-device sample is recorded. For a phone on the development network:

1. run `npm run serve -- --host 0.0.0.0`;
2. open the dev URL with `?motionDiagnostics=1`;
3. record screenshots with browser chrome expanded and collapsed; and
4. in remote devtools, call `window.__portfolioVisualProbe()` and save the result beside those screenshots (outside the non-ignored workspace inputs, or in an ignored directory);
5. create the versioned envelope defined by `DeviceEvidenceEnvelope` in `scripts/merge-device-inspection.ts`; include the current synthetic run ID/commit/diff hash, phone/browser/viewport data, the probe and hero snapshot, and both screenshot paths, SHA-256 hashes, curtain verdicts, and timestamps; and
6. run `npm run inspect:motion:device -- path/to/device-evidence.json` to produce device-qualified findings without overwriting the synthetic baseline. The importer rejects a stale synthetic manifest when the commit or tracked/untracked input hash changed, copies both screenshots into an atomic ignored sidecar under the current run, and stores relative sidecar paths in the merged observation. Device evidence changes R1 only; R2–R4 remain synthetic-only.

Viewport inset math is context, not the R1 verdict: browser chrome naturally changes the visual viewport. Only paired real-device screenshots with an explicit curtain review can move R1 from `inconclusive` to `met` or `unmet`.

Non-loopback diagnostics are enabled only in Vite development builds and still require the query flag. Production builds retain the loopback-only gate.

### Current report vocabulary

- **R1:** paired expanded/collapsed real-device browser-chrome screenshots; viewport inset is context only. Current synthetic status: `inconclusive`; the page now uses `viewport-fit=cover`, a matching theme color, and full html/body/scrolly surface coverage, but only a real-device pair can verify the browser-chrome curtain.
- **R2:** whole first-screen background continuity from eight fixed named, background-only screenshot patch averages over the `#scrolly` surface above the overlapping About section; high-frequency texture is averaged. Current status: `met` (0 RGB-channel spread at role, experience, and terminal checkpoints).
- **R3:** semantic “14+ years” text, a runtime `playbackCompleted` latch, terminal/normal exit phases, display/visibility/opacity, nonzero geometry, viewport/clipping/occlusion, plus immediate/500ms/2000ms return samples. Released copy is accepted only when the observed latch is true. Current status: `met` (fully visible at terminal, exit-hold, released, and all three return samples).
- **R4:** minimum rendered left edge of the section header, every year, and every timeline body versus the shared 24px gutter; decorative spine/dots are excluded. Current status: `met` (minimum 24px; no offenders or horizontal overflow).

## Repository and evidence policy

Durable knowledge belongs in source, tests, narrowly scoped comments, and this index. Generated evidence is disposable and ignored:

- `motion-artifacts/`
- `playwright-report/`
- `test-results/`
- `coverage/` and local caches/logs

Do not check generated screenshots, traces, state dumps, browser binaries, or OS metadata into the repository. Keep a real-device envelope and its source screenshots outside the non-ignored workspace inputs (or under an ignored directory); the importer copies validated images into the ignored run sidecar. Keep a temporary research note only while a genuine unimplemented decision depends on it; at phase completion, move its requirements into tests/code, update this index, and delete the note.

## Remaining external validation

No known architecture migration remains in the current scope. Before public release:

1. run the WebKit mobile project in a supported environment;
2. review M1–M4 on representative iOS and Android devices;
3. record real-device frame-time and battery observations before setting performance thresholds; and
4. make future aesthetic changes one named scenario at a time, with before/after evidence and no contract regression.

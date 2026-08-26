# Motion and responsive-layout index

Last updated: 2026-08-26

This is the canonical project note for motion work. Load this file before changing animation timing, responsive geometry, canvas behavior, or mobile input. Historical research was removed after its durable conclusions moved into the implementation and tests.

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
- Skills and particles use seeded fixed-step simulations. Mobile particles are disabled; desktop neighbor work is bounded rather than all-pairs.
- Reduced motion exposes essential content immediately and schedules no decorative work.
- Diagnostics require both a loopback host and `?motionDiagnostics=1`. `motionDisable=hero,particles,skills,timeline,contact` isolates named scenes for tests.

## Verification

Run:

```sh
npm run check
npm run test:browser
```

`npm run check` performs strict type checking, unit/property tests, a production build, and an exact runtime-asset inventory/size check. The browser suite builds and previews `dist` rather than using Vite's source-serving development mode, so missing deployment assets fail before release. It covers Chromium mobile and desktop scenarios for M1–M4, scheduler lifecycle, reduced motion, asset degradation, breakpoint changes, native scrolling, diagnostics isolation, narrow-width containment, and the case dialog.

Mobile WebKit is configured as an opt-in project, but this workstation lacks its required host libraries. Run `npm run test:browser:webkit` in CI or on a host with those libraries before release. Headless Chromium evidence is not a substitute for final real-device performance and visual review.

## Visual convergence workflow

No animation or responsive-layout fix starts from a screenshot alone. Before implementation:

1. define a named checkpoint and numerical acceptance metric in `src/motion/visual-inspection.ts`;
2. capture the current state with `npm run inspect:motion`;
3. review `motion-artifacts/inspection-current/mobile-390x844/index.html` and its JSON observations;
4. classify each claim as `met`, `unmet`, or `inconclusive`—never convert unavailable evidence into a pass;
5. run a read-only methodology review before using the metric as a fix gate; and
6. after implementation, rerun the identical checkpoints and require the intended metric to converge without regressing the others.

The capture sequence is fixed: role → experience → terminal → below hero → timeline → return to hero. Playwright seeks times derived from the shared hero contract, then asserts the named phase and rendered frame. CSS-only transitions are fast-forwarded at screenshot time; JavaScript animation state remains at the recorded checkpoint. R2 samples eight fixed named edge points (top, upper, middle, and lower pairs) from the actual unmasked rendered composite at role, experience, and terminal. Points stay above the overlapping About surface; the 36px patches are centered on canonical normalized coordinates and reject known foreground controls/text while retaining structural `#scrolly`/canvas ownership. Each completed run has a unique manifest (commit, working-tree hash, browser, viewport, fonts, and configuration) and is promoted atomically to `inspection-current`; failed runs cannot replace it.

Before accepting a metric as a fix gate, capture it twice. The normalized observations and findings must match; screenshots are review aids and may only differ within an explicitly understood raster tolerance. Generated artifacts are disposable and ignored. Once an issue is closed, preserve its contract in source/tests and delete obsolete runs.

Use `npm run inspect:motion:compare` to make that repeatability check explicit. It compares the default `inspection-current/mobile-390x844` directory with its `.previous` promotion (or accepts current and previous directories as the first and second arguments). `findings.json` must be byte-identical and parsed findings must also be semantically identical. For `observations.json`, object keys are sorted, array order is preserved, and every finite number is rounded to the nearest `0.001` before recursive comparison; non-finite values are left unchanged. The command prints JSON paths for up to 20 differences and exits nonzero on a missing file, findings byte/semantic difference, or normalized observation difference.

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

- **R1:** paired expanded/collapsed real-device browser-chrome screenshots; viewport inset is context only. Current synthetic status: `inconclusive`.
- **R2:** whole first-screen background continuity from eight fixed named, background-only screenshot patch averages over the `#scrolly` surface above the overlapping About section; high-frequency texture is averaged. Current status: `unmet` (actual composite spread).
- **R3:** semantic “14+ years” text, terminal phase, display/visibility/opacity, nonzero geometry, viewport/clipping/occlusion, plus immediate/500ms/2000ms return samples. Current status: `unmet` (opacity ≈0.24 throughout).
- **R4:** minimum rendered left edge of the section header, every year, and every timeline body versus the shared 24px gutter; decorative spine/dots are excluded. Current status: `unmet` (minimum −14px; several year labels protrude).

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

# Motion and responsive-layout index

Last updated: 2026-08-25

This is the canonical project note for motion work. Load this file before changing animation timing, responsive geometry, canvas behavior, or mobile input. Historical research was removed after its durable conclusions moved into the implementation and tests.

## Product contracts

- **M1 — stable mobile hero:** capture one stable first-screen height; place the animation stage in its lower `38%–85%` region; recompute only for a real orientation or breakpoint change.
- **M2 — mobile copy sequence:** show the role and experience groups sequentially in one centered slot entirely above the animation. They have zero visual overlap while replacing one another. Desktop retains its lateral composition.
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

`npm run check` performs strict type checking, unit/property tests, and a production build. The browser suite covers Chromium mobile and desktop scenarios for M1–M4, scheduler lifecycle, reduced motion, asset degradation, breakpoint changes, native scrolling, diagnostics isolation, and the case dialog.

Mobile WebKit is configured as an opt-in project, but this workstation lacks its required host libraries. Run `npm run test:browser:webkit` in CI or on a host with those libraries before release. Headless Chromium evidence is not a substitute for final real-device performance and visual review.

## Repository and evidence policy

Durable knowledge belongs in source, tests, narrowly scoped comments, and this index. Generated evidence is disposable and ignored:

- `motion-artifacts/`
- `playwright-report/`
- `test-results/`
- `coverage/` and local caches/logs

Do not check generated screenshots, traces, state dumps, browser binaries, or OS metadata into the repository. Keep a temporary research note only while a genuine unimplemented decision depends on it; at phase completion, move its requirements into tests/code, update this index, and delete the note.

## Remaining external validation

No known architecture migration remains in the current scope. Before public release:

1. run the WebKit mobile project in a supported environment;
2. review M1–M4 on representative iOS and Android devices;
3. record real-device frame-time and battery observations before setting performance thresholds; and
4. make future aesthetic changes one named scenario at a time, with before/after evidence and no contract regression.

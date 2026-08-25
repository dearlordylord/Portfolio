# Animation observability and improvement plan

Date: 2026-08-25
Status: initial research/design record. M1–M4 implementation and reduced-motion coverage now exist; retain this plan for the active scheduler, performance, and asset-fallback decisions.

This document is the working decision produced from:

- the [repository animation audit](./repository-animation-audit.md);
- the [primary-source animation testing research](./animation-testing-primary-sources.md); and
- the four reported mobile failures: unstable hero heading placement, incorrect mobile heading choreography, disappearing **Explore work**, and an intermittently blank **Tools & Skills** animation.

## Decision

Do not tune the current constants in `index.html` as an isolated aesthetic exercise. The initial motion-observability layer and M1–M4 contracts now exist; remaining changes should be judged against repeatable event tapes, browser diagnostics, and disposable evidence rather than live timing or memory.

The target feedback loop is:

```text
viewport + capabilities + assets + seed + event tape + virtual time
                              |
                              v
                  pure motion/layout models
                              |
               +--------------+--------------+
               |              |              |
               v              v              v
          DOM/canvas      state + events    geometry
           renderer           JSON            JSON
               |              |              |
               +--------------+--------------+
                              |
                              v
               labeled storyboard + SVG timeline
                    + Playwright trace on failure
```

This works without an interactive browser. Pure-model tests and SVG/JSON reports run in Node. A pinned headless Playwright browser supplies actual layout, canvas screenshots, WebKit/Chromium differences, and traces. The resulting PNG, SVG, Markdown, and JSON files are directly inspectable by an agent.

## Why the current implementation cannot be tuned reliably

The main problems are architectural, not four unrelated styling errors:

1. **Visible time changes with device performance.** Hero phase progress uses elapsed milliseconds, but the displayed frame is smoothed by `lerp(..., 0.07)` once per rendered frame. Its lag is therefore about 117 ms at 120 Hz, 233 ms at 60 Hz, and 467 ms at 30 Hz. Text and CTA opacity use that lagging displayed frame. Particles and skills physics also advance once per rendered frame rather than by elapsed time.
2. **There is no single geometry contract.** The hero/About boundary is independently represented by `100vh`, `85vh`, `-15vh`, `innerHeight * 0.85`, and pixel positions assigned during canvas painting. Mobile browser chrome and resize events can make those values move independently.
3. **Mobile choreography is currently impossible by construction.** The desktop messages overlap in time, while the mobile media query hides the second message with `display: none`. There is no mobile sequence in which the two top messages replace one another.
4. **CTA availability is an indirect side effect.** It becomes interactive only after the lagging displayed frame passes 112, is positioned from inside the canvas draw function despite living outside the hero, and has no named state that a test can assert.
5. **Skills startup is opaque and stochastic.** Intersection state, canvas width, icon loading, `performance.now()`, and unseeded random initial velocities all participate, but none are exposed. Once started, the loop never stops. A blank canvas has no diagnostic distinction between “not intersecting,” “zero/invalid geometry,” “not scheduled,” “assets late,” and “render starved.”
6. **Mobile is overloaded.** Four independent perpetual rAF loops can be active. The decorative field alone performs 96,580 particle-pair distance checks per frame for 440 particles, before drawing and before the hero/skills/contact work.
7. **Input is coupled to animation completion.** A non-passive window-level `touchmove` handler cancels native scrolling through the hero, and the 440 px-tall skills canvas separately cancels touch scrolling over itself.
8. **There is no reduced-motion, test, seed, snapshot, trace, or debug path.** Asset errors can silently leave requested hero frames unavailable, and direct `Math.random()` makes canvas runs irreproducible.

Recent repository history contains 22 changes to `index.html`, including repeated mobile scroll, photo-position, head-scale, CTA z-index, and tools fixes. That history is consistent with a coupled system whose effects cannot be characterized before editing.

## Motion lab contract

### One serializable model per scene

The hero, particles, skills, timeline reveal, and contact tilt should each have model state separate from rendering. The production renderer and the test renderer must consume the same snapshots.

At minimum, a snapshot should report:

```ts
type MotionSnapshot = {
  nowMs: number;
  environment: {
    viewport: { width: number; height: number; stableHeight: number; dpr: number };
    input: "touch" | "mouse";
    reducedMotion: boolean;
  };
  scheduler: { activeScenes: string[]; lastFrameDeltaMs: number };
  hero: {
    phase: "loading" | "intro" | "ready" | "playing" | "complete" | "released";
    progress: number;
    requestedFrame: number;
    renderedFrame: number;
    cue: "role" | "experience" | "cta" | null;
    assets: { loaded: number; failed: number[]; fallbackFrame: number | null };
    layout: Record<string, Rect>;
  };
  skills: {
    phase: "idle" | "loading" | "entering" | "settled" | "paused" | "degraded";
    seed: number;
    chips: Array<{ id: string; x: number; y: number; vx: number; vy: number; r: number }>;
    assets: { loaded: number; failed: string[] };
  };
};
```

Named state is the primary oracle; pixels are supporting evidence.

### Injectable time and randomness

- Production uses an rAF clock; tests use `seek(ms)`, `step(ms)`, and `runUntil(predicate)` without real sleeps.
- Every update uses elapsed milliseconds or a fixed simulation timestep. Sampling the same tape at 30, 60, and 120 Hz must produce the same phase order and equivalent state.
- Canvas simulations receive a seeded PRNG. The seed is recorded with every artifact.
- CSS/WAAPI effects are paused and sought through `document.getAnimations()` and `Animation.currentTime` for exact motion screenshots.
- Headless integration tests install Playwright Clock before page code starts and use `runFor()`, which drives timers and rAF callbacks through intermediate frames.

### One lifecycle-aware scheduler

One scheduler should update only scenes that are visible and moving. A scene stops when settled, offscreen, the document is hidden, or reduced motion is active. “Active animation loops” becomes a reported metric, with zero required at rest.

### Stable diagnostic surface

A development/test-only API should expose the real models, not a second test animation:

```js
window.__portfolioMotion = {
  version: 1,
  ready,
  snapshot(),
  events(),
  pause(),
  step(ms),
  seek({ scene, timeMs }),
  dispatch(input),
  reset({ scenario, seed }),
  metrics()
};
```

The event log is a bounded list of `{time, scene, from, event, to, reason}` records. It must include asset readiness/failure, viewport changes, intersection changes, input acceptance/rejection, phase transitions, fallback rendering, and scheduler start/stop.

## Geometry policy

The first mobile screen needs one stable height policy. Use a named `stableHeight` captured from the initial small/stable viewport (or an equivalent `svh` policy), recomputing it only for a genuine orientation/breakpoint change—not every address-bar resize. The implemented M1 contract uses one stable first-screen height; its motion stage occupies the lower `38%–85%` region, so the stage ends at the `85%` boundary rather than at the viewport bottom. A single `computeHeroLayout(environment, imageIntrinsic)` function should return:

- first-screen, safe-area, nav, copy slot, motion stage, image/focal point, CTA, hint, and About rectangles;
- CSS canvas size and bounded-DPR backing size; and
- exclusion regions where text may not cover the portrait.

CSS consumes exported custom properties from this result; canvas drawing consumes the same rectangles. CTA and About placement must not be recomputed as side effects of drawing a frame.

The exact artistic start of the lower motion stage remains a named design token, not another scattered `vh` constant. The current token is `38%` of the stable first screen and its boundary is `85%`; future aesthetic work may revise those values only with fresh layout evidence and an explicit contract update.

## Artifact bundle

Each canonical scenario produces:

```text
motion-artifacts/hero/mobile-390x844/no-preference/
  summary.md
  storyboard.png
  timeline.svg
  layout.svg
  states.json
  events.json
  00-loading.png
  01-role.png
  02-crossfade.png
  03-experience.png
  04-cta.png
  05-released.png
  trace.zip              # retained on failure
```

The storyboard labels viewport, browser, input mode, motion preference, virtual time, phase, frame, cue, and seed. `layout.svg` overlays all important rectangles and collision warnings. `timeline.svg` plots requested/rendered frame, cue opacity, phase, inputs, and asset events. This combination reveals both what looked wrong and why.

Maintain two screenshot suites:

- **settled layout:** native animations disabled, for stable responsive goldens;
- **motion checkpoints:** model and native animations manually sought, for start/25%/50%/75%/end plus cue boundaries and maximal overlap.

Goldens are generated in a pinned browser/container and changed only through reviewed diffs.

## Canonical test matrix

- Viewports: 320×568, 360×640, 390×844, 412×915, 768×1024, 1440×900, plus representative phone landscape.
- Breakpoint probes: 599/600/601, 767/768/769, and 899/900/901 CSS px.
- Engines: Chromium and mobile WebKit for the motion suite; Chromium, Firefox, and WebKit settled smoke tests.
- Capabilities: touch/no-hover and mouse/hover.
- Motion: `reduce` and `no-preference`.
- Rendering tapes: 30, 60, and 120 Hz sampling of identical virtual time/events.
- Assets: cached, cold, delayed font, delayed frame/icon, one missing intro frame, one missing later frame/icon.
- Lifecycle: initial load, enter/exit/re-enter, direct anchor navigation, resize/orientation during motion, hidden/visible time jump, rapid/repeated input, interruption and reversal where applicable.

## Explicit acceptance tests for the four mobile failures

### M1 — stable mobile hero placement

- `firstScreen.bottom === stableHeight ± 1 CSS px` at every checkpoint.
- `motionStage.bottom === firstScreen.bottom ± 1 CSS px`; `motionStage.top` does not change across animation time.
- Copy is fully between the navigation safe boundary and the motion-stage boundary with the declared spacing; it never intersects the portrait exclusion rectangle.
- Address-bar-like visual viewport resize preserves `stableHeight`, normalized animation progress, copy rectangle, and focal point. Orientation change recomputes once and produces the same geometry as a fresh load at that orientation.
- About begins at the one computed boundary; there is no unintended horizontal overflow at 320 CSS px.

### M2 — mobile headings replace one another at the top

- Cue order is exactly `role -> experience -> CTA`; the second cue is not suppressed by CSS.
- At each steady cue checkpoint exactly one heading group has opacity at least 0.99 and the other at most 0.01.
- A deliberate crossfade may overlap for one tokenized interval, initially capped at 150 ms; outside it, overlap is zero.
- Both groups use the same top copy slot, are horizontally centered within 1 CSS px, and use no desktop lateral entrance/exit on touch viewports.
- The sequence and checkpoint state are identical at 30/60/120 Hz and with cached versus cold assets.
- In reduced motion, the essential text is present without spatial animation and without an elapsed-time gate.

### M3 — **Explore work** remains available

- CTA has a named `available` state; it is not inferred only from a canvas frame number.
- From `available` until hero release, opacity is at least 0.99, visibility is visible, pointer events are enabled, and its full rectangle stays inside the declared safe region.
- Its center hit-test resolves to the link or its child; its hit target is at least 44×44 CSS px.
- It remains available through visual-viewport resize, delayed/missing nonessential frames, font completion, repeated input, and the final settled checkpoint.
- Activation releases the hero and navigates exactly once. In reduced motion it is available immediately with the final readable hero state.

### M4 — **Tools & Skills** always starts visibly

- On first qualifying intersection, the state transitions once from `idle` to `entering` (or a recorded `degraded` fallback), and scheduling begins within the next virtual frame.
- Once `ready` resolves, the first checkpoint contains the expected semantic skill list and at least one rendered chip; after the declared entrance duration it contains the full mobile count with finite in-bounds coordinates.
- Cached, cold, late, and missing-icon tapes never yield an unexplained blank canvas; missing icons use a named fallback while labels remain visible in semantic DOM.
- The same seed/event tape yields the same chip state and pixels. 30/60/120 Hz tapes agree within the global tolerances.
- Direct anchor navigation, exit/re-entry, resize during entry, and page hide/show leave the scene in a defined state. It pauses offscreen and reports zero scheduled work when settled/hidden/reduced.
- Touching the skills region never prevents ordinary vertical page scrolling.

## Global improvement gates

An animation change is accepted only if all applicable gates pass:

| Axis | Pass condition |
| --- | --- |
| Determinism | Same viewport, seed, assets, event tape, and checkpoint produce the same semantic trace hash and stable pixels in the pinned environment. |
| Refresh-rate independence | 30/60/120 Hz tapes have identical phases/final state; matching-time geometry differs by ≤0.5 CSS px and opacity/progress by ≤0.01. |
| Layout | No unintended overflow, clipping, subject/text collision, fixed-header obstruction, or unreachable control in the matrix. |
| State completeness | Loading, initial, active, terminal, interrupted, repeated-input, resize, asset failure, hidden, and reduced states are defined. |
| Input | Native scroll is not globally cancelled; touch has no hover dependency or scroll trap; last valid repeated input wins. |
| Accessibility | Essential content/controls are semantic and keyboard available; reduced motion removes autoplay, physics, parallax/3D, pulse, and forced smooth scroll. |
| Lifecycle | Diagnostics report zero active animation systems when settled, offscreen, hidden, or reduced. |
| Rendering | All canvases follow one bounded-DPR policy; requested unavailable frames use and report a deterministic fallback. |
| Performance | Work has declared bounds; no direct all-pairs mobile particle loop; pinned traces show no unexplained regression. Real-device p95 update/draw and missed-frame targets are set only after a baseline is measured. |
| Evidence | Reviewed summary, states/events, timeline/layout SVG, settled golden, checkpoint storyboard, and trace on failure. |

For aesthetic review, score each before/after storyboard from 1–5 for hierarchy, legibility, cause/effect, continuity, restraint, and touch responsiveness. “Better” means no automated gate regresses, no score falls, and each timing/easing/distance change has a stated intent.

## Current implementation order after M1–M4

1. Consolidate scheduler ownership and lifecycle: stop released/offscreen/hidden systems and expose active-loop metrics.
2. Bound mobile workload and DPR, replace the particle all-pairs field, and establish pinned plus real-device performance evidence.
3. Add deterministic missing/late hero-frame and skill-icon fallback tapes.
4. Expand the viewport/reduced-motion/resize/interruption matrix, then redesign one named animation scenario at a time.

The observation foundation is already installed. Do not recreate the deleted characterization/report path; use current tests and ignored browser evidence instead.

# Animation and responsive-layout audit

Date: 2026-08-25
Scope: repository implementation only. This is a read-only audit of the current site plus a proposed way to make motion and layout observable and testable without an interactive browser. No runtime code was changed.

Status: historical pre-M1–M4 evidence. Keep this note for the original failure analysis and scheduler/performance rationale; statements about missing tooling, reduced motion, and the old characterization sequence describe the repository before the current implementation phase and are not a current inventory.

## Executive finding

At the time of this audit, the site could not be evaluated reliably by an agent because animation, input handling, rendering, layout, asset loading, and time were coupled inside one large HTML file, and the observable result existed mainly as pixels in three canvases. The repository now has pinned test tooling, reusable motion modules, loopback diagnostics, reduced-motion handling, and current M1–M4 browser coverage; this paragraph is retained as the pre-M1–M4 baseline rather than a current inventory.

The mobile problems are not one isolated easing defect. They are the combined result of:

1. a hero interaction that intercepts every touch move at window scope until a multi-phase sequence releases it;
2. frame-based interpolation and physics whose behavior changes with refresh rate;
3. four independent JavaScript animation loops, all of which run indefinitely once started;
4. expensive canvas and blur work with no mobile or reduced-motion budget;
5. viewport geometry duplicated between CSS and JavaScript; and
6. no inspectable state or deterministic replay with which to distinguish a layout bug, timing bug, input bug, missing asset, or slow frame.

The appropriate first implementation step was therefore a small **motion laboratory**, not visual retuning. That foundation now exists. The remaining work is scheduler/lifecycle consolidation, bounded mobile performance, and deterministic asset-fallback tapes before an aesthetic pass.

## What exists today

### Site and asset shape

- The app is a static document with inline CSS and three inline script blocks. The hero begins at [`index.html:427`](../../index.html#L427), its implementation at [`index.html:757`](../../index.html#L757), particles at [`index.html:1036`](../../index.html#L1036), skills physics at [`index.html:1136`](../../index.html#L1136), reveal/timeline effects at [`index.html:1358`](../../index.html#L1358), and contact tilt at [`index.html:1498`](../../index.html#L1498).
- The hero sequence contains 150 WebP frames. A filesystem count and byte sum found 4,578,812 bytes (4.37 MiB), with each sampled frame reported by ImageMagick as 900×507. The loop eagerly creates all 150 `Image` objects and assigns their sources in one pass ([`index.html:762`](../../index.html#L762), [`index.html:864`](../../index.html#L864), [`index.html:874`](../../index.html#L874)).
- `ШУМ.png` is 1920×1080 and 2,442,020 bytes. It is painted into the hero canvas on every animation frame and is also present as a full hero DOM layer, so the same texture has two rendering paths ([`index.html:780`](../../index.html#L780), [`index.html:852`](../../index.html#L852), [`index.html:334`](../../index.html#L334), [`index.html:463`](../../index.html#L463)).
- The repository is about 362 MiB, including about 161.75 MiB across 52 project image assets. Several individual case-study PNGs are 26–42 MB by filesystem measurement. Those case images are lazy-loaded only after overlay markup is injected, but the large asset sizes still make memory/decode behavior a relevant mobile criterion ([`index.html:1463`](../../index.html#L1463), [`index.html:1470`](../../index.html#L1470)).
- Recent history itself signals mobile fragility: commits include “скролл фикс”, “скролл фикс мобила”, “Fix Explore button z-index above About”, “Mobile: anchor photo lower”, “Mobile: reduce head scale”, and “mobi fix” in the ten commits preceding the current revision. This is not proof of a specific defect, but it is evidence that the same coupled area has required repeated correction (`git log`, repository history).

### Motion inventory

| System | Time/input source | Lifetime | Observable output | Determinism today |
|---|---|---|---|---|
| Hero frame sequence | rAF timestamp, wheel, touch, mouse Y, `setTimeout` | Perpetual rAF | canvas pixels, inline opacity/position, implicit phase | Partly time-based, not replayable |
| Particle field | one update per rAF, mouse, `Math.random()` | Perpetual | canvas pixels only | No |
| Skills bubbles | one update per rAF, mouse/touch, `performance.now()`, `Math.random()` | Starts on intersection, then perpetual | canvas pixels only | No |
| Card/timeline reveals | intersection and scroll geometry | Until revealed / every scroll | classes and inline styles | Viewport-dependent; no trace |
| Contact tilt | mouse/device orientation plus one interpolation per rAF | Perpetual | inline transform | No |
| CSS hint/CTA | CSS keyframes | Infinite while mounted | compositor/paint output | Time is not controllable |

Evidence: hero loop and inputs at [`index.html:895`](../../index.html#L895) and [`index.html:940`](../../index.html#L940); particles at [`index.html:1061`](../../index.html#L1061) and [`index.html:1126`](../../index.html#L1126); skills at [`index.html:1186`](../../index.html#L1186) and [`index.html:1294`](../../index.html#L1294); reveal/timeline at [`index.html:1361`](../../index.html#L1361) and [`index.html:1381`](../../index.html#L1381); contact tilt at [`index.html:1506`](../../index.html#L1506); CSS infinite animations at [`index.html:357`](../../index.html#L357) and [`index.html:359`](../../index.html#L359).

## Why mobile motion is likely poor

### P0 — touch scrolling is deliberately blocked at window scope

The hero registers a non-passive `touchmove` listener on `window`. The handler calls `preventDefault()` before it decides whether the gesture is large enough or whether the phase accepts input. Consequently, ordinary page movement is blocked during both autoplay phases, for sub-threshold movement, and while waiting at the hero. Advancing through the hero requires one accepted upward swipe, 3.5 seconds of playback, another accepted swipe, a forced 750 ms hold, and then scripted smooth scrolling. This can feel stuck or unresponsive even when it is functioning exactly as coded ([`index.html:947`](../../index.html#L947), [`index.html:973`](../../index.html#L973), [`index.html:976`](../../index.html#L976), [`index.html:983`](../../index.html#L983), [`index.html:992`](../../index.html#L992), [`index.html:1014`](../../index.html#L1014)).

The skills canvas separately prevents default touch movement for every `touchmove` over its 440 px-tall mobile surface. It therefore creates a second scroll trap lower on the page ([`index.html:1177`](../../index.html#L1177), [`index.html:1339`](../../index.html#L1339)).

### P0 — elapsed-time animation is followed by refresh-rate-dependent smoothing

The hero's phase progress uses the rAF timestamp, which is sound in isolation, but `displayFrame = lerp(displayFrame, targetFrame, 0.07)` applies a fixed fraction once per rendered frame. That makes the visible lag depend on display/load rate: approximately 14 render updates are needed for one time constant, roughly 117 ms at 120 Hz, 233 ms at 60 Hz, and 467 ms at 30 Hz. The end user therefore sees different timing under mobile load even though `INTRO_MS` and `FULL_MS` are constants ([`index.html:917`](../../index.html#L917), [`index.html:1001`](../../index.html#L1001), [`index.html:1028`](../../index.html#L1028)).

Particles and skills physics are even more directly frame-based: position, velocity, damping, gravity, noise, and particle life all advance once per rendered frame without a delta-time term. Both speed and simulation lifetime change with refresh rate and missed frames ([`index.html:1063`](../../index.html#L1063), [`index.html:1075`](../../index.html#L1075), [`index.html:1301`](../../index.html#L1301), [`index.html:1312`](../../index.html#L1312), [`index.html:1319`](../../index.html#L1319)).

### P1 — animation work is unbounded and fragmented

- Hero rAF never stops, including after the hero is released ([`index.html:1024`](../../index.html#L1024), [`index.html:1031`](../../index.html#L1031)).
- The 440-particle field runs continuously and checks every pair for lines: `440 × 439 / 2 = 96,580` distance checks per rendered frame before particle updates/draws. It has no mobile count reduction, visibility pause, or reduced-motion mode ([`index.html:1044`](../../index.html#L1044), [`index.html:1104`](../../index.html#L1104), [`index.html:1126`](../../index.html#L1126)).
- Skills animation begins lazily but never pauses again after leaving the viewport ([`index.html:1346`](../../index.html#L1346)).
- Contact tilt also runs forever, even though its target is mobile device orientation and the element is usually offscreen ([`index.html:1525`](../../index.html#L1525), [`index.html:1532`](../../index.html#L1532)).
- Multiple `backdrop-filter: blur(20px/24px)`, three fixed `blur(140px)` blobs, canvas shadows/gradients, and the duplicate noise layer add paint/compositing pressure around those loops ([`index.html:23`](../../index.html#L23), [`index.html:29`](../../index.html#L29), [`index.html:68`](../../index.html#L68), [`index.html:1223`](../../index.html#L1223)).

Static inspection cannot quantify device frame time, but it can prove the absence of lifecycle and workload bounds. Runtime instrumentation should measure the remaining cost rather than assume it.

### P1 — viewport and pixels have inconsistent models

The intended hero/About boundary is encoded three times: hero section height `100vh`, canvas height `85vh`, and About overlap `-15vh`. JavaScript separately sizes the drawing buffer to `innerHeight × 0.85` and then positions the strip, CTA, hint, and noise in pixels during `draw()` ([`index.html:58`](../../index.html#L58), [`index.html:315`](../../index.html#L315), [`index.html:318`](../../index.html#L318), [`index.html:784`](../../index.html#L784), [`index.html:801`](../../index.html#L801)). Mobile browser chrome can change the visual viewport and trigger resize; CSS `vh` and JavaScript `innerHeight` need not represent a single stable layout contract through that transition. There is no debounce or stable-viewport policy ([`index.html:789`](../../index.html#L789)).

The hero canvas sets its backing dimensions to CSS pixels, omitting device-pixel-ratio scaling, so it is expected to look soft on high-density mobile displays. The skills canvas does apply DPR scaling, meaning the two canvas systems follow different pixel policies ([`index.html:784`](../../index.html#L784), [`index.html:1175`](../../index.html#L1175)).

The frame scaling formula is neither a conventional `cover` nor `contain`: it takes the larger fit ratio and then multiplies it by 0.55 on mobile or 0.59 on desktop. Its result and bottom anchor are embedded directly in the paint function, which makes geometry hard to assert independently ([`index.html:798`](../../index.html#L798)). Mobile overlay placement is then patched by a separate breakpoint that hides the second message entirely ([`index.html:376`](../../index.html#L376)).

### P1 — no accessibility or degraded-motion contract

There is no `prefers-reduced-motion` query in CSS or `matchMedia` check in JavaScript. Infinite CSS animations, forced smooth scrolling, hero autoplay, particles, bubble physics, and tilt therefore remain active for users requesting less motion (complete stylesheet/script inspection; animation sites cited above).

The skills list exists only as pixels drawn into a canvas, so its contents are not present as semantic fallback content. The four case cards are clickable `div` elements rather than native controls and are not keyboard-focusable. These are not merely semantic issues: they prevent state-based automation from locating and exercising important interactions without pixel interpretation ([`index.html:646`](../../index.html#L646), [`index.html:716`](../../index.html#L716)).

### P2 — asset failure and randomness cannot be diagnosed

If a sequence frame is absent or undecoded, `draw()` silently returns instead of choosing the nearest loaded frame or recording a degraded state. `onerror` only increments `loaded`; `allReady` is written but never used. The loader can therefore finish while later animation positions render no replacement frame, with no externally visible reason ([`index.html:792`](../../index.html#L792), [`index.html:869`](../../index.html#L869), [`index.html:886`](../../index.html#L886), [`index.html:891`](../../index.html#L891)).

Both canvas simulations call `Math.random()` throughout initialization or motion. No run can be reproduced from an input sequence, and a resize re-randomizes the particle field ([`index.html:1056`](../../index.html#L1056), [`index.html:1063`](../../index.html#L1063), [`index.html:1201`](../../index.html#L1201), [`index.html:1305`](../../index.html#L1305)).

## Proposed motion laboratory (historical design; foundation now exists)

The goal is to make the exact same model power production rendering, tests, traces, and static previews. Avoid a separate “test approximation” of the animation.

### 1. Define explicit contracts

Create small modules rather than another large framework:

```text
motion/
  tokens.ts               durations, easings, amplitudes, budgets
  clock.ts                RafClock and ManualClock
  random.ts               seeded PRNG
  hero-model.ts           reducer + sample(state, time)
  hero-layout.ts          pure viewport/image geometry
  particles-model.ts      bounded, delta-time simulation
  skills-model.ts         bounded, delta-time simulation
  scheduler.ts            one lifecycle-aware rAF coordinator
  diagnostics.ts          snapshots, events, frame-cost counters
scripts/
  motion-report.ts        scenario traces + SVG/contact sheets
tests/
  motion/*.test.ts
  layout/*.test.ts
motion-artifacts/          generated in CI; do not hand-edit
```

Each pure model should accept only serializable data:

```ts
type Environment = {
  viewport: { width: number; height: number; dpr: number };
  capabilities: { hover: boolean; coarsePointer: boolean; reducedMotion: boolean };
};

type MotionInput =
  | { type: "assets-ready"; availableFrames: number[] }
  | { type: "advance" }
  | { type: "pointer"; x: number; y: number }
  | { type: "visibility"; visible: boolean }
  | { type: "resize"; environment: Environment };

type HeroSnapshot = {
  nowMs: number;
  phase: "loading" | "intro" | "ready" | "playing" | "complete" | "released";
  progress: number;
  requestedFrame: number;
  renderedFrame: number;
  overlays: { intro: number; experience: number; cta: number; hint: number };
  scrollPolicy: "native" | "local-direct-manipulation";
  layout: HeroLayout;
};
```

Model transitions should be event-driven; rendering should only consume snapshots. Use elapsed milliseconds or a fixed simulation timestep with accumulated delta. Convert smoothing coefficients with elapsed time (for example, exponential decay based on `dt`) so 30/60/120 Hz sampling converges on the same state.

### 2. Add an injectable clock and deterministic randomness

Production supplies rAF timestamps. Tests and the report generator supply a `ManualClock` that supports `seek(ms)`, `step(ms)`, and `runUntil(predicate)`. All randomized motion receives a seed; production may choose a session seed, while CI records a fixed seed in every artifact.

One scheduler should own rAF and invoke only active systems. A system is active when visible and moving. It stops when settled, offscreen, the document is hidden, or reduced motion is enabled. This turns “number of active loops” into an inspectable value.

### 3. Expose a stable debug surface

In development/test builds, expose a deliberately small API such as:

```ts
window.__portfolioMotion = {
  version: 1,
  snapshot(),
  pause(),
  step(ms),
  seekHero(progress),
  dispatch(input),
  setSeed(seed),
  metrics(),
  subscribe(listener)
};
```

`snapshot()` must contain state and computed rectangles, not DOM nodes. `metrics()` should report active systems, sampled frame intervals, long-frame count, update/draw duration, fallback-frame count, asset readiness, and the last N state transitions. This interface is useful to agents, unit tests, optional browser automation, and a human debug panel without coupling any of them to private implementation.

### 4. Generate artifacts that are understandable without a browser

The original report-generator proposal is retained as a design reference. The current browser suite emits ignored local/CI evidence only when explicitly requested; it does not recreate the deleted characterization report path.

- `summary.md`: pass/fail table, phase durations, input-to-response latency, geometry violations, active-loop counts, and trace hashes;
- `traces/*.json`: timestamped inputs and snapshots, including every phase transition;
- `timelines/*.svg`: tracks for requested/rendered frame, overlay opacity, phase, input events, and scroll policy over time;
- `storyboards/*.png`: contact sheets of actual sequence frames at named progress points, annotated with viewport/layout rectangles and overlay state;
- `layout/*.svg`: viewport wireframes showing hero, image bounds, overlays, CTA, About boundary, and safe-area insets;
- `failures/*.md`: minimal counterexample input sequence for every violated invariant.

The SVG and Markdown artifacts remain structurally inspectable as text. PNG contact sheets can be viewed directly by an image-capable agent; they do not require an interactive browser. The existing 150 source frames are enough to generate honest hero storyboards with ImageMagick or a Node image library. General CSS visual regression may later add a headless-browser screenshot layer, but core motion correctness must not depend on it.

Canonical scenarios should include:

| Scenario | Viewport/capability | Inputs |
|---|---|---|
| Small mobile | 320×568, DPR 2, coarse pointer | load, partial drag, scroll, rotate |
| Modern iPhone-like | 390×844, DPR 3, coarse pointer | load, one advance, native continuation |
| Android-like | 412×915, DPR 2.625, coarse pointer | slow asset, missing frame, resize/chrome change |
| Tablet portrait | 768×1024, DPR 2, coarse pointer | scroll and orientation |
| Desktop | 1440×900, DPR 1, hover | pointer extrema, wheel, nav jump |
| Reduced motion | 390×844 and 1440×900 | load, navigation, overlay open/close |
| Slow rendering | each key viewport sampled at 30 Hz | same event tape as 60/120 Hz |

### 5. Make layout a pure calculation where motion depends on it

`computeHeroLayout(environment, imageIntrinsic)` should return all hero rectangles and use one declared viewport policy. CSS consumes exported custom properties; canvas consumes the same result. The report can then assert bounds without a layout engine. At minimum include:

- visual/stable viewport rectangle and safe-area insets;
- canvas CSS size and backing-store size;
- image destination rectangle and focal point;
- both overlay rectangles;
- strip, CTA, hint, and About boundary;
- minimum readable/clickable regions and detected intersections.

Use semantic DOM for text, controls, and the skills list; reserve canvas for decoration. Tests can then assert content and interaction separately from pixels, while a no-motion fallback remains complete.

## Improvement criteria (definition of “better”)

These criteria should be checked before aesthetic tuning and preserved afterward.

### Interaction and accessibility

- Native vertical scrolling is never cancelled by a window-level handler. A local canvas may capture a gesture only after proving direct-manipulation intent, and must release it on cancel/end.
- From initial load, one ordinary scroll/swipe begins moving toward content; no forced hold is required to reach About. Navigation links bypass hero phases immediately.
- Reduced-motion mode shows all essential content, disables autoplay/physics/tilt/pulsing/smooth scrolling, and never gates navigation on elapsed time.
- Every case is keyboard-operable and focus-visible; every skill exists as text in the DOM; canvases have an explicit decorative or accessible role.

### Determinism and timing

- Given the same environment, seed, assets, and event tape, two runs produce the same normalized trace hash.
- Sampling the same scenario at 30, 60, and 120 Hz produces identical phase order and final state; at matching wall-clock timestamps, geometry differs by at most 0.5 CSS px, opacity/progress by at most 0.01, and discrete transitions by at most one simulation step.
- Every named animation has a tokenized duration/easing and an explicit interruption rule. No correctness assertion relies on sleeping real time.
- Missing or late frames result in a recorded nearest-frame fallback and never an unexplained blank canvas.

### Layout

- Across the canonical viewport matrix: zero unintended horizontal overflow; hero focal point remains inside its declared safe region; essential text does not intersect the subject exclusion zone; CTA is entirely visible and has at least a 44×44 CSS px hit target; About begins at the one computed boundary.
- A visual-viewport resize or orientation change produces at most one recomputation per rendered frame and preserves normalized hero progress and focused control.
- Canvas backing dimensions equal rounded CSS dimensions × bounded DPR, using the same policy for every canvas.
- Key-state layout SVGs and storyboards are reviewed as artifacts; their trace/layout JSON is snapshot-tested.

### Runtime budgets

- At rest or while all animated regions are offscreen, diagnostics report zero active rAF systems.
- On mobile, decorative particles are disabled or use a measured bounded count and non-quadratic neighbor lookup. The report records particle count and pair/neighbor checks; both have declared maxima.
- CI static checks reject direct `Math.random()`, perpetual self-scheduling loops outside the scheduler, non-tokenized animation durations, and non-passive global touch/wheel listeners.
- Device testing eventually records p95 update+draw cost and missed-frame ratio against a declared target device. Until real-device data establishes a baseline, do not claim a numeric performance win from static inspection alone.

## Current next steps after M1–M4

1. **Scheduler/lifecycle:** consolidate remaining contact, particle, and hero scheduling; stop released/offscreen work and expose active-loop metrics.
2. **Mobile performance:** bound or replace the particle all-pairs field, verify canvas/DPR budgets, and establish pinned plus real-device measurements.
3. **Asset resilience:** add deterministic missing/late hero-frame and skill-icon fallback tapes with explicit diagnostics.
4. **Semantic fallbacks:** keep skill labels and controls available outside canvas rendering, including reduced-motion and asset-failure states.
5. **Aesthetic pass:** only after the scheduler/performance gates pass, compare easing, staging, distance, overlap, and timing with fresh evidence.

## First test set to write

```text
hero-model
  intro reaches ready at the declared wall-clock time
  one advance starts play; navigation releases immediately
  reduced motion starts released with final readable content
  30/60/120 Hz tapes agree within tolerance
  missing requested frame selects and reports nearest available frame

hero-layout
  canonical viewport matrix has no out-of-bounds CTA or unintended overflow
  DPR policy produces expected backing dimensions
  resize preserves progress and normalized focal point

input-policy
  sub-threshold touch never cancels native scroll
  autoplay never cancels native scroll
  local direct manipulation releases on pointercancel/pointerup

scheduler
  no callbacks remain when systems settle or become hidden
  reduced motion schedules no decorative systems

particles/skills
  seeded replay is identical
  results are wall-clock invariant across sampling rates
  bounds and non-overlap invariants hold after each fixed step
```

## Decision and handoff

The original decision was to build observability before changing animation constants; that decision is now implemented. Do not start the aesthetic pass until the active scheduler, mobile-performance, and asset-fallback gates above are covered by current tests and disposable browser evidence.

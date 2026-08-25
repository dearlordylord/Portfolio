# Making motion and layout deterministic, visible, and testable

Research date: 2026-08-25

Status: research reference retained for the active scheduler, accessibility, performance, and frontier browser-testing work. The opening repository snapshot and original implementation sequence are historical pre-M1–M4 context; current tooling and tests have since been added.

## Decision summary

This repository should treat each animation as a named, seekable state machine and generate review evidence from a headless browser. The useful artifact is not a video alone. It is a **motion storyboard**: one contact sheet per scenario and viewport, with columns for named time checkpoints, accompanied by JSON describing animation timing, computed styles, and element geometry. This makes the work visible to a coding agent and reviewable in CI without an interactive browser. The current repository already has the initial diagnostics/test seam; this note now guides the remaining scheduler and performance work.

Use two independent controls:

1. Playwright's virtual clock for `Date`, timers, `performance`, and `requestAnimationFrame`.
2. The Web Animations API for CSS Animations, CSS Transitions, and WAAPI animations: enumerate them, pause them, and seek `currentTime` directly.

Canvas simulations need one additional seam: seeded randomness plus an explicit `step(deltaMs)`/`seek(timeMs)` API and serializable model state. Pixels alone cannot explain a stochastic physics failure.

Do not start by changing animation aesthetics. The initial harness, inventory, scenarios, and acceptance criteria are now in the repository; use the same evidence discipline for the remaining scheduler/performance changes, then compare aesthetic improvements against it.

## Repository fit and present risks

The site began as a dependency-free static document: HTML, CSS, and JavaScript still live in `index.html`, but the repository now has a pinned `package.json`, TypeScript motion modules, and Playwright/Vitest coverage. The motion system still mixes several unrelated mechanisms:

- CSS transitions and infinite keyframe animations (`arrowBounce`, `pulseCTA`).
- Multiple perpetual `requestAnimationFrame` loops for the hero, particle field, skills physics, and contact-title tilt.
- Scroll- and intersection-driven mutations.
- Two canvas scenes, both affected by runtime dimensions; the particle field still uses unseeded `Math.random()`, while Skills now uses a fixed seed and fixed-step state for replayable startup/resize checks.
- Mouse, touch, and device-orientation input.
- Breakpoints at 600, 768, and 900 CSS px, plus many viewport-relative dimensions.
- Broad `transition: all` declarations, which hide the intended animated property contract and can accidentally animate later layout/style changes.

This combination explains why screenshots taken at arbitrary wall-clock moments are neither repeatable nor comprehensive. It is especially risky on mobile, where touch/hover behavior, orientation, narrow widths, canvas sizing, and reduced compute differ at the same time.

## What "agent-visible" should mean

Every named motion scenario should produce a folder such as:

```text
test-results/motion/hero-intro/mobile-390x844/no-preference/
  storyboard.png
  00-before.png
  01-start.png
  02-quarter.png
  03-mid.png
  04-three-quarter.png
  05-end.png
  06-settled.png
  states.json
  trace.zip                 # retained on failure
```

`storyboard.png` should tile the checkpoint frames and label scenario, viewport, input mode, motion preference, phase, and virtual time. `states.json` should contain, for every tracked element:

- stable motion id and semantic phase;
- animation type/name, delay, duration, iterations, easing, play state, and current time;
- `getBoundingClientRect()` and a small allowlist of meaningful computed properties (`opacity`, `transform`, visibility, pointer events, overflow, and scenario-specific properties);
- scroll position, viewport dimensions, device-pixel ratio, and reduced-motion state;
- for canvas scenes, the seed and serialized logical objects (position, velocity, radius, phase), not only the bitmap.

Playwright traces add an action timeline, screenshot filmstrip, console/network data, and before/action/after DOM snapshots. They are excellent failure evidence, but their filmstrip is action-oriented, so explicit checkpoint frames remain necessary for a complete animation shape. [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)

## Proposed architecture

### 1. A small motion control plane

Introduce a single test-aware motion controller rather than letting each loop own real time and randomness implicitly. A future implementation can expose a read-only/test-only interface similar to:

```js
window.__motionDiagnostics = {
  version: 1,
  ready: Promise,
  scenarios: ['hero-intro', 'skills-enter', 'timeline-scroll', 'contact-tilt'],
  setMode('live' | 'manual' | 'reduced'),
  setSeed(12345),
  reset(scenario),
  step(deltaMs),
  seek(timeMs),
  snapshot()
};
```

Production behavior remains `live`; headless tests select `manual`. The important contract is that the same render/update functions serve both modes. Do not create a separate fake animation just for screenshots.

Each animation should also have:

- a stable `data-motion-id` on its meaningful DOM target;
- named phases rather than anonymous timeout/rAF progress;
- centralized tokens for duration, delay, easing, travel distance, and stagger;
- a defined initial, active, terminal, interrupted, and reduced-motion state;
- an explicit lifecycle: start, pause, resume, cancel, finish, and cleanup.

### 2. Deterministic JavaScript time

Install Playwright Clock before navigation. It replaces `Date`, timers, `requestAnimationFrame`, idle callbacks, and `performance`, and `runFor()` advances time while firing callbacks. This is the correct driver for the existing imperative rAF loops and timeout-triggered work. `fastForward()` intentionally fires due timers at most once, so use `runFor()` when intermediate frames matter. [Playwright Clock guide](https://playwright.dev/docs/clock), [Clock API](https://playwright.dev/docs/api/class-clock)

Animation updates must derive progress from the supplied timestamp or `deltaMs`, not from "one update equals one frame." The Web Animations timing model is explicitly stateless and frame-rate independent: a time input produces progress independently of how many prior frames were sampled. That is the model to copy for custom canvas motion. [Web Animations timing model](https://www.w3.org/TR/web-animations-1/)

Replace direct `Math.random()` use in animation state with an injected seeded PRNG. Record the seed in every artifact. A failing physics/collision frame then becomes replayable.

### 3. Deterministic CSS/WAAPI time

Do not assume virtual JavaScript time alone provides an exact seek for native CSS/WAAPI animation timelines. Use the platform animation objects directly:

1. Trigger the scenario.
2. Call `document.getAnimations()` or `element.getAnimations()`.
3. Select animations by stable target/name, pause them, and await readiness where required.
4. Read `effect.getComputedTiming()` and set `animation.currentTime` to the checkpoint.
5. Read computed styles/geometry and capture with screenshot animation handling set to `allow`.

The Web Animations specification explicitly defines inspection, pause/control, and testing by seeking to a chosen time; it also covers CSS animations and transitions through the common model. [Web Animations use cases and testing](https://www.w3.org/TR/web-animations-1/), [CSS Animations Level 2](https://www.w3.org/TR/css-animations-2/)

### 4. Two screenshot suites, not one

Maintain separate evidence:

- **Settled layout snapshots:** `toHaveScreenshot()` with its default `animations: 'disabled'`. Playwright fast-forwards finite animations and resets infinite ones for the shot. These catch layout and final-state regressions.
- **Motion checkpoint snapshots:** pause/seek animations manually and take screenshots with `animations: 'allow'`. These catch bad paths, easing, overlap, clipping, and intermediate mobile states.

Visual output varies with OS, browser version, hardware, settings, power state, and headless/headed mode. Generate and compare baselines in one pinned container and browser build. Commit goldens and review their diffs; never auto-approve baseline updates. Use a tiny documented tolerance only for known renderer noise. A screenshot-specific stylesheet may hide genuinely volatile third-party content, but must not hide the motion under test. [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots), [screenshot assertion behavior](https://playwright.dev/docs/api/class-pageassertions)

### 5. Responsive scenario matrix

Playwright projects should cover Chromium, Firefox, and WebKit for settled smoke tests, with the more expensive checkpoint suite initially on Chromium plus mobile WebKit. Device profiles include viewport/screen, user agent, device scale factor, and touch behavior; they are useful emulation, not a claim of real-device GPU performance. [Playwright projects](https://playwright.dev/docs/test-projects), [emulation](https://playwright.dev/docs/emulation)

Minimum layout matrix for this repository:

| Dimension | Values |
| --- | --- |
| Breakpoint probes | 599/600/601, 767/768/769, 899/900/901 px |
| Narrow viewports | 320, 360, 390 px portrait |
| Larger viewports | 768 px portrait; 1024, 1280, 1440 px landscape |
| Input capability | touch/no-hover and mouse/hover |
| Motion preference | `reduce`, `no-preference` |
| Orientation | portrait and landscape for representative phones |

Use explicit viewports: Playwright documents that `viewport: null` depends on the host window and is nondeterministic. [Playwright viewport option](https://playwright.dev/docs/api/class-testoptions#test-options-viewport)

At each scenario checkpoint, assert:

- `document.documentElement.scrollWidth <= document.documentElement.clientWidth`, except for a specifically approved horizontal scroller;
- tracked rectangles stay within their intended container/viewport safe area;
- text and controls neither overlap nor clip;
- fixed/sticky UI does not obstruct the active heading or control;
- the hit target at each important control's center is that control or its child;
- visible interactive elements have non-zero size and remain keyboard actionable;
- resizing or rotating during motion reaches the same valid state as starting at the destination size.

WCAG 2.2 Reflow requires content at 320 CSS px wide to work without loss of information/functionality and without two-dimensional page scrolling for vertically scrolling content, subject to listed exceptions. [Understanding WCAG 1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)

## Scenario coverage

For every finite transition, capture at least start, 25%, 50%, 75%, end, and settled. Add checkpoints at keyframe boundaries, maximal overshoot, and stagger boundaries. The following behavioral scenarios matter more than a larger number of arbitrary timestamps:

1. Initial load with cold and cached assets.
2. Enter, exit, and re-enter viewport.
3. Interrupt halfway and reverse.
4. Repeat the input rapidly; the last requested state must win.
5. Resize/orientation change halfway through.
6. Scroll slowly, jump-scroll, and scroll backward through each boundary.
7. Pointer and touch equivalents; no hover-only information.
8. Background/foreground-like time jump for long-lived loops.
9. Reduced-motion mode.
10. Missing/late image or font, where relevant to layout.

Playwright considers an element stable only after its bounding box is unchanged for two consecutive animation frames. Use its normal actionability checks for user interactions rather than forced clicks; a timeout is evidence of unwanted motion or obstruction. [Playwright actionability and stability](https://playwright.dev/docs/actionability)

## Accessibility behavior

Treat reduced motion as a product state, not a testing hack. Playwright can emulate both `reduce` and `no-preference`. [Playwright `emulateMedia`](https://playwright.dev/docs/api/class-page#page-emulate-media)

In reduced mode:

- remove nonessential translation, scale, parallax, 3D tilt, bounce, pulse, and physics drift;
- preserve content, ordering, interaction, focus behavior, and terminal states;
- prefer an instant change or restrained opacity/color change where transition feedback is useful;
- stop perpetual decorative canvas work rather than merely making it faster;
- do not request device-orientation input for decoration.

WCAG 2.3.3 says nonessential motion animation triggered by interaction can be disabled, and its guidance identifies `prefers-reduced-motion` as an appropriate mechanism. [Understanding Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions)

WCAG 2.2.2 (Level A) requires a pause/stop/hide mechanism for automatically started moving, blinking, or scrolling information that lasts more than five seconds and is presented alongside other content, unless essential. W3C recommends one global mechanism when a page contains multiple moving elements. This applies directly to the perpetual decorative loops and infinite CTA/hint animations unless they are stopped promptly or covered by an effective global control. [Understanding Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide)

## Performance and motion-quality criteria

Prefer `transform` and `opacity` for visual motion. Geometry-changing properties cause layout and commonly paint; transforms can move/scale content without layout shift. Use `will-change` only for a demonstrated need and remove it after finite motion, because overuse consumes resources. [web.dev animation performance](https://web.dev/articles/animations-and-performance), [high-performance CSS animation guide](https://web.dev/articles/animations-guide)

Do not make absolute frame-rate pass/fail decisions from a shared headless CI machine. Use two distinct gates:

- **Deterministic correctness gate:** geometry/state/pixel results at exact virtual times.
- **Performance non-regression gate:** pinned environment, representative mobile CPU throttling or real-device runs, comparing long tasks, frame/render timings, and work per frame against an approved baseline.

As a current diagnostic, the W3C Long Animation Frames API defines `long-animation-frame` performance entries for rendering updates over 50 ms, including render/style-layout timing and script attribution. Where supported, collect these during named scenarios and attach them to `states.json`; treat them as attribution evidence, not as a cross-browser guarantee or a replacement for frame-by-frame review. [Long Animation Frames API](https://www.w3.org/TR/long-animation-frames/)

Use CLS as a settled-layout field metric, not as a complete animation-quality metric. The current Core Web Vitals guidance defines "good" as CLS at or below 0.1 at the 75th percentile, evaluated separately for mobile and desktop. Transform animations do not themselves cause layout shifts. [web.dev CLS](https://web.dev/articles/cls)

## Acceptance rubric for an animation improvement

An animation is ready only when all applicable rows pass:

| Axis | Pass criterion |
| --- | --- |
| Intent | The motion has a named purpose: orientation, continuity, hierarchy, feedback, or delight. Decorative motion does not block reading or input. |
| Determinism | Same seed + viewport + scenario + checkpoint yields identical semantic state and stable pixels in the pinned environment. No wall-clock sleeps are needed. |
| State completeness | Initial, active, terminal, interrupted, repeated-input, resize-during-motion, and reduced states are defined and tested. |
| Timing | Transition has no accidental dead time; key information becomes legible at the intended checkpoint; completion events/state occur once. |
| Continuity | Interrupt/reversal starts from the current rendered state with no jump; rapid input ends in the last requested state. |
| Layout | No unexpected page overflow, clipping, collision, fixed-header obstruction, or layout shift at any checkpoint in the matrix. |
| Mobile input | Touch works without hover; orientation and resize preserve a valid state; targets remain reachable. |
| Reduced motion | No nonessential spatial/3D/parallax/physics motion; same content and functions remain available. |
| Performance | Primarily compositor-friendly properties; no unexplained regression in the pinned trace; perpetual work pauses when hidden/offscreen/reduced. |
| Evidence | Reviewed contact sheet, `states.json`, settled golden, motion-frame goldens, and trace on failure. |

For aesthetic comparison, score each storyboard from 1–5 on clarity of cause/effect, continuity, hierarchy, restraint, and mobile legibility. This is intentionally a review rubric, not an automated truth. An improvement should not lower any dimension and should have a written explanation for changed timing, easing, distance, or staging.

## Current implementation sequence after M1–M4

1. Consolidate scheduler ownership and lifecycle: stop released/offscreen/hidden systems and expose active-loop metrics.
2. Bound mobile work: replace or cap the particle all-pairs field, verify canvas/DPR budgets, and measure pinned plus real-device performance.
3. Add deterministic asset-failure tapes for hero frames and skill icons, including readable fallback states.
4. Expand settled and motion-checkpoint coverage across the viewport, reduced-motion, resize, and interruption matrix.
5. Improve animations one named scenario at a time and require the rubric/evidence above in review.

The initial observation system now makes these decisions comparable and reversible; do not recreate the deleted characterization report path as a prerequisite.

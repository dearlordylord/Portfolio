# Project work index

Last updated: 2026-08-25

This is the canonical, root-linked index for animation and responsive-layout work. It is the only project note that should be loaded routinely. Update it when a phase starts or finishes so research and implementation context remain discoverable without pulling old research into the active context.

## Objective

Make the site's layout, animation state, elapsed time, assets, and canvas output deterministic and inspectable before redesigning the animations—especially on mobile.

The four primary mobile acceptance scenarios are:

1. Keep the mobile hero geometry stable, with the animation occupying the intended lower portion of the first screen.
2. Show the two mobile heading groups at the top in sequence, replacing one another instead of using the desktop side layout.
3. Keep **Explore work** visible and actionable through its intended hero states.
4. Make **Tools & Skills** start reliably and never fail as an unexplained blank canvas.

## Completed research

| Document | Purpose | Status |
| --- | --- | --- |
| [Animation observability and improvement plan](./research/animation-observability-plan.md) | Accepted M1–M4 gates plus the still-active scheduler/performance direction | Active reference |
| [Repository animation audit](./research/repository-animation-audit.md) | Evidence from the implementation and repository history; refresh when the scheduler changes | Reference |
| [Primary-source animation testing research](./research/animation-testing-primary-sources.md) | Platform, Playwright, Web Animations, accessibility, and performance guidance | Reference while scheduler/performance work is active |

## Accepted decisions

- Do not tune animation aesthetics until current behavior can be replayed and compared.
- Separate serializable state/layout models from DOM and canvas rendering.
- Inject time and seeded randomness; do not make correctness depend on real sleeps or rendered-frame count.
- Keep browser diagnostics and test failure output agent-readable; generated reports and screenshots are local/CI evidence, not source.
- Use property tests for pure geometry/timing invariants and explicit scenarios for browser interaction and visual review.
- Keep one lifecycle-aware scheduler and require zero active decorative work when settled, offscreen, hidden, or reduced.
- Treat reduced motion, asset failure, resize/orientation, interruption, and touch scrolling as defined product states.

## Completed phase: observability foundation

- [x] Add pinned TypeScript, unit-test, static-server, and headless-browser tooling.
- [x] Add reusable motion types, a manual clock, seeded randomness, and the mobile hero contract.
- [x] Add localhost-only, query-gated read-only diagnostics and scene isolation for browser review.
- [x] Encode the M1–M4 contracts in current unit and Chromium browser tests; no expected-failure characterization tests remain in the default suite.

Normal URLs do not expose diagnostics. Browser reports, screenshots, traces, and motion state dumps are reproducible evidence written to ignored local/CI directories only when requested. Mobile WebKit is configured but requires host libraries that this password-restricted environment cannot install, so it remains an explicit environment/CI follow-up.

## Completed phase: mobile hero contract

- [x] Introduce one stable first-screen/mobile-stage geometry calculation.
- [x] Make mobile heading cues sequential and colocated at the top.
- [x] Give **Explore work** an explicit latched availability state and safe-region geometry.
- [x] Preserve native touch scrolling and direct navigation.

Implementation notes: mobile geometry captures one stable initial height and recomputes only for breakpoint/orientation changes. The animation stage occupies the lower `38%–85%` region of that stable first screen—the stage ends at the `85%` boundary, not at the viewport bottom. Hero canvas DPR is capped at 2; mobile copy uses time-based target progress rather than refresh-rate-dependent display lag; touch movement is passive; and direct navigation cancels a pending exit hold. Desktop copy timing/layout remains on its existing path.

## Completed phase: Tools & Skills reliability (M4)

- [x] Replace unseeded initialization and frame-count physics with deterministic fixed-step elapsed-time state.
- [x] Expose idle/entering/running/settled/paused state, activity, seed, and asset failures.
- [x] Provide semantic skill content and visible label fallbacks when icons are late or missing.
- [x] Never cancel ordinary vertical touch scrolling over the skills region.
- [x] Pause offscreen/hidden/reduced work and verify direct navigation, offscreen transition, and reduced motion.
- [x] Repaint the deterministic skill model after resize, including paused and reduced-motion states.

## Completed phase: reduced-motion policy

- [x] Make essential hero copy and **Explore work** immediately available without autoplay.
- [x] Disable hero, particle, contact, Skills, CSS pulse, and CSS bounce loops under `prefers-reduced-motion: reduce`.
- [x] Verify the whole-page policy in Chromium without scene isolation.

## Active phase: scheduler and mobile performance

- [ ] Stop the hero loop after release and pause it while offscreen/hidden (reduced-motion is already handled).
- [ ] Bound the 440-particle all-pairs field on mobile; keep it disabled under reduced motion.
- [ ] Consolidate remaining perpetual contact/particle/hero scheduling and expose active-loop metrics.
- [ ] Add asset-failure tapes for hero frames and skill icons.
- [ ] Establish pinned performance baselines without claiming real-device results from headless CI.

## Planned phases

1. **Scheduler and accessibility:** consolidate animation work, finish offscreen/release pausing, and keep the reduced-motion policy covered.
2. **Performance:** bound canvas DPR/work, remove quadratic mobile particle work, and establish pinned plus real-device measurements.
3. **Asset resilience:** add deterministic failure tapes for hero frames and skill icons.
4. **Aesthetic pass:** revise timing, easing, staging, distance, and overlap using fresh local/CI evidence and the accepted rubric.

## Durable source vs ephemeral evidence

Durable implementation knowledge lives in `index.html`, `src/motion/`, `tests/`, and this index. The M1–M4 acceptance identifiers remain in the [observability plan](./research/animation-observability-plan.md#explicit-acceptance-tests-for-the-four-mobile-failures).

Local and CI evidence is intentionally ignored and disposable:

- `motion-artifacts/` is written only when browser tests are asked to emit state or screenshots;
- `playwright-report/` and `test-results/` contain reports, traces, and failure screenshots; and
- `coverage/`, `.nyc_output/`, caches, logs, and OS metadata are transient.

Do not link to a generated path from this index and do not check these directories into the repository. Attach or inspect them during a review, then delete successful/stale output when the phase is complete.

Tests and implementation notes should link back to the acceptance identifiers `M1` through `M4` defined in the [observability plan](./research/animation-observability-plan.md#explicit-acceptance-tests-for-the-four-mobile-failures).

## Maintenance rule

When work advances:

1. update the checklist and phase here;
2. link any new durable decision or investigation note (ephemeral test output stays unlinked);
3. preserve research notes while their implementation phase is active; and
4. describe any intentional change to an acceptance criterion rather than silently changing a test contract.

## Documentation and artifact lifecycle

Research notes are temporary working memory. Keep them while they still inform an unimplemented phase, but do not load them by default when this index is sufficient.

At the end of each implementation phase:

1. move durable requirements into executable tests, types, schemas, and narrowly scoped code comments;
2. summarize only the remaining active decisions in this index;
3. remove research notes whose decisions are fully implemented or superseded, and remove their links here;
4. delete stale generated baselines, successful traces, and redundant checkpoint images; and
5. keep failure traces only while the failure is active. CI artifacts should expire automatically rather than enter the repository.

Deletion happens only in the phase-completion cleanup, after tests and implementation contain the durable knowledge. Repository history remains the recovery mechanism.

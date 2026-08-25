import {
  MotionScheduler,
  type MotionSchedulerScene,
} from "../motion/scheduler";

/** The optional local inspection surface used by the page diagnostics script. */
export type PageEffectsDiagnosticsPort = {
  register(name: string, reader: () => unknown): void;
  unregister?(name: string): void;
  isDisabled?(name: string): boolean;
};

export type PageEffectsIntersectionObserverConstructor = new (
  callback: IntersectionObserverCallback,
  options?: IntersectionObserverInit,
) => IntersectionObserver;

type ReducedMotionListenerRegistrar = (
  listener: (reducedMotion: boolean) => void,
) => () => void;

type ListenerTarget = {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void;
};

export type PageEffectsOptions = Readonly<{
  /** The one frame owner shared with the other browser motion adapters. */
  scheduler: MotionScheduler;
  /** Optional local diagnostics and scene-isolation policy. */
  diagnostics?: PageEffectsDiagnosticsPort;
  /** Defaults to the ambient browser document. */
  document?: Document;
  /** Defaults to the supplied document's default view, then ambient window. */
  window?: Window;
  /** Explicit policy override; otherwise the shared scheduler is authoritative. */
  reducedMotion?: boolean;
  /** Optional shared reduced-motion transition registrar from lifecycle.ts. */
  onReducedMotionChange?: ReducedMotionListenerRegistrar;
  /** Disable both page-effect families while retaining named diagnostics. */
  disabled?: boolean;
  /** Isolate the timeline effect without affecting contact tilt. */
  timelineDisabled?: boolean;
  /** Isolate contact tilt without affecting the timeline effect. */
  contactDisabled?: boolean;
  /** Optional query seam for isolated browser/unit tests. */
  reducedMotionQuery?: MediaQueryList;
  /** Optional constructor seam for tests without a native IntersectionObserver. */
  intersectionObserver?: PageEffectsIntersectionObserverConstructor;
}>;

export type PageEffectsHandle = {
  dispose(): void;
};

type HTMLElementLike = HTMLElement & {
  style: CSSStyleDeclaration;
};

const TIMELINE_NAME = "timeline";
const CONTACT_NAME = "contact";
const MOBILE_BREAKPOINT = 768;
const CONTACT_MAX_RY = 14;
const CONTACT_MAX_RX = 9;
const CONTACT_EASING = 0.075;
const CARD_SELECTOR = ".pcard,.tcard,.case-card";

function ambientDocument(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}

function ambientWindow(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function addListener(
  target: ListenerTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions | boolean,
): () => void {
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}

function disabledFor(
  diagnostics: PageEffectsDiagnosticsPort | undefined,
  name: string,
): boolean {
  try {
    return Boolean(diagnostics?.isDisabled?.(name));
  } catch {
    return false;
  }
}

function unregisterDiagnostics(
  diagnostics: PageEffectsDiagnosticsPort | undefined,
  name: string,
): void {
  try {
    diagnostics?.unregister?.(name);
  } catch {
    // Diagnostics are optional and must never make page cleanup fail.
  }
}

function registerDiagnostics(
  diagnostics: PageEffectsDiagnosticsPort | undefined,
  name: string,
  reader: () => unknown,
): void {
  try {
    diagnostics?.register(name, reader);
  } catch {
    // The visual effects remain useful when an inspection port is malformed.
  }
}

function getReducedMotion(options: PageEffectsOptions, browserWindow?: Window): boolean {
  if (options.reducedMotion !== undefined) return options.reducedMotion;
  if (options.onReducedMotionChange) return options.scheduler.reducedMotion;
  if (options.scheduler.reducedMotion) return true;
  // The shared lifecycle normally sets scheduler.reducedMotion before mounting.
  // This fallback only helps direct adapter consumers; it does not create a
  // second media-query listener or scheduler policy.
  if (options.reducedMotionQuery) return options.reducedMotionQuery.matches;
  return Boolean(browserWindow?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function queryElements<T extends Element>(
  owner: ParentNode | undefined,
  selector: string,
): T[] {
  if (!owner) return [];
  return Array.from(owner.querySelectorAll<T>(selector));
}

function setTimelineSettled(
  rows: HTMLElementLike[],
  fill: HTMLElementLike | null,
  cursor: HTMLElementLike | null,
): void {
  rows.forEach((row) => row.classList.add("visible"));
  if (fill) fill.style.height = "100%";
  if (cursor) cursor.style.top = "100%";
}

function clearContactTransform(element: HTMLElementLike): void {
  // The CSS baseline is the accessible, flat presentation.  Do not leave an
  // inline transform behind when reduced motion is enabled or a scene is
  // disposed.
  element.style.transform = "";
}

/**
 * Mounts the page's shallow, non-hero motion effects.
 *
 * Card reveals and the timeline are direct DOM effects.  Contact tilt is the
 * only scheduler scene here: it is activated by input, returns false after
 * easing reaches its target, and never owns a requestAnimationFrame loop.
 */
export function mountPageEffects(options: PageEffectsOptions): PageEffectsHandle {
  if (!options.scheduler) throw new TypeError("mountPageEffects requires a MotionScheduler");

  const ownerDocument = options.document ?? ambientDocument();
  const ownerWindow = options.window ?? ownerDocument?.defaultView ?? ambientWindow();
  const diagnostics = options.diagnostics;
  const cards = queryElements<HTMLElementLike>(ownerDocument, CARD_SELECTOR);
  const timelineSection = ownerDocument?.getElementById("timeline") as HTMLElementLike | null;
  const timelineFill = timelineSection?.querySelector<HTMLElementLike>(".tl-spine-fill") ?? null;
  const timelineCursor = timelineSection?.querySelector<HTMLElementLike>(".tl-cursor") ?? null;
  const timelineSpine = timelineSection?.querySelector<HTMLElementLike>(".tl-spine") ?? null;
  const timelineRows = timelineSection
    ? queryElements<HTMLElementLike>(timelineSection, ".tl-row")
    : [];
  const contactTitle = ownerDocument?.getElementById("ctitle-3d") as HTMLElementLike | null;
  const timelineDisabled =
    options.disabled === true ||
    options.timelineDisabled === true ||
    disabledFor(diagnostics, TIMELINE_NAME);
  const contactDisabled =
    options.disabled === true ||
    options.contactDisabled === true ||
    disabledFor(diagnostics, CONTACT_NAME);
  let reducedMotion = getReducedMotion(options, ownerWindow);
  let disposed = false;
  let timelineUpdateCount = 0;
  let timelineActive = false;
  let timelineCleanup: (() => void) | null = null;
  let cardObserver: IntersectionObserver | null = null;
  let contactScene: MotionSchedulerScene | null = null;
  let contactCleanup: (() => void)[] = [];
  let reducedMotionCleanup: (() => void) | null = null;
  let contactAnimating = false;
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;

  function timelineSnapshot(): Record<string, unknown> {
    return {
      active: !disposed && !timelineDisabled && timelineActive,
      reducedMotion,
      disabled: timelineDisabled,
      reason: timelineDisabled
        ? "disabled-for-scene-isolation"
        : reducedMotion
          ? "prefers-reduced-motion"
          : timelineActive
            ? "scroll-listener"
            : "inactive",
      updateCount: timelineUpdateCount,
      rowsVisible: timelineRows.filter((row) => row.classList.contains("visible")).length,
      fillHeight: timelineFill?.style.height ?? "",
      cursorTop: timelineCursor?.style.top ?? "",
    };
  }

  function contactSnapshot(): Record<string, unknown> {
    const disabled = contactDisabled;
    return {
      active: !disposed && !reducedMotion && !contactDisabled && contactAnimating,
      reducedMotion,
      disabled,
      reason: reducedMotion
        ? "prefers-reduced-motion"
        : disabled
          ? "disabled-for-scene-isolation"
          : "easing-to-pointer-target",
    };
  }

  function removeTimelineListeners(): void {
    timelineCleanup?.();
    timelineCleanup = null;
    timelineActive = false;
  }

  function updateTimeline(): void {
    if (disposed || timelineDisabled || reducedMotion || !timelineSpine || !ownerWindow) return;
    timelineUpdateCount += 1;
    const spineRect = timelineSpine.getBoundingClientRect();
    const viewportHeight = ownerWindow.innerHeight;
    const trigger = viewportHeight * 0.65;
    const progress =
      spineRect.height > 0
        ? Math.max(0, Math.min(1, (trigger - spineRect.top) / spineRect.height))
        : 0;
    const pixels = `${(progress * spineRect.height).toFixed(1)}px`;

    if (timelineFill) timelineFill.style.height = pixels;
    if (timelineCursor) timelineCursor.style.top = pixels;
    timelineRows.forEach((row) => {
      if (row.getBoundingClientRect().top < viewportHeight * 0.82) {
        row.classList.add("visible");
      }
    });
  }

  function mountTimeline(): void {
    if (disposed || timelineDisabled || reducedMotion || !timelineSpine || !ownerWindow) return;
    if (timelineActive) return;
    timelineActive = true;
    updateTimeline();
    const removeScroll = addListener(ownerWindow, "scroll", updateTimeline, { passive: true });
    const removeResize = addListener(ownerWindow, "resize", updateTimeline, { passive: true });
    timelineCleanup = () => {
      removeScroll();
      removeResize();
    };
  }

  function settleCards(): void {
    cards.forEach((card) => {
      card.style.opacity = "1";
      card.style.transform = "translateY(0)";
      if (reducedMotion) card.style.transition = "none";
    });
  }

  function mountCardObserver(): void {
    if (disposed || reducedMotion || cardObserver || cards.length === 0) return;
    const Observer =
      options.intersectionObserver ??
      (ownerWindow as (Window & { IntersectionObserver?: PageEffectsIntersectionObserverConstructor }) | undefined)
        ?.IntersectionObserver;
    if (!Observer || !ownerDocument) {
      settleCards();
      return;
    }
    cards.forEach((card) => {
      // Keep already-revealed content visible when a media preference changes
      // back from reduced motion.
      if (card.style.opacity !== "1") {
        card.style.opacity = "0";
        card.style.transform = "translateY(20px)";
      }
      card.style.transition = "opacity 0.55s ease,transform 0.55s ease";
    });
    cardObserver = new Observer(
      (entries) => {
        if (disposed || reducedMotion) return;
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const card = entry.target as HTMLElementLike;
          card.style.opacity = "1";
          card.style.transform = "translateY(0)";
        });
      },
      { threshold: 0.12 },
    );
    cards.forEach((card) => cardObserver?.observe(card));
  }

  function removeCardObserver(): void {
    cardObserver?.disconnect();
    cardObserver = null;
  }

  function removeContactListeners(): void {
    contactCleanup.forEach((remove) => remove());
    contactCleanup = [];
  }

  function unregisterContactScene(): void {
    if (!contactScene) return;
    try {
      contactScene.deactivate();
      contactScene.unregister();
    } catch {
      // The shared lifecycle may already have disposed its scheduler.
    }
    contactScene = null;
  }

  function stopContact(): void {
    removeContactListeners();
    unregisterContactScene();
    contactAnimating = false;
    targetX = 0;
    targetY = 0;
    currentX = 0;
    currentY = 0;
    if (contactTitle) clearContactTransform(contactTitle);
  }

  function startContact(): void {
    if (disposed || reducedMotion || contactDisabled || !contactTitle || !ownerDocument || !ownerWindow) return;
    if (contactScene) return;

    const activate = (): void => {
      contactAnimating = true;
      try {
        contactScene?.activate();
      } catch {
        // A disposed parent scheduler cannot accept new input work.
        contactAnimating = false;
      }
    };
    const onMouseMove = (event: Event): void => {
      if (ownerWindow.innerWidth <= MOBILE_BREAKPOINT) return;
      const mouseEvent = event as MouseEvent;
      const rect = contactTitle.getBoundingClientRect();
      const halfWidth = Math.max(1, ownerWindow.innerWidth / 2);
      const halfHeight = Math.max(1, ownerWindow.innerHeight / 2);
      const mx = (mouseEvent.clientX - (rect.left + rect.width / 2)) / halfWidth;
      const my = (mouseEvent.clientY - (rect.top + rect.height / 2)) / halfHeight;
      targetY = mx * CONTACT_MAX_RY;
      targetX = -my * CONTACT_MAX_RX;
      activate();
    };
    const onMouseLeave = (): void => {
      targetX = 0;
      targetY = 0;
      activate();
    };
    const onDeviceOrientation = (event: Event): void => {
      if (ownerWindow.innerWidth > MOBILE_BREAKPOINT) return;
      const orientation = event as DeviceOrientationEvent;
      targetY = Math.max(-CONTACT_MAX_RY, Math.min(CONTACT_MAX_RY, (orientation.gamma ?? 0) * 0.55));
      targetX = Math.max(
        -CONTACT_MAX_RX,
        Math.min(CONTACT_MAX_RX, -((orientation.beta ?? 45) - 45) * 0.3),
      );
      activate();
    };

    contactScene = options.scheduler.register(
      CONTACT_NAME,
      () => {
        if (disposed || reducedMotion || contactDisabled || !contactTitle) return false;
        currentX += (targetX - currentX) * CONTACT_EASING;
        currentY += (targetY - currentY) * CONTACT_EASING;
        contactTitle.style.transform =
          `perspective(700px) rotateX(${currentX.toFixed(2)}deg) rotateY(${currentY.toFixed(2)}deg)`;
        const settled = Math.abs(currentX - targetX) < 0.02 && Math.abs(currentY - targetY) < 0.02;
        if (settled) {
          currentX = targetX;
          currentY = targetY;
          contactAnimating = false;
        }
        return !settled && contactAnimating;
      },
      { active: false },
    );
    contactCleanup = [
      addListener(ownerDocument, "mousemove", onMouseMove, { passive: true }),
      addListener(ownerDocument, "mouseleave", onMouseLeave, { passive: true }),
      addListener(ownerWindow, "deviceorientation", onDeviceOrientation, { passive: true }),
    ];
  }

  function applyMotionPolicy(nextReducedMotion: boolean): void {
    if (disposed || reducedMotion === nextReducedMotion) return;
    reducedMotion = nextReducedMotion;
    if (reducedMotion) {
      removeTimelineListeners();
      removeCardObserver();
      stopContact();
      settleCards();
      setTimelineSettled(timelineRows, timelineFill, timelineCursor);
      return;
    }
    if (options.disabled) {
      removeTimelineListeners();
      removeCardObserver();
      stopContact();
      settleCards();
      setTimelineSettled(timelineRows, timelineFill, timelineCursor);
      return;
    }
    mountCardObserver();
    mountTimeline();
    startContact();
  }

  registerDiagnostics(diagnostics, TIMELINE_NAME, timelineSnapshot);
  registerDiagnostics(diagnostics, CONTACT_NAME, contactSnapshot);

  if (reducedMotion) {
    settleCards();
    setTimelineSettled(timelineRows, timelineFill, timelineCursor);
    if (contactTitle) clearContactTransform(contactTitle);
  } else {
    if (options.disabled) settleCards();
    if (timelineDisabled) setTimelineSettled(timelineRows, timelineFill, timelineCursor);
    mountCardObserver();
    mountTimeline();
    startContact();
  }

  if (options.onReducedMotionChange) {
    reducedMotionCleanup = options.onReducedMotionChange(applyMotionPolicy);
  } else if (options.reducedMotionQuery) {
    const query = options.reducedMotionQuery;
    const onChange = (event: MediaQueryListEvent): void => applyMotionPolicy(event.matches);
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      reducedMotionCleanup = () => query.removeEventListener("change", onChange);
    } else {
      query.addListener(onChange);
      reducedMotionCleanup = () => query.removeListener(onChange);
    }
  }

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      reducedMotionCleanup?.();
      reducedMotionCleanup = null;
      removeTimelineListeners();
      removeCardObserver();
      stopContact();
      unregisterDiagnostics(diagnostics, TIMELINE_NAME);
      unregisterDiagnostics(diagnostics, CONTACT_NAME);
    },
  };
}

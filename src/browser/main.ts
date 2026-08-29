import { mountCaseOverlay } from "./case-overlay";
import { setupMotionDiagnostics } from "./diagnostics";
import { mountHeroScene } from "./hero-scene";
import type { ProductionHeroRendererPreference } from "../motion/hero-renderer";
import {
  isMotionDisabled,
  motionScheduler,
  onReducedMotionChange,
  disposeMotionLifecycle,
  registerSchedulerDiagnostics,
} from "./lifecycle";
import { mountPageEffects } from "./page-effects";
import { mountParticleScene } from "./particle-scene";
import { mountSkillsScene } from "./skills-scene";
import { registerVisualInspection } from "./visual-inspection";

// Keep startup order explicit: the opt-in inspection surface must exist before
// any scene registers its reader, and every scene must receive the same frame
// owner and reduced-motion lifecycle.
const motionDiagnostics = setupMotionDiagnostics({ allowNonLoopback: import.meta.env.DEV });
const unregisterSchedulerDiagnostics = registerSchedulerDiagnostics(motionDiagnostics);
const unregisterVisualInspection = registerVisualInspection(motionDiagnostics);

const reducedMotionLifecycle = onReducedMotionChange;

// Existing diagnostics scenarios are C fixtures unless a test explicitly
// opts into the native ladder. Normal URLs have no renderer selector and use
// the production H → A → C capability path. The query override is loopback
// diagnostics-only; it is not an asset qualification mechanism.
const heroRendererPreference: ProductionHeroRendererPreference = (() => {
  const params = new URLSearchParams(window.location.search);
  const hostname = window.location.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  if (params.has("motionDiagnostics") && loopback) {
    const requested = params.get("heroRenderer");
    if (requested === "h" || requested === "a" || requested === "c" || requested === "auto") return requested;
    return "c";
  }
  return "auto";
})();

const heroScene = mountHeroScene({
  scheduler: motionScheduler,
  diagnostics: motionDiagnostics,
  onReducedMotionChange: reducedMotionLifecycle,
  disabled: isMotionDisabled("hero"),
  rendererPreference: heroRendererPreference,
});

const particleScene = mountParticleScene({
  scheduler: motionScheduler,
  canvas: document.getElementById("pcanvas") as HTMLCanvasElement | null,
  diagnostics: motionDiagnostics,
  onReducedMotionChange: reducedMotionLifecycle,
  disabled: isMotionDisabled("particles"),
});

const skillsScene = mountSkillsScene({
  scheduler: motionScheduler,
  diagnostics: motionDiagnostics,
  onReducedMotionChange: reducedMotionLifecycle,
  disabled: isMotionDisabled("skills"),
});

const pageEffects = mountPageEffects({
  scheduler: motionScheduler,
  diagnostics: motionDiagnostics,
  onReducedMotionChange: reducedMotionLifecycle,
  timelineDisabled: isMotionDisabled("timeline"),
  contactDisabled: isMotionDisabled("contact"),
});

const caseOverlay = mountCaseOverlay();

// Preserve direct links to the Skills section while allowing the scene's
// intersection lifecycle to remain authoritative for ordinary scrolling.
const startSkillsFromHash = (): void => {
  if (window.location.hash === "#skills") skillsScene?.start();
};
startSkillsFromHash();
window.addEventListener("hashchange", startSkillsFromHash);

type ViteHot = {
  dispose(callback: () => void): void;
};

let cleanedUp = false;
const cleanup = (): void => {
  if (cleanedUp) return;
  cleanedUp = true;
  window.removeEventListener("hashchange", startSkillsFromHash);
  window.removeEventListener("pagehide", onPageHide);
  caseOverlay.destroy();
  pageEffects.dispose();
  skillsScene?.destroy();
  particleScene?.destroy();
  heroScene.dispose();
  unregisterSchedulerDiagnostics();
  unregisterVisualInspection();
  disposeMotionLifecycle();
};

const onPageHide = (event: PageTransitionEvent): void => {
  // BFCache retains the live module graph. Keep scenes/listeners registered so
  // pageshow can resume them; ordinary teardown still owns the final cleanup.
  if (event.persisted) return;
  cleanup();
};

// The entry module is long-lived under Vite HMR and can otherwise leave its
// scenes, delegated DOM listeners, and diagnostics readers registered after a
// remount. Page teardown uses the same idempotent path.
window.addEventListener("pagehide", onPageHide);
const viteHot = (import.meta as ImportMeta & { hot?: ViteHot }).hot;
viteHot?.dispose(cleanup);

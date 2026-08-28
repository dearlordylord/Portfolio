/**
 * PROTOTYPE ONLY — video hero architecture comparison.
 *
 * Question: can one responsive hero stage use a native VP9-alpha WebM where
 * available, a packed H.264 color+matte video decoded through WebGL, and the
 * existing WebP frame sequence as a deterministic fallback?
 *
 * This file intentionally keeps the wiring visible. It is not a production
 * media abstraction: every renderer owns its own loading, timing, and metric
 * updates so a reviewer can see exactly where Safari behavior differs.
 */

import {
  createVideoPlaybackModel,
  playbackHandoffFrame as modelPlaybackHandoffFrame,
  shouldAutoplayHandoff,
  type PlaybackEvent,
  type PlaybackRenderer,
  type VideoPlaybackModel,
  type VideoPlaybackSnapshot,
} from "../motion/video-playback-model";
import { hasTransparentProbePixel } from "../motion/packed-alpha";
import { nextExactSequenceFrame } from "../motion/sequence-playback";

type Variant = PlaybackRenderer;

type VariantDefinition = {
  key: Variant;
  shortLabel: string;
  label: string;
  detail: string;
};

const VARIANTS: readonly VariantDefinition[] = [
  { key: "a", shortLabel: "A", label: "Native VP9 alpha", detail: "transparent WebM" },
  { key: "b", shortLabel: "B", label: "Packed H.264 + WebGL", detail: "RGB + matte shader" },
  { key: "c", shortLabel: "C", label: "WebP sequence", detail: "baseline fallback" },
];

const FRAME_COUNT = 150;
const FRAME_RATE = 15;
const FRAME_DURATION_SECONDS = FRAME_COUNT / FRAME_RATE;
// Mobile decoders can take longer than one half-second to present a random
// seek (the first Chromium probe took ~1.1s). Keep the watchdog observable,
// but do not misclassify a slow seek as a deadlock while play is already
// requested.
const RESUME_DEADLINE_MS = 2000;
const INTRO_END_FRAME = 31;
const LAST_FRAME = FRAME_COUNT - 1;
const LAST_FRAME_PTS_SECONDS = LAST_FRAME / FRAME_RATE;
const WEBP_TOTAL_BYTES = 4_578_812;
const WEBM_BYTES = 2_238_324;
const MP4_BYTES = 1_839_215;
const HQ_WEBM_BYTES = 0;
const HQ_MP4_BYTES = 1_796_188;
const SOURCE_WIDTH = 900;
const SOURCE_HEIGHT = 507;
const HQ_WIDTH = 1280;
const HQ_HEIGHT = 720;
const PACKED_WIDTH = 1800;
const PACKED_HEIGHT = 508;
const WEBP_PREFIX = "/Кадры/frame_";
const WEBP_SUFFIX = "_delay-0.067s.webp";
const WEBM_SOURCE = "/video-prototype/hero-alpha-vp9.webm";
const MP4_SOURCE = "/video-prototype/hero-color-matte.mp4";
const HQ_WEBM_SOURCE = "/video-prototype/hq-hero-alpha-vp9.webm";
const HQ_MP4_SOURCE = "/video-prototype/hq-hero-color-matte.mp4";
const prototypeParams = new URLSearchParams(window.location.search);
// Continuous playback is the comparison default. The production-style
// checkpoint at frame 31 is opt-in so a bare prototype URL cannot look broken.
const segmentedPlayback = prototypeParams.get("mode") === "segmented";
const requestedQuality = prototypeParams.get("quality")?.toLowerCase() === "hq" ? "hq" : "standard";
const activeQuality: "standard" | "hq" = requestedQuality === "hq" && HQ_MP4_BYTES > 0 ? "hq" : "standard";
const nativeQuality: "standard" | "hq" = activeQuality === "hq" && HQ_WEBM_BYTES > 0 ? "hq" : "standard";

// `forceFail` accepts repeated query parameters or a comma-separated list so
// a reviewer can exercise one boundary (`forceFail=b`) or a full cascade
// (`forceFail=a,b`) without changing code or pretending a network failure.
const forcedFailures = new Set(
  prototypeParams
    .getAll("forceFail")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value === "a" || value === "b" || value === "webgl"),
);

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Video prototype markup is missing #${id}`);
  return element as T;
}

const root = requiredElement<HTMLElement>("video-prototype-root");
const mediaStage = requiredElement<HTMLElement>("media-stage");
const playToggle = requiredElement<HTMLButtonElement>("play-toggle");
const roleCopy = requiredElement<HTMLElement>("copy-role");
const experienceCopy = requiredElement<HTMLElement>("copy-experience");
const scrub = requiredElement<HTMLInputElement>("timeline-scrub");
const switcher = requiredElement<HTMLElement>("variant-switcher");
const statusLabel = requiredElement<HTMLElement>("metrics-status");
const metricEvents = requiredElement<HTMLOListElement>("metric-events");
const metricTape = requiredElement<HTMLOListElement>("metric-tape");

const metricElements = {
  requested: document.getElementById("metric-requested"),
  active: document.getElementById("metric-active"),
  injected: document.getElementById("metric-injected"),
  vp9: document.getElementById("metric-vp9"),
  h264: document.getElementById("metric-h264"),
  alpha: document.getElementById("metric-alpha"),
  segment: document.getElementById("metric-segment"),
  state: document.getElementById("metric-state"),
  error: document.getElementById("metric-error"),
  firstVisible: document.getElementById("metric-first-visible"),
  ready: document.getElementById("metric-ready"),
  seek: document.getElementById("metric-seek"),
  duration: document.getElementById("metric-duration"),
  resolution: document.getElementById("metric-resolution"),
  bytes: document.getElementById("metric-bytes"),
  frames: document.getElementById("metric-frames"),
  scrub: document.getElementById("metric-scrub"),
  fallback: document.getElementById("metric-fallback"),
  quality: document.getElementById("metric-quality"),
  intended: document.getElementById("metric-intended"),
  mediaTime: document.getElementById("metric-media-time"),
  mediaFrame: document.getElementById("metric-media-frame"),
  presented: document.getElementById("metric-presented"),
  confirmation: document.getElementById("metric-confirmation"),
  targetConfirmed: document.getElementById("metric-target-confirmed"),
  postSeekProgress: document.getElementById("metric-post-seek-progress"),
  targetTimeout: document.getElementById("metric-target-timeout"),
  delta: document.getElementById("metric-delta"),
  expected: document.getElementById("metric-expected"),
  actual: document.getElementById("metric-actual"),
  reason: document.getElementById("metric-reason"),
  resumeRequested: document.getElementById("metric-resume-requested"),
  progressAge: document.getElementById("metric-progress-age"),
} as const;

type MetricElement = HTMLElement | null;

type Metrics = {
  requested: Variant;
  active: Variant;
  injected: string;
  vp9: string;
  h264: string;
  alpha: string;
  segment: string;
  state: string;
  error: string;
  firstVisibleMs: number | null;
  readyMs: number | null;
  seekMs: number | null;
  durationSeconds: number | null;
  resolution: string;
  transferredBytes: number;
  loadedFrames: number;
  scrubHeldFrame: number | null;
  scrubState: string;
  fallbackReason: string;
  frame: number;
  events: string[];
  quality: string;
  playback: VideoPlaybackSnapshot | null;
};

type Runtime = {
  variant: Variant;
  destroy: () => void;
  togglePlayback: () => void;
  pauseForScrub: () => void;
  resumeFromScrub: (frame: number) => void;
  resumeAfterScrubRelease: (frame: number) => void;
  seek: (frame: number) => void;
};

type PlaybackBinding = {
  model: VideoPlaybackModel;
  dispatch: (event: PlaybackEvent) => VideoPlaybackSnapshot;
  snapshot: (atMs?: number) => VideoPlaybackSnapshot;
};

const bootStartedAt = performance.now();
let metrics: Metrics = createMetrics("a");
let runtime: Runtime | null = null;
let runId = 0;
let currentVariant: Variant = "a";
let requestedVariant: Variant = "a";
let scrubHeldFrame: number | null = null;
let scrubPointerActive = false;
let scrubCompletedFrameAwaitingChange: number | null = null;
let scrubResumeIssued = false;
let playbackBinding: PlaybackBinding | null = null;

// A paused seek may produce no further media event. Keep the diagnostic model
// observable through its resume deadline without using the watchdog to drive
// either renderer's playback.
window.setInterval(() => {
  playbackBinding?.snapshot(playbackTimeMs());
}, 100);

function createMetrics(requested: Variant): Metrics {
  return {
    requested,
    active: requested,
    injected: forcedFailures.size > 0 ? [...forcedFailures].join(", ") : "none",
    vp9: "not checked",
    h264: "not checked",
    alpha: "not checked",
    segment: segmentedPlayback ? `enabled · pause @ frame ${INTRO_END_FRAME}` : "loop mode · no pauses",
    state: "booting",
    error: "none",
    firstVisibleMs: null,
    readyMs: null,
    seekMs: null,
    durationSeconds: null,
    resolution: "—",
    transferredBytes: 0,
    loadedFrames: 0,
    scrubHeldFrame: null,
    scrubState: "idle",
    fallbackReason: "none",
    frame: 0,
    events: [],
    quality: activeQuality === "hq" ? "HQ packed B · A/C standard" : "standard ladder",
    playback: null,
  };
}

function definition(variant: Variant): VariantDefinition {
  return VARIANTS.find((item) => item.key === variant) ?? VARIANTS[0];
}

function parseVariant(value: string | null): Variant {
  switch (value?.toLowerCase()) {
    case "a":
    case "vp9":
    case "webm":
    case "alpha":
      return "a";
    case "b":
    case "packed":
    case "h264":
    case "mp4":
      return "b";
    case "c":
    case "webp":
    case "sequence":
    case "fallback":
      return "c";
    default:
      return "a";
  }
}

function shouldForceFailure(key: "a" | "b" | "webgl"): boolean {
  return forcedFailures.has(key);
}

function injectFailure(key: "a" | "b" | "webgl"): void {
  const reason = `injected: forceFail=${key}`;
  metrics.state = `${key.toUpperCase()} forced failure`;
  addFallbackReason(reason);
  recordEvent(reason);
}

function formatMs(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "pending" : `${Math.round(value)} ms`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "pending";
  const units = ["B", "KiB", "MiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `~${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function normalizeFrame(frame: number): number {
  return Math.max(0, Math.min(LAST_FRAME, Math.round(frame)));
}

function setScrubHold(frame: number | null, state: string): void {
  scrubHeldFrame = frame === null ? null : normalizeFrame(frame);
  metrics.scrubHeldFrame = scrubHeldFrame;
  metrics.scrubState = state;
  if (scrubHeldFrame !== null) scrub.value = String(scrubHeldFrame);
  renderMetrics();
}

function currentTime(): number {
  return performance.now();
}

function playbackTimeMs(): number {
  return Math.max(0, currentTime() - bootStartedAt);
}

function syncPlaybackSnapshot(snapshot: VideoPlaybackSnapshot): void {
  metrics.playback = snapshot;
  scrubHeldFrame = snapshot.scrubHeldFrame;
  metrics.scrubHeldFrame = snapshot.scrubHeldFrame;
  if (snapshot.seeking) metrics.scrubState = `seeking · target ${snapshot.scrubHeldFrame ?? snapshot.intendedFrame}`;
  else if (snapshot.targetConfirmedFrame !== null) {
    metrics.scrubState = snapshot.resumeRequested ? "resume requested · target observed" : "target observed";
  }
  renderMetrics();
}

function createPlaybackBinding(renderer: Variant): PlaybackBinding {
  const model = createVideoPlaybackModel({
    renderer,
    frameCount: FRAME_COUNT,
    frameRate: FRAME_RATE,
    resumeDeadlineMs: RESUME_DEADLINE_MS,
    tapeLimit: 32,
  });
  const binding: PlaybackBinding = {
    model,
    dispatch: (event) => {
      const snapshot = model.dispatch(event);
      syncPlaybackSnapshot(snapshot);
      return snapshot;
    },
    snapshot: (atMs = playbackTimeMs()) => {
      const snapshot = model.snapshot(atMs);
      syncPlaybackSnapshot(snapshot);
      return snapshot;
    },
  };
  return binding;
}

function recordEvent(message: string): void {
  metrics.events.unshift(`${Math.round(currentTime() - bootStartedAt)}ms · ${message}`);
  metrics.events = metrics.events.slice(0, 10);
  renderMetrics();
}

function setMetricClass(element: MetricElement, value: string): void {
  if (!element) return;
  element.classList.remove("good", "warn", "bad");
  if (value === "none" || value === "ready" || value === "probably") element.classList.add("good");
  if (value === "pending" || value === "maybe" || value === "not checked") element.classList.add("warn");
  if (value.includes("error") || value.includes("unsupported") || value.includes("failed")) element.classList.add("bad");
}

function writeMetric(element: MetricElement, value: string): void {
  if (!element) return;
  element.textContent = value;
  setMetricClass(element, value);
}

function renderMetrics(): void {
  const requested = definition(metrics.requested);
  const active = definition(metrics.active);
  writeMetric(metricElements.requested, `${requested.shortLabel} · ${requested.label}`);
  writeMetric(metricElements.active, `${active.shortLabel} · ${active.label}`);
  writeMetric(metricElements.injected, metrics.injected);
  writeMetric(metricElements.vp9, metrics.vp9);
  writeMetric(metricElements.h264, metrics.h264);
  writeMetric(metricElements.alpha, metrics.alpha);
  writeMetric(metricElements.segment, metrics.segment);
  writeMetric(metricElements.state, metrics.state);
  writeMetric(metricElements.error, metrics.error);
  writeMetric(metricElements.firstVisible, formatMs(metrics.firstVisibleMs));
  writeMetric(metricElements.ready, formatMs(metrics.readyMs));
  writeMetric(metricElements.seek, formatMs(metrics.seekMs));
  writeMetric(
    metricElements.duration,
    metrics.durationSeconds === null ? "pending" : `${metrics.durationSeconds.toFixed(2)} s`,
  );
  writeMetric(metricElements.resolution, metrics.resolution);
  writeMetric(metricElements.bytes, formatBytes(metrics.transferredBytes));
  writeMetric(metricElements.frames, `${metrics.loadedFrames} / ${FRAME_COUNT}`);
  writeMetric(metricElements.quality, metrics.quality);
  writeMetric(
    metricElements.scrub,
    metrics.scrubHeldFrame === null ? "none" : `frame ${metrics.scrubHeldFrame} · ${metrics.scrubState}`,
  );
  const playback = metrics.playback;
  writeMetric(metricElements.intended, playback === null ? "pending" : `frame ${playback.intendedFrame}`);
  writeMetric(
    metricElements.mediaTime,
    playback?.mediaCurrentTimeSeconds === null || playback?.mediaCurrentTimeSeconds === undefined
      ? "pending"
      : `${playback.mediaCurrentTimeSeconds.toFixed(3)} s`,
  );
  writeMetric(metricElements.mediaFrame, playback?.mediaFrame === null || playback?.mediaFrame === undefined ? "pending" : `frame ${playback.mediaFrame}`);
  writeMetric(
    metricElements.presented,
    playback?.confirmedPresentedFrame === null || playback?.confirmedPresentedFrame === undefined
      ? "pending"
      : `frame ${playback.confirmedPresentedFrame}`,
  );
  writeMetric(metricElements.confirmation, playback?.confirmationSource ?? "pending");
  writeMetric(
    metricElements.targetConfirmed,
    playback?.targetConfirmedFrame === null || playback?.targetConfirmedFrame === undefined
      ? "pending"
      : `frame ${playback.targetConfirmedFrame}`,
  );
  writeMetric(
    metricElements.postSeekProgress,
    playback?.postSeekProgressFrame === null || playback?.postSeekProgressFrame === undefined
      ? "pending"
      : `frame ${playback.postSeekProgressFrame}`,
  );
  writeMetric(metricElements.targetTimeout, playback === null ? "pending" : playback.targetConfirmationTimedOut ? "yes" : "no");
  writeMetric(metricElements.delta, playback?.deltaFrames === null || playback?.deltaFrames === undefined ? "pending" : `${playback.deltaFrames > 0 ? "+" : ""}${playback.deltaFrames} frames`);
  writeMetric(metricElements.expected, playback === null ? "pending" : playback.expectedMotion ? "yes" : "no");
  writeMetric(metricElements.actual, playback === null ? "pending" : playback.actualPlayback);
  writeMetric(metricElements.reason, playback === null ? "pending" : playback.reason);
  writeMetric(metricElements.resumeRequested, playback === null ? "pending" : playback.resumeRequested ? "yes" : "no");
  writeMetric(
    metricElements.progressAge,
    playback?.lastProgressAgeMs === null || playback?.lastProgressAgeMs === undefined
      ? "pending"
      : `${Math.round(playback.lastProgressAgeMs)} ms`,
  );
  writeMetric(metricElements.fallback, metrics.fallbackReason);
  statusLabel.textContent = metrics.state;
  metricEvents.replaceChildren(
    ...metrics.events.map((entry) => {
      const item = document.createElement("li");
      item.textContent = entry;
      return item;
    }),
  );
  metricTape.replaceChildren(
    ...(playback?.eventTape ?? []).map((entry) => {
      const item = document.createElement("li");
      const details = Object.entries(entry.details)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      item.textContent = `${Math.round(entry.atMs)}ms · ${entry.event}${details ? ` · ${details}` : ""}`;
      return item;
    }),
  );
}

function addFallbackReason(reason: string): void {
  if (metrics.fallbackReason === "none") metrics.fallbackReason = reason;
  else if (!metrics.fallbackReason.includes(reason)) metrics.fallbackReason += `; ${reason}`;
}

function markFirstVisible(): void {
  if (metrics.firstVisibleMs !== null) return;
  metrics.firstVisibleMs = currentTime() - bootStartedAt;
  recordEvent(`first visible (${formatMs(metrics.firstVisibleMs)})`);
}

function markReady(): void {
  if (metrics.readyMs !== null) return;
  metrics.readyMs = currentTime() - bootStartedAt;
  recordEvent(`ready (${formatMs(metrics.readyMs)})`);
}

function resourceBytes(path: string, fallback: number): number {
  const expected = new URL(path, window.location.href).href;
  const entries = performance.getEntriesByType("resource");
  const resource = entries.find((entry): entry is PerformanceResourceTiming => {
    return entry instanceof PerformanceResourceTiming && entry.name === expected;
  });
  if (!resource) return fallback;
  // transferSize is zero for a cache hit; encodedBodySize is the best local
  // approximation in that case, and the committed asset size is the final
  // fallback when the browser exposes neither field.
  return resource.transferSize || resource.encodedBodySize || fallback;
}

function updateMediaMetrics(video: HTMLVideoElement, resolutionFallback: string): void {
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  if (duration !== null) metrics.durationSeconds = duration;
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    metrics.resolution = `${video.videoWidth}×${video.videoHeight}`;
  } else if (metrics.resolution === "—") {
    metrics.resolution = resolutionFallback;
  }
  renderMetrics();
}

/**
 * canPlayType only describes a decoder claim. Safari releases that decode VP9
 * while dropping the alpha plane must be rejected after a real frame is
 * drawable, otherwise the transparent hero silently becomes a black box.
 */
function observeNativeAlpha(
  video: HTMLVideoElement,
  isCurrent: () => boolean,
  onFailure: (reason: string) => void,
): () => void {
  const probe = document.createElement("canvas");
  probe.width = 2;
  probe.height = 2;
  const context = probe.getContext("2d", { willReadFrequently: true });
  let checked = false;
  let rafHandle: number | null = null;
  const check = (): void => {
    rafHandle = null;
    if (checked || !isCurrent() || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !context) return;
    try {
      context.clearRect(0, 0, probe.width, probe.height);
      context.drawImage(video, 0, 0, probe.width, probe.height);
      const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
      checked = true;
      if (!hasTransparentProbePixel(pixels)) {
        onFailure("A alpha pixel probe failed: decoded frame is opaque/black");
      } else {
        metrics.alpha += " · pixel probe passed";
        renderMetrics();
        recordEvent("A alpha pixel probe passed");
      }
    } catch (error) {
      checked = true;
      onFailure(`A alpha pixel probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const scheduleCheck = (): void => {
    if (checked || rafHandle !== null) return;
    rafHandle = requestAnimationFrame(check);
  };
  const onLoadedData = (): void => scheduleCheck();
  const onPlaying = (): void => scheduleCheck();
  video.addEventListener("loadeddata", onLoadedData);
  video.addEventListener("playing", onPlaying);
  scheduleCheck();
  return () => {
    video.removeEventListener("loadeddata", onLoadedData);
    video.removeEventListener("playing", onPlaying);
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
  };
}

function setCopy(frame: number): void {
  metrics.frame = Math.max(0, Math.min(LAST_FRAME, frame));
  // These are the same semantic handoff points used by the current hero:
  // role fades out by frame 58, experience fades in from frame 58.
  const roleOpacity = metrics.frame < 5
    ? 0
    : metrics.frame < 14
      ? (metrics.frame - 5) / 9
      : metrics.frame < 48
        ? 1
        : metrics.frame <= 58
          ? 1 - (metrics.frame - 48) / 10
          : 0;
  const experienceOpacity = metrics.frame < 58
    ? 0
    : metrics.frame < 72
      ? (metrics.frame - 58) / 14
      : 1;
  roleCopy.style.opacity = String(Math.max(0, Math.min(1, roleOpacity)));
  experienceCopy.style.opacity = String(Math.max(0, Math.min(1, experienceOpacity)));
  if (!scrubPointerActive && !(metrics.playback?.seeking ?? false)) scrub.value = String(Math.round(metrics.frame));
  renderMetrics();
}

type MediaEventCallbacks = {
  onReady?: () => void;
  onPlaying?: () => void;
  onPaused?: () => void;
};

function appendMediaEvents(
  video: HTMLVideoElement,
  isCurrent: () => boolean,
  onError: (reason: string) => void,
  callbacks: MediaEventCallbacks = {},
): () => void {
  const eventNames = ["loadstart", "loadedmetadata", "loadeddata", "canplay", "playing", "pause", "waiting", "stalled", "suspend", "emptied", "abort"] as const;
  const listeners = new Map<string, EventListener>();
  for (const name of eventNames) {
    const listener: EventListener = () => {
      if (!isCurrent()) return;
      metrics.state = name;
      if (name === "loadedmetadata" || name === "loadeddata" || name === "canplay") updateMediaMetrics(video, "video metadata pending");
      if (name === "canplay") {
        markReady();
        callbacks.onReady?.();
      }
      if (name === "loadeddata" || name === "playing") markFirstVisible();
      if (name === "playing") playToggle.classList.remove("visible");
      if (name === "pause" || name === "waiting") playToggle.classList.add("visible");
      if (name === "pause" && scrubHeldFrame !== null) metrics.state = `scrub held frame ${scrubHeldFrame}`;
      if (name === "playing") callbacks.onPlaying?.();
      if (name === "pause") callbacks.onPaused?.();
      recordEvent(`media:${name}`);
    };
    listeners.set(name, listener);
    video.addEventListener(name, listener);
  }
  const errorListener: EventListener = () => {
    if (!isCurrent()) return;
    const mediaError = video.error;
    const detail = mediaError ? `code ${mediaError.code}${mediaError.message ? ` (${mediaError.message})` : ""}` : "unknown media error";
    metrics.error = detail;
    metrics.state = "media error";
    playToggle.classList.add("visible");
    recordEvent(`media:error ${detail}`);
    onError(detail);
  };
  video.addEventListener("error", errorListener);
  return () => {
    for (const [name, listener] of listeners) video.removeEventListener(name, listener);
    video.removeEventListener("error", errorListener);
  };
}

function setupVideoElement(source: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.className = "hero-render hero-render-source";
  video.autoplay = true;
  video.defaultMuted = true;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("muted", "");
  video.setAttribute("aria-hidden", "true");
  video.poster = frameSource(0);
  mediaStage.replaceChildren(video);
  // Cloudflare Pages currently answers Range requests for these static media
  // files with 200 rather than 206. A normal URL-backed video therefore
  // reports seekable=[0,0] even after it is buffered, making the diagnostic
  // controller jump back to frame 0. A blob URL is locally seekable and keeps
  // the prototype honest. Production linear playback need not pay this cost.
  void fetch(source)
    .then((response) => {
      if (!response.ok) throw new Error(`media fetch ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      if (!video.isConnected) return;
      const objectUrl = URL.createObjectURL(blob);
      video.dataset.objectUrl = objectUrl;
      video.src = objectUrl;
      video.load();
      recordEvent(`seekable media blob ready (${formatBytes(blob.size)})`);
    })
    .catch((error) => {
      if (!video.isConnected) return;
      // Preserve a playable comparison when blob preparation itself fails;
      // diagnostics will still expose the browser/server seek limitation.
      video.src = source;
      video.load();
      recordEvent(`seekable blob failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  return video;
}

function releaseVideoElement(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
  const objectUrl = video.dataset.objectUrl;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  delete video.dataset.objectUrl;
}

function playVideo(
  video: HTMLVideoElement,
  isCurrent: () => boolean,
  onAutoplayBlocked?: () => void,
): void {
  void video.play().catch(() => {
    if (!isCurrent()) return;
    metrics.state = "autoplay blocked";
    addFallbackReason("autoplay blocked — tap Play");
    playToggle.classList.add("visible");
    playbackBinding?.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "autoplay-blocked" });
    recordEvent("play() rejected; waiting for user gesture");
    onAutoplayBlocked?.();
  });
}

function setupNativeVp9(run: number): Runtime | null {
  const probe = document.createElement("video");
  const vp9 = probe.canPlayType('video/webm; codecs="vp09.00.10.08"');
  metrics.vp9 = vp9 || "unsupported";
  recordEvent(`VP9 alpha canPlayType=${metrics.vp9}`);
  if (shouldForceFailure("a")) {
    injectFailure("a");
    return null;
  }
  if (!vp9) {
    addFallbackReason("A unsupported by canPlayType");
    return null;
  }

  const video = setupVideoElement(nativeQuality === "hq" ? HQ_WEBM_SOURCE : WEBM_SOURCE);
  video.classList.remove("hero-render-source");
  video.loop = !segmentedPlayback;
  metrics.active = "a";
  metrics.alpha = `encoded VP9 alpha (${nativeQuality}; alpha_mode=1; browser render unverified)`;
  metrics.state = `loading ${nativeQuality === "hq" ? "HQ " : ""}WebM`;
  metrics.transferredBytes = resourceBytes(nativeQuality === "hq" ? HQ_WEBM_SOURCE : WEBM_SOURCE, nativeQuality === "hq" ? HQ_WEBM_BYTES : WEBM_BYTES);
  renderMetrics();
  const isCurrent = () => runId === run && runtime?.variant === "a";
  const binding = playbackBinding ?? createPlaybackBinding("a");
  playbackBinding = binding;
  const handoff = binding.snapshot();
  const handoffFrame = normalizeFrame(modelPlaybackHandoffFrame(handoff));
  const shouldResumeHandoff = shouldAutoplayHandoff(handoff);
  let readyDispatched = false;
  const applyHandoff = (): void => {
    if (!handoff.eventTape.some((entry) => entry.event === "media-ready") || handoffFrame <= 0) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = handoffFrame / FRAME_RATE;
    if (shouldResumeHandoff) playVideo(video, isCurrent);
    else video.pause();
  };
  const onReady = (): void => {
    if (readyDispatched) return;
    readyDispatched = true;
    dispatchMediaReady(binding, video, isCurrent);
    applyHandoff();
  };
  const removeMediaListeners = appendMediaEvents(video, isCurrent, (reason) => {
    if (isCurrent()) {
      addFallbackReason(`A media error: ${reason}`);
      fallbackFrom("a", `A media error: ${reason}`);
    }
  }, {
    onReady,
    onPlaying: () => binding.dispatch({ type: "media-playing", atMs: playbackTimeMs() }),
    onPaused: () => {
      const state = binding.snapshot();
      if (state.reason !== "user-pause" && !state.seeking) {
        binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "media-paused" });
      }
    },
  });
  let segmentPhase: "intro" | "waiting" | "main" | "terminal" | "loop" = !segmentedPlayback
    ? "loop"
    : handoffFrame >= LAST_FRAME
      ? "terminal"
      : handoffFrame >= INTRO_END_FRAME
        ? "main"
        : "intro";
  const timeListener = (): void => {
    if (!isCurrent()) return;
    const frame = video.currentTime * FRAME_RATE;
    binding.dispatch({ type: "media-timeupdate", atMs: playbackTimeMs(), currentTimeSeconds: video.currentTime });
    setCopy(frame);
    if (!segmentedPlayback) return;
    const introTime = INTRO_END_FRAME / FRAME_RATE;
    const terminalTime = LAST_FRAME_PTS_SECONDS;
    if (segmentPhase === "intro" && video.currentTime >= introTime) {
      segmentPhase = "waiting";
      video.pause();
      video.currentTime = introTime;
      binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "segment-pause@31" });
      metrics.segment = `exact pause · frame ${INTRO_END_FRAME} · resume on tap`;
      playToggle.textContent = "Resume main segment";
      playToggle.classList.add("visible");
      recordEvent(`segment pause @ frame ${INTRO_END_FRAME}`);
    } else if (segmentPhase === "main" && video.currentTime >= terminalTime) {
      segmentPhase = "terminal";
      video.pause();
      video.currentTime = terminalTime;
      binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "segment-terminal-pause" });
      metrics.segment = `exact terminal pause · frame ${LAST_FRAME}`;
      playToggle.textContent = "Replay intro segment";
      playToggle.classList.add("visible");
      recordEvent(`terminal pause @ frame ${LAST_FRAME}`);
    }
  };
  video.addEventListener("timeupdate", timeListener);
  const seekListener = (): void => {
    if (!isCurrent() || seekStartedAt === null) return;
    metrics.seekMs = currentTime() - seekStartedAt;
    seekStartedAt = null;
    recordEvent(`seek complete (${formatMs(metrics.seekMs)})`);
  };
  video.addEventListener("seeked", seekListener);
  let seekStartedAt: number | null = null;
  let alphaProbeFailed = false;
  const stopAlphaProbe = observeNativeAlpha(video, isCurrent, (reason) => {
    if (alphaProbeFailed || !isCurrent()) return;
    alphaProbeFailed = true;
    metrics.alpha = "failed: VP9 alpha plane not observable";
    metrics.error = reason;
    addFallbackReason(reason);
    recordEvent(reason);
    fallbackFrom("a", reason);
  });
  const pauseForScrub = (): void => {
    if (!isCurrent()) return;
    video.pause();
    binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "scrub-pause" });
    metrics.state = `scrub held frame ${Math.round(metrics.frame)}`;
    playToggle.textContent = "Play if seek stalls";
    playToggle.classList.add("visible");
    recordEvent(`scrub paused at frame ${Math.round(metrics.frame)}`);
  };
  const resumeFromScrub = (frame: number): void => {
    if (!isCurrent()) return;
    const target = normalizeFrame(frame);
    video.loop = !segmentedPlayback;
    if (segmentedPlayback) {
      if (target >= LAST_FRAME) {
        segmentPhase = "intro";
        video.currentTime = 0;
        metrics.segment = `intro segment running · scrub released from frame ${target}`;
      } else if (target < INTRO_END_FRAME) {
        segmentPhase = "intro";
        video.currentTime = target / FRAME_RATE;
        metrics.segment = `intro segment running · pause @ frame ${INTRO_END_FRAME}`;
      } else {
        segmentPhase = "main";
        video.currentTime = target / FRAME_RATE;
        metrics.segment = `main segment running · terminal pause @ frame ${LAST_FRAME}`;
      }
    } else {
      video.currentTime = target / FRAME_RATE;
    }
    metrics.state = `playing from scrub frame ${target}`;
    playToggle.classList.remove("visible");
    recordEvent(`scrub released by Play at frame ${target}`);
    playVideo(video, isCurrent);
  };
  const resumeAfterScrubRelease = (frame: number): void => {
    if (!isCurrent()) return;
    const target = normalizeFrame(frame);
    video.loop = !segmentedPlayback;
    if (segmentedPlayback) {
      if (target >= LAST_FRAME) {
        segmentPhase = "terminal";
        metrics.segment = `terminal frame confirmed · pause @ frame ${LAST_FRAME}`;
        return;
      }
      segmentPhase = target < INTRO_END_FRAME ? "intro" : "main";
      metrics.segment = segmentPhase === "intro"
        ? `intro segment running · pause @ frame ${INTRO_END_FRAME}`
        : `main segment running · terminal pause @ frame ${LAST_FRAME}`;
    }
    playVideo(video, isCurrent);
  };
  const stopPresentation = observeNativePresentation(video, isCurrent, binding);
  playToggle.classList.remove("visible");
  applyHandoff();
  if (shouldResumeHandoff) playVideo(video, isCurrent);
  else video.pause();
  return {
    variant: "a",
    pauseForScrub,
    resumeFromScrub,
    resumeAfterScrubRelease,
    togglePlayback: () => {
      if (segmentedPlayback && segmentPhase === "waiting") {
        segmentPhase = "main";
        video.loop = false;
        video.currentTime = INTRO_END_FRAME / FRAME_RATE;
        metrics.segment = `main segment running · terminal pause @ frame ${LAST_FRAME}`;
        playToggle.classList.remove("visible");
        playVideo(video, isCurrent);
      } else if (segmentedPlayback && segmentPhase === "terminal") {
        segmentPhase = "intro";
        video.loop = false;
        video.currentTime = 0;
        metrics.segment = `intro segment running · pause @ frame ${INTRO_END_FRAME}`;
        playToggle.classList.remove("visible");
        playVideo(video, isCurrent);
      } else if (video.paused) {
        playToggle.classList.remove("visible");
        playVideo(video, isCurrent);
      } else {
        video.pause();
        playToggle.textContent = "Play animation";
        playToggle.classList.add("visible");
      }
    },
    seek: (frame) => {
      if (!isCurrent() || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const target = normalizeFrame(frame);
      if (segmentedPlayback) {
        segmentPhase = target < INTRO_END_FRAME ? "intro" : target < LAST_FRAME ? "main" : "terminal";
        metrics.segment = `manual seek · scrub hold frame ${target}`;
      }
      seekStartedAt = currentTime();
      video.currentTime = target / FRAME_RATE;
      recordEvent(`seek requested frame ${target}`);
    },
    destroy: () => {
      stopAlphaProbe();
      removeMediaListeners();
      stopPresentation();
      video.removeEventListener("timeupdate", timeListener);
      video.removeEventListener("seeked", seekListener);
      releaseVideoElement(video);
      playToggle.classList.remove("visible");
    },
  };
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

type PresentationSource = "rvfc" | "timeupdate-estimate" | "raf-estimate" | "seeked-estimate" | "webgl-draw" | "webgl-raf-estimate" | "sequence-draw";

function frameFromVideoTime(video: HTMLVideoElement, mediaTime = video.currentTime): number {
  void video;
  return normalizeFrame(mediaTime * FRAME_RATE);
}

function dispatchMediaReady(binding: PlaybackBinding, video: HTMLVideoElement, isCurrent: () => boolean): void {
  if (!isCurrent() || playbackBinding !== binding) return;
  if (binding.snapshot().eventTape.some((entry) => entry.event === "media-ready")) return;
  binding.dispatch({
    type: "media-ready",
    atMs: playbackTimeMs(),
    durationSeconds: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : FRAME_DURATION_SECONDS,
    currentTimeSeconds: Number.isFinite(video.currentTime) ? video.currentTime : 0,
  });
}

function dispatchPresentedFrame(
  binding: PlaybackBinding,
  isCurrent: () => boolean,
  video: HTMLVideoElement,
  mediaTime: number,
  source: PresentationSource,
): void {
  if (!isCurrent() || playbackBinding !== binding || !Number.isFinite(mediaTime)) return;
  const before = binding.snapshot();
  // A paused frame is useful confirmation only while a scrub seek is pending.
  // This prevents a segment boundary or autoplay rejection from looking like
  // forward progress in the public gauges.
  if (video.paused && !before.seeking) return;
  const frame = frameFromVideoTime(video, mediaTime);
  binding.dispatch({
    type: "media-presented",
    atMs: playbackTimeMs(),
    frame,
    currentTimeSeconds: mediaTime,
    source,
  });
  setCopy(frame);
}

/**
 * Prefer requestVideoFrameCallback, then use RAF plus timeupdate/seeked for
 * browsers without it. The callback reports a presented media frame, not a
 * requested currentTime, which is the distinction Safari needs for scrub
 * recovery.
 */
function observeNativePresentation(
  video: HTMLVideoElement,
  isCurrent: () => boolean,
  binding: PlaybackBinding,
): () => void {
  const frameVideo = video as FrameVideo;
  const hasVideoFrameCallback = typeof frameVideo.requestVideoFrameCallback === "function";
  let stopped = false;
  let rafHandle: number | null = null;
  let videoFrameHandle: number | null = null;
  const emit = (mediaTime = video.currentTime, source: PresentationSource = "timeupdate-estimate"): void => {
    if (!stopped) dispatchPresentedFrame(binding, isCurrent, video, mediaTime, source);
  };
  const scheduleVideoFrame = (): void => {
    if (stopped || !hasVideoFrameCallback) return;
    // Keep exactly one rVFC outstanding. A seek can emit multiple `seeked`
    // notifications while the prior callback is still pending; queuing one
    // per notification would multiply the presentation loop on Safari.
    if (videoFrameHandle !== null) return;
    videoFrameHandle = frameVideo.requestVideoFrameCallback?.((_now, metadata) => {
      videoFrameHandle = null;
      emit(metadata.mediaTime, "rvfc");
      scheduleVideoFrame();
    }) ?? null;
  };
  const onTimeUpdate = (): void => {
    if (!hasVideoFrameCallback) emit(video.currentTime, "timeupdate-estimate");
  };
  const onSeeked = (): void => {
    // With rVFC, `seeked` reports a requested timeline position, not a
    // presented frame. Let only the pending rVFC confirm presentation; use the
    // seeked estimate solely on browsers without rVFC.
    if (hasVideoFrameCallback) scheduleVideoFrame();
    else emit(video.currentTime, "seeked-estimate");
  };
  const tick = (): void => {
    if (stopped) return;
    if (!hasVideoFrameCallback && !video.paused) emit(video.currentTime, "raf-estimate");
    rafHandle = requestAnimationFrame(tick);
  };
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("seeked", onSeeked);
  if (hasVideoFrameCallback) scheduleVideoFrame();
  else rafHandle = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("seeked", onSeeked);
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    if (videoFrameHandle !== null && typeof frameVideo.cancelVideoFrameCallback === "function") {
      frameVideo.cancelVideoFrameCallback(videoFrameHandle);
    }
  };
}

function createPackedWebGl(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  onPresented?: (mediaTime: number, source: PresentationSource) => void,
  onAlphaProbe?: (passed: boolean, reason?: string) => void,
): (() => void) | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;

  const vertexSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = (a_position + 1.0) * 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;
  const fragmentSource = `
    precision mediump float;
    uniform sampler2D u_video;
    varying vec2 v_uv;
    void main() {
      vec2 colorUv = vec2(v_uv.x * 0.5, v_uv.y);
      vec2 matteUv = vec2(0.5 + v_uv.x * 0.5, v_uv.y);
      vec4 color = texture2D(u_video, colorUv);
      float alpha = texture2D(u_video, matteUv).r;
      gl_FragColor = vec4(color.rgb, alpha);
    }
  `;
  const compile = (kind: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(kind);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      recordEvent(`WebGL shader error: ${gl.getShaderInfoLog(shader) ?? "unknown"}`);
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    recordEvent(`WebGL link error: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
    return null;
  }
  const position = gl.getAttribLocation(program, "a_position");
  const sampler = gl.getUniformLocation(program, "u_video");
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  if (position < 0 || !sampler || !buffer || !texture) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // HTML video/image rows are top-to-bottom. Flip once so the quad's bottom
  // edge remains the asset's bottom edge, matching the native and WebP paths.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  // The shader writes straight (not premultiplied) RGB plus the matte alpha.
  // Make the upload mode explicit so an implementation default cannot turn
  // transparent black/white corners into an opaque fringe.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.disable(gl.BLEND);
  gl.useProgram(program);
  gl.enableVertexAttribArray(position);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(sampler, 0);
  gl.clearColor(0, 0, 0, 0);

  let stopped = false;
  let rafHandle: number | null = null;
  let videoFrameHandle: number | null = null;
  let alphaChecked = false;
  const frameVideo = video as FrameVideo;
  const draw = (mediaTime?: number, source: PresentationSource = "webgl-draw"): void => {
    if (stopped || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const width = video.videoWidth || PACKED_WIDTH;
    const height = video.videoHeight || PACKED_HEIGHT;
    canvas.width = width / 2;
    canvas.height = height;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (error) {
      recordEvent(`WebGL upload error: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!alphaChecked && onAlphaProbe) {
      const pixels = new Uint8Array(16);
      const probe = new Uint8Array(4);
      const widthPixels = Math.max(1, canvas.width);
      const heightPixels = Math.max(1, canvas.height);
      const points = [
        [0, 0],
        [widthPixels - 1, 0],
        [0, heightPixels - 1],
        [widthPixels - 1, heightPixels - 1],
      ] as const;
      points.forEach(([x, y], index) => {
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
        pixels.set(probe, index * 4);
      });
      alphaChecked = true;
      if (hasTransparentProbePixel(pixels)) onAlphaProbe(true);
      else onAlphaProbe(false, "B alpha pixel probe failed: matte rendered opaque/black");
    }
    markFirstVisible();
    const time = mediaTime ?? video.currentTime;
    setCopy(time * FRAME_RATE);
    onPresented?.(time, source);
  };
  const schedule = (): void => {
    if (stopped) return;
    if (typeof frameVideo.requestVideoFrameCallback === "function") {
      // Do not fan out callbacks when loadeddata/playing/seek events overlap.
      if (videoFrameHandle !== null) return;
      videoFrameHandle = frameVideo.requestVideoFrameCallback((_now, metadata) => {
        videoFrameHandle = null;
        draw(metadata.mediaTime, "rvfc");
        schedule();
      });
    } else {
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        draw(undefined, "webgl-raf-estimate");
        schedule();
      });
    }
  };
  const onVideoFrame = (): void => {
    draw(undefined, "webgl-draw");
    schedule();
  };
  video.addEventListener("playing", onVideoFrame);
  video.addEventListener("loadeddata", onVideoFrame);
  draw();
  schedule();
  return () => {
    stopped = true;
    video.removeEventListener("playing", onVideoFrame);
    video.removeEventListener("loadeddata", onVideoFrame);
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    if (videoFrameHandle !== null && typeof frameVideo.cancelVideoFrameCallback === "function") frameVideo.cancelVideoFrameCallback(videoFrameHandle);
    gl.deleteTexture(texture);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
  };
}

function setupPackedH264(run: number): Runtime | null {
  const probe = document.createElement("video");
  const h264 = probe.canPlayType('video/mp4; codecs="avc1.64001f"');
  metrics.h264 = h264 || "unsupported";
  recordEvent(`H.264 canPlayType=${metrics.h264}`);
  if (shouldForceFailure("b")) {
    injectFailure("b");
    return null;
  }
  if (!h264) {
    addFallbackReason("B unsupported by H.264 canPlayType");
    return null;
  }

  const video = setupVideoElement(activeQuality === "hq" ? HQ_MP4_SOURCE : MP4_SOURCE);
  video.loop = !segmentedPlayback;
  const canvas = document.createElement("canvas");
  canvas.className = "hero-render hero-render-canvas";
  canvas.setAttribute("aria-hidden", "true");
  mediaStage.append(canvas);
  const isCurrent = () => runId === run && runtime?.variant === "b";
  const binding = playbackBinding ?? createPlaybackBinding("b");
  playbackBinding = binding;
  const handoff = binding.snapshot();
  const handoffFrame = normalizeFrame(modelPlaybackHandoffFrame(handoff));
  const shouldResumeHandoff = shouldAutoplayHandoff(handoff);
  let alphaProbeFailed = false;
  let resumeAfterScrubRelease: (frame: number) => void = () => undefined;
  const stopWebGl = shouldForceFailure("webgl")
    ? null
    : createPackedWebGl(video, canvas, (mediaTime, source) => {
      dispatchPresentedFrame(binding, isCurrent, video, mediaTime, source);
    }, (passed, reason) => {
      if (!isCurrent() || alphaProbeFailed) return;
      alphaProbeFailed = !passed;
      if (passed) {
        metrics.alpha += " · pixel probe passed";
        renderMetrics();
        recordEvent("B alpha pixel probe passed");
      } else {
        metrics.alpha = "failed: packed matte not observable";
        metrics.error = reason ?? "B alpha pixel probe failed";
        addFallbackReason(metrics.error);
        recordEvent(metrics.error);
        fallbackFrom("b", metrics.error);
      }
    });
  if (!stopWebGl) {
    if (shouldForceFailure("webgl")) injectFailure("webgl");
    else addFallbackReason("B unavailable: WebGL context/shader failed");
    releaseVideoElement(video);
    mediaStage.replaceChildren();
    return null;
  }

  metrics.active = "b";
  metrics.alpha = `WebGL samples packed matte → output alpha (${activeQuality})`;
  metrics.state = `loading ${activeQuality === "hq" ? "HQ " : ""}H.264 + WebGL`;
  metrics.transferredBytes = resourceBytes(activeQuality === "hq" ? HQ_MP4_SOURCE : MP4_SOURCE, activeQuality === "hq" ? HQ_MP4_BYTES : MP4_BYTES);
  metrics.resolution = activeQuality === "hq"
    ? `${HQ_WIDTH * 2}×${HQ_HEIGHT} packed → ${HQ_WIDTH}×${HQ_HEIGHT} output`
    : `${PACKED_WIDTH}×${PACKED_HEIGHT} packed → ${SOURCE_WIDTH}×${PACKED_HEIGHT} output`;
  renderMetrics();
  let readyDispatched = false;
  const applyHandoff = (): void => {
    if (!handoff.eventTape.some((entry) => entry.event === "media-ready") || handoffFrame <= 0) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = handoffFrame / FRAME_RATE;
    if (shouldResumeHandoff) playVideo(video, isCurrent);
    else video.pause();
  };
  const onReady = (): void => {
    if (readyDispatched) return;
    readyDispatched = true;
    dispatchMediaReady(binding, video, isCurrent);
    applyHandoff();
  };
  const removeMediaListeners = appendMediaEvents(video, isCurrent, (reason) => {
    if (isCurrent()) {
      addFallbackReason(`B media error: ${reason}`);
      fallbackFrom("b", `B media error: ${reason}`);
    }
  }, {
    onReady,
    onPlaying: () => binding.dispatch({ type: "media-playing", atMs: playbackTimeMs() }),
    onPaused: () => {
      const state = binding.snapshot();
      if (state.reason !== "user-pause" && !state.seeking) {
        binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "media-paused" });
      }
    },
  });
  const contextLostListener = (contextEvent: Event): void => {
    contextEvent.preventDefault();
    if (!isCurrent()) return;
    metrics.state = "WebGL context lost";
    metrics.error = "WebGL context lost";
    recordEvent("WebGL context lost");
    fallbackFrom("b", "B WebGL context lost");
  };
  canvas.addEventListener("webglcontextlost", contextLostListener);
  let segmentPhase: "intro" | "waiting" | "main" | "terminal" | "loop" = !segmentedPlayback
    ? "loop"
    : handoffFrame >= LAST_FRAME
      ? "terminal"
      : handoffFrame >= INTRO_END_FRAME
        ? "main"
        : "intro";
  const timeListener = (): void => {
    if (!isCurrent()) return;
    const frame = video.currentTime * FRAME_RATE;
    binding.dispatch({ type: "media-timeupdate", atMs: playbackTimeMs(), currentTimeSeconds: video.currentTime });
    setCopy(frame);
    if (!segmentedPlayback) return;
    const introTime = INTRO_END_FRAME / FRAME_RATE;
    const terminalTime = LAST_FRAME_PTS_SECONDS;
    if (segmentPhase === "intro" && video.currentTime >= introTime) {
      segmentPhase = "waiting";
      video.pause();
      video.currentTime = introTime;
      binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "segment-pause@31" });
      metrics.segment = `exact pause · frame ${INTRO_END_FRAME} · resume on tap`;
      playToggle.textContent = "Resume main segment";
      playToggle.classList.add("visible");
      recordEvent(`segment pause @ frame ${INTRO_END_FRAME}`);
    } else if (segmentPhase === "main" && video.currentTime >= terminalTime) {
      segmentPhase = "terminal";
      video.pause();
      video.currentTime = terminalTime;
      binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "segment-terminal-pause" });
      metrics.segment = `exact terminal pause · frame ${LAST_FRAME}`;
      playToggle.textContent = "Replay intro segment";
      playToggle.classList.add("visible");
      recordEvent(`terminal pause @ frame ${LAST_FRAME}`);
    }
  };
  video.addEventListener("timeupdate", timeListener);
  let seekStartedAt: number | null = null;
  const seekListener = (): void => {
    if (!isCurrent() || seekStartedAt === null) return;
    metrics.seekMs = currentTime() - seekStartedAt;
    seekStartedAt = null;
    recordEvent(`seek complete (${formatMs(metrics.seekMs)})`);
  };
  video.addEventListener("seeked", seekListener);
  const pauseForScrub = (): void => {
    if (!isCurrent()) return;
    video.pause();
    binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "scrub-pause" });
    metrics.state = `scrub held frame ${Math.round(metrics.frame)}`;
    playToggle.textContent = "Play if seek stalls";
    playToggle.classList.add("visible");
    recordEvent(`scrub paused at frame ${Math.round(metrics.frame)}`);
  };
  const resumeFromScrub = (frame: number): void => {
    if (!isCurrent()) return;
    const target = normalizeFrame(frame);
    video.loop = !segmentedPlayback;
    if (segmentedPlayback) {
      if (target >= LAST_FRAME) {
        segmentPhase = "intro";
        video.currentTime = 0;
        metrics.segment = `intro segment running · scrub released from frame ${target}`;
      } else if (target < INTRO_END_FRAME) {
        segmentPhase = "intro";
        video.currentTime = target / FRAME_RATE;
        metrics.segment = `intro segment running · pause @ frame ${INTRO_END_FRAME}`;
      } else {
        segmentPhase = "main";
        video.currentTime = target / FRAME_RATE;
        metrics.segment = `main segment running · terminal pause @ frame ${LAST_FRAME}`;
      }
    } else {
      video.currentTime = target / FRAME_RATE;
    }
    metrics.state = `playing from scrub frame ${target}`;
    playToggle.classList.remove("visible");
    recordEvent(`scrub released by Play at frame ${target}`);
    playVideo(video, isCurrent);
  };
  resumeAfterScrubRelease = (frame: number): void => {
    if (!isCurrent()) return;
    const target = normalizeFrame(frame);
    video.loop = !segmentedPlayback;
    if (segmentedPlayback) {
      if (target >= LAST_FRAME) {
        segmentPhase = "terminal";
        metrics.segment = `terminal frame confirmed · pause @ frame ${LAST_FRAME}`;
        return;
      }
      segmentPhase = target < INTRO_END_FRAME ? "intro" : "main";
      metrics.segment = segmentPhase === "intro"
        ? `intro segment running · pause @ frame ${INTRO_END_FRAME}`
        : `main segment running · terminal pause @ frame ${LAST_FRAME}`;
    }
    playVideo(video, isCurrent);
  };
  playToggle.classList.remove("visible");
  applyHandoff();
  if (shouldResumeHandoff) playVideo(video, isCurrent);
  else video.pause();
  return {
    variant: "b",
    pauseForScrub,
    resumeFromScrub,
    resumeAfterScrubRelease,
    togglePlayback: () => {
      if (segmentedPlayback && segmentPhase === "waiting") {
        segmentPhase = "main";
        video.loop = false;
        video.currentTime = INTRO_END_FRAME / FRAME_RATE;
        metrics.segment = `main segment running · terminal pause @ frame ${LAST_FRAME}`;
        playToggle.classList.remove("visible");
        playVideo(video, isCurrent);
      } else if (segmentedPlayback && segmentPhase === "terminal") {
        segmentPhase = "intro";
        video.loop = false;
        video.currentTime = 0;
        metrics.segment = `intro segment running · pause @ frame ${INTRO_END_FRAME}`;
        playToggle.classList.remove("visible");
        playVideo(video, isCurrent);
      } else if (video.paused) {
        playToggle.classList.remove("visible");
        playVideo(video, isCurrent);
      } else {
        video.pause();
        playToggle.textContent = "Play animation";
        playToggle.classList.add("visible");
      }
    },
    seek: (frame) => {
      if (!isCurrent() || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const target = normalizeFrame(frame);
      if (segmentedPlayback) {
        segmentPhase = target < INTRO_END_FRAME ? "intro" : target < LAST_FRAME ? "main" : "terminal";
        metrics.segment = `manual seek · scrub hold frame ${target}`;
      }
      seekStartedAt = currentTime();
      video.currentTime = target / FRAME_RATE;
      recordEvent(`seek requested frame ${target}`);
    },
    destroy: () => {
      stopWebGl();
      removeMediaListeners();
      canvas.removeEventListener("webglcontextlost", contextLostListener);
      video.removeEventListener("timeupdate", timeListener);
      video.removeEventListener("seeked", seekListener);
      releaseVideoElement(video);
      playToggle.classList.remove("visible");
    },
  };
}

function frameSource(frame: number): string {
  return `${WEBP_PREFIX}${String(frame).padStart(3, "0")}${WEBP_SUFFIX}`;
}

function setupWebpSequence(run: number): Runtime {
  const canvas = document.createElement("canvas");
  canvas.className = "hero-render hero-render-canvas";
  canvas.width = SOURCE_WIDTH;
  canvas.height = SOURCE_HEIGHT;
  // Keep the sequence canvas clickable for the prototype's direct play/pause
  // acceptance trace; the stage itself remains pointer-transparent.
  canvas.style.pointerEvents = "auto";
  canvas.setAttribute("aria-hidden", "true");
  mediaStage.replaceChildren(canvas);
  const context = canvas.getContext("2d", { alpha: true });
  const binding = playbackBinding ?? createPlaybackBinding("c");
  playbackBinding = binding;
  const handoff = binding.snapshot();
  const handoffFrame = normalizeFrame(modelPlaybackHandoffFrame(handoff));
  const hasReady = handoff.eventTape.some((entry) => entry.event === "media-ready");
  metrics.active = "c";
  metrics.alpha = "source WebP RGBA → 2D canvas alpha (standard fallback)";
  metrics.state = "loading WebP sequence (standard fallback)";
  metrics.durationSeconds = FRAME_DURATION_SECONDS;
  metrics.resolution = `${SOURCE_WIDTH}×${SOURCE_HEIGHT}`;
  metrics.transferredBytes = 0;
  renderMetrics();
  if (!context) {
    metrics.state = "canvas unavailable";
    metrics.error = "2D canvas context unavailable";
    addFallbackReason("C unavailable: 2D canvas context failed");
    renderMetrics();
    return {
      variant: "c",
      pauseForScrub: () => undefined,
      resumeFromScrub: () => undefined,
      resumeAfterScrubRelease: () => undefined,
      togglePlayback: () => undefined,
      seek: () => undefined,
      destroy: () => undefined,
    };
  }

  // During setup `runtime` is assigned only after this function returns. The
  // initial pump must still be allowed to request frame 0; runId protects
  // late callbacks from a renderer that has already been replaced.
  const isCurrent = () => runId === run && (runtime?.variant === "c" || (runtime === null && currentVariant === "c"));
  const images: Array<HTMLImageElement | null> = Array.from({ length: FRAME_COUNT }, () => null);
  const loaded = new Set<number>();
  const failed = new Set<number>();
  const queue: number[] = hasReady && handoffFrame > 0 ? [handoffFrame] : [0];
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    if (!queue.includes(frame)) queue.push(frame);
  }
  const inFlight = new Set<number>();
  let stopped = false;
  let loadPumpHandle: number | null = null;
  let animationHandle: number | null = null;
  let playing = shouldAutoplayHandoff(handoff);
  let segmentPhase: "intro" | "waiting" | "main" | "terminal" | "loop" = !segmentedPlayback
    ? "loop"
    : handoffFrame >= LAST_FRAME
      ? "terminal"
      : handoffFrame >= INTRO_END_FRAME
        ? "main"
        : "intro";
  let startedAt: number | null = null;
  let currentFrame = handoffFrame;
  let pendingSeek: { frame: number; startedAt: number } | null = null;
  let resumeAfterScrubRelease: (frame: number) => void = () => undefined;

  const draw = (frame: number, allowFallback = true): boolean => {
    if (!isCurrent() || stopped) return false;
    const exact = images[frame];
    if (!exact && !allowFallback) return false;
    const fallback = exact ?? images.slice(0, frame + 1).reverse().find((image) => image !== null) ?? images.find((image) => image !== null);
    if (!fallback) return false;
    const width = SOURCE_WIDTH;
    const height = SOURCE_HEIGHT;
    context.clearRect(0, 0, width, height);
    context.drawImage(fallback, 0, 0, width, height);
    markFirstVisible();
    if (exact) currentFrame = frame;
    // Do not let a fallback copy of an as-yet-unloaded frame advance the
    // sequence clock. The first exact drawable frame establishes the clock;
    // on a renderer handoff that exact frame is the handed-off target.
    if (startedAt === null && exact) startedAt = currentTime() - (frame / FRAME_RATE) * 1000;
    const before = binding.snapshot();
    if (exact && (playing || before.seeking)) {
      binding.dispatch({
        type: "media-presented",
        atMs: playbackTimeMs(),
        frame,
        currentTimeSeconds: frame / FRAME_RATE,
        source: "sequence-draw",
      });
    }
    setCopy(frame);
    if (pendingSeek && pendingSeek.frame === frame && exact) {
      metrics.seekMs = currentTime() - pendingSeek.startedAt;
      pendingSeek = null;
      recordEvent(`seek complete (${formatMs(metrics.seekMs)})`);
    }
    return exact !== null;
  };

  const loadOne = (frame: number): void => {
    if (stopped || inFlight.has(frame) || loaded.has(frame) || failed.has(frame)) return;
    inFlight.add(frame);
    const image = new Image();
    image.decoding = "async";
    images[frame] = image;
    image.addEventListener("load", () => {
      inFlight.delete(frame);
      if (!isCurrent()) return;
      loaded.add(frame);
      metrics.loadedFrames = loaded.size;
      // The approximation scales the committed total by completed frame count;
      // it remains useful when browser resource timings report cache hits as 0.
      const sequenceBytes = WEBP_TOTAL_BYTES;
      metrics.transferredBytes = Math.round((loaded.size / FRAME_COUNT) * sequenceBytes);
      if (frame === 0 && !hasReady) {
        markReady();
        binding.dispatch({
          type: "media-ready",
          atMs: playbackTimeMs(),
          durationSeconds: FRAME_DURATION_SECONDS,
          currentTimeSeconds: 0,
        });
        metrics.state = "ready / playing WebP sequence";
        draw(0);
      }
      if (hasReady && frame === handoffFrame && handoffFrame > 0) draw(frame);
      if (pendingSeek?.frame === frame) draw(frame);
      renderMetrics();
      pump();
    });
    image.addEventListener("error", () => {
      inFlight.delete(frame);
      failed.add(frame);
      if (!isCurrent()) return;
      metrics.error = `frame ${frame} failed`;
      recordEvent(`WebP frame ${frame} failed`);
      pump();
    });
    image.src = frameSource(frame);
  };

  const pump = (): void => {
    if (stopped || !isCurrent()) return;
    const concurrency = loaded.size < 1 ? 1 : 5;
    while (inFlight.size < concurrency && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      loadOne(next);
    }
  };

  const tick = (now: number): void => {
    if (stopped || !isCurrent()) return;
    if (playing) {
      if (startedAt === null) {
        animationHandle = requestAnimationFrame(tick);
        return;
      }
      const elapsed = (now - startedAt) / 1000;
      const desiredFrame = segmentedPlayback
        ? Math.min(LAST_FRAME, Math.floor(elapsed * FRAME_RATE))
        : Math.floor((elapsed % FRAME_DURATION_SECONDS) * FRAME_RATE);
      let frame = currentFrame;
      if (desiredFrame !== currentFrame) {
        const next = nextExactSequenceFrame(currentFrame, desiredFrame, loaded, FRAME_COUNT, !segmentedPlayback);
        if (next === null) {
          // Hold the logical clock at the last exact frame until the next
          // contiguous image is decoded. A fallback copy may be visible, but
          // it must never make the sequence claim progress it cannot draw.
          const nextCandidate = currentFrame < LAST_FRAME ? currentFrame + 1 : (segmentedPlayback ? null : 0);
          if (nextCandidate !== null) loadOne(nextCandidate);
          startedAt = now - (currentFrame / FRAME_RATE) * 1000;
        } else {
          draw(next, false);
          frame = next;
        }
      }
      if (segmentedPlayback && segmentPhase === "intro" && frame >= INTRO_END_FRAME) {
        draw(INTRO_END_FRAME, false);
        playing = false;
        segmentPhase = "waiting";
        metrics.segment = `exact pause · frame ${INTRO_END_FRAME} · resume on tap`;
        binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "segment-pause@31" });
        playToggle.textContent = "Resume main segment";
        playToggle.classList.add("visible");
        recordEvent(`segment pause @ frame ${INTRO_END_FRAME}`);
      } else if (segmentedPlayback && segmentPhase === "main" && frame >= LAST_FRAME) {
        draw(LAST_FRAME, false);
        playing = false;
        segmentPhase = "terminal";
        metrics.segment = `exact terminal pause · frame ${LAST_FRAME}`;
        binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "segment-terminal-pause" });
        playToggle.textContent = "Replay intro segment";
        playToggle.classList.add("visible");
        recordEvent(`terminal pause @ frame ${LAST_FRAME}`);
      }
    }
    animationHandle = requestAnimationFrame(tick);
  };
  const startAnimation = (): void => {
    if (animationHandle === null) animationHandle = requestAnimationFrame(tick);
  };
  const startClockFromFrame = (frame: number): void => {
    if (loaded.has(frame)) startedAt = currentTime() - (frame / FRAME_RATE) * 1000;
    else {
      startedAt = null;
      loadOne(frame);
    }
  };
  const togglePlayback = (): void => {
    if (segmentedPlayback && segmentPhase === "waiting") {
      segmentPhase = "main";
      playing = true;
      startClockFromFrame(INTRO_END_FRAME);
      metrics.segment = `main segment running · terminal pause @ frame ${LAST_FRAME}`;
      playToggle.classList.remove("visible");
      binding.dispatch({ type: "media-playing", atMs: playbackTimeMs() });
      recordEvent("WebP resumed main segment");
      startAnimation();
      return;
    }
    if (segmentedPlayback && segmentPhase === "terminal") {
      segmentPhase = "intro";
      playing = true;
      currentFrame = 0;
      startClockFromFrame(0);
      metrics.segment = `intro segment running · pause @ frame ${INTRO_END_FRAME}`;
      playToggle.classList.remove("visible");
      binding.dispatch({ type: "media-playing", atMs: playbackTimeMs() });
      recordEvent("WebP replayed intro segment");
      startAnimation();
      return;
    }
    playing = !playing;
    if (playing) {
      startClockFromFrame(currentFrame);
      metrics.state = "playing WebP";
      playToggle.classList.remove("visible");
      binding.dispatch({ type: "media-playing", atMs: playbackTimeMs() });
      startAnimation();
    } else {
      metrics.state = "paused WebP";
      playToggle.classList.add("visible");
    }
    recordEvent(playing ? "WebP play" : "WebP pause");
  };
  const pauseForScrub = (): void => {
    if (!isCurrent()) return;
    playing = false;
    binding.dispatch({ type: "media-paused", atMs: playbackTimeMs(), reason: "scrub-pause" });
    metrics.state = `scrub held frame ${Math.round(metrics.frame)}`;
    playToggle.textContent = "Play if seek stalls";
    playToggle.classList.add("visible");
    recordEvent(`scrub paused at frame ${Math.round(metrics.frame)}`);
  };
  const resumeFromScrub = (frame: number): void => {
    if (!isCurrent()) return;
    const target = normalizeFrame(frame);
    if (segmentedPlayback) {
      if (target >= LAST_FRAME) {
        segmentPhase = "intro";
        currentFrame = 0;
        startClockFromFrame(0);
      } else if (target < INTRO_END_FRAME) {
        segmentPhase = "intro";
        currentFrame = target;
        startClockFromFrame(target);
      } else {
        segmentPhase = "main";
        currentFrame = target;
        startClockFromFrame(target);
      }
    } else {
      currentFrame = target;
      startClockFromFrame(target);
    }
    playing = true;
    metrics.state = `playing from scrub frame ${target}`;
    playToggle.classList.remove("visible");
    recordEvent(`scrub released by Play at frame ${target}`);
    binding.dispatch({ type: "media-playing", atMs: playbackTimeMs() });
    startAnimation();
  };
  resumeAfterScrubRelease = (frame: number): void => {
    if (!isCurrent()) return;
    const target = normalizeFrame(frame);
    if (segmentedPlayback) {
      if (target >= LAST_FRAME) {
        segmentPhase = "terminal";
        playing = false;
        metrics.segment = `terminal frame confirmed · pause @ frame ${LAST_FRAME}`;
        return;
      }
      segmentPhase = target < INTRO_END_FRAME ? "intro" : "main";
      metrics.segment = segmentPhase === "intro"
        ? `intro segment running · pause @ frame ${INTRO_END_FRAME}`
        : `main segment running · terminal pause @ frame ${LAST_FRAME}`;
    }
    currentFrame = target;
    startClockFromFrame(target);
    playing = true;
    binding.dispatch({ type: "media-playing", atMs: playbackTimeMs() });
    startAnimation();
  };
  const seek = (frame: number): void => {
    const target = Math.max(0, Math.min(LAST_FRAME, Math.round(frame)));
    if (segmentedPlayback) {
      segmentPhase = target <= INTRO_END_FRAME ? "waiting" : "main";
      metrics.segment = `manual seek · segment pause contract bypassed at frame ${target}`;
      playing = false;
      playToggle.textContent = "Resume / replay";
      playToggle.classList.add("visible");
    }
    pendingSeek = { frame: target, startedAt: currentTime() };
    startedAt = null;
    loadOne(target);
    draw(target);
    recordEvent(`seek requested frame ${target}`);
  };
  const clickListener = (): void => {
    const playback = binding.snapshot();
    binding.dispatch({
      type: playback.actualPlayback === "playing" ? "user-pause" : "user-play",
      atMs: playbackTimeMs(),
    });
    togglePlayback();
  };
  canvas.addEventListener("click", clickListener);
  playToggle.classList.remove("visible");
  playToggle.textContent = "Pause animation";
  pump();
  startAnimation();
  return {
    variant: "c",
    pauseForScrub,
    resumeFromScrub,
    resumeAfterScrubRelease,
    togglePlayback,
    seek,
    destroy: () => {
      stopped = true;
      canvas.removeEventListener("click", clickListener);
      if (animationHandle !== null) cancelAnimationFrame(animationHandle);
      if (loadPumpHandle !== null) cancelAnimationFrame(loadPumpHandle);
      images.forEach((image) => image?.removeAttribute("src"));
      playToggle.classList.remove("visible");
    },
  };
}

function nextFallback(variant: Variant): Variant | null {
  if (variant === "a") return "b";
  if (variant === "b") return "c";
  return null;
}

function fallbackFrom(variant: Variant, reason: string): void {
  const next = nextFallback(variant);
  addFallbackReason(reason);
  if (!next) {
    metrics.state = "fallback exhausted";
    renderMetrics();
    return;
  }
  recordEvent(`${definition(variant).shortLabel} → ${definition(next).shortLabel} fallback`);
  playbackBinding?.dispatch({
    type: "renderer-fallback",
    atMs: playbackTimeMs(),
    from: variant,
    to: next,
  });
  startRenderer(next, true);
}

function startRenderer(variant: Variant, preservePlayback = false): void {
  runId += 1;
  const run = runId;
  currentVariant = variant;
  if (!preservePlayback || playbackBinding === null) playbackBinding = createPlaybackBinding(variant);
  runtime?.destroy();
  runtime = null;
  mediaStage.replaceChildren();
  playToggle.classList.remove("visible");
  metrics.active = variant;
  renderMetrics();

  let next: Runtime | null = null;
  if (variant === "a") next = setupNativeVp9(run);
  if (variant === "b") next = setupPackedH264(run);
  if (next) {
    runtime = next;
    recordEvent(`active ${definition(variant).label}`);
    return;
  }
  const fallback = nextFallback(variant);
  if (fallback) {
    // Keep one frame of the reason in the diagnostic log, then let the next
    // renderer own the stage and all later events.
    playbackBinding?.dispatch({
      type: "renderer-fallback",
      atMs: playbackTimeMs(),
      from: variant,
      to: fallback,
    });
    startRenderer(fallback, true);
    return;
  }
  runtime = setupWebpSequence(run);
  recordEvent(`active ${definition(variant).label}`);
}

function resetForRequestedVariant(variant: Variant): void {
  requestedVariant = variant;
  metrics = createMetrics(variant);
  metrics.requested = variant;
  scrubHeldFrame = null;
  scrubPointerActive = false;
  scrubCompletedFrameAwaitingChange = null;
  scrubResumeIssued = false;
  const probe = document.createElement("video");
  metrics.vp9 = probe.canPlayType('video/webm; codecs="vp09.00.10.08"') || "unsupported";
  metrics.h264 = probe.canPlayType('video/mp4; codecs="avc1.64001f"') || "unsupported";
  scrub.value = "0";
  roleCopy.style.opacity = "0";
  experienceCopy.style.opacity = "0";
  renderMetrics();
  startRenderer(variant);
}

function updateUrl(variant: Variant): void {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", variant);
  window.history.replaceState({}, "", url);
}

function selectVariant(variant: Variant): void {
  updateUrl(variant);
  resetForRequestedVariant(variant);
  updateSwitcher();
  recordEvent(`selected ${definition(variant).label}`);
}

function updateSwitcher(): void {
  switcher.replaceChildren();
  const previous = document.createElement("button");
  previous.className = "switcher-arrow";
  previous.type = "button";
  previous.setAttribute("aria-label", "Previous renderer");
  previous.textContent = "←";
  previous.addEventListener("click", () => {
    const index = VARIANTS.findIndex((item) => item.key === requestedVariant);
    const item = VARIANTS[(index - 1 + VARIANTS.length) % VARIANTS.length];
    selectVariant(item.key);
  });
  switcher.append(previous);
  for (const item of VARIANTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.shortLabel;
    button.className = item.key === requestedVariant ? "selected" : "";
    button.setAttribute("aria-label", `${item.shortLabel}: ${item.label}`);
    button.setAttribute("aria-pressed", String(item.key === requestedVariant));
    button.addEventListener("click", () => selectVariant(item.key));
    switcher.append(button);
  }
  const label = document.createElement("span");
  label.className = "switcher-label";
  label.textContent = `${definition(requestedVariant).shortLabel} · ${definition(requestedVariant).label}`;
  switcher.append(label);
  const next = document.createElement("button");
  next.className = "switcher-arrow";
  next.type = "button";
  next.setAttribute("aria-label", "Next renderer");
  next.textContent = "→";
  next.addEventListener("click", () => {
    const index = VARIANTS.findIndex((item) => item.key === requestedVariant);
    const item = VARIANTS[(index + 1) % VARIANTS.length];
    selectVariant(item.key);
  });
  switcher.append(next);
}

function beginScrub(frame: number): void {
  const target = normalizeFrame(frame);
  scrubCompletedFrameAwaitingChange = null;
  scrubResumeIssued = false;
  // Every new input gesture must stop an already-running renderer. Keeping
  // this unconditional is important for C: after a prior release its clock
  // is running even though the model still retains the held target.
  runtime?.pauseForScrub();
  recordEvent(`scrub started at frame ${target}`);
  playbackBinding?.dispatch({ type: "scrub-input", atMs: playbackTimeMs(), frame: target });
  setScrubHold(target, "seeking");
  metrics.state = `scrubbing frame ${target}`;
  runtime?.seek(target);
  recordEvent(`scrub input captured frame ${target}`);
}

function scrubInputFrame(event: Event): number | null {
  const input = event.currentTarget as HTMLInputElement | null;
  const value = Number(input?.value);
  return Number.isFinite(value) ? normalizeFrame(value) : null;
}

function requestScrubResume(
  eventType: "scrub-pointerup" | "scrub-change",
  capturedFrame: number | null,
): void {
  const target = scrubHeldFrame;
  if (target === null) {
    if (scrubCompletedFrameAwaitingChange !== null) {
      playbackBinding?.dispatch({ type: eventType, atMs: playbackTimeMs(), frame: capturedFrame ?? undefined });
      scrubCompletedFrameAwaitingChange = null;
    }
    return;
  }
  scrubCompletedFrameAwaitingChange = target;
  playbackBinding?.dispatch({ type: eventType, atMs: playbackTimeMs(), frame: capturedFrame ?? undefined });
  scrubPointerActive = false;
  scrub.value = String(target);
  metrics.scrubState = "resume requested · target presentation observational";
  metrics.state = `resume requested from scrub frame ${target}`;
  // Pointerup and change can both arrive for one gesture. Only the first
  // release calls the renderer; the second lifecycle event is an acknowledgement.
  if (!scrubResumeIssued) {
    scrubResumeIssued = true;
    runtime?.resumeAfterScrubRelease(target);
  }
  renderMetrics();
  recordEvent(`scrub ${eventType.replace("scrub-", "")} requested resume at frame ${target}`);
}

playToggle.addEventListener("click", () => {
  if (scrubHeldFrame !== null && runtime) {
    const heldFrame = scrubHeldFrame;
    scrubPointerActive = false;
    scrubResumeIssued = false;
    playbackBinding?.dispatch({ type: "user-play", atMs: playbackTimeMs() });
    setScrubHold(null, "idle");
    runtime.resumeFromScrub(heldFrame);
    return;
  }
  const playback = playbackBinding?.snapshot();
  if (playback?.actualPlayback === "playing") {
    playbackBinding?.dispatch({ type: "user-pause", atMs: playbackTimeMs() });
  } else {
    playbackBinding?.dispatch({ type: "user-play", atMs: playbackTimeMs() });
  }
  runtime?.togglePlayback();
});
scrub.addEventListener("pointerdown", () => {
  scrubPointerActive = true;
});
scrub.addEventListener("pointerup", (scrubEvent) => {
  scrubPointerActive = false;
  requestScrubResume("scrub-pointerup", scrubInputFrame(scrubEvent));
});
scrub.addEventListener("pointercancel", (scrubEvent) => {
  scrubPointerActive = false;
  requestScrubResume("scrub-pointerup", scrubInputFrame(scrubEvent));
});
scrub.addEventListener("change", (scrubEvent) => {
  const capturedFrame = scrubInputFrame(scrubEvent);
  if (scrubHeldFrame === null && scrubCompletedFrameAwaitingChange !== null) {
    const completedFrame = scrubCompletedFrameAwaitingChange;
    scrubCompletedFrameAwaitingChange = null;
    scrub.value = String(completedFrame);
    playbackBinding?.dispatch({ type: "scrub-change", atMs: playbackTimeMs(), frame: capturedFrame ?? undefined });
    renderMetrics();
    recordEvent(`scrub change acknowledged after release at frame ${completedFrame}`);
    return;
  }
  const target = scrubHeldFrame ?? capturedFrame;
  if (target === null) return;
  if (scrubHeldFrame === null) beginScrub(target);
  requestScrubResume("scrub-change", capturedFrame);
});
scrub.addEventListener("input", (scrubEvent) => {
  const capturedFrame = scrubInputFrame(scrubEvent);
  if (capturedFrame === null) return;
  scrubPointerActive = true;
  beginScrub(capturedFrame);
});
window.addEventListener("keydown", (keyboardEvent) => {
  const target = keyboardEvent.target as HTMLElement | null;
  if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
  if (keyboardEvent.key !== "ArrowLeft" && keyboardEvent.key !== "ArrowRight") return;
  keyboardEvent.preventDefault();
  const index = VARIANTS.findIndex((item) => item.key === requestedVariant);
  const delta = keyboardEvent.key === "ArrowLeft" ? -1 : 1;
  selectVariant(VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length].key);
});

requestedVariant = parseVariant(new URLSearchParams(window.location.search).get("variant"));
currentVariant = requestedVariant;
updateSwitcher();
resetForRequestedVariant(requestedVariant);

// Keep the browser's normal page lifecycle visible in the log. A cached page
// can make later runs appear instant, which is precisely why the metric names
// and cache caveat remain on-screen.
window.addEventListener("pageshow", (pageshowEvent) => {
  recordEvent(`pageshow persisted=${pageshowEvent.persisted}`);
});

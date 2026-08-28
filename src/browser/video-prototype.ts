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

type Variant = "a" | "b" | "c";

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
const INTRO_END_FRAME = 31;
const LAST_FRAME = FRAME_COUNT - 1;
const WEBP_TOTAL_BYTES = 4_578_812;
const WEBM_BYTES = 2_011_506;
const MP4_BYTES = 1_706_162;
const SOURCE_WIDTH = 900;
const SOURCE_HEIGHT = 507;
const PACKED_WIDTH = 1800;
const PACKED_HEIGHT = 508;
const WEBP_PREFIX = "/Кадры/frame_";
const WEBP_SUFFIX = "_delay-0.067s.webp";
const WEBM_SOURCE = "/video-prototype/hero-alpha-vp9.webm";
const MP4_SOURCE = "/video-prototype/hero-color-matte.mp4";
const prototypeParams = new URLSearchParams(window.location.search);
const segmentedPlayback = prototypeParams.get("mode") !== "loop";

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
};

type Runtime = {
  variant: Variant;
  destroy: () => void;
  togglePlayback: () => void;
  pauseForScrub: () => void;
  resumeFromScrub: (frame: number) => void;
  seek: (frame: number) => void;
};

const bootStartedAt = performance.now();
let metrics: Metrics = createMetrics("a");
let runtime: Runtime | null = null;
let runId = 0;
let currentVariant: Variant = "a";
let requestedVariant: Variant = "a";
let scrubHeldFrame: number | null = null;
let scrubPointerActive = false;

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

function markScrubSeekComplete(): void {
  if (scrubHeldFrame === null) return;
  metrics.scrubState = "held · seek complete";
  renderMetrics();
}

function currentTime(): number {
  return performance.now();
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
  writeMetric(
    metricElements.scrub,
    metrics.scrubHeldFrame === null ? "none" : `frame ${metrics.scrubHeldFrame} · ${metrics.scrubState}`,
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
  if (scrubHeldFrame === null && !scrubPointerActive) scrub.value = String(Math.round(metrics.frame));
  renderMetrics();
}

function appendMediaEvents(video: HTMLVideoElement, isCurrent: () => boolean, onError: (reason: string) => void): () => void {
  const eventNames = ["loadstart", "loadedmetadata", "loadeddata", "canplay", "playing", "pause", "waiting", "stalled", "suspend", "emptied", "abort"] as const;
  const listeners = new Map<string, EventListener>();
  for (const name of eventNames) {
    const listener: EventListener = () => {
      if (!isCurrent()) return;
      metrics.state = name;
      if (name === "loadedmetadata" || name === "loadeddata" || name === "canplay") updateMediaMetrics(video, "video metadata pending");
      if (name === "canplay") markReady();
      if (name === "loadeddata" || name === "playing") markFirstVisible();
      if (name === "playing") playToggle.classList.remove("visible");
      if (name === "pause" || name === "waiting") playToggle.classList.add("visible");
      if (name === "pause" && scrubHeldFrame !== null) metrics.state = `scrub held frame ${scrubHeldFrame}`;
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
  video.src = source;
  mediaStage.replaceChildren(video);
  return video;
}

function playVideo(video: HTMLVideoElement, isCurrent: () => boolean): void {
  void video.play().catch(() => {
    if (!isCurrent()) return;
    metrics.state = "autoplay blocked";
    addFallbackReason("autoplay blocked — tap Play");
    playToggle.classList.add("visible");
    recordEvent("play() rejected; waiting for user gesture");
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

  const video = setupVideoElement(WEBM_SOURCE);
  video.classList.remove("hero-render-source");
  video.loop = !segmentedPlayback;
  metrics.active = "a";
  metrics.alpha = "encoded VP9 alpha (alpha_mode=1; browser render unverified)";
  metrics.state = "loading WebM";
  metrics.transferredBytes = resourceBytes(WEBM_SOURCE, WEBM_BYTES);
  renderMetrics();
  const isCurrent = () => runId === run && runtime?.variant === "a";
  const removeMediaListeners = appendMediaEvents(video, isCurrent, (reason) => {
    if (isCurrent()) {
      addFallbackReason(`A media error: ${reason}`);
      fallbackFrom("a", `A media error: ${reason}`);
    }
  });
  let segmentPhase: "intro" | "waiting" | "main" | "terminal" | "loop" = segmentedPlayback ? "intro" : "loop";
  const timeListener = (): void => {
    if (!isCurrent()) return;
    const duration = Math.max(video.duration || FRAME_DURATION_SECONDS, 0.001);
    const frame = (video.currentTime / duration) * LAST_FRAME;
    setCopy(frame);
    if (!segmentedPlayback) return;
    const introTime = (INTRO_END_FRAME / LAST_FRAME) * duration;
    const terminalTime = Math.max(0, duration - 1 / FRAME_RATE);
    if (segmentPhase === "intro" && video.currentTime >= introTime) {
      segmentPhase = "waiting";
      video.pause();
      video.currentTime = introTime;
      metrics.segment = `exact pause · frame ${INTRO_END_FRAME} · resume on tap`;
      playToggle.textContent = "Resume main segment";
      playToggle.classList.add("visible");
      recordEvent(`segment pause @ frame ${INTRO_END_FRAME}`);
    } else if (segmentPhase === "main" && video.currentTime >= terminalTime) {
      segmentPhase = "terminal";
      video.pause();
      video.currentTime = terminalTime;
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
    markScrubSeekComplete();
    recordEvent(`seek complete (${formatMs(metrics.seekMs)})`);
  };
  video.addEventListener("seeked", seekListener);
  let seekStartedAt: number | null = null;
  const pauseForScrub = (): void => {
    if (!isCurrent()) return;
    video.pause();
    metrics.state = `scrub held frame ${Math.round(metrics.frame)}`;
    playToggle.textContent = "Play from held frame";
    playToggle.classList.add("visible");
    recordEvent(`scrub paused at frame ${Math.round(metrics.frame)}`);
  };
  const resumeFromScrub = (frame: number): void => {
    if (!isCurrent()) return;
    const target = normalizeFrame(frame);
    const duration = Math.max(video.duration || FRAME_DURATION_SECONDS, 0.001);
    video.loop = !segmentedPlayback;
    if (segmentedPlayback) {
      if (target >= LAST_FRAME) {
        segmentPhase = "intro";
        video.currentTime = 0;
        metrics.segment = `intro segment running · scrub released from frame ${target}`;
      } else if (target < INTRO_END_FRAME) {
        segmentPhase = "intro";
        video.currentTime = (target / LAST_FRAME) * duration;
        metrics.segment = `intro segment running · pause @ frame ${INTRO_END_FRAME}`;
      } else {
        segmentPhase = "main";
        video.currentTime = (target / LAST_FRAME) * duration;
        metrics.segment = `main segment running · terminal pause @ frame ${LAST_FRAME}`;
      }
    } else {
      video.currentTime = (target / LAST_FRAME) * duration;
    }
    metrics.state = `playing from scrub frame ${target}`;
    playToggle.classList.remove("visible");
    recordEvent(`scrub released by Play at frame ${target}`);
    playVideo(video, isCurrent);
  };
  playToggle.classList.remove("visible");
  playVideo(video, isCurrent);
  return {
    variant: "a",
    pauseForScrub,
    resumeFromScrub,
    togglePlayback: () => {
      if (segmentedPlayback && segmentPhase === "waiting") {
        segmentPhase = "main";
        video.loop = false;
        const duration = Math.max(video.duration || FRAME_DURATION_SECONDS, 0.001);
        video.currentTime = (INTRO_END_FRAME / LAST_FRAME) * duration;
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
      video.currentTime = (target / LAST_FRAME) * video.duration;
      recordEvent(`seek requested frame ${target}`);
    },
    destroy: () => {
      removeMediaListeners();
      video.removeEventListener("timeupdate", timeListener);
      video.removeEventListener("seeked", seekListener);
      video.pause();
      video.removeAttribute("src");
      video.load();
      playToggle.classList.remove("visible");
    },
  };
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function createPackedWebGl(video: HTMLVideoElement, canvas: HTMLCanvasElement): (() => void) | null {
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
  gl.useProgram(program);
  gl.enableVertexAttribArray(position);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(sampler, 0);
  gl.clearColor(0, 0, 0, 0);

  let stopped = false;
  let rafHandle: number | null = null;
  let videoFrameHandle: number | null = null;
  const frameVideo = video as FrameVideo;
  const draw = (mediaTime?: number): void => {
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
    markFirstVisible();
    const time = mediaTime ?? video.currentTime;
    setCopy((time / Math.max(video.duration || FRAME_DURATION_SECONDS, 0.001)) * LAST_FRAME);
  };
  const schedule = (): void => {
    if (stopped) return;
    if (typeof frameVideo.requestVideoFrameCallback === "function") {
      videoFrameHandle = frameVideo.requestVideoFrameCallback((_now, metadata) => {
        videoFrameHandle = null;
        draw(metadata.mediaTime);
        schedule();
      });
    } else {
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        draw();
        schedule();
      });
    }
  };
  const onVideoFrame = (): void => {
    draw();
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

  const video = setupVideoElement(MP4_SOURCE);
  video.loop = !segmentedPlayback;
  const canvas = document.createElement("canvas");
  canvas.className = "hero-render hero-render-canvas";
  canvas.setAttribute("aria-hidden", "true");
  mediaStage.append(canvas);
  const stopWebGl = shouldForceFailure("webgl") ? null : createPackedWebGl(video, canvas);
  if (!stopWebGl) {
    if (shouldForceFailure("webgl")) injectFailure("webgl");
    else addFallbackReason("B unavailable: WebGL context/shader failed");
    video.pause();
    video.removeAttribute("src");
    video.load();
    mediaStage.replaceChildren();
    return null;
  }

  metrics.active = "b";
  metrics.alpha = "WebGL samples packed matte → output alpha";
  metrics.state = "loading H.264 + WebGL";
  metrics.transferredBytes = resourceBytes(MP4_SOURCE, MP4_BYTES);
  metrics.resolution = `${PACKED_WIDTH}×${PACKED_HEIGHT} packed → ${SOURCE_WIDTH}×${PACKED_HEIGHT} output`;
  renderMetrics();
  const isCurrent = () => runId === run && runtime?.variant === "b";
  const removeMediaListeners = appendMediaEvents(video, isCurrent, (reason) => {
    if (isCurrent()) {
      addFallbackReason(`B media error: ${reason}`);
      fallbackFrom("b", `B media error: ${reason}`);
    }
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
  let segmentPhase: "intro" | "waiting" | "main" | "terminal" | "loop" = segmentedPlayback ? "intro" : "loop";
  const timeListener = (): void => {
    if (!isCurrent()) return;
    const duration = Math.max(video.duration || FRAME_DURATION_SECONDS, 0.001);
    const frame = (video.currentTime / duration) * LAST_FRAME;
    setCopy(frame);
    if (!segmentedPlayback) return;
    const introTime = (INTRO_END_FRAME / LAST_FRAME) * duration;
    const terminalTime = Math.max(0, duration - 1 / FRAME_RATE);
    if (segmentPhase === "intro" && video.currentTime >= introTime) {
      segmentPhase = "waiting";
      video.pause();
      video.currentTime = introTime;
      metrics.segment = `exact pause · frame ${INTRO_END_FRAME} · resume on tap`;
      playToggle.textContent = "Resume main segment";
      playToggle.classList.add("visible");
      recordEvent(`segment pause @ frame ${INTRO_END_FRAME}`);
    } else if (segmentPhase === "main" && video.currentTime >= terminalTime) {
      segmentPhase = "terminal";
      video.pause();
      video.currentTime = terminalTime;
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
    markScrubSeekComplete();
    recordEvent(`seek complete (${formatMs(metrics.seekMs)})`);
  };
  video.addEventListener("seeked", seekListener);
  const pauseForScrub = (): void => {
    if (!isCurrent()) return;
    video.pause();
    metrics.state = `scrub held frame ${Math.round(metrics.frame)}`;
    playToggle.textContent = "Play from held frame";
    playToggle.classList.add("visible");
    recordEvent(`scrub paused at frame ${Math.round(metrics.frame)}`);
  };
  const resumeFromScrub = (frame: number): void => {
    if (!isCurrent()) return;
    const target = normalizeFrame(frame);
    const duration = Math.max(video.duration || FRAME_DURATION_SECONDS, 0.001);
    video.loop = !segmentedPlayback;
    if (segmentedPlayback) {
      if (target >= LAST_FRAME) {
        segmentPhase = "intro";
        video.currentTime = 0;
        metrics.segment = `intro segment running · scrub released from frame ${target}`;
      } else if (target < INTRO_END_FRAME) {
        segmentPhase = "intro";
        video.currentTime = (target / LAST_FRAME) * duration;
        metrics.segment = `intro segment running · pause @ frame ${INTRO_END_FRAME}`;
      } else {
        segmentPhase = "main";
        video.currentTime = (target / LAST_FRAME) * duration;
        metrics.segment = `main segment running · terminal pause @ frame ${LAST_FRAME}`;
      }
    } else {
      video.currentTime = (target / LAST_FRAME) * duration;
    }
    metrics.state = `playing from scrub frame ${target}`;
    playToggle.classList.remove("visible");
    recordEvent(`scrub released by Play at frame ${target}`);
    playVideo(video, isCurrent);
  };
  playToggle.classList.remove("visible");
  playVideo(video, isCurrent);
  return {
    variant: "b",
    pauseForScrub,
    resumeFromScrub,
    togglePlayback: () => {
      if (segmentedPlayback && segmentPhase === "waiting") {
        segmentPhase = "main";
        video.loop = false;
        const duration = Math.max(video.duration || FRAME_DURATION_SECONDS, 0.001);
        video.currentTime = (INTRO_END_FRAME / LAST_FRAME) * duration;
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
      video.currentTime = (target / LAST_FRAME) * video.duration;
      recordEvent(`seek requested frame ${target}`);
    },
    destroy: () => {
      stopWebGl();
      removeMediaListeners();
      canvas.removeEventListener("webglcontextlost", contextLostListener);
      video.removeEventListener("timeupdate", timeListener);
      video.removeEventListener("seeked", seekListener);
      video.pause();
      video.removeAttribute("src");
      video.load();
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
  canvas.setAttribute("aria-hidden", "true");
  mediaStage.replaceChildren(canvas);
  const context = canvas.getContext("2d", { alpha: true });
  metrics.active = "c";
  metrics.alpha = "source WebP RGBA → 2D canvas alpha";
  metrics.state = "loading WebP sequence";
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
      togglePlayback: () => undefined,
      seek: () => undefined,
      destroy: () => undefined,
    };
  }

  const isCurrent = () => runId === run && runtime?.variant === "c";
  const images: Array<HTMLImageElement | null> = Array.from({ length: FRAME_COUNT }, () => null);
  const loaded = new Set<number>();
  const failed = new Set<number>();
  const queue: number[] = [0];
  for (let frame = 1; frame < FRAME_COUNT; frame += 1) queue.push(frame);
  const inFlight = new Set<number>();
  let stopped = false;
  let loadPumpHandle: number | null = null;
  let animationHandle: number | null = null;
  let playing = true;
  let segmentPhase: "intro" | "waiting" | "main" | "terminal" | "loop" = segmentedPlayback ? "intro" : "loop";
  let startedAt = currentTime();
  let currentFrame = 0;
  let pendingSeek: { frame: number; startedAt: number } | null = null;

  const draw = (frame: number): void => {
    if (!isCurrent() || stopped) return;
    const exact = images[frame];
    const fallback = exact ?? images.slice(0, frame + 1).reverse().find((image) => image !== null) ?? images.find((image) => image !== null);
    if (!fallback) return;
    context.clearRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
    context.drawImage(fallback, 0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
    markFirstVisible();
    currentFrame = frame;
    setCopy(frame);
    if (pendingSeek && pendingSeek.frame === frame && exact) {
      metrics.seekMs = currentTime() - pendingSeek.startedAt;
      pendingSeek = null;
      markScrubSeekComplete();
      recordEvent(`seek complete (${formatMs(metrics.seekMs)})`);
    }
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
      metrics.transferredBytes = Math.round((loaded.size / FRAME_COUNT) * WEBP_TOTAL_BYTES);
      if (frame === 0) {
        markReady();
        metrics.state = "ready / playing WebP";
        draw(0);
      }
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
      const elapsed = (now - startedAt) / 1000;
      const frame = segmentedPlayback
        ? Math.min(LAST_FRAME, Math.floor(elapsed * FRAME_RATE))
        : Math.floor((elapsed % FRAME_DURATION_SECONDS) * FRAME_RATE);
      if (frame !== currentFrame) draw(frame);
      if (segmentedPlayback && segmentPhase === "intro" && frame >= INTRO_END_FRAME) {
        draw(INTRO_END_FRAME);
        playing = false;
        segmentPhase = "waiting";
        metrics.segment = `exact pause · frame ${INTRO_END_FRAME} · resume on tap`;
        playToggle.textContent = "Resume main segment";
        playToggle.classList.add("visible");
        recordEvent(`segment pause @ frame ${INTRO_END_FRAME}`);
      } else if (segmentedPlayback && segmentPhase === "main" && frame >= LAST_FRAME) {
        draw(LAST_FRAME);
        playing = false;
        segmentPhase = "terminal";
        metrics.segment = `exact terminal pause · frame ${LAST_FRAME}`;
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
  const togglePlayback = (): void => {
    if (segmentedPlayback && segmentPhase === "waiting") {
      segmentPhase = "main";
      playing = true;
      startedAt = currentTime() - (INTRO_END_FRAME / FRAME_RATE) * 1000;
      metrics.segment = `main segment running · terminal pause @ frame ${LAST_FRAME}`;
      playToggle.classList.remove("visible");
      recordEvent("WebP resumed main segment");
      startAnimation();
      return;
    }
    if (segmentedPlayback && segmentPhase === "terminal") {
      segmentPhase = "intro";
      playing = true;
      currentFrame = 0;
      startedAt = currentTime();
      metrics.segment = `intro segment running · pause @ frame ${INTRO_END_FRAME}`;
      playToggle.classList.remove("visible");
      recordEvent("WebP replayed intro segment");
      startAnimation();
      return;
    }
    playing = !playing;
    if (playing) {
      startedAt = currentTime() - (currentFrame / FRAME_RATE) * 1000;
      metrics.state = "playing WebP";
      playToggle.classList.remove("visible");
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
    metrics.state = `scrub held frame ${Math.round(metrics.frame)}`;
    playToggle.textContent = "Play from held frame";
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
        startedAt = currentTime();
      } else if (target < INTRO_END_FRAME) {
        segmentPhase = "intro";
        currentFrame = target;
        startedAt = currentTime() - (target / FRAME_RATE) * 1000;
      } else {
        segmentPhase = "main";
        currentFrame = target;
        startedAt = currentTime() - (target / FRAME_RATE) * 1000;
      }
    } else {
      currentFrame = target;
      startedAt = currentTime() - (target / FRAME_RATE) * 1000;
    }
    playing = true;
    metrics.state = `playing from scrub frame ${target}`;
    playToggle.classList.remove("visible");
    recordEvent(`scrub released by Play at frame ${target}`);
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
    startedAt = currentTime() - (target / FRAME_RATE) * 1000;
    loadOne(target);
    draw(target);
    recordEvent(`seek requested frame ${target}`);
  };
  const clickListener = (): void => {
    togglePlayback();
  };
  canvas.addEventListener("click", clickListener);
  playToggle.classList.add("visible");
  playToggle.textContent = "Pause / play";
  pump();
  startAnimation();
  return {
    variant: "c",
    pauseForScrub,
    resumeFromScrub,
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
  startRenderer(next);
}

function startRenderer(variant: Variant): void {
  runId += 1;
  const run = runId;
  currentVariant = variant;
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
    startRenderer(fallback);
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
  if (scrubHeldFrame === null) {
    runtime?.pauseForScrub();
    recordEvent(`scrub started at frame ${target}`);
  }
  setScrubHold(target, "held · seek pending");
  metrics.state = `scrubbing frame ${target}`;
  runtime?.seek(target);
  recordEvent(`scrub input captured frame ${target}`);
}

function scrubInputFrame(event: Event): number | null {
  const input = event.currentTarget as HTMLInputElement | null;
  const value = Number(input?.value);
  return Number.isFinite(value) ? normalizeFrame(value) : null;
}

playToggle.addEventListener("click", () => {
  if (scrubHeldFrame !== null && runtime) {
    const heldFrame = scrubHeldFrame;
    scrubPointerActive = false;
    setScrubHold(null, "idle");
    runtime.resumeFromScrub(heldFrame);
    return;
  }
  runtime?.togglePlayback();
});
scrub.addEventListener("pointerdown", () => {
  scrubPointerActive = true;
});
scrub.addEventListener("pointerup", () => {
  scrubPointerActive = false;
  if (scrubHeldFrame === null) return;
  metrics.scrubState = "held · release via Play";
  metrics.state = `scrub held frame ${scrubHeldFrame}`;
  scrub.value = String(scrubHeldFrame);
  renderMetrics();
  recordEvent(`scrub pointer released; holding frame ${scrubHeldFrame}`);
});
scrub.addEventListener("pointercancel", () => {
  scrubPointerActive = false;
  if (scrubHeldFrame === null) return;
  metrics.scrubState = "held · release via Play";
  metrics.state = `scrub held frame ${scrubHeldFrame}`;
  scrub.value = String(scrubHeldFrame);
  renderMetrics();
  recordEvent(`scrub pointer canceled; holding frame ${scrubHeldFrame}`);
});
scrub.addEventListener("change", (scrubEvent) => {
  const capturedFrame = scrubInputFrame(scrubEvent);
  const target = scrubHeldFrame ?? capturedFrame;
  if (target === null) return;
  // `input` already sought the final captured value. A change event only
  // closes the pointer gesture; it never re-reads a possibly overwritten DOM
  // value or issues a duplicate seek.
  if (scrubHeldFrame === null) beginScrub(target);
  scrubPointerActive = false;
  if (scrubHeldFrame !== null) {
    scrub.value = String(scrubHeldFrame);
    metrics.scrubState = "held · release via Play";
    metrics.state = `scrub held frame ${scrubHeldFrame}`;
    renderMetrics();
    recordEvent(`scrub change finalized frame ${scrubHeldFrame}`);
  }
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

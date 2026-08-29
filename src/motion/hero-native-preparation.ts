/**
 * Deterministic readiness state for a native hero candidate.
 *
 * Media readiness only proves that a decoder can provide data. The surface is
 * not safe to expose until a real video frame has been presented. Keeping the
 * gate as a reducer makes the poster/visibility boundary testable without a
 * browser and prevents `loadeddata` + `canplay` from becoming an accidental
 * paint contract.
 */

export type NativePreparationRenderer = "h" | "a";
export type NativePreparationStatus = "hidden" | "ready" | "failed";
export type NativePreparationReason =
  | "waiting-media"
  | "waiting-alpha"
  | "waiting-presentation"
  | "first-presented-frame"
  | "preparation-timeout";

export type NativePreparationState = Readonly<{
  renderer: NativePreparationRenderer;
  loadedData: boolean;
  canPlay: boolean;
  alphaProof: boolean;
  presentationProof: boolean;
  firstPresentedFrame: number | null;
  /** Incremented whenever a covered seek invalidates the prior proof. */
  presentationGeneration: number;
  status: NativePreparationStatus;
  reason: NativePreparationReason;
}>;

export type NativePreparationEvent =
  | { type: "loaded-data" }
  | { type: "can-play" }
  | { type: "alpha-proof" }
  | { type: "presented-frame"; frame: number }
  | { type: "reset-presentation" }
  | { type: "timeout" };

export function initialNativePreparationState(
  renderer: NativePreparationRenderer,
): NativePreparationState {
  return {
    renderer,
    loadedData: false,
    canPlay: false,
    // H's AVFoundation-validated asset carries alpha by construction. A's
    // alpha probe remains an independent decoded-pixel requirement.
    alphaProof: renderer === "h",
    presentationProof: false,
    firstPresentedFrame: null,
    presentationGeneration: 0,
    status: "hidden",
    reason: "waiting-media",
  };
}

function assertFrame(frame: number): void {
  if (!Number.isFinite(frame) || frame < 0) {
    throw new RangeError("Native presented frame must be finite and non-negative");
  }
}

function waitingReason(state: Pick<NativePreparationState, "loadedData" | "canPlay" | "alphaProof" | "presentationProof">): NativePreparationReason {
  if (!state.loadedData || !state.canPlay) return "waiting-media";
  if (!state.alphaProof) return "waiting-alpha";
  return state.presentationProof ? "first-presented-frame" : "waiting-presentation";
}

/** Apply one browser fact to the native candidate's preparation gate. */
export function reduceNativePreparation(
  previous: NativePreparationState,
  event: NativePreparationEvent,
): NativePreparationState {
  if (event.type === "presented-frame") assertFrame(event.frame);
  if (event.type === "reset-presentation") {
    if (previous.status === "failed") return previous;
    return {
      ...previous,
      presentationProof: false,
      firstPresentedFrame: null,
      presentationGeneration: previous.presentationGeneration + 1,
      status: "hidden",
      reason: waitingReason({ ...previous, presentationProof: false }),
    };
  }
  if (previous.status === "failed" || previous.status === "ready") return previous;
  if (event.type === "timeout") {
    return { ...previous, status: "failed", reason: "preparation-timeout" };
  }

  const next = {
    ...previous,
    loadedData: previous.loadedData || event.type === "loaded-data",
    canPlay: previous.canPlay || event.type === "can-play",
    alphaProof: previous.alphaProof || event.type === "alpha-proof",
    presentationProof: previous.presentationProof
      || (event.type === "presented-frame" && event.frame === 0),
    firstPresentedFrame: previous.firstPresentedFrame
      ?? (event.type === "presented-frame" ? event.frame : null),
  };
  const complete = next.loadedData && next.canPlay && next.alphaProof && next.presentationProof;
  return {
    ...next,
    status: complete ? "ready" : "hidden",
    reason: complete ? "first-presented-frame" : waitingReason(next),
  };
}

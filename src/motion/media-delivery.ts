/**
 * PROTOTYPE ONLY — media delivery observations used by the renderer gate.
 *
 * A successful fetch and a seekable video are different facts. Cloudflare
 * Pages may answer a Range request with 200; a Blob URL is then a deliberate
 * full-download fallback for this prototype. Keep that distinction visible.
 */

export type MediaDeliveryMode = "pending" | "blob" | "range" | "url" | "failed";

export type MediaDeliverySnapshot = Readonly<{
  mode: MediaDeliveryMode;
  seekable: boolean;
  bytes: number | null;
  status: number | null;
  reason: string;
}>;

export type MediaResponseObservation = Readonly<{
  status: number;
  acceptRanges?: string | null;
  contentRange?: string | null;
  bytes?: number | null;
}>;

function positiveBytes(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

export function pendingMediaDelivery(reason = "waiting for media response"): MediaDeliverySnapshot {
  return { mode: "pending", seekable: false, bytes: null, status: null, reason };
}

export function mediaDeliveryFromBlob(bytes: number, reason = "full Blob URL is locally seekable"): MediaDeliverySnapshot {
  const size = positiveBytes(bytes);
  if (size === null) return { mode: "failed", seekable: false, bytes: null, status: null, reason: "empty media Blob" };
  return { mode: "blob", seekable: true, bytes: size, status: 200, reason };
}

export function mediaDeliveryFromResponse(observation: MediaResponseObservation): MediaDeliverySnapshot {
  if (!observation || !Number.isInteger(observation.status) || observation.status < 100) {
    return { mode: "failed", seekable: false, bytes: null, status: null, reason: "invalid media response" };
  }
  if (observation.status < 200 || observation.status >= 400) {
    return {
      mode: "failed",
      seekable: false,
      bytes: positiveBytes(observation.bytes),
      status: observation.status,
      reason: `media response ${observation.status}`,
    };
  }
  const acceptsRanges = observation.acceptRanges?.toLowerCase().includes("bytes") ?? false;
  const hasRange = typeof observation.contentRange === "string" && observation.contentRange.includes("bytes ");
  if (observation.status === 206 && acceptsRanges && hasRange) {
    return {
      mode: "range",
      seekable: true,
      bytes: positiveBytes(observation.bytes),
      status: observation.status,
      reason: "HTTP byte ranges available",
    };
  }
  return {
    mode: "url",
    seekable: false,
    bytes: positiveBytes(observation.bytes),
    status: observation.status,
    reason: observation.status === 200
      ? "HTTP 200 without a verified byte-range response"
      : "HTTP response is playable but range semantics are unverified",
  };
}

export function formatMediaDelivery(snapshot: MediaDeliverySnapshot): string {
  const bytes = snapshot.bytes === null ? "bytes pending" : `~${snapshot.bytes} B`;
  return `${snapshot.mode} · ${snapshot.seekable ? "seekable" : "not seekable"} · ${bytes}`;
}

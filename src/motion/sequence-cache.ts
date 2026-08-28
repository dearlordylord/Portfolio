/**
 * PROTOTYPE ONLY — bounded decoded-frame cache and target/display/render seam.
 *
 * Image loading is asynchronous. A frame that finishes after a newer target
 * was requested must remain cacheable, but it must never move the displayed or
 * rendered frame back to that stale result. The browser adapter owns image
 * decoding; this module owns the small, serializable state boundary.
 */

export type SequenceFrameToken = Readonly<{
  frame: number;
  generation: number;
}>;

export type SequenceCommitResult = Readonly<{
  accepted: boolean;
  reason: "accepted" | "stale-generation" | "wrong-frame" | "not-displayed";
}>;

export type SequenceFrameSnapshot = Readonly<{
  targetFrame: number | null;
  displayedFrame: number | null;
  renderedFrame: number | null;
  generation: number;
  staleCommitCount: number;
}>;

export type BoundedFrameCacheSnapshot = Readonly<{
  capacity: number;
  size: number;
  frames: readonly number[];
  hits: number;
  misses: number;
  evictions: number;
}>;

export type UniqueFrameTransferSnapshot = Readonly<{
  frameCount: number;
  totalBytes: number;
  loadedFrameCount: number;
  estimatedBytes: number;
  loadedFrames: readonly number[];
}>;

export type FrameDisposer<T> = (value: T, frame: number) => void;

function assertFrame(frame: number, frameCount?: number): number {
  if (!Number.isFinite(frame)) throw new RangeError("frame must be finite");
  const normalized = Math.round(frame);
  if (normalized < 0 || (frameCount !== undefined && normalized >= frameCount)) {
    throw new RangeError("frame is outside the sequence");
  }
  return normalized;
}

function assertCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError("cache capacity must be a positive integer");
  }
}

/**
 * Small LRU cache for decoded frame resources. `get()` refreshes recency;
 * `set()` disposes the least-recently-used resource when capacity is full.
 */
export class BoundedFrameCache<T> {
  readonly #capacity: number;
  readonly #dispose?: FrameDisposer<T>;
  readonly #entries = new Map<number, T>();
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(capacity: number, dispose?: FrameDisposer<T>) {
    assertCapacity(capacity);
    this.#capacity = capacity;
    this.#dispose = dispose;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(frame: number): boolean {
    return this.#entries.has(assertFrame(frame));
  }

  get(frame: number): T | undefined {
    const normalized = assertFrame(frame);
    const value = this.#entries.get(normalized);
    if (value === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    this.#entries.delete(normalized);
    this.#entries.set(normalized, value);
    return value;
  }

  set(frame: number, value: T): void {
    const normalized = assertFrame(frame);
    const previous = this.#entries.get(normalized);
    if (previous !== undefined && previous !== value) this.#dispose?.(previous, normalized);
    this.#entries.delete(normalized);
    this.#entries.set(normalized, value);
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.entries().next().value as [number, T] | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
      this.#evictions += 1;
      this.#dispose?.(oldest[1], oldest[0]);
    }
  }

  delete(frame: number): boolean {
    const normalized = assertFrame(frame);
    const value = this.#entries.get(normalized);
    if (value === undefined) return false;
    this.#entries.delete(normalized);
    this.#dispose?.(value, normalized);
    return true;
  }

  clear(): void {
    for (const [frame, value] of this.#entries) this.#dispose?.(value, frame);
    this.#entries.clear();
  }

  frames(): readonly number[] {
    return [...this.#entries.keys()];
  }

  snapshot(): BoundedFrameCacheSnapshot {
    return {
      capacity: this.#capacity,
      size: this.#entries.size,
      frames: this.frames(),
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
    };
  }
}

/**
 * Tracks successful frame IDs independently of the decoded-resource cache.
 * A frame may be evicted and decoded again without making the unique transfer
 * estimate shrink or double-counting that frame.
 */
export class UniqueFrameTransferAccounting {
  readonly #frameCount: number;
  readonly #totalBytes: number;
  readonly #loadedFrames = new Set<number>();

  constructor(frameCount: number, totalBytes: number) {
    if (!Number.isInteger(frameCount) || frameCount < 1) {
      throw new RangeError("frameCount must be a positive integer");
    }
    if (!Number.isFinite(totalBytes) || totalBytes < 0) {
      throw new RangeError("totalBytes must be non-negative");
    }
    this.#frameCount = frameCount;
    this.#totalBytes = totalBytes;
  }

  /** Record one successfully loaded frame; duplicate IDs are ignored. */
  record(frame: number): boolean {
    const normalized = assertFrame(frame, this.#frameCount);
    if (this.#loadedFrames.has(normalized)) return false;
    this.#loadedFrames.add(normalized);
    return true;
  }

  snapshot(): UniqueFrameTransferSnapshot {
    const loadedFrames = [...this.#loadedFrames].sort((left, right) => left - right);
    return {
      frameCount: this.#frameCount,
      totalBytes: this.#totalBytes,
      loadedFrameCount: loadedFrames.length,
      estimatedBytes: Math.round((loadedFrames.length / this.#frameCount) * this.#totalBytes),
      loadedFrames,
    };
  }
}

/**
 * Serializes target → displayed → rendered commits. Every target request gets
 * a generation token; late image callbacks carrying an older token are
 * rejected before they can mutate either observable frame.
 */
export class SequenceFrameCoordinator {
  readonly #frameCount?: number;
  #generation = 0;
  #targetFrame: number | null = null;
  #displayedFrame: number | null = null;
  #renderedFrame: number | null = null;
  #staleCommitCount = 0;

  constructor(frameCount?: number) {
    if (frameCount !== undefined && (!Number.isInteger(frameCount) || frameCount < 1)) {
      throw new RangeError("frameCount must be a positive integer");
    }
    this.#frameCount = frameCount;
  }

  request(frame: number): SequenceFrameToken {
    const normalized = assertFrame(frame, this.#frameCount);
    this.#generation += 1;
    this.#targetFrame = normalized;
    return { frame: normalized, generation: this.#generation };
  }

  display(token: SequenceFrameToken): SequenceCommitResult {
    const result = this.#validate(token);
    if (!result.accepted) {
      this.#staleCommitCount += 1;
      return result;
    }
    this.#displayedFrame = token.frame;
    return result;
  }

  render(token: SequenceFrameToken): SequenceCommitResult {
    const result = this.#validate(token);
    if (!result.accepted) {
      this.#staleCommitCount += 1;
      return result;
    }
    if (this.#displayedFrame !== token.frame) {
      this.#staleCommitCount += 1;
      return { accepted: false, reason: "not-displayed" };
    }
    this.#renderedFrame = token.frame;
    return result;
  }

  snapshot(): SequenceFrameSnapshot {
    return {
      targetFrame: this.#targetFrame,
      displayedFrame: this.#displayedFrame,
      renderedFrame: this.#renderedFrame,
      generation: this.#generation,
      staleCommitCount: this.#staleCommitCount,
    };
  }

  #validate(token: SequenceFrameToken): SequenceCommitResult {
    if (!token || !Number.isInteger(token.generation) || !Number.isFinite(token.frame)) {
      return { accepted: false, reason: "stale-generation" };
    }
    if (token.generation !== this.#generation) {
      return { accepted: false, reason: "stale-generation" };
    }
    if (token.frame !== this.#targetFrame) {
      return { accepted: false, reason: "wrong-frame" };
    }
    return { accepted: true, reason: "accepted" };
  }
}

/** Return a deterministic bounded prefetch window centered on the target. */
export function prefetchFrames(
  targetFrame: number,
  frameCount: number,
  radius: number,
): readonly number[] {
  const target = assertFrame(targetFrame, frameCount);
  if (!Number.isInteger(radius) || radius < 0) throw new RangeError("prefetch radius must be non-negative");
  const frames: number[] = [];
  for (let offset = -radius; offset <= radius; offset += 1) {
    const frame = target + offset;
    if (frame >= 0 && frame < frameCount) frames.push(frame);
  }
  return frames;
}

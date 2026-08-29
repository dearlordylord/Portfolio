export type ClockSubscriber = (nowMs: number, deltaMs: number) => void;

export class ManualClock {
  readonly #subscribers = new Set<ClockSubscriber>();
  #nowMs: number;

  constructor(startMs = 0) {
    if (!Number.isFinite(startMs) || startMs < 0) {
      throw new RangeError("ManualClock start must be a finite non-negative number");
    }
    this.#nowMs = startMs;
  }

  get nowMs(): number {
    return this.#nowMs;
  }

  subscribe(subscriber: ClockSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  step(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      throw new RangeError("ManualClock step must be a finite positive number");
    }
    this.#nowMs += deltaMs;
    for (const subscriber of this.#subscribers) {
      subscriber(this.#nowMs, deltaMs);
    }
  }

  seek(targetMs: number): void {
    if (!Number.isFinite(targetMs) || targetMs < this.#nowMs) {
      throw new RangeError("ManualClock can only seek forward to a finite time");
    }
    if (targetMs > this.#nowMs) this.step(targetMs - this.#nowMs);
  }

  runFor(durationMs: number, sampleEveryMs = 1000 / 60): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError("ManualClock duration must be finite and non-negative");
    }
    if (!Number.isFinite(sampleEveryMs) || sampleEveryMs <= 0) {
      throw new RangeError("ManualClock sample interval must be finite and positive");
    }

    const target = this.#nowMs + durationMs;
    while (this.#nowMs + sampleEveryMs < target) this.step(sampleEveryMs);
    if (this.#nowMs < target) this.step(target - this.#nowMs);
  }

  runUntil(
    predicate: () => boolean,
    options: { timeoutMs: number; sampleEveryMs?: number },
  ): boolean {
    const sampleEveryMs = options.sampleEveryMs ?? 1000 / 60;
    const deadline = this.#nowMs + options.timeoutMs;
    while (!predicate() && this.#nowMs < deadline) {
      this.step(Math.min(sampleEveryMs, deadline - this.#nowMs));
    }
    return predicate();
  }
}


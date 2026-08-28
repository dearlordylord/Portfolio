/**
 * PROTOTYPE ONLY — exact-frame gate for the WebP sequence renderer.
 *
 * A wall-clock target is only a request. The sequence must advance through
 * contiguous decoded frames and wait when the next exact drawable is not
 * available; drawing an older image as a placeholder must never advance the
 * playback clock or its reported frame.
 */
export function nextExactSequenceFrame(
  currentFrame: number,
  desiredFrame: number,
  loadedFrames: ReadonlySet<number>,
  frameCount: number,
  loop: boolean,
): number | null {
  if (!Number.isInteger(frameCount) || frameCount < 2) return null;
  const current = Math.max(0, Math.min(frameCount - 1, Math.round(currentFrame)));
  const desired = Math.max(0, Math.min(frameCount - 1, Math.round(desiredFrame)));
  if (current === desired) return loadedFrames.has(current) ? current : null;
  let next = current + 1;
  if (next >= frameCount) {
    if (!loop) return null;
    next = 0;
  }
  return loadedFrames.has(next) ? next : null;
}

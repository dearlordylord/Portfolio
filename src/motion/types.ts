export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type ViewportEnvironment = {
  width: number;
  height: number;
  dpr: number;
  input: "touch" | "mouse";
  reducedMotion: boolean;
};

export type MotionEventRecord = {
  timeMs: number;
  scene: string;
  from: string;
  event: string;
  to: string;
  reason: string;
};

export function rect(x: number, y: number, width: number, height: number): Rect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
  };
}

export function isFiniteRect(value: Rect): boolean {
  return Object.values(value).every(Number.isFinite);
}


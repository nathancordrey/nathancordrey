import type { Vec2 } from './shared/geometry';

export type PointerGestureResult<Context> = {
  kind: 'tap' | 'drag' | 'cancel';
  context: Context;
  durationMs: number;
};

export type PointerGestureMove = {
  dragging: boolean;
  becameDrag: boolean;
  delta: Vec2;
};

type ActiveGesture<Context> = {
  pointerId: number;
  start: Vec2;
  last: Vec2;
  startedAtMs: number;
  dragged: boolean;
  context: Context;
};

/**
 * Classifies one active pointer as either a short tap or a deliberate drag.
 * Once the drag threshold is crossed the gesture can never become a tap again.
 */
export class PointerGestureController<Context> {
  private active: ActiveGesture<Context> | null = null;
  private readonly dragThresholdPx: number;
  private readonly maxTapDurationMs: number;

  constructor(dragThresholdPx = 10, maxTapDurationMs = 350) {
    this.dragThresholdPx = dragThresholdPx;
    this.maxTapDurationMs = maxTapDurationMs;
  }

  begin(pointerId: number, point: Vec2, atMs: number, context: Context): boolean {
    if (this.active !== null) return false;
    this.active = {
      pointerId,
      start: { ...point },
      last: { ...point },
      startedAtMs: atMs,
      dragged: false,
      context,
    };
    return true;
  }

  move(pointerId: number, point: Vec2): PointerGestureMove | null {
    const active = this.active;
    if (active === null || active.pointerId !== pointerId) return null;

    const totalDistance = Math.hypot(point.x - active.start.x, point.y - active.start.y);
    const becameDrag = !active.dragged && totalDistance >= this.dragThresholdPx;
    if (becameDrag) active.dragged = true;

    const delta = active.dragged
      ? becameDrag
        ? { x: point.x - active.start.x, y: point.y - active.start.y }
        : { x: point.x - active.last.x, y: point.y - active.last.y }
      : { x: 0, y: 0 };

    active.last = { ...point };
    return { dragging: active.dragged, becameDrag, delta };
  }

  end(pointerId: number, point: Vec2, atMs: number): PointerGestureResult<Context> | null {
    const active = this.active;
    if (active === null || active.pointerId !== pointerId) return null;

    const totalDistance = Math.hypot(point.x - active.start.x, point.y - active.start.y);
    const dragged = active.dragged || totalDistance >= this.dragThresholdPx;
    const durationMs = Math.max(0, atMs - active.startedAtMs);
    this.active = null;

    if (dragged) return { kind: 'drag', context: active.context, durationMs };
    if (durationMs > this.maxTapDurationMs) {
      return { kind: 'cancel', context: active.context, durationMs };
    }
    return { kind: 'tap', context: active.context, durationMs };
  }

  cancel(pointerId?: number): void {
    if (this.active === null) return;
    if (pointerId !== undefined && this.active.pointerId !== pointerId) return;
    this.active = null;
  }

  activePointerId(): number | null {
    return this.active?.pointerId ?? null;
  }
}

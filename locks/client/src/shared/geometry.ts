// Pure geometry — no Phaser, no DOM. Safe to import on a Node server.

export type Vec2 = { x: number; y: number };

export type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type Segment = { start: Vec2; end: Vec2 };

export type RayHit = { point: Vec2; t: number };

export function rectFromCenter(x: number, y: number, width: number, height: number): Rect {
  return {
    left: x - width / 2,
    top: y - height / 2,
    right: x + width / 2,
    bottom: y + height / 2,
  };
}

export function rectEdges(rect: Rect): Segment[] {
  const { left, top, right, bottom } = rect;
  return [
    { start: { x: left, y: top }, end: { x: right, y: top } },
    { start: { x: right, y: top }, end: { x: right, y: bottom } },
    { start: { x: right, y: bottom }, end: { x: left, y: bottom } },
    { start: { x: left, y: bottom }, end: { x: left, y: top } },
  ];
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function circleIntersectsRect(cx: number, cy: number, radius: number, rect: Rect): boolean {
  const closestX = Math.max(rect.left, Math.min(cx, rect.right));
  const closestY = Math.max(rect.top, Math.min(cy, rect.bottom));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= radius * radius;
}

export function segmentSegmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): RayHit | null {
  const rX = b.x - a.x;
  const rY = b.y - a.y;
  const sX = d.x - c.x;
  const sY = d.y - c.y;

  const denominator = rX * sY - rY * sX;
  if (Math.abs(denominator) < 1e-6) return null;

  const cMinusAX = c.x - a.x;
  const cMinusAY = c.y - a.y;

  const t = (cMinusAX * sY - cMinusAY * sX) / denominator;
  const u = (cMinusAX * rY - cMinusAY * rX) / denominator;

  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return { point: { x: a.x + t * rX, y: a.y + t * rY }, t };
}

export function segmentRectIntersection(start: Vec2, end: Vec2, rect: Rect): RayHit | null {
  let nearest: RayHit | null = null;
  for (const edge of rectEdges(rect)) {
    const hit = segmentSegmentIntersection(start, end, edge.start, edge.end);
    if (hit && (!nearest || hit.t < nearest.t)) nearest = hit;
  }
  return nearest;
}

export function segmentCircleIntersection(
  start: Vec2,
  end: Vec2,
  center: Vec2,
  radius: number
): RayHit | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  const fx = start.x - center.x;
  const fy = start.y - center.y;

  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  const sqrtDiscriminant = Math.sqrt(discriminant);
  const t1 = (-b - sqrtDiscriminant) / (2 * a);
  const t2 = (-b + sqrtDiscriminant) / (2 * a);
  const t = [t1, t2].find((value) => value >= 0 && value <= 1);
  if (t === undefined) return null;

  return { point: { x: start.x + dx * t, y: start.y + dy * t }, t };
}

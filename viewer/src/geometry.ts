/**
 * Pointer geometry for hover cards. Moving from a trigger to its card crosses a gap, and
 * the pointer may drift over other things on the way; a card that closed the moment the
 * pointer left the trigger would be unreachable. So while the pointer travels from one to
 * the other it is tracked against the convex hull of where it left and the destination
 * (the "safe triangle", widened to the destination's whole edge): staying inside the hull
 * keeps the card open, leaving it closes the card.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const inRect = (p: Point, r: Rect): boolean => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

export const inflate = (r: Rect, d: number): Rect => ({ left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d });

export const corners = (r: Rect): Point[] => [
  { x: r.left, y: r.top },
  { x: r.right, y: r.top },
  { x: r.right, y: r.bottom },
  { x: r.left, y: r.bottom },
];

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull, counter-clockwise (Andrew's monotone chain). */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const build = (list: Point[]) => {
    const out: Point[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(pts), ...build(pts.reverse())];
}

/** Even-odd ray casting; points on an edge count as inside for a convex polygon. */
export function inPolygon(p: Point, poly: Point[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (cross(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Extra reach around the destination, so grazing its corner still counts. */
const REACH = 6;

/**
 * Whether the pointer is still "on its way" between a trigger and its card, or in either.
 * Feed it every pointer position; `move` says whether the card should stay open.
 */
export class SafeZone {
  private zone: "trigger" | "card" | "gap" | "out" = "trigger";
  private hull: Point[] | undefined;
  private last: Point;

  constructor(
    private readonly trigger: () => Rect,
    private readonly card: () => Rect,
    start: Point,
  ) {
    this.last = start;
  }

  move(p: Point): boolean {
    const card = this.card();
    const trigger = this.trigger();
    const previous = this.zone;
    let zone: typeof this.zone = inRect(p, card) ? "card" : inRect(p, trigger) ? "trigger" : "out";
    if (zone === "trigger" || zone === "card") {
      this.hull = undefined;
      this.last = p;
    } else if (previous === "trigger" || previous === "card") {
      // Just left one of them: the way to the other is the hull of where the pointer was and it.
      this.hull = convexHull([this.last, ...corners(inflate(previous === "trigger" ? card : trigger, REACH))]);
      if (inPolygon(p, this.hull)) zone = "gap";
    } else if (this.hull && inPolygon(p, this.hull)) zone = "gap";
    if (zone === "out") this.hull = undefined;
    this.zone = zone;
    return zone !== "out";
  }
}

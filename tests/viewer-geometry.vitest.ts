/** The pointer geometry that keeps a hover card open while the pointer travels to it. */
import { describe, expect, it } from "vitest";
import { convexHull, inPolygon, SafeZone, type Rect } from "../viewer/src/geometry.ts";

describe("convexHull / inPolygon", () => {
  it("hulls a point and a rectangle, dropping interior points", () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
    ]);
    expect(hull).toHaveLength(4);
    expect(inPolygon({ x: 5, y: 5 }, hull)).toBe(true);
    expect(inPolygon({ x: 11, y: 5 }, hull)).toBe(false);
    expect(inPolygon({ x: 10, y: 5 }, hull)).toBe(true); // on the edge
  });

  it("is not fooled by a concave-looking sweep", () => {
    const tri = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]);
    expect(inPolygon({ x: 2, y: 2 }, tri)).toBe(true);
    expect(inPolygon({ x: 8, y: 8 }, tri)).toBe(false);
  });
});

describe("SafeZone", () => {
  // A trigger row at the right, its card 40px to the left and taller than the row.
  const trigger: Rect = { left: 500, top: 100, right: 700, bottom: 120 };
  const card: Rect = { left: 100, top: 60, right: 460, bottom: 420 };
  const zone = (start = { x: 520, y: 110 }) => new SafeZone(() => trigger, () => card, start);

  it("stays open while the pointer is in the trigger or the card", () => {
    const z = zone();
    expect(z.move({ x: 600, y: 110 })).toBe(true);
    expect(z.move({ x: 300, y: 200 })).toBe(true); // jumped straight into the card
  });

  it("stays open across the gap while heading for the card, whatever it passes over", () => {
    const z = zone();
    for (const p of [{ x: 495, y: 112 }, { x: 480, y: 118 }, { x: 470, y: 140 }, { x: 465, y: 200 }]) expect(z.move(p)).toBe(true);
    expect(z.move({ x: 440, y: 210 })).toBe(true);
  });

  it("closes when the pointer heads away from the card", () => {
    const z = zone();
    expect(z.move({ x: 600, y: 112 })).toBe(true);
    expect(z.move({ x: 650, y: 200 })).toBe(false); // below the trigger, out of the hull
    expect(z.move({ x: 480, y: 118 })).toBe(false); // and can't be revived by the hull afterwards
  });

  it("closes when the pointer leaves the card away from the trigger", () => {
    const z = zone();
    z.move({ x: 300, y: 200 });
    expect(z.move({ x: 300, y: 500 })).toBe(false);
  });

  it("keeps the card while returning from it to the trigger", () => {
    const z = zone();
    z.move({ x: 440, y: 100 });
    expect(z.move({ x: 470, y: 108 })).toBe(true);
    expect(z.move({ x: 510, y: 110 })).toBe(true);
  });
});

/** j/k prompt stepping, including near the bottom of the page where jumps can't reach the landing line. */
import { describe, expect, it } from "vitest";
import { stepPrompt } from "../viewer/src/nav.ts";

const LAND = 60;

/**
 * A page of prompts `gap` px apart, scrolled so prompt `at` sits on the landing line,
 * or as close as the page allows: `maxScroll` is the farthest it can scroll.
 */
function page(count: number, at: number, gap = 500, maxScroll = Infinity) {
  const scroll = Math.min(at * gap, maxScroll);
  return { tops: Array.from({ length: count }, (_, i) => LAND + i * gap - scroll), atBottom: at * gap >= maxScroll };
}

describe("stepPrompt by position", () => {
  it("goes to the next prompt below the line and the previous one above it", () => {
    const { tops, atBottom } = page(5, 2);
    expect(stepPrompt(1, tops, LAND, atBottom)).toBe(3);
    expect(stepPrompt(-1, tops, LAND, atBottom)).toBe(1);
  });

  it("treats a prompt sitting on the line as the current one", () => {
    const { tops } = page(5, 2);
    tops[2]! += 5;
    expect(stepPrompt(1, tops, LAND, false)).toBe(3);
    expect(stepPrompt(-1, tops, LAND, false)).toBe(1);
  });

  it("starts at the first prompt from the top of the page", () => {
    const tops = [300, 800, 1300];
    expect(stepPrompt(1, tops, LAND, false)).toBe(0);
    expect(stepPrompt(-1, tops, LAND, false)).toBeUndefined();
  });

  it("stops at the last prompt", () => {
    const { tops, atBottom } = page(3, 2);
    expect(stepPrompt(1, tops, LAND, atBottom)).toBeUndefined();
  });

  it("does nothing with no prompts", () => {
    expect(stepPrompt(1, [], LAND, true)).toBeUndefined();
    expect(stepPrompt(-1, [], LAND, true, 0)).toBeUndefined();
  });
});

describe("stepPrompt near the bottom", () => {
  // Five prompts 500px apart, but the page only scrolls to 1200: prompts 3 and 4 can't
  // reach the line (they rest at 360 and 860).
  const bottom = () => page(5, 4, 500, 1200);

  it("shows the problem by position alone: the same prompt is picked again", () => {
    const { tops } = bottom();
    expect(tops[3]).toBeGreaterThan(LAND + 8);
    expect(stepPrompt(1, tops, LAND, true)).toBe(3);
  });

  it("moves on from the prompt the last jump went to", () => {
    const { tops, atBottom } = bottom();
    expect(stepPrompt(1, tops, LAND, atBottom, 3)).toBe(4);
  });

  it("can walk every remaining prompt, then stays on the last", () => {
    const { tops, atBottom } = bottom();
    let cursor = stepPrompt(1, tops, LAND, atBottom); // 3; the page can't scroll any further
    const visited = [cursor];
    for (let i = 0; i < 3; i++) {
      // As in main.ts, the cursor stays put when there's nowhere to go.
      cursor = stepPrompt(1, tops, LAND, atBottom, cursor) ?? cursor;
      visited.push(cursor);
    }
    expect(visited).toEqual([3, 4, 4, 4]);
  });

  it("steps back through prompts that never reached the line", () => {
    const { tops, atBottom } = bottom();
    expect(stepPrompt(-1, tops, LAND, atBottom, 4)).toBe(3);
    expect(stepPrompt(-1, tops, LAND, atBottom, 3)).toBe(2);
    // Position alone would skip prompt 3 here: it is below the line, and 2 is the last one above.
    expect(stepPrompt(-1, tops, LAND, atBottom)).toBe(2);
  });

  it("returns to position stepping once the reader has moved (no cursor)", () => {
    const { tops, atBottom } = page(5, 2);
    expect(atBottom).toBe(false);
    expect(stepPrompt(1, tops, LAND, atBottom, 4)).toBe(3);
  });

  it("ignores a cursor that was scrolled past, even at the bottom", () => {
    // Prompt 1 is far above the line, so it isn't where the reader is.
    const { tops } = bottom();
    expect(tops[1]).toBeLessThan(LAND - 8);
    expect(stepPrompt(1, tops, LAND, true, 1)).toBe(3);
  });

  it("copes with a cursor index that no longer exists", () => {
    const { tops, atBottom } = bottom();
    expect(stepPrompt(1, tops, LAND, atBottom, 99)).toBe(3);
  });
});

/**
 * Which prompt j/k should go to. Normally that is decided by position: the next prompt
 * is the first one below the landing line. But the page can't scroll past its end, so
 * the last few prompts never reach the line, and by position alone j keeps picking the
 * same one. Near the bottom the prompt the last jump went to (the cursor) stands in for
 * "where we are" instead.
 */

/** Slack, in px, so a prompt sitting on the line counts as being at it. */
const EPS = 8;

/**
 * Index into `tops` (each prompt's viewport top) to jump to, or undefined when there is
 * nowhere to go. `cursor` is the prompt the last j/k jump went to, if the reader hasn't
 * scrolled since; it is only trusted at the bottom of the page, where a jump can fall
 * short of the line.
 */
export function stepPrompt(dir: 1 | -1, tops: readonly number[], land: number, atBottom: boolean, cursor?: number): number | undefined {
  const stranded = atBottom && cursor !== undefined && tops[cursor] !== undefined && tops[cursor]! > land - EPS;
  if (stranded) {
    const to = cursor! + dir;
    return to >= 0 && to < tops.length ? to : undefined;
  }
  if (dir > 0) {
    const next = tops.findIndex((top) => top > land + EPS);
    return next < 0 ? undefined : next;
  }
  for (let i = tops.length - 1; i >= 0; i--) if (tops[i]! < land - EPS) return i;
  return undefined;
}

/**
 * Whether a wheel tick will scroll the page, given its `deltaY` and where the page is.
 * Trackpad inertia keeps sending ticks after the page has hit an end; those don't move
 * anything, so they shouldn't count as the reader scrolling away from a j/k target.
 */
export function wheelMovesPage(deltaY: number, scrollY: number, max: number): boolean {
  if (deltaY > 0) return scrollY < max - 1;
  if (deltaY < 0) return scrollY > 0;
  return false;
}

/** Whether the key was pressed while typing in a field, where shortcuts must stay out of the way. */
export function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

/** `v` goes to the next variant, `V` to the previous; undefined for any other key, with a modifier, or while typing. */
export function variantKeyStep(e: KeyboardEvent): 1 | -1 | undefined {
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return undefined;
  return e.key === "v" ? 1 : e.key === "V" ? -1 : undefined;
}

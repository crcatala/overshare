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

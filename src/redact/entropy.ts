/**
 * Shannon entropy of `s` in bits per character. Counts code points but divides by UTF-16 length, the definition every
 * threshold here was set against (it came with `@sanity-labs/secret-scan`); for ASCII the two are the same.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

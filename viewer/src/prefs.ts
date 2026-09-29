/** Per-viewer conveniences in localStorage (theme, variant, rail state). Never required. */
const PREFIX = "agent-share-";

export function load(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, value);
  } catch {
    // storage unavailable (private mode, sandbox)
  }
}

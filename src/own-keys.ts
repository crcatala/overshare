/**
 * Records keyed by names the transcript supplies (tool names, model ids, entry types, JSON keys). Bracket assignment
 * `record["__proto__"] = x` sets the prototype instead of an own key, so the entry silently vanishes, and a read of
 * `record["__proto__"]` finds `Object.prototype`. These write and read own properties only.
 */

/** Set an own, enumerable property, whatever the name. */
export function setOwn<V>(record: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
}

/** The own value for `key`, never one inherited from `Object.prototype`. */
export function getOwn<V>(record: Record<string, V>, key: string): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** `record[key] += n`, as own keys. */
export function bumpOwn(record: Record<string, number>, key: string, n = 1): void {
  setOwn(record, key, (getOwn(record, key) ?? 0) + n);
}

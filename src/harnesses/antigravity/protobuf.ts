/**
 * A protobuf wire-format reader, without a schema: enough to pull known fields out of Antigravity's `.db` blobs
 * (docs/harnesses/antigravity.md). Field numbers come from observation, so every read is defensive: a blob that does
 * not decode yields nothing, never an exception.
 */

export interface Field {
  field: number;
  /** A varint's value, or a length-delimited field's bytes. Fixed 32/64-bit fields are skipped. */
  value: number | Uint8Array;
}

function varint(b: Uint8Array, at: number): [number, number] | undefined {
  let value = 0;
  let scale = 1;
  for (let i = at; i < b.length && i < at + 10; i++) {
    const x = b[i]!;
    value += (x & 0x7f) * scale;
    scale *= 128;
    if (!(x & 0x80)) return [value, i + 1];
  }
  return undefined;
}

/** The top-level fields of a message, in order; stops (keeping what it read) at anything that does not decode. */
export function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    const key = varint(b, i);
    if (!key) break;
    const [k, next] = key;
    const field = Math.floor(k / 8);
    const wire = k % 8;
    if (field === 0) break;
    i = next;
    if (wire === 0) {
      const v = varint(b, i);
      if (!v) break;
      out.push({ field, value: v[0] });
      i = v[1];
    } else if (wire === 2) {
      const len = varint(b, i);
      if (!len || len[1] + len[0] > b.length) break;
      out.push({ field, value: b.subarray(len[1], len[1] + len[0]) });
      i = len[1] + len[0];
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else break;
  }
  return out;
}

/** Every value at a field path (`[20, 7, 1]`: field 20, then 7 inside it, then 1), in order. */
export function getAll(b: Uint8Array, path: readonly number[]): (number | Uint8Array)[] {
  let current: (number | Uint8Array)[] = [b];
  for (const f of path) {
    current = current.flatMap((v) => (v instanceof Uint8Array ? fields(v).filter((x) => x.field === f).map((x) => x.value) : []));
  }
  return current;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The bytes as UTF-8 text, or undefined when they are not valid UTF-8 (a submessage, binary data). */
export function text(v: number | Uint8Array | undefined): string | undefined {
  if (!(v instanceof Uint8Array)) return undefined;
  try {
    return decoder.decode(v);
  } catch {
    return undefined;
  }
}

/** The first string at a path. */
export const getString = (b: Uint8Array, path: readonly number[]): string | undefined => {
  for (const v of getAll(b, path)) {
    const s = text(v);
    if (s !== undefined) return s;
  }
  return undefined;
};

/** The first number at a path. */
export const getNumber = (b: Uint8Array, path: readonly number[]): number | undefined => getAll(b, path).find((v): v is number => typeof v === "number");

/** The submessages at a path. */
export const getMessages = (b: Uint8Array, path: readonly number[]): Uint8Array[] => getAll(b, path).filter((v): v is Uint8Array => v instanceof Uint8Array);

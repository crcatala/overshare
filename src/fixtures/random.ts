/** Small seeded PRNG (mulberry32) so fixtures are reproducible per seed. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  token(length: number, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"): string {
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(this.next() * alphabet.length)];
    return out;
  }

  hex(length: number): string {
    return this.token(length, "0123456789abcdef");
  }

  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[this.int(0, 3)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  /** Time-ordered id in the shape pi uses (uuidv7-like). */
  uuid7(ms: number): string {
    const t = ms.toString(16).padStart(12, "0");
    const h = this.hex(20);
    return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${h.slice(0, 3)}-${"89ab"[this.int(0, 3)]}${h.slice(3, 6)}-${h.slice(6, 18)}`;
  }
}

/** Randomness abstraction. Competitive outcomes must never use Math.random() directly. */

export interface RandomSource {
  nextInt(min: number, max: number): number;
  nextFloat(): number;
}

/** Deterministic Xorshift32 — tests, replays, seeded matches. */
export class SeededRandom implements RandomSource {
  private state: number;
  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }
  nextFloat(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x1_0000_0000;
  }
  nextInt(min: number, max: number): number {
    if (max < min) throw new Error("max < min");
    const span = max - min + 1;
    return min + Math.floor(this.nextFloat() * span);
  }
  getState(): number {
    return this.state >>> 0;
  }
  setState(s: number): void {
    this.state = s >>> 0;
  }
}

/** Cryptographically secure local RNG for ordinary (non-test) play. */
export class SecureRandom implements RandomSource {
  nextFloat(): number {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return (buf[0] as number) / 0x1_0000_0000;
  }
  nextInt(min: number, max: number): number {
    if (max < min) throw new Error("max < min");
    const span = max - min + 1;
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return min + Number((buf[0] as number) % span);
  }
}

/** Fixed sequence — unit tests that need exact dice/cards. */
export class SequenceRandom implements RandomSource {
  private cursor = 0;
  constructor(private readonly values: number[]) {}
  nextFloat(): number {
    if (this.values.length === 0) return 0.5;
    const v = this.values[this.cursor % this.values.length] as number;
    this.cursor += 1;
    return v;
  }
  nextInt(min: number, max: number): number {
    const span = max - min + 1;
    return min + Math.floor(this.nextFloat() * span);
  }
}

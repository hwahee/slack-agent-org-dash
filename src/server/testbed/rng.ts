/**
 * Seeded randomness (docs/testbed/faults-and-seed.md §2).
 *
 * Every random behaviour goes through a `SeededRng`; the same seed yields the
 * same sequence. Seeds are strings so they can be recorded in Run meta and
 * typed back in by a person.
 */
import { createHash, randomBytes } from 'node:crypto';

/** A fresh seed for a Run (or a boot) that was given none. */
export function generateSeed(): string {
  return randomBytes(6).toString('hex');
}

/** sfc32 seeded from sha256(seed): small, fast, and good enough for test traffic. */
export class SeededRng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly seed: string) {
    const digest = createHash('sha256').update(seed).digest();
    this.a = digest.readUInt32LE(0);
    this.b = digest.readUInt32LE(4);
    this.c = digest.readUInt32LE(8);
    this.d = digest.readUInt32LE(12);
  }

  /** A float in [0, 1). */
  next(): number {
    this.a |= 0;
    this.b |= 0;
    this.c |= 0;
    this.d |= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4_294_967_296;
  }

  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
}

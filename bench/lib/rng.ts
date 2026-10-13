/**
 * Tiny deterministic PRNG (mulberry32) for bench fixtures and task selection.
 * Seedable, zero dependencies, and stable across platforms: all math is pure
 * 32-bit integer arithmetic, so the same seed always yields the same sequence.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). Throws when maxExclusive <= 0. */
  int(maxExclusive: number): number;
  /** Uniform integer in [minInclusive, maxInclusive]. */
  range(minInclusive: number, maxInclusive: number): number;
  /** Uniform pick from a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates shuffle; returns a copy, input is not mutated. */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed)) {
    throw new Error(`createRng: seed must be an integer, got ${seed}`);
  }
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error(`rng.int: maxExclusive must be a positive integer, got ${maxExclusive}`);
      }
      return Math.floor(next() * maxExclusive);
    },
    range(minInclusive: number, maxInclusive: number): number {
      if (!Number.isInteger(minInclusive) || !Number.isInteger(maxInclusive) || maxInclusive < minInclusive) {
        throw new Error(
          `rng.range: needs integers min <= max, got ${minInclusive}..${maxInclusive}`,
        );
      }
      return minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("rng.pick: input must not be empty");
      return items[Math.floor(next() * items.length)]!;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i]!;
        out[i] = out[j]!;
        out[j] = tmp;
      }
      return out;
    },
  };
}

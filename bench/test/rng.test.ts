import { describe, expect, it } from "vitest";
import { createRng } from "../lib/rng.ts";

describe("createRng", () => {
  it("produces identical sequences for the same seed", () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(Array.from({ length: 8 }, () => a.next())).not.toEqual(
      Array.from({ length: 8 }, () => b.next()),
    );
  });

  it("keeps next() in [0, 1) and int() within bounds", () => {
    const rng = createRng(42);
    for (let i = 0; i < 500; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      expect(rng.int(7)).toBeGreaterThanOrEqual(0);
      expect(rng.int(7)).toBeLessThan(7);
      const r = rng.range(3, 5);
      expect(r).toBeGreaterThanOrEqual(3);
      expect(r).toBeLessThanOrEqual(5);
    }
  });

  it("shuffles deterministically and preserves elements", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const first = createRng(7).shuffle(items);
    const second = createRng(7).shuffle(items);
    expect(first).toEqual(second);
    expect([...first].sort((a, b) => a - b)).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // input untouched
  });

  it("rejects non-integer seeds and invalid bounds", () => {
    expect(() => createRng(1.5)).toThrow();
    expect(() => createRng(0).int(0)).toThrow();
    expect(() => createRng(0).range(5, 1)).toThrow();
    expect(() => createRng(0).pick([])).toThrow();
  });
});

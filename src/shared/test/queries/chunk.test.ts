import { describe, it, expect } from "vitest";
import {
  chunk,
  maxRowsPerInsert,
  maxInParams,
  D1_MAX_BIND_PARAMS,
  D1_MAX_IN_PARAMS,
} from "../../src/db/queries/_chunk";

describe("chunk", () => {
  it("returns [] for an empty array", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("returns a single chunk when N < size", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("returns a single full chunk when N === size", () => {
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it("splits into two chunks when N === size + 1", () => {
    expect(chunk([1, 2, 3, 4], 3)).toEqual([[1, 2, 3], [4]]);
  });

  it("splits evenly when N === 2 * size", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("preserves order across chunks", () => {
    const arr = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunk(arr, 90);
    expect(chunks.map((c) => c.length)).toEqual([90, 90, 70]);
    expect(chunks.flat()).toEqual(arr);
  });

  it("throws on size < 1", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("maxRowsPerInsert", () => {
  it("caps so rows*paramsPerRow never exceeds 100", () => {
    for (const p of [1, 2, 3, 4, 5, 6, 7, 10, 33, 50, 100]) {
      const rows = maxRowsPerInsert(p);
      expect(rows * p).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
      expect((rows + 1) * p).toBeGreaterThan(D1_MAX_BIND_PARAMS);
    }
  });

  it("matches the pinned per-table caps", () => {
    expect(maxRowsPerInsert(5)).toBe(20); // communityMention
    expect(maxRowsPerInsert(6)).toBe(16); // communityReadState, communityChannelMember
    expect(maxRowsPerInsert(3)).toBe(33); // communityServerFolderItem
  });

  it("throws on paramsPerRow < 1", () => {
    expect(() => maxRowsPerInsert(0)).toThrow();
  });
});

describe("maxInParams", () => {
  it.each([
    [0, 100],
    [1, 99],
    [2, 98],
    [5, 95],
    [6, 94],
  ])("reserves %i fixed binds", (fixed, expected) => {
    expect(maxInParams(fixed)).toBe(expected);
  });

  it.each([-1, 1.5, 100, 101])("rejects invalid fixed bind budget %s", (fixed) => {
    expect(() => maxInParams(fixed)).toThrow();
  });
});

describe("constants", () => {
  it("D1_MAX_IN_PARAMS leaves headroom under the hard limit", () => {
    expect(D1_MAX_BIND_PARAMS).toBe(100);
    expect(D1_MAX_IN_PARAMS).toBeLessThan(D1_MAX_BIND_PARAMS);
  });
});

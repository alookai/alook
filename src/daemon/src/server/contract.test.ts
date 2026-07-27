import { describe, it, expect } from "vitest";
import { parseSeq, formatSeq } from "./contract";

describe("parseSeq / formatSeq", () => {
  it("parses with and without a leading #", () => {
    expect(parseSeq("#12")).toBe(12);
    expect(parseSeq("12")).toBe(12);
    expect(parseSeq("#0")).toBe(0);
  });
  it("throws on non-numeric", () => {
    expect(() => parseSeq("#abc")).toThrow();
    expect(() => parseSeq("xyz")).toThrow();
  });
  // NOTE: parseSeq("") returns 0 because Number("") === 0 (finite). Empty string
  // is arguably invalid input, but no caller passes it — documenting the behavior.
  it("treats empty string as 0 (Number('') === 0) — known edge", () => {
    expect(parseSeq("")).toBe(0);
  });
  it("formatSeq round-trips", () => {
    expect(formatSeq(12)).toBe("#12");
    expect(parseSeq(formatSeq(7))).toBe(7);
  });
});

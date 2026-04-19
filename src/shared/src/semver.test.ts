import { describe, it, expect } from "vitest";
import { semverGte } from "./semver";

describe("semverGte", () => {
  it("returns true when a > b", () => {
    expect(semverGte("0.2.0", "0.1.0")).toBe(true);
  });

  it("returns false when a < b", () => {
    expect(semverGte("0.1.0", "0.2.0")).toBe(false);
  });

  it("compares numerically, not lexicographically", () => {
    expect(semverGte("0.10.0", "0.2.0")).toBe(true);
  });

  it("returns true when equal", () => {
    expect(semverGte("1.0.0", "1.0.0")).toBe(true);
  });

  it("handles major version dominance", () => {
    expect(semverGte("2.0.0", "1.99.99")).toBe(true);
  });

  it("handles patch differences", () => {
    expect(semverGte("1.0.1", "1.0.0")).toBe(true);
    expect(semverGte("1.0.0", "1.0.1")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { parseReleaseVersion, releaseVersionGte, semverGte } from "./semver";

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

describe("strict release versions", () => {
  it("parses exactly three non-negative safe integer components", () => {
    expect(parseReleaseVersion("0.1.7")).toEqual([0, 1, 7]);
    expect(parseReleaseVersion("12.34.56")).toEqual([12, 34, 56]);
  });

  it.each([
    "",
    "abc",
    "1",
    "1.2",
    "1.2.3.4",
    "-1.2.3",
    "1.-2.3",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-alpha",
    "v1.2.3",
    "9007199254740992.0.0",
  ])("rejects unsupported release version %j", (value) => {
    expect(parseReleaseVersion(value)).toBeNull();
  });

  it("compares valid releases and fails closed for invalid input", () => {
    expect(releaseVersionGte("0.1.7", "0.1.7")).toBe(true);
    expect(releaseVersionGte("0.2.0", "0.1.7")).toBe(true);
    expect(releaseVersionGte("0.1.6", "0.1.7")).toBe(false);
    expect(releaseVersionGte("abc", "0.1.7")).toBe(false);
    expect(releaseVersionGte("0.1.7", "latest")).toBe(false);
  });

  it("does not change the loose legacy comparator", () => {
    expect(semverGte("1.2", "1.2.0")).toBe(true);
  });
});

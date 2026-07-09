import { describe, it, expect } from "vitest";
import { computeDiscriminator, parseNameAndTag } from "./discriminator";

describe("computeDiscriminator", () => {
  it("is deterministic — same id returns same output across calls", () => {
    const id = "user_abcdef1234567890";
    expect(computeDiscriminator(id)).toBe(computeDiscriminator(id));
  });

  it("returns exactly 4 digits, zero-padded", () => {
    for (const id of ["a", "ab", "user_1", "x".repeat(50)]) {
      const out = computeDiscriminator(id);
      expect(out).toMatch(/^\d{4}$/);
      expect(out.length).toBe(4);
    }
  });

  it("distributes across the full 0000-9999 range", () => {
    // Deterministic pseudo-ids — no clock/random needed. 10k samples land in
    // a wide band; we just want to prove we aren't stuck near 0.
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(computeDiscriminator(`u_${i}`));
    expect(seen.size).toBeGreaterThan(5000);
  });

  it("differs between ids with the same length", () => {
    expect(computeDiscriminator("aaaa")).not.toBe(computeDiscriminator("aaab"));
  });
});

describe("parseNameAndTag", () => {
  it("splits `name#0042` into name + discriminator", () => {
    expect(parseNameAndTag("ada#0042")).toEqual({ name: "ada", discriminator: "0042" });
  });

  it("preserves internal # in the name (only trailing #dddd is a tag)", () => {
    expect(parseNameAndTag("a#b#0042")).toEqual({ name: "a#b", discriminator: "0042" });
  });

  it("returns null when the tag is missing or malformed", () => {
    expect(parseNameAndTag("ada")).toBeNull();
    expect(parseNameAndTag("ada#nope")).toBeNull();
    expect(parseNameAndTag("ada#42")).toBeNull();
    expect(parseNameAndTag("ada#00042")).toBeNull();
    expect(parseNameAndTag("#0042")).toBeNull();
  });

  it("trims whitespace off the name", () => {
    expect(parseNameAndTag("  ada  #0042")).toEqual({ name: "ada", discriminator: "0042" });
  });
});

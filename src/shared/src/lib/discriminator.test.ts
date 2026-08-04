import { describe, it, expect } from "vitest";
import { computeDiscriminator, parseNameAndTag, formatHandle } from "./discriminator";

describe("computeDiscriminator", () => {
  it("is deterministic — same (seed, width) returns same output across calls", () => {
    const id = "user_abcdef1234567890";
    expect(computeDiscriminator(id)).toBe(computeDiscriminator(id));
    expect(computeDiscriminator(id, 6)).toBe(computeDiscriminator(id, 6));
  });

  it("defaults to exactly 4 digits, zero-padded (pre-widening value unchanged)", () => {
    for (const id of ["a", "ab", "user_1", "x".repeat(50)]) {
      const out = computeDiscriminator(id);
      expect(out).toMatch(/^\d{4}$/);
      expect(out.length).toBe(4);
    }
  });

  it("pads to its OWN width — width N returns exactly N digits (never a global max)", () => {
    for (let width = 4; width <= 9; width++) {
      const out = computeDiscriminator("some_seed", width);
      expect(out).toMatch(new RegExp(`^\\d{${width}}$`));
      expect(out.length).toBe(width);
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

  it("preserves internal # in the name (only the LAST #dddd is a tag)", () => {
    expect(parseNameAndTag("a#b#0042")).toEqual({ name: "a#b", discriminator: "0042" });
  });

  // Variable-width: a 5+-digit tail IS now a valid (widened) tag. This is the
  // intended behavior change vs the old fixed-4 `\d{4}` (which returned null).
  it("accepts a widened 5+-digit discriminator", () => {
    expect(parseNameAndTag("ada#00042")).toEqual({ name: "ada", discriminator: "00042" });
    expect(parseNameAndTag("ada#1234567")).toEqual({ name: "ada", discriminator: "1234567" });
  });

  // Single-value (Ingaborg #87 2c): a name that itself ends in digits splits to
  // exactly one (name, discriminator) at any width — the LAST #, all-digit tail.
  it("splits a digit-ending name to exactly one (name, discriminator)", () => {
    expect(parseNameAndTag("user123#4567")).toEqual({ name: "user123", discriminator: "4567" });
    expect(parseNameAndTag("user123#45678")).toEqual({ name: "user123", discriminator: "45678" });
  });

  it("returns null when the tag is missing or malformed", () => {
    expect(parseNameAndTag("ada")).toBeNull();
    expect(parseNameAndTag("ada#nope")).toBeNull();
    expect(parseNameAndTag("ada#42")).toBeNull(); // fewer than 4 digits is not a tag
    expect(parseNameAndTag("#0042")).toBeNull();
  });

  it("trims whitespace off the name", () => {
    expect(parseNameAndTag("  ada  #0042")).toEqual({ name: "ada", discriminator: "0042" });
  });
});

describe("formatHandle ↔ parseNameAndTag round-trip", () => {
  // Ingaborg #87 2b: inverse at EACH width; ④ formatHandle bare-concats (no pad
  // to a uniform width), so the handle carries the disc's true width verbatim.
  it("round-trips at every width 4..8", () => {
    for (let width = 4; width <= 8; width++) {
      const disc = computeDiscriminator("round_trip_seed", width);
      const handle = formatHandle("ada", disc);
      expect(handle).toBe(`ada#${disc}`); // bare concat, no extra padding
      expect(parseNameAndTag(handle)).toEqual({ name: "ada", discriminator: disc });
      // The parsed disc width equals the true allocation width — no truncate, no pad-up.
      expect(parseNameAndTag(handle)!.discriminator.length).toBe(width);
    }
  });
});

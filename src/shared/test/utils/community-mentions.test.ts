import { describe, it, expect } from "vitest";
import { extractMentionedUserIds } from "../../src/utils/community-mentions";

const ROSTER = [
  { userId: "u1", name: "Alice" },
  { userId: "u2", name: "Bob" },
  { userId: "u3", name: "John" },
  { userId: "u4", name: "John Doe" },
  { userId: "u5", name: "李雷" },
];

describe("extractMentionedUserIds", () => {
  it("returns empty when content is empty", () => {
    expect(extractMentionedUserIds("", ROSTER)).toEqual([]);
  });

  it("returns empty when no candidates", () => {
    expect(extractMentionedUserIds("hi @Alice", [])).toEqual([]);
  });

  it("finds a single mention", () => {
    expect(extractMentionedUserIds("hi @Alice", ROSTER)).toEqual(["u1"]);
  });

  it("is case-insensitive", () => {
    expect(extractMentionedUserIds("hi @alice", ROSTER)).toEqual(["u1"]);
    expect(extractMentionedUserIds("HI @ALICE", ROSTER)).toEqual(["u1"]);
  });

  it("matches multiple distinct mentions", () => {
    const got = extractMentionedUserIds("@Alice @Bob hey", ROSTER);
    expect(got.sort()).toEqual(["u1", "u2"]);
  });

  it("dedupes repeated mentions of the same user", () => {
    expect(extractMentionedUserIds("@Alice @Alice", ROSTER)).toEqual(["u1"]);
  });

  it("prefers longest match (John Doe over John)", () => {
    expect(extractMentionedUserIds("hi @John Doe", ROSTER)).toEqual(["u4"]);
  });

  it("falls back to short name when long does not fit boundary", () => {
    expect(extractMentionedUserIds("hi @John, hey", ROSTER)).toEqual(["u3"]);
  });

  it("respects left boundary — won't match in email", () => {
    expect(extractMentionedUserIds("contact me@Alice.com", ROSTER)).toEqual([]);
  });

  it("respects right boundary — won't match partial token", () => {
    expect(extractMentionedUserIds("hi @AliceBob", ROSTER)).toEqual([]);
  });

  it("handles unicode names", () => {
    expect(extractMentionedUserIds("早 @李雷 好", ROSTER)).toEqual(["u5"]);
  });

  it("does not match @everyone / @here when not in roster", () => {
    expect(extractMentionedUserIds("@everyone hi", ROSTER)).toEqual([]);
  });

  it("returns ids in encounter order", () => {
    const got = extractMentionedUserIds("@Bob @Alice", ROSTER);
    expect(got).toEqual(["u2", "u1"]);
  });
});

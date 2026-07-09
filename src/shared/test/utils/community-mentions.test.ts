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

describe("extractMentionedUserIds — @Name#0042 disambiguation", () => {
  const DUP_ROSTER = [
    { userId: "u_alex_1", name: "Alex", discriminator: "0001" },
    { userId: "u_alex_2", name: "Alex", discriminator: "0002" },
    { userId: "u_bob", name: "Bob", discriminator: "9999" },
  ];

  it("disambiguates two same-named members via the #0042 handle", () => {
    expect(extractMentionedUserIds("hey @Alex#0001", DUP_ROSTER)).toEqual(["u_alex_1"]);
    expect(extractMentionedUserIds("hey @Alex#0002", DUP_ROSTER)).toEqual(["u_alex_2"]);
  });

  it("handle matching is case-insensitive on the name part", () => {
    expect(extractMentionedUserIds("hey @ALEX#0002", DUP_ROSTER)).toEqual(["u_alex_2"]);
  });

  it("matches both duplicates in one message when both handles are used", () => {
    const got = extractMentionedUserIds("@Alex#0001 and @Alex#0002 discuss", DUP_ROSTER);
    expect(got).toEqual(["u_alex_1", "u_alex_2"]);
  });

  it("falls back to bare-name (first occurrence) when no #0042 suffix is present", () => {
    expect(extractMentionedUserIds("hey @Alex, you there?", DUP_ROSTER)).toEqual(["u_alex_1"]);
  });

  it("falls back to bare-name when the discriminator suffix doesn't match anyone", () => {
    expect(extractMentionedUserIds("hey @Alex#9999", DUP_ROSTER)).toEqual(["u_alex_1"]);
  });

  it("a longer digit run after # doesn't match the handle, falls back to bare-name", () => {
    // "#00013" isn't the "#0001" handle (boundary char after would need to be
    // non-identifier) — falls through to the bare "@Alex" bare-name match,
    // since "#" itself is already a non-identifier boundary character.
    expect(extractMentionedUserIds("hey @Alex#00013", DUP_ROSTER)).toEqual(["u_alex_1"]);
  });

  it("handle match still respects word-boundary punctuation immediately after", () => {
    expect(extractMentionedUserIds("cc @Bob#9999, ok?", DUP_ROSTER)).toEqual(["u_bob"]);
  });
});

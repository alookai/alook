import { describe, it, expect } from "vitest";
import { extractMentionedUserIds } from "../../src/utils/community-mentions";

// Every mention now resolves ONLY via a fully-tagged `@Name#dddd` handle — a
// hand-typed bare `@Alice` is not a mention (see
// plans/mandatory-mention-discriminator.md). Rosters carry a discriminator.
const ROSTER = [
  { userId: "u1", name: "Alice", discriminator: "0001" },
  { userId: "u2", name: "Bob", discriminator: "0002" },
  { userId: "u3", name: "John", discriminator: "0003" },
  { userId: "u4", name: "John Doe", discriminator: "0004" },
  { userId: "u5", name: "李雷", discriminator: "0005" },
];

describe("extractMentionedUserIds", () => {
  it("returns empty when content is empty", () => {
    expect(extractMentionedUserIds("", ROSTER)).toEqual([]);
  });

  it("returns empty when no candidates", () => {
    expect(extractMentionedUserIds("hi @Alice#0001", [])).toEqual([]);
  });

  it("finds a single tagged mention", () => {
    expect(extractMentionedUserIds("hi @Alice#0001", ROSTER)).toEqual(["u1"]);
  });

  it("is case-insensitive on the name part", () => {
    expect(extractMentionedUserIds("hi @alice#0001", ROSTER)).toEqual(["u1"]);
    expect(extractMentionedUserIds("HI @ALICE#0001", ROSTER)).toEqual(["u1"]);
  });

  it("matches multiple distinct mentions", () => {
    const got = extractMentionedUserIds("@Alice#0001 @Bob#0002 hey", ROSTER);
    expect(got.sort()).toEqual(["u1", "u2"]);
  });

  it("dedupes repeated mentions of the same user", () => {
    expect(extractMentionedUserIds("@Alice#0001 @Alice#0001", ROSTER)).toEqual(["u1"]);
  });

  it("resolves a spaced name via its handle", () => {
    expect(extractMentionedUserIds("hi @John Doe#0004", ROSTER)).toEqual(["u4"]);
  });

  it("respects right boundary — trailing punctuation after the handle is fine", () => {
    expect(extractMentionedUserIds("hi @John#0003, hey", ROSTER)).toEqual(["u3"]);
  });

  it("respects left boundary — won't match in email", () => {
    expect(extractMentionedUserIds("contact me@Alice#0001.com", ROSTER)).toEqual([]);
  });

  it("handles unicode names via handle", () => {
    expect(extractMentionedUserIds("早 @李雷#0005 好", ROSTER)).toEqual(["u5"]);
  });

  it("handles accented-Latin names — the #4 charset fix", () => {
    const roster = [
      { userId: "u_jose", name: "José", discriminator: "0001" },
      { userId: "u_unal", name: "Ünal", discriminator: "0002" },
    ];
    expect(extractMentionedUserIds("hi @José#0001", roster)).toEqual(["u_jose"]);
    expect(extractMentionedUserIds("hi @Ünal#0002", roster)).toEqual(["u_unal"]);
  });

  it("a hand-typed bare @name (no discriminator) is NOT a mention", () => {
    expect(extractMentionedUserIds("hi @Alice", ROSTER)).toEqual([]);
    expect(extractMentionedUserIds("hi @John Doe", ROSTER)).toEqual([]);
    expect(extractMentionedUserIds("早 @李雷 好", ROSTER)).toEqual([]);
  });

  it("does not match @everyone / @here", () => {
    expect(extractMentionedUserIds("@everyone hi", ROSTER)).toEqual([]);
  });

  it("returns ids in encounter order", () => {
    const got = extractMentionedUserIds("@Bob#0002 @Alice#0001", ROSTER);
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

  it("a bare @name with no matching handle resolves to nothing (no bare-name fallback)", () => {
    expect(extractMentionedUserIds("hey @Alex, you there?", DUP_ROSTER)).toEqual([]);
  });

  it("a #dddd suffix that matches no one resolves to nothing", () => {
    expect(extractMentionedUserIds("hey @Alex#9999", DUP_ROSTER)).toEqual([]);
  });

  it("a longer digit run after # doesn't match the handle and resolves to nothing", () => {
    // "#00013" isn't the "#0001" handle (the char after the 4-digit tag must be
    // a boundary; "3" is an identifier char), and there is no bare-name fallback.
    expect(extractMentionedUserIds("hey @Alex#00013", DUP_ROSTER)).toEqual([]);
  });

  it("handle match still respects word-boundary punctuation immediately after", () => {
    expect(extractMentionedUserIds("cc @Bob#9999, ok?", DUP_ROSTER)).toEqual(["u_bob"]);
  });
});

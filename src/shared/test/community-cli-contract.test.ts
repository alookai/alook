import { describe, it, expect } from "vitest";
import { parseRef, formatRef, formatSeq, parseSeq, DM_SERVER } from "../src/community-cli-contract";

describe("parseRef", () => {
  it('parses "/studio/general" as a plain channel ref', () => {
    expect(parseRef("/studio/general")).toEqual({ server: "studio", channel: "general" });
  });

  it('parses "/studio/general#42" as a pinned-message ref (seq)', () => {
    expect(parseRef("/studio/general#42")).toEqual({ server: "studio", channel: "general", seq: 42 });
  });

  it('parses "/studio/general/#42" as a thread ref (threadRootSeq)', () => {
    expect(parseRef("/studio/general/#42")).toEqual({
      server: "studio",
      channel: "general",
      threadRootSeq: 42,
    });
  });

  it('parses "/.dm/user_123" as a DM ref (server === DM_SERVER)', () => {
    const parsed = parseRef("/.dm/user_123");
    expect(parsed).toEqual({ server: DM_SERVER, channel: "user_123" });
    expect(parsed.server).toBe(".dm");
  });

  it("throws when the ref doesn't start with /", () => {
    expect(() => parseRef("studio/general")).toThrow();
  });

  it("throws when the ref has fewer than 2 segments", () => {
    expect(() => parseRef("/studio")).toThrow();
  });
});

describe("formatRef", () => {
  it("formats a plain channel", () => {
    expect(formatRef({ server: "studio", channel: "general" })).toBe("/studio/general");
  });

  it("formats a thread ref with threadRootSeq", () => {
    expect(formatRef({ server: "studio", channel: "general", threadRootSeq: 42 })).toBe(
      "/studio/general/#42"
    );
  });

  it("round-trips through parseRef for the thread form", () => {
    const ref = formatRef({ server: "studio", channel: "general", threadRootSeq: 7 });
    expect(parseRef(ref)).toEqual({ server: "studio", channel: "general", threadRootSeq: 7 });
  });
});

describe("formatSeq / parseSeq", () => {
  it("formatSeq prefixes with #", () => {
    expect(formatSeq(12)).toBe("#12");
  });

  it("parseSeq strips a leading # if present", () => {
    expect(parseSeq("#12")).toBe(12);
  });

  it("parseSeq accepts a bare number string too", () => {
    expect(parseSeq("12")).toBe(12);
  });

  it("parseSeq throws on a non-numeric value", () => {
    expect(() => parseSeq("#abc")).toThrow();
  });
});

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
    // Legacy/no-discriminator id form: no "#" in the segment, so it round-trips
    // through the PARSER unchanged — see Design §1. Resolution (not parsing) is
    // what changes once `resolve-ref.ts` requires a `name#0042` handle; this
    // parser-level case documents that the shape itself still parses fine.
    const parsed = parseRef("/.dm/user_123");
    expect(parsed).toEqual({ server: DM_SERVER, channel: "user_123" });
    expect(parsed.server).toBe(".dm");
  });

  it('parses "/.dm/gusye#1231" as a bare handle (no seq stripped)', () => {
    expect(parseRef("/.dm/gusye#1231")).toEqual({ server: DM_SERVER, channel: "gusye#1231" });
  });

  it('parses "/.dm/gusye#1231#42" as a pinned message on a handle peer', () => {
    expect(parseRef("/.dm/gusye#1231#42")).toEqual({ server: DM_SERVER, channel: "gusye#1231", seq: 42 });
  });

  it('parses "/.dm/gusye#1231/#42" as a thread rooted on a handle peer', () => {
    expect(parseRef("/.dm/gusye#1231/#42")).toEqual({
      server: DM_SERVER,
      channel: "gusye#1231",
      threadRootSeq: 42,
    });
  });

  it('parses "/.dm/a#b#0042" (name itself contains "#") with the documented ambiguity: peer="a#b", seq=42, NOT peer="a#b#0042"', () => {
    // Known, accepted footgun from the Breaking Changes section — asserting
    // it here means a future change to this behavior is a deliberate diff,
    // not a silent regression.
    expect(parseRef("/.dm/a#b#0042")).toEqual({ server: DM_SERVER, channel: "a#b", seq: 42 });
  });

  it("throws when the ref doesn't start with /", () => {
    expect(() => parseRef("studio/general")).toThrow();
  });

  it("throws when the ref has fewer than 2 segments", () => {
    expect(() => parseRef("/studio")).toThrow();
  });

  it('falls back to a plain-channel result for a DM ref with a non-numeric tail after "#" — does NOT throw', () => {
    // Regression guard: previously `parseRef("/.dm/foo#bar")` fell into
    // the `parseSeq(tail)` path and threw `bad seq: bar`, crashing any
    // caller not wrapped in try/catch (`mockServer.ts` in tests,
    // future callers in production). Now the whole segment is treated
    // as the channel/handle and the resolution layer
    // (`parseNameAndTag`) rejects the shape cleanly at its own boundary.
    expect(() => parseRef("/.dm/foo#bar")).not.toThrow();
    expect(parseRef("/.dm/foo#bar")).toEqual({ server: DM_SERVER, channel: "foo#bar" });
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

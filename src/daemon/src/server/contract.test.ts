import { describe, it, expect } from "vitest";
import { parseRef, formatRef, parseSeq, formatSeq, DM_SERVER } from "./contract";

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

describe("parseRef", () => {
  it("parses a plain channel ref", () => {
    expect(parseRef("/demo/general")).toEqual({ server: "demo", channel: "general" });
  });
  it("parses a message-pinned ref (#N on the channel segment)", () => {
    expect(parseRef("/demo/general#12")).toEqual({ server: "demo", channel: "general", seq: 12 });
  });
  it("parses a thread ref (/server/channel/#N)", () => {
    expect(parseRef("/demo/general/#5")).toEqual({ server: "demo", channel: "general", threadRootSeq: 5 });
  });
  it("parses a DM ref", () => {
    // No "#" in the segment — legacy/no-discriminator id form, round-trips
    // through the parser unchanged. Resolution (not parsing) is what changes
    // once the server requires a `name#0042` handle for DM refs.
    expect(parseRef("/.dm/gustavo")).toEqual({ server: DM_SERVER, channel: "gustavo" });
  });
  it("parses a DM ref that's a bare name#0042 handle (no seq stripped)", () => {
    expect(parseRef("/.dm/gusye#1231")).toEqual({ server: DM_SERVER, channel: "gusye#1231" });
  });
  it("parses a pinned message on a handle peer (/.dm/name#0042#N)", () => {
    expect(parseRef("/.dm/gusye#1231#42")).toEqual({ server: DM_SERVER, channel: "gusye#1231", seq: 42 });
  });
  it("parses a thread on a handle peer (/.dm/name#0042/#N)", () => {
    expect(parseRef("/.dm/gusye#1231/#42")).toEqual({
      server: DM_SERVER,
      channel: "gusye#1231",
      threadRootSeq: 42,
    });
  });
  it("rejects refs not starting with '/'", () => {
    expect(() => parseRef("demo/general")).toThrow(/must start with/);
  });
  it("rejects refs missing a channel segment", () => {
    expect(() => parseRef("/demo")).toThrow(/server.*channel/);
  });
});

describe("formatRef", () => {
  it("formats a plain channel ref", () => {
    expect(formatRef({ server: "demo", channel: "general" })).toBe("/demo/general");
  });
  it("formats a thread ref", () => {
    expect(formatRef({ server: "demo", channel: "general", threadRootSeq: 5 })).toBe("/demo/general/#5");
  });
  it("round-trips channel refs through parse→format", () => {
    const ref = "/demo/general";
    const p = parseRef(ref);
    expect(formatRef(p)).toBe(ref);
  });
});

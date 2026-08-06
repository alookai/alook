import { describe, it, expect } from "vitest";
import { parseRef, formatRef, formatCanonicalRef, formatSeq, parseSeq, DM_SERVER } from "../src/community-cli-contract";

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
    // caller not wrapped in try/catch. Now the whole segment is treated
    // as the channel/handle and the resolution layer
    // (`parseNameAndTag`) rejects the shape cleanly at its own boundary.
    expect(() => parseRef("/.dm/foo#bar")).not.toThrow();
    expect(parseRef("/.dm/foo#bar")).toEqual({ server: DM_SERVER, channel: "foo#bar" });
  });

  it('parses "/demo/general/#5#42" as a thread-reply message ref', () => {
    expect(parseRef("/demo/general/#5#42")).toEqual({
      server: "demo",
      channel: "general",
      threadRootSeq: 5,
      seq: 42,
    });
  });

  it('parses "/demo/general/#5" unchanged (regression)', () => {
    expect(parseRef("/demo/general/#5")).toEqual({
      server: "demo",
      channel: "general",
      threadRootSeq: 5,
    });
  });

  it('throws on "/demo/general/#5#" — empty seq tail (Number("") === 0 trap)', () => {
    expect(() => parseRef("/demo/general/#5#")).toThrow();
  });

  it('throws on "/demo/general/##5" — empty root', () => {
    expect(() => parseRef("/demo/general/##5")).toThrow();
  });

  it('throws on "/demo/general/#5#abc" — non-numeric seq', () => {
    expect(() => parseRef("/demo/general/#5#abc")).toThrow();
  });

  it('throws on "/demo/general/#5#42#7" — three tails, not two', () => {
    expect(() => parseRef("/demo/general/#5#42#7")).toThrow();
  });

  it('parses "/demo/general/#0#5" — parser stays permissive (server rejects root 0)', () => {
    expect(parseRef("/demo/general/#0#5")).toEqual({
      server: "demo",
      channel: "general",
      threadRootSeq: 0,
      seq: 5,
    });
  });

  it('parses "/demo/general/#5#0" — parser stays permissive (server rejects seq 0)', () => {
    expect(parseRef("/demo/general/#5#0")).toEqual({
      server: "demo",
      channel: "general",
      threadRootSeq: 5,
      seq: 0,
    });
  });

  it('throws on "/demo/general#5#42" — slashless form must NOT accept a trailing #M', () => {
    // The thread form requires the explicit `/#` separator. This shape is
    // ambiguous with the message form `/server/channel#N` and must be
    // rejected so callers can't sneak past the grammar.
    expect(() => parseRef("/demo/general#5#42")).toThrow();
  });

  it('parses "/.dm/gusye#1231/#5#42" — parser is DM-agnostic on thread form', () => {
    // Server rejects DM threads at resolve-ref.ts; the parser itself does
    // not know DM rules.
    expect(parseRef("/.dm/gusye#1231/#5#42")).toEqual({
      server: DM_SERVER,
      channel: "gusye#1231",
      threadRootSeq: 5,
      seq: 42,
    });
  });

  it('the old forum-post ref shape "/studio/ideas/my-post" no longer parses (no-compat, phase2 forum≡thread)', () => {
    // A post is now addressed like any other thread (by-root-seq), never by
    // its own child-name — the old 3-segment-no-hash form is GONE, not just
    // unsupported. A ref-render layer that fails to parse this degrades to
    // plain literal text (never a misresolved-to-wrong-target pill).
    expect(() => parseRef("/studio/ideas/my-post")).toThrow();
  });

  it("still parses the thread form (3rd segment starts with #) unaffected by the forum-post removal", () => {
    expect(parseRef("/studio/ideas/#5")).toEqual({ server: "studio", channel: "ideas", threadRootSeq: 5 });
  });

  it("throws on any 3+ segment ref whose last segment doesn't start with # (the old forum-post ref's territory)", () => {
    expect(() => parseRef("/studio/ideas/notes")).toThrow();
    expect(() => parseRef("/studio/ideas/post/extra")).toThrow();
    expect(() => parseRef("/studio/ideas/post#3")).toThrow();
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

  it("formats a thread-reply message ref (threadRootSeq + seq)", () => {
    expect(
      formatRef({ server: "studio", channel: "general", threadRootSeq: 5, seq: 42 }),
    ).toBe("/studio/general/#5#42");
  });

  it("round-trips through parseRef for the thread-reply form", () => {
    const input = { server: "studio", channel: "general", threadRootSeq: 5, seq: 42 };
    expect(parseRef(formatRef(input))).toEqual(input);
  });

  it("throws when seq is provided without threadRootSeq", () => {
    expect(() =>
      formatRef({ server: "studio", channel: "general", seq: 42 }),
    ).toThrow();
  });

  it("formats a plain channel ref unchanged (regression)", () => {
    expect(formatRef({ server: "studio", channel: "general" })).toBe("/studio/general");
  });

  it("formats a plain thread ref unchanged (regression)", () => {
    expect(formatRef({ server: "studio", channel: "general", threadRootSeq: 5 })).toBe(
      "/studio/general/#5",
    );
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

// The single canonical-ref emitter (B1 trait model, red-line ①). Dispatches the
// ref SHAPE off the channel type's addressing trait so every emit site (agent
// inbox, wake notice, listChannels) produces one addressing identity per type.
describe("formatCanonicalRef", () => {
  it("by-server-name (text): /server/name", () => {
    expect(formatCanonicalRef({ type: "text", serverName: "studio", name: "general" })).toBe("/studio/general");
  });

  it("by-server-name (forum): /server/name", () => {
    expect(formatCanonicalRef({ type: "forum", serverName: "studio", name: "ideas" })).toBe("/studio/ideas");
  });

  it("by-root-seq (thread): /server/channel/#rootSeq", () => {
    expect(
      formatCanonicalRef({ type: "thread", serverName: "studio", parentName: "general", rootSeq: 42 }),
    ).toBe("/studio/general/#42");
  });

  it("by-peer-identity (dm): /.dm/peer", () => {
    expect(formatCanonicalRef({ type: "dm", peerSegment: "gusye#1231" })).toBe("/.dm/gusye#1231");
  });

  // Round-trip: every emitted canonical ref must parse back to a ref that
  // resolves the same scope — the emitter and parser share the addressing model
  // so a ref a bot receives is one it can send/read/ack against (red-line ①).
  it("round-trips through parseRef for every addressing trait", () => {
    expect(parseRef(formatCanonicalRef({ type: "text", serverName: "studio", name: "general" })!)).toEqual({
      server: "studio",
      channel: "general",
    });
    expect(
      parseRef(formatCanonicalRef({ type: "thread", serverName: "studio", parentName: "general", rootSeq: 7 })!),
    ).toEqual({ server: "studio", channel: "general", threadRootSeq: 7 });
    expect(parseRef(formatCanonicalRef({ type: "dm", peerSegment: "gusye#1231" })!)).toEqual({
      server: DM_SERVER,
      channel: "gusye#1231",
    });
  });

  // Missing-field → null (not a bogus ref): a caller that can't resolve the
  // context an addressing value needs keeps its own fallback/skip handling
  // rather than emitting a ref that won't round-trip.
  it("returns null when a required addressing field is absent", () => {
    expect(formatCanonicalRef({ type: "text", serverName: "studio" })).toBeNull(); // no name
    expect(formatCanonicalRef({ type: "thread", serverName: "studio", parentName: "g" })).toBeNull(); // no rootSeq
    expect(formatCanonicalRef({ type: "dm" })).toBeNull(); // no peerSegment
  });
});

import { describe, it, expect } from "vitest";
import {
  parseRef,
  formatRef,
  formatSeq,
  parseSeq,
  DM_SERVER,
  parseRefToken,
  formatRefToken,
  sanitizeLabel,
  compactLabel,
  formatRefLabel,
  stripRefTokens,
} from "../src/community-cli-contract";

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

  it('parses "/studio/ideas/my-post" as a forum-post ref (childChannelName)', () => {
    expect(parseRef("/studio/ideas/my-post")).toEqual({
      server: "studio",
      channel: "ideas",
      childChannelName: "my-post",
    });
  });

  it("does not confuse a forum-post ref with a thread ref (3rd segment has no #)", () => {
    // Thread: 3rd segment starts with "#". Post: it doesn't.
    expect(parseRef("/studio/ideas/#5")).toEqual({ server: "studio", channel: "ideas", threadRootSeq: 5 });
    expect(parseRef("/studio/ideas/notes")).toEqual({ server: "studio", channel: "ideas", childChannelName: "notes" });
  });

  it("throws on a 4th segment (posts have no deeper addressing today)", () => {
    expect(() => parseRef("/studio/ideas/post/extra")).toThrow();
  });

  it('parses "/studio/ideas/post#3" — a message pinned inside a forum post', () => {
    // Symmetric to the top-level message form /server/channel#N — used by
    // `message emoji` to react to a specific message inside a post.
    expect(parseRef("/studio/ideas/post#3")).toEqual({
      server: "studio",
      channel: "ideas",
      childChannelName: "post",
      seq: 3,
    });
  });

  it("throws when a forum-post pin-seq ref has an empty post name (#N with no post)", () => {
    expect(() => parseRef("/studio/ideas/#3")).not.toThrow(); // this is the THREAD form, still valid
    expect(parseRef("/studio/ideas/#3")).toEqual({ server: "studio", channel: "ideas", threadRootSeq: 3 });
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

  it("formats a forum-post ref (childChannelName)", () => {
    expect(formatRef({ server: "studio", channel: "ideas", childChannelName: "my-post" })).toBe(
      "/studio/ideas/my-post",
    );
  });

  it("round-trips a forum-post ref through parseRef", () => {
    const input = { server: "studio", channel: "ideas", childChannelName: "my-post" };
    expect(parseRef(formatRef(input))).toEqual(input);
  });

  it("formats a forum-post message ref (childChannelName + seq)", () => {
    expect(formatRef({ server: "studio", channel: "ideas", childChannelName: "my-post", seq: 3 })).toBe(
      "/studio/ideas/my-post#3",
    );
  });

  it("round-trips a forum-post message ref through parseRef", () => {
    const input = { server: "studio", channel: "ideas", childChannelName: "my-post", seq: 3 };
    expect(parseRef(formatRef(input))).toEqual(input);
  });

  it("throws when childChannelName is combined with threadRootSeq (posts have no thread root)", () => {
    expect(() =>
      formatRef({ server: "studio", channel: "ideas", childChannelName: "p", threadRootSeq: 5 }),
    ).toThrow();
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

describe("ref token {label}(type/id) — shared parser (ref/id §3, reused by web + CLI)", () => {
  it("parses each whitelisted type into {label, type, id}", () => {
    expect(parseRefToken("{/Alook/general}(channel/K9f_rnJk)")).toEqual({
      label: "/Alook/general", type: "channel", id: "K9f_rnJk",
    });
    expect(parseRefToken("{/Alook/general#42}(message/m_ab)")).toEqual({
      label: "/Alook/general#42", type: "message", id: "m_ab",
    });
    expect(parseRefToken("{/Alook}(server/srv_x)")).toEqual({
      label: "/Alook", type: "server", id: "srv_x",
    });
  });

  it("returns null for a non-whitelisted type", () => {
    expect(parseRefToken("{/x}(user/u_1)")).toBeNull();
  });

  it("returns null unless the WHOLE string is exactly one token (no partial / embedded match)", () => {
    expect(parseRefToken("see {/Alook/general}(channel/c1) here")).toBeNull();
    expect(parseRefToken("{/Alook/general}(channel/c1) trailing")).toBeNull();
    expect(parseRefToken("")).toBeNull();
    expect(parseRefToken("/Alook/general")).toBeNull();
  });

  it("returns null on a malformed / shell-mangled fragment", () => {
    expect(parseRefToken("{/Alook/general}(channel")).toBeNull();
    expect(parseRefToken("/Alook/general}(channel/c1)")).toBeNull();
  });

  it("formatRefToken round-trips a well-formed token", () => {
    const tok = { label: "/Alook/general#42", type: "message" as const, id: "m_ab" };
    expect(parseRefToken(formatRefToken(tok))).toEqual(tok);
  });

  it("sanitizeLabel collapses a `}` (which would close the delimiter) to `_`", () => {
    expect(sanitizeLabel("/Alook/plan}b")).toBe("/Alook/plan_b");
    expect(formatRefToken({ label: "/Alook/plan}b", type: "channel", id: "c1" }))
      .toBe("{/Alook/plan_b}(channel/c1)");
  });
});

describe("compactLabel", () => {
  it("takes the last path segment", () => {
    expect(compactLabel("/Alook/general")).toBe("general");
    expect(compactLabel("/Alook/general#42")).toBe("general#42");
    expect(compactLabel("/Alook")).toBe("Alook");
  });
  it("trims a trailing slash and falls back to the whole label when there's no /", () => {
    expect(compactLabel("/Alook/general/")).toBe("general");
    expect(compactLabel("plain")).toBe("plain");
  });
});

describe("formatRefLabel — compact leaf + type sigil (ref/id PR-9)", () => {
  // The `/` prefix (not `#`) matches the app's `/server/channel` path grammar and
  // the body pill's slash glyph (Gener #305/#308, Faustine #314): app-internal
  // consistency over the Discord `#channel` habit.
  it("channel → /<leaf>", () => {
    expect(formatRefLabel("channel", "/Alook/general")).toBe("/general");
  });
  it("server → /<leaf> (same path style as channel)", () => {
    expect(formatRefLabel("server", "/Alook")).toBe("/Alook");
  });
  it("message → #<seq> (the trailing #N of the full-path label — seq grammar, not a channel sigil)", () => {
    expect(formatRefLabel("message", "/Alook/general#42")).toBe("#42");
    expect(formatRefLabel("message", "/Alook/general/#5#42")).toBe("#42");
  });
  it("message with no # in the label falls back to the compact leaf", () => {
    expect(formatRefLabel("message", "/Alook/general")).toBe("general");
  });
});

describe("stripRefTokens — plaintext preview formatter (ref/id PR-9)", () => {
  it("replaces each token with its compact display label", () => {
    expect(stripRefTokens("see {/Alook/general}(channel/K9f_rnJk) now")).toBe("see /general now");
    expect(stripRefTokens("in {/Alook}(server/srv_x)")).toBe("in /Alook");
    expect(stripRefTokens("re {/Alook/general#42}(message/m_ab)")).toBe("re #42");
  });
  it("handles multiple tokens in one string", () => {
    expect(stripRefTokens("{/A/x}(channel/c1) and {/A/y}(channel/c2)")).toBe("/x and /y");
  });
  it("leaves plain text (and a non-token) untouched", () => {
    expect(stripRefTokens("just words")).toBe("just words");
    expect(stripRefTokens("{/x}(user/u_1)")).toBe("{/x}(user/u_1)"); // non-whitelisted type: not a token
  });

  // BINARY INVARIANT (Aigneis #286/#290, Blondie #290): a plaintext surface must
  // NEVER expose the authoritative `(type/id)` half of a token — raw ids are not
  // for humans (#66). This is the CI backstop for "which surface leaked".
  it("output never contains a raw (channel|message|server)/<id> residue", () => {
    const RAW_ID = /\((?:channel|message|server)\/[A-Za-z0-9_-]+\)/;
    const inputs = [
      "see {/Alook/general}(channel/K9f_rnJk)",
      "{/Alook}(server/srv_x) and {/Alook/general#42}(message/m_ab)",
      "prefix {/总部-🎉/架构}(channel/nfvEw1) suffix",
      "{/A/x}(channel/c1){/A/y}(channel/c2)",
    ];
    for (const raw of inputs) {
      expect(RAW_ID.test(stripRefTokens(raw))).toBe(false);
    }
  });
});

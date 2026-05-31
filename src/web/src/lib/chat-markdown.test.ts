import { describe, it, expect } from "vitest";
import { decodeChatEntities } from "./chat-markdown";

/**
 * `@tiptap/markdown` HTML-entity-encodes `<` `>` `&` in plain text when
 * serializing. The chat wire format must stay the raw typed string (parity with
 * the old textarea), so the composer decodes exactly those three. These tests
 * lock that behavior and guard the `&amp;`-last ordering.
 */
describe("decodeChatEntities", () => {
  it("decodes the three HTML entities the serializer emits", () => {
    expect(decodeChatEntities("a &lt; b &amp;&amp; c &gt; d")).toBe("a < b && c > d");
  });

  it("decodes <Component /> style text", () => {
    expect(decodeChatEntities("use &lt;Component /&gt; here")).toBe("use <Component /> here");
  });

  it("leaves text without entities untouched", () => {
    expect(decodeChatEntities("plain @Alice - list 1. item")).toBe(
      "plain @Alice - list 1. item",
    );
  });

  it("decodes &amp; last so a literal typed entity round-trips", () => {
    // User types the literal text "&lt;". The serializer escapes the `&` to
    // "&amp;lt;". Decoding &amp; LAST yields "&lt;" (the typed text), not "<".
    expect(decodeChatEntities("&amp;lt;")).toBe("&lt;");
  });

  it("does not touch markdown punctuation", () => {
    expect(decodeChatEntities("a*b_c`d# heading")).toBe("a*b_c`d# heading");
  });

  it("handles empty string", () => {
    expect(decodeChatEntities("")).toBe("");
  });
});

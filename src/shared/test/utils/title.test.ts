import { describe, it, expect } from "vitest";
import { truncateTitle, stripInlineMarkup, deriveThreadName } from "../../src/utils/title";

describe("truncateTitle", () => {
  it("collapses runs of whitespace into single spaces", () => {
    expect(truncateTitle("hello   \n\t  world")).toBe("hello world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(truncateTitle("   padded title   ")).toBe("padded title");
  });

  it("returns the text unchanged when at or under the cap", () => {
    const exact = "a".repeat(50);
    expect(truncateTitle(exact)).toBe(exact);
    expect(truncateTitle("short")).toBe("short");
  });

  it("caps at a word boundary and appends an ellipsis", () => {
    // 60-char input, last space before the 50-char cut is after "boundary".
    const text =
      "the quick brown fox jumps over the lazy dog near a boundary marker";
    const out = truncateTitle(text);
    expect(out.endsWith("...")).toBe(true);
    expect(out).not.toContain("  ");
    // Cut on a space, never mid-word.
    expect(out.slice(0, -3).endsWith(" ")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(53); // <=50 word-boundary cut + "..."
  });

  it("hard-cuts mid-word when there's no late-enough space (lastSpace <= 20)", () => {
    // One long token (no spaces) — lastSpace is -1, so it slices at maxLen.
    const text = "x".repeat(80);
    const out = truncateTitle(text);
    expect(out).toBe("x".repeat(50) + "...");
  });

  it("respects a custom maxLen", () => {
    expect(truncateTitle("hello world", 5)).toBe("hello...");
  });
});

describe("stripInlineMarkup", () => {
  it("unwraps ||spoiler|| to its inner text", () => {
    expect(stripInlineMarkup("a ||secret|| b")).toBe("a secret b");
  });

  it("removes HTML/XML-style tags but keeps their text", () => {
    expect(stripInlineMarkup("<spoiler>secret</spoiler> plan")).toBe("secret plan");
    expect(stripInlineMarkup("line<br/>break")).toBe("linebreak");
  });

  it("strips bold/emphasis/strike markers", () => {
    expect(stripInlineMarkup("**bold** _em_ ~~gone~~ *i* __u__")).toBe("bold em gone i u");
  });

  it("keeps inner text of inline and fenced code", () => {
    expect(stripInlineMarkup("run `npm test` now")).toBe("run npm test now");
    expect(stripInlineMarkup("```ts\nconst x = 1\n```")).toBe("const x = 1\n");
  });

  it("strips leading block markers (heading, quote, list)", () => {
    expect(stripInlineMarkup("# Title")).toBe("Title");
    expect(stripInlineMarkup("> quote")).toBe("quote");
    expect(stripInlineMarkup("- item")).toBe("item");
    expect(stripInlineMarkup("1. first")).toBe("first");
  });

  it("keeps link/image label text", () => {
    expect(stripInlineMarkup("see [the docs](https://x.io)")).toBe("see the docs");
    expect(stripInlineMarkup("![alt text](a.png) after")).toBe("alt text after");
    expect(stripInlineMarkup("ref [label][1]")).toBe("ref label");
  });

  it("drops a @mention discriminator but keeps unicode names", () => {
    expect(stripInlineMarkup("hi @李四#0042 there")).toBe("hi @李四 there");
  });

  it("compacts a {}() ref token to its labelled leaf (never the raw (type/id))", () => {
    // ref/id PR-9: stripInlineMarkup now runs stripRefTokens first, so a body
    // preview / derived title never shows the raw token.
    expect(stripInlineMarkup("see {/Alook/general}(channel/K9f_rnJk) now")).toBe("see /general now");
    expect(stripInlineMarkup("in {/Alook}(server/srv_x)")).toBe("in /Alook");
    expect(stripInlineMarkup("re {/Alook/general#42}(message/m_ab)")).toBe("re #42");
    expect(stripInlineMarkup("{/Alook/general}(channel/c1)")).not.toMatch(/\(channel\/[A-Za-z0-9_-]+\)/);
  });
});

describe("deriveThreadName", () => {
  it("strips markup then keeps the first six words", () => {
    expect(deriveThreadName("||secret|| plan **for** the big launch today", "fallback")).toBe(
      "secret plan for the big launch",
    );
  });

  it("caps at 60 chars", () => {
    const long = deriveThreadName("a".repeat(80), "fallback");
    expect(long.length).toBeLessThanOrEqual(60);
  });

  it("falls back when the body yields no readable text", () => {
    expect(deriveThreadName("", "General")).toBe("General");
    expect(deriveThreadName("   \n\t ", "General")).toBe("General");
    expect(deriveThreadName(null, "General")).toBe("General");
    expect(deriveThreadName("<br/>", "General")).toBe("General");
  });

  it("collapses whitespace across lines", () => {
    expect(deriveThreadName("first\n\n\nsecond", "fallback")).toBe("first second");
  });
});

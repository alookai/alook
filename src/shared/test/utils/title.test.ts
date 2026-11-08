import { describe, it, expect } from "vitest";
import { deriveThreadName } from "../../src/utils/title";
import { messagePreviewText } from "../../src/lib/message-preview";

const previewText = (content: string) => messagePreviewText({ content });

describe("semantic message preview", () => {
  it("masks spoiler text", () => {
    expect(previewText("a ||secret|| b")).toBe("a [Spoiler] b");
  });

  it("retains literal typed HTML", () => {
    expect(previewText("<spoiler>secret</spoiler> plan")).toBe("<spoiler>secret</spoiler> plan");
    expect(previewText("line<br/>break")).toBe("line<br/>break");
  });

  it("strips bold/emphasis/strike markers", () => {
    expect(previewText("**bold** _em_ ~~gone~~ *i* __u__")).toBe("bold em gone i u");
  });

  it("keeps inner text of inline and fenced code", () => {
    expect(previewText("run `npm test` now")).toBe("run npm test now");
    expect(previewText("```ts\nconst x = 1\n```")).toBe("Code: const x = 1");
  });

  it("strips leading block markers (heading, quote, list)", () => {
    expect(previewText("# Title")).toBe("Title");
    expect(previewText("> quote")).toBe("quote");
    expect(previewText("- item")).toBe("item");
    expect(previewText("1. first")).toBe("first");
  });

  it("keeps link/image label text", () => {
    expect(previewText("see [the docs](https://x.io)")).toBe("see the docs");
    expect(previewText("![alt text](a.png) after")).toBe("Photo: alt text after");
    expect(previewText("ref [label][1]")).toBe("ref [label][1]");
  });

  it("keeps a @mention discriminator but keeps unicode names", () => {
    expect(previewText("hi @Zoë#0042 there")).toBe("hi @Zoë#0042 there");
  });
});

describe("deriveThreadName", () => {
  it("strips markup then keeps the first six words", () => {
    expect(deriveThreadName("||secret|| plan **for** the big launch today", "fallback")).toBe(
      "[Spoiler] plan for the big launch",
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
    expect(deriveThreadName("<br/>", "General")).toBe("<br/>");
  });

  it("collapses whitespace across lines", () => {
    expect(deriveThreadName("first\n\n\nsecond", "fallback")).toBe("first second");
  });
});

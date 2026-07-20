import { describe, expect, it } from "vitest";
import {
  CANONICAL_PRODUCT_SLUG,
  PRODUCT_BOILERPLATE,
  checkBlogEditorial,
  countExternalLinks,
  countWords,
  firstNWords,
  paragraphLengthStdev,
  parseMdxFile,
  sentenceCount,
  splitParagraphs,
  stripMdxForProse,
} from "./check-editorial";

describe("stripMdxForProse", () => {
  it("removes metadata and code blocks", () => {
    const content = [
      'export const metadata = { title: "T", slug: "demo" };',
      "",
      "```js",
      "code()",
      "```",
      "",
      "Hello world.",
    ].join("\n");
    expect(stripMdxForProse(content)).toBe("Hello world.");
  });
});

describe("parseMdxFile", () => {
  it("reads title from metadata export", () => {
    const parsed = parseMdxFile(
      "demo",
      'export const metadata = { title: "Short title", slug: "demo" };\n\nBody text.'
    );
    expect(parsed.title).toBe("Short title");
    expect(parsed.bodyProse).toContain("Body text.");
  });
});

describe("paragraphLengthStdev", () => {
  it("returns low stdev for uniform paragraphs", () => {
    const paragraphs = ["One. Two.", "Three. Four.", "Five. Six."];
    expect(paragraphLengthStdev(paragraphs)).toBeLessThanOrEqual(1.5);
  });

  it("returns higher stdev for mixed lengths", () => {
    const paragraphs = ["One.", "Two. Three. Four. Five. Six.", "Seven."];
    expect(paragraphLengthStdev(paragraphs)).toBeGreaterThan(1.5);
  });
});

describe("countExternalLinks", () => {
  it("counts third-party links and ignores alook", () => {
    const md = [
      "[HBR](https://hbr.org/example)",
      "[Docs](https://code.claude.com/docs)",
      "[Alook](https://alook.ai)",
      "[GH](https://github.com/alookai/alook)",
    ].join("\n");
    expect(countExternalLinks(md)).toBe(2);
  });
});

describe("checkBlogEditorial", () => {
  it("fails when title exceeds 60 characters", () => {
    const longTitle = "A".repeat(61);
    const findings = checkBlogEditorial([
      parseMdxFile(
        "demo",
        `export const metadata = { title: "${longTitle}" };\n\nBody with enough words. [a](https://example.com/a) [b](https://example.com/b)`
      ),
    ]);
    expect(findings.some((f) => f.rule === "title-length" && f.severity === "fail")).toBe(
      true
    );
  });

  it("fails when opening 100 words mention alook.ai", () => {
    const findings = checkBlogEditorial([
      parseMdxFile(
        "demo",
        'export const metadata = { title: "T" };\n\nVisit [Alook](https://alook.ai) first. More text here with [a](https://example.com/a) and [b](https://example.com/b).'
      ),
    ]);
    expect(findings.some((f) => f.rule === "opening-alook")).toBe(true);
  });

  it("warns on corpus product boilerplate duplication", () => {
    const body = `${PRODUCT_BOILERPLATE}\n\nExtra. [a](https://a.com) [b](https://b.com)`;
    const findings = checkBlogEditorial([
      parseMdxFile(CANONICAL_PRODUCT_SLUG, `export const metadata = { title: "T" };\n\n${body}`),
      parseMdxFile("other-post", `export const metadata = { title: "T" };\n\n${body}`),
    ]);
    expect(findings.some((f) => f.rule === "corpus-product-boilerplate")).toBe(true);
  });

  it("passes a minimal valid post", () => {
    const content = [
      'export const metadata = { title: "Agent teams" };',
      "",
      "Stripe webhooks failed twice last week before we fixed handoffs.",
      "",
      "See [HBR](https://hbr.org/2026/06/example) and [Anthropic](https://code.claude.com/docs).",
    ].join("\n");
    const findings = checkBlogEditorial([parseMdxFile("good-post", content)]);
    expect(findings.filter((f) => f.severity === "fail")).toEqual([]);
  });
});

describe("sentenceCount", () => {
  it("counts sentences in a paragraph", () => {
    expect(sentenceCount("One. Two! Three?")).toBe(3);
    expect(sentenceCount("Single")).toBe(1);
  });
});

describe("firstNWords", () => {
  it("returns the first n words", () => {
    expect(firstNWords("alpha beta gamma", 2)).toBe("alpha beta");
  });
});

describe("splitParagraphs", () => {
  it("splits on blank lines", () => {
    expect(splitParagraphs("A\n\nB")).toEqual(["A", "B"]);
  });
});

describe("countWords", () => {
  it("counts words", () => {
    expect(countWords("one two three")).toBe(3);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const article = readFileSync(new URL("./alook-vs-buzz.mdx", import.meta.url), "utf8");

function faqPairs() {
  const [schema, body] = article.split("\n];\n\n", 2);
  const schemaPairs = Array.from(
    schema.matchAll(
      /name: ("(?:\\.|[^"\\])*"),\s*acceptedAnswer: \{\s*"@type": "Answer",\s*text: ("(?:\\.|[^"\\])*"),/g,
    ),
    ([, question, answer]) => ({
      question: JSON.parse(question) as string,
      answer: JSON.parse(answer) as string,
    }),
  );
  const faqBody = body.split("## FAQ\n\n", 2)[1];
  const visiblePairs = Array.from(
    faqBody.matchAll(/### ([^\n]+)\n\n([^\n]+)/g),
    ([, question, answer]) => ({ question, answer }),
  );
  return { schemaPairs, visiblePairs };
}

describe("Alook vs Buzz article", () => {
  it("keeps all four FAQPage answers identical to the visible FAQ", () => {
    const { schemaPairs, visiblePairs } = faqPairs();
    expect(schemaPairs).toHaveLength(4);
    expect(visiblePairs).toEqual(schemaPairs);
  });

  it("preserves the source boundary and locked hero description", () => {
    expect(article).toContain("This comparison follows published docs; we have not run a hands-on benchmark.");
    expect(article).toContain(
      "![Illustration comparing two shared workspaces, each with two people and two AI agents around a table with chat, document, workflow, and folder icons.](/blog/alook-vs-buzz/hero.webp)",
    );
  });
});

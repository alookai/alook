import { describe, expect, it } from "vitest";
import { validateStepGuide } from "./validate-step-guides";

const guide = { slug: "two-agents", title: "Two agents" };
const html = `<title>Two agents</title><meta name="description" content="Connect two agents"><meta property="og:image" content="https://alook.ai/og.png"><link rel="canonical" href="https://alook.ai/guides/two-agents"><main><article data-step-guide="two-agents"><h1>Two agents</h1>${["one", "two", "three", "four"].map((id) => `<section id="${id}"><h2>${id}</h2><p>${"Complete this step using your own account. ".repeat(5)}</p></section>`).join("")}<a href="#one">Start</a><a href="/c">Open Alook</a></article></main><footer>Home</footer>`;

describe("step guide rendered contract", () => {
  it("accepts complete server-rendered content without scripts", () => {
    expect(validateStepGuide(html, guide)).toEqual([]);
  });
  it.each([
    ['<h1>Two agents</h1>', '', 'matching H1'],
    ['https://alook.ai/guides/two-agents', 'https://alook.ai/blog/two-agents', 'canonical'],
    ['href="#one"', 'href="#missing"', 'anchor target'],
    ['<footer>Home</footer>', '', 'footer'],
    ['<h2>four</h2>', '', 'step headings'],
  ])("rejects incomplete output %s", (from, to, expected) => {
    expect(validateStepGuide(html.replace(from, to), guide).join()).toContain(expected);
  });
});

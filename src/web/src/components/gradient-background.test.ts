import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GradientBackground } from "./gradient-background";

describe("GradientBackground", () => {
  it("renders the shared app background token", () => {
    const markup = renderToStaticMarkup(createElement(GradientBackground));

    expect(markup).toContain("bg-(--app-bg)");
  });

  it("keeps the app rail and document on the chat background in both themes", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

    expect(css).toMatch(/:root\s*\{[^}]*--app-bg:\s*var\(--background\);/s);
    expect(css).toMatch(/\.dark\s*\{[^}]*--app-bg:\s*var\(--background\);/s);
    expect(css).toMatch(
      /html,\s*body\s*\{[^}]*background-color:\s*var\(--background\);/s,
    );
  });
});

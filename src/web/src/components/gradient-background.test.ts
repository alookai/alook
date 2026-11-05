import rawContractInput0 from "../app/globals.css?raw"
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GradientBackground } from "./gradient-background";

describe("GradientBackground", () => {
  it("renders the shared app frame token", () => {
    const markup = renderToStaticMarkup(createElement(GradientBackground));

    expect(markup).toContain("bg-(--app-frame)");
  });

  it("keeps the default reading surface and document fallback in both themes", () => {
    const css = rawContractInput0;

    expect(css).toMatch(/:root\s*\{[^}]*--app-bg:\s*var\(--background\);/s);
    expect(css).toMatch(/\.dark\s*\{[^}]*--app-bg:\s*var\(--background\);/s);
    expect(css).toMatch(
      /html,\s*body\s*\{[^}]*background-color:\s*var\(--background\);/s,
    );
  });
});

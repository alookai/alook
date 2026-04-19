import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GradientBackground } from "./gradient-background";

describe("GradientBackground", () => {
  it("limits the noise overlay to dark mode", () => {
    const markup = renderToStaticMarkup(createElement(GradientBackground));

    expect(markup).toContain("hidden");
    expect(markup).toContain("dark:block");
    expect(markup).toContain("dark:mix-blend-overlay");
  });
});

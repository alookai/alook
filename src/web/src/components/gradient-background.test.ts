import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GradientBackground } from "./gradient-background";

describe("GradientBackground", () => {
  it("renders a light-mode background with dark transparent override", () => {
    const markup = renderToStaticMarkup(createElement(GradientBackground));

    expect(markup).toContain("bg-[oklch(0.93_0.015_80)]");
    expect(markup).toContain("dark:bg-transparent");
  });
});

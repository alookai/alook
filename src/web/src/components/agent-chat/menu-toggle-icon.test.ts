import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MenuToggleIcon } from "./menu-toggle-icon";

describe("MenuToggleIcon", () => {
  it("renders Menu icon visible and X icon hidden when closed", () => {
    const markup = renderToStaticMarkup(
      createElement(MenuToggleIcon, { open: false }),
    );

    expect(markup).toContain("opacity-100 rotate-0 scale-100");
    expect(markup).toContain("opacity-0 -rotate-90 scale-75");
  });

  it("renders Menu icon hidden and X icon visible when open", () => {
    const markup = renderToStaticMarkup(
      createElement(MenuToggleIcon, { open: true }),
    );

    expect(markup).toContain("opacity-0 rotate-90 scale-75");
    expect(markup).toContain("opacity-100 rotate-0 scale-100");
  });

  it("wraps icons in a relative container", () => {
    const markup = renderToStaticMarkup(
      createElement(MenuToggleIcon, { open: false }),
    );

    expect(markup).toContain("relative size-4");
  });

  it("applies transition classes to both icons", () => {
    const markup = renderToStaticMarkup(
      createElement(MenuToggleIcon, { open: false }),
    );

    expect(markup).toContain("transition-all duration-200");
  });
});

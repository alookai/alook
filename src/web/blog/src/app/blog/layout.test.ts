import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: "theme-toggle",
}));

vi.mock("@/components/public-layout", () => ({
  PublicLayout: "public-layout",
}));

vi.mock("@/components/github-outbound-link", () => ({
  GithubOutboundBoundary: "github-outbound-boundary",
}));

import BlogLayout from "./layout";

describe("BlogLayout", () => {
  it("wraps blog content in the outbound GitHub analytics boundary", () => {
    const child = createElement("article", null, "Post");
    const layout = BlogLayout({ children: child });

    expect(layout.type).toBe("public-layout");
    expect(layout.props).toMatchObject({
      zone: "blog",
      breadcrumb: "Blog",
      footer: "rich",
    });
    expect(layout.props.rightSlot.type).toBe("theme-toggle");
    expect(layout.props.children.type).toBe("github-outbound-boundary");
    expect(layout.props.children.props).toEqual({
      surface: "blog",
      children: child,
    });
  });
});

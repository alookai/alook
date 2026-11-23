import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./blog-footer", () => ({ BlogFooter: "blog-footer" }));

vi.mock("@blog/components/blog/blog-nav-actions", () => ({
  BlogNavCenter: "blog-nav-center",
  BlogNavRight: "blog-nav-right",
}));

vi.mock("@/components/public-layout", () => ({
  PublicLayout: "public-layout",
}));

vi.mock("@/components/github-outbound-link", () => ({
  GithubOutboundBoundary: "github-outbound-boundary",
}));

import BlogLayout from "./layout";

describe("BlogLayout", () => {
  it("wraps blog content with navigation, conversion actions, and outbound GitHub boundary", () => {
    const child = createElement("article", null, "Post");
    const layout = BlogLayout({ children: child });

    expect(layout.type).toBe("public-layout");
    expect(layout.props).toMatchObject({
      zone: "blog",
      breadcrumb: "Blog",
      footer: expect.objectContaining({ type: "blog-footer" }),
    });
    expect(layout.props.centerSlot.type).toBe("blog-nav-center");
    expect(layout.props.rightSlot.type).toBe("blog-nav-right");
    expect(layout.props.children.type).toBe("github-outbound-boundary");
    expect(layout.props.children.props).toEqual({
      surface: "blog",
      children: child,
    });
  });
});

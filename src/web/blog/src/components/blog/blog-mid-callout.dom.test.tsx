import { render, waitFor } from "@/test/react-dom-harness";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics", () => ({
  trackLandingCtaClicked: vi.fn(),
}));

import { BlogMidCallout } from "./blog-mid-callout";
import { getBlogConversionCopy } from "@blog/lib/blog/conversion-copy";

describe("BlogMidCallout", () => {
  const copy = getBlogConversionCopy("coding-agents").mid;

  it("inserts one image-free callout before the 3rd H2 for posts with >= 4 H2 headings and cleans up on unmount", async () => {
    const { container, unmount } = render(
      <>
        <div className="blog-content blog-prose" data-blog-prose>
          <h2 id="one">One</h2>
          <p>P1</p>
          <h2 id="two">Two</h2>
          <p>P2</p>
          <h2 id="three">Three</h2>
          <p>P3</p>
          <h2 id="four">Four</h2>
          <p>P4</p>
        </div>
        <BlogMidCallout copy={copy} headingCount={4} />
      </>,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="blog-mid-callout"]')).not.toBeNull();
    });

    const host = container.querySelector("[data-blog-callout]")!;
    expect(host.nextElementSibling?.id).toBe("three");
    expect(host.querySelectorAll("img")).toHaveLength(0);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/sign-in?cta_placement=blog-mid");

    unmount();
    expect(document.querySelector("[data-blog-callout]")).toBeNull();
  });

  it("does not inject a callout for short posts (< 4 H2 headings)", () => {
    const { container } = render(
      <>
        <div className="blog-content blog-prose" data-blog-prose>
          <h2 id="one">One</h2>
          <h2 id="two">Two</h2>
          <h2 id="three">Three</h2>
        </div>
        <BlogMidCallout copy={copy} headingCount={3} />
      </>,
    );

    expect(container.querySelector("[data-blog-callout]")).toBeNull();
  });
});

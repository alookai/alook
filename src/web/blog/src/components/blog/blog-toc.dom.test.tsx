import { fireEvent, render, waitFor } from "@/test/react-dom-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics", () => ({
  trackLandingCtaClicked: vi.fn(),
}));

import { BlogToc } from "./blog-toc";

describe("BlogToc", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders Stageshow TOC links, share actions, Try Alook button with 3 perched bots, and copies canonical URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const { container } = render(
      <BlogToc
        headings={[
          { id: "first-section", text: "First Section" },
          { id: "second-section", text: "Second Section" },
        ]}
        title="Claude Code & Codex"
        slug="claude-code-and-codex-same-team"
      />,
    );

    const links = [...container.querySelectorAll('[data-testid="blog-toc"] a')];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#first-section",
      "#second-section",
    ]);
    expect(container.querySelector('[data-testid="blog-toc-indicator"]')).not.toBeNull();

    const xLink = container.querySelector('[data-testid="blog-share-x"]') as HTMLAnchorElement;
    expect(xLink.href).toContain("https://x.com/intent/tweet?");
    expect(xLink.href).toContain(encodeURIComponent("https://alook.ai/blog/claude-code-and-codex-same-team"));

    const tryBtn = container.querySelector('[data-testid="blog-sidebar-try-alook"]') as HTMLAnchorElement;
    expect(tryBtn.getAttribute("href")).toBe("/sign-in?cta_placement=blog-sidebar");
    expect(container.querySelectorAll('[data-testid="blog-try-alook-bots"] svg')).toHaveLength(3);

    const copyBtn = container.querySelector('[data-testid="blog-share-copy"]') as HTMLButtonElement;
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledOnce();
      expect(copyBtn.textContent).toContain("Copied");
    });
  });
});

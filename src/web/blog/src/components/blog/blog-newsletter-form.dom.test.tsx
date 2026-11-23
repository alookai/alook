import { fireEvent, render, waitFor } from "@/test/react-dom-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trackMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({
  trackBlogNewsletterSubscribed: (...args: unknown[]) => trackMock(...args),
}));

import { BlogNewsletterForm } from "./blog-newsletter-form";

describe("BlogNewsletterForm", () => {
  beforeEach(() => {
    trackMock.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders unique end form IDs without collisions", () => {
    const { container } = render(<BlogNewsletterForm placement="end" slug="test-post" />);
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("blog-newsletter-email-end");
  });

  it("submits email to /api/newsletter/subscribe and tracks analytics on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ ok: true, status: "subscribed" }, { status: 200 }),
    );
    const { container } = render(<BlogNewsletterForm placement="end" slug="claude-code-and-codex-same-team" />);
    const input = container.querySelector("#blog-newsletter-email-end") as HTMLInputElement;
    const form = container.querySelector("form")!;

    fireEvent.change(input, { target: { value: "reader@example.com" } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Subscribed");
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/newsletter/subscribe",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(trackMock).toHaveBeenCalledWith({
      placement: "end",
      sourcePath: "/blog/claude-code-and-codex-same-team",
    });
    expect(input.value).toBe("");
  });

  it("shows rate limit and server error messages without firing analytics", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ error: "Too many attempts" }, { status: 429 }),
    );
    const { container } = render(<BlogNewsletterForm placement="end" slug="test-post" />);
    const input = container.querySelector("#blog-newsletter-email-end") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "reader@example.com" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Too many attempts");
    });
    expect(trackMock).not.toHaveBeenCalled();
  });
});

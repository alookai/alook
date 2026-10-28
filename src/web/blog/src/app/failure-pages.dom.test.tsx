import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, setupUser } from "@/test/react-dom-harness";
import BlogError from "./error";
import BlogNotFound, { metadata } from "./not-found";

vi.mock("@/components/typewriter-visual", () => ({
  TypewriterVisual: ({ paper }: { paper: ReactNode }) => <div>{paper}</div>,
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a data-next-link="true" {...props}>{children}</a>,
}));

describe("Blog recovery routes", () => {
  it("passes the retry callback through the lazy error screen and leaves the Blog zone for home", async () => {
    const reset = vi.fn();
    const user = setupUser();
    render(<BlogError error={new Error("Render failed")} reset={reset} />);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Go home" })).not.toHaveAttribute("data-next-link");
  });

  it("keeps missing pages out of search and gives a document link home", async () => {
    render(<BlogNotFound />);
    expect(await screen.findByText(/The page you're looking for/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Go home" })).not.toHaveAttribute("data-next-link");
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
});

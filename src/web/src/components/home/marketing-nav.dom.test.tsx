import React, { type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/react-dom-harness";

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) =>
    <a {...props} data-prefetch={prefetch === false ? "disabled" : "auto"} />,
}));
vi.mock("@/lib/analytics", () => ({ trackLandingCtaClicked: vi.fn(), trackGithubOutboundClicked: vi.fn() }));

import { MarketingNav } from "./marketing-nav";

afterEach(() => vi.restoreAllMocks());

it("defers route prefetch until the homepage navigation is revealed, without changing link destinations", () => {
  let bottom = 100;
  const { container } = render(<><section className="hero-section" /><MarketingNav isLoggedIn={false} revealAfterHero collapseLinksOnMobile /></>);
  vi.spyOn(container.querySelector(".hero-section")!, "getBoundingClientRect").mockImplementation(() => ({ bottom }) as DOMRect);
  fireEvent.scroll(window);
  for (const link of container.querySelectorAll("[data-prefetch]")) expect(link).toHaveAttribute("data-prefetch", "disabled");
  expect(screen.getAllByRole("link", { name: "Pricing" })[0]).toHaveAttribute("href", "/pricing");
  bottom = -1;
  fireEvent.scroll(window);
  for (const link of container.querySelectorAll("[data-prefetch]")) expect(link).toHaveAttribute("data-prefetch", "auto");
  bottom = 100;
  fireEvent.scroll(window);
  for (const link of container.querySelectorAll("[data-prefetch]")) expect(link).toHaveAttribute("data-prefetch", "disabled");
});

it("preserves default prefetch outside the homepage reveal behavior", () => {
  const { container } = render(<MarketingNav isLoggedIn={false} />);
  for (const link of container.querySelectorAll("[data-prefetch]")) expect(link).toHaveAttribute("data-prefetch", "auto");
});

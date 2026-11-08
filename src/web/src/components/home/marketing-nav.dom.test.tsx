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

function prefetchLinks(container: HTMLElement) {
  const links = container.querySelectorAll("[data-prefetch]");
  expect(links.length).toBeGreaterThan(0);
  return links;
}

it("defers route prefetch until the homepage navigation is revealed, without changing link destinations", () => {
  let bottom = 100;
  const { container } = render(<><section className="hero-section" data-testid="foreign-hero" /><div className="landing"><section className="hero-section" data-testid="owned-hero" /><MarketingNav isLoggedIn={false} revealAfterHero collapseLinksOnMobile /></div></>);
  vi.spyOn(screen.getByTestId("foreign-hero"), "getBoundingClientRect").mockReturnValue({ bottom: -1 } as DOMRect);
  vi.spyOn(screen.getByTestId("owned-hero"), "getBoundingClientRect").mockImplementation(() => ({ bottom }) as DOMRect);
  fireEvent.scroll(window);
  for (const link of prefetchLinks(container)) expect(link).toHaveAttribute("data-prefetch", "disabled");
  expect(screen.getAllByRole("link", { name: "Pricing" })[0]).toHaveAttribute("href", "/pricing");
  bottom = -1;
  fireEvent.scroll(window);
  for (const link of prefetchLinks(container)) expect(link).toHaveAttribute("data-prefetch", "auto");
  bottom = 100;
  fireEvent.scroll(window);
  for (const link of prefetchLinks(container)) expect(link).toHaveAttribute("data-prefetch", "disabled");
});

it("preserves default prefetch outside the homepage reveal behavior", () => {
  const { container } = render(<MarketingNav isLoggedIn={false} />);
  expect(screen.getByRole("link", { name: /^Pricing$/ })).toHaveAttribute("href", "/pricing");
  for (const link of prefetchLinks(container)) expect(link).toHaveAttribute("data-prefetch", "auto");
});

it.each(["touch", "mouse"])("dismisses mobile navigation on an outside %s pointer without swallowing inside interaction", (pointerType) => {
  const { container } = render(<><button>Outside</button><MarketingNav isLoggedIn={false} collapseLinksOnMobile /></>);
  const summary = screen.getByLabelText("Open navigation menu");
  const menu = container.querySelector("details")!;
  fireEvent.click(summary);
  expect(menu.open).toBe(true);
  fireEvent.pointerDown(menu.querySelector("a")!, { pointerType });
  expect(menu.open).toBe(true);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }), { pointerType });
  expect(menu.open).toBe(false);
  fireEvent.click(summary);
  expect(menu.open).toBe(true);
  fireEvent.pointerDown(document.body, { pointerType });
  expect(menu.open).toBe(false);
});

it("closes mobile navigation with Escape and restores its disclosure focus", () => {
  const { container } = render(<MarketingNav isLoggedIn={false} collapseLinksOnMobile />);
  const summary = screen.getByLabelText("Open navigation menu");
  const menu = container.querySelector("details")!;
  fireEvent.click(summary);
  expect(menu.open).toBe(true);
  menu.querySelector("a")!.focus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(menu.open).toBe(false);
  expect(summary).toHaveFocus();
});

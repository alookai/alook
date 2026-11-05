import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/react-dom-harness";
import { HeroScrollCue } from "./hero-scroll-cue";

afterEach(() => vi.unstubAllGlobals());

describe("hero scroll cue", () => {
  it.each([false, true])("moves to the product section with reduced motion %s", (reduced) => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
    render(<><HeroScrollCue targetId="product" /><section id="product" tabIndex={-1}><div data-landing-scroll-anchor>Product</div></section></>);
    const product = document.getElementById("product")!;
    const scroll = vi.fn();
    const anchor = product.querySelector<HTMLElement>("[data-landing-scroll-anchor]")!;
    product.getBoundingClientRect = () => ({ top: 900 } as DOMRect);
    anchor.getBoundingClientRect = () => ({ top: 1000 } as DOMRect);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 6000 });
    vi.stubGlobal("scrollTo", scroll);
    fireEvent.click(screen.getByRole("link", { name: "Explore what’s below" }));
    expect(scroll).toHaveBeenCalledWith({ top: 912, behavior: reduced ? "instant" : "smooth" });
    expect(document.activeElement).toBe(product);
  });
});

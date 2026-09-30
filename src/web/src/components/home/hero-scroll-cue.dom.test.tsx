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
    render(<><HeroScrollCue targetId="product" /><section id="product" tabIndex={-1}>Product</section></>);
    const product = document.getElementById("product")!;
    const scroll = vi.fn();
    product.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole("link", { name: "Explore what’s below" }));
    expect(scroll).toHaveBeenCalledWith({ behavior: reduced ? "instant" : "smooth", block: "start" });
    expect(document.activeElement).toBe(product);
  });
});

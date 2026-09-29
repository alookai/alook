import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/react-dom-harness";

vi.mock("@gsap/react", () => ({ useGSAP: vi.fn() }));
vi.mock("gsap", () => ({ default: { registerPlugin: vi.fn() } }));
vi.mock("@/components/typewriter-visual", () => ({ TypewriterVisual: () => null }));

import { HeroSection } from "./hero-section";

afterEach(() => vi.unstubAllGlobals());

it("reveals the home-logo faces over the combined hero brand and restores them on leave", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  render(<HeroSection isLoggedIn={false} showClipboard={false} showCommunityLinks={false} />);
  const brand = screen.getByRole("link", { name: "Alook home" });
  const logo = screen.getByRole("img", { name: "Alook" });
  expect(logo.parentElement).toBe(brand);
  expect(brand.textContent).toBe("Alook");
  fireEvent.pointerEnter(brand);
  expect(logo.getAttribute("data-state")).toBe("reveal");
  fireEvent.pointerLeave(brand);
  expect(logo.getAttribute("data-state")).toBe("default");
  fireEvent.focus(brand);
  expect(logo.getAttribute("data-state")).toBe("reveal");
});

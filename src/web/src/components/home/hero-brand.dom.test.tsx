import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/react-dom-harness";

vi.mock("@gsap/react", () => ({ useGSAP: vi.fn() }));
vi.mock("gsap", () => ({ default: { registerPlugin: vi.fn() } }));
vi.mock("@/components/typewriter-visual", () => ({ TypewriterVisual: ({ onPaperSettled }: { onPaperSettled?: () => void }) => <button onClick={onPaperSettled}>Finish paper</button> }));

import { HeroSection } from "./hero-section";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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


it("signals hero readiness after only its own images settle", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  const ready = vi.fn();
  render(<><img src="below-hero.png" alt="Outside hero" /><HeroSection isLoggedIn={false} onReady={ready} backgroundDecoration={<><img src="hero-a.png" alt="Hero A" /><img src="hero-b.png" alt="Hero B" /></>} /></>);
  fireEvent.click(screen.getByRole("button", { name: "Finish paper" }));
  expect(ready).not.toHaveBeenCalled();
  fireEvent.load(screen.getByAltText("Outside hero"));
  expect(ready).not.toHaveBeenCalled();
  fireEvent.load(screen.getByAltText("Hero A"));
  expect(ready).not.toHaveBeenCalled();
  fireEvent.load(screen.getByAltText("Hero B"));
  expect(ready).toHaveBeenCalledTimes(1);
});

it("does not wait for window load when hero images are cached", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  const ready = vi.fn();
  render(<HeroSection isLoggedIn={false} onReady={ready} backgroundDecoration={<img src="cached-hero.png" alt="Cached hero" />} />);
  expect(ready).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Finish paper" }));
  expect(ready).toHaveBeenCalledTimes(1);
});

it("releases the scheduler on a failed hero image and removes pending handlers on unmount", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  const ready = vi.fn();
  const view = render(<HeroSection isLoggedIn={false} onReady={ready} backgroundDecoration={<img src="hero.png" alt="Hero" />} />);
  fireEvent.click(screen.getByRole("button", { name: "Finish paper" }));
  const image = screen.getByAltText("Hero");
  fireEvent.error(image);
  expect(ready).toHaveBeenCalledTimes(1);
  fireEvent.load(image);
  expect(ready).toHaveBeenCalledTimes(1);
  view.unmount();
  fireEvent.load(image);
  expect(ready).toHaveBeenCalledTimes(1);
});

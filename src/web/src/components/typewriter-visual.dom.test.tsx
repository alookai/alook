import React from "react";
import { renderToString } from "react-dom/server";
import { act, render, screen } from "@/test/react-dom-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@gsap/react", () => ({ useGSAP: vi.fn() }));

import { TypewriterVisual } from "./typewriter-visual";
import { TYPEWRITER_CITY_ART } from "./typewriter-city-art-data";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

describe("typewriter paper", () => {
  it("waits for the paper font and committed canvas before releasing the hero", async () => {
    let resolveFont!: () => void;
    const font = new Promise<void>((resolve) => { resolveFont = resolve; });
    Object.defineProperty(document, "fonts", { configurable: true, value: { load: () => font } });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage, fillText: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const settled = vi.fn();
    const { container } = render(<TypewriterVisual animateEntrance={false} onPaperSettled={settled} />);
    expect(settled).not.toHaveBeenCalled();
    await act(async () => { resolveFont(); await font; });
    expect(drawImage).toHaveBeenCalled();
    expect(container.querySelector("pre")?.className).toContain("rendered");
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("announces the paper font in server HTML before hydration", () => {
    const html = renderToString(<TypewriterVisual animateEntrance={false} />);
    expect(html).toContain('rel="preload"');
    expect(html).toContain('href="/fonts/jgs5/jgs5.ttf"');
    expect(html).toContain('as="font"');
    expect(html).toContain('crossorigin="anonymous"');
  });

  it("renders static hero paper visible before effects", () => {
    const { container } = render(<TypewriterVisual animateEntrance={false} />);
    expect((container.querySelector(".tw-paper") as HTMLElement).style.opacity).toBe("1");
    expect(container.querySelector("pre")?.textContent).toBe(TYPEWRITER_CITY_ART);
  });

  it.each([false, true])("keeps keyboard on a flat front with animated paper=%s", (animateEntrance) => {
    const { container } = render(<TypewriterVisual animateEntrance={animateEntrance} />);
    const front = container.querySelector(".tw-body-front")!;
    const track = container.querySelector(".tw-paper-track")!;
    expect(front.querySelectorAll(".tw-key")).toHaveLength(26);
    expect(track.parentElement).toBe(animateEntrance ? front : container.querySelector(".tw-body"));
  });

  it("shows the city without a switch control or consuming Enter", () => {
    const { container } = render(<TypewriterVisual />);
    expect(screen.getByRole("img", { name: /Alook sculpture/ })).toBeTruthy();
    expect(container.querySelector("pre")?.textContent).toBe(TYPEWRITER_CITY_ART);
    expect(screen.queryByRole("button")).toBeNull();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    document.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(container.querySelector("pre")?.textContent).toBe(TYPEWRITER_CITY_ART);
  });

  it("keeps custom error-page paper", () => {
    const { container } = render(<TypewriterVisual paper={<p>Undeliverable — page not found</p>} />);
    expect(screen.getByText("Undeliverable — page not found")).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();
  });
});

import React from "react";
import { renderToString } from "react-dom/server";
import { render, screen } from "@/test/react-dom-harness";
import { describe, expect, it, vi } from "vitest";

vi.mock("@gsap/react", () => ({ useGSAP: vi.fn() }));

import { TypewriterVisual } from "./typewriter-visual";
import { TYPEWRITER_CITY_ART } from "./typewriter-city-art-data";

describe("typewriter paper", () => {
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

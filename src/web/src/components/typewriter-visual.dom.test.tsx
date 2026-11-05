import React from "react";
import { renderToString } from "react-dom/server";
import { act, fireEvent, render, screen } from "@/test/react-dom-harness";
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

  it.each([false, true])("keeps keyboard on the front and seats the paper in the top deck with animated paper=%s", (animateEntrance) => {
    const { container } = render(<TypewriterVisual animateEntrance={animateEntrance} />);
    const front = container.querySelector(".tw-body-front")!;
    const track = container.querySelector(".tw-paper-track")!;
    expect(front.querySelectorAll(".tw-key")).toHaveLength(26);
    expect(track.parentElement).toBe(container.querySelector(".tw-body"));
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

describe("homepage hover pose", () => {
  function frames(reduced = false) {
    const pending = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { pending.set(++id, callback); return id; });
    const cancel = vi.fn((frame: number) => pending.delete(frame));
    vi.stubGlobal("cancelAnimationFrame", cancel);
    return {
      pending,
      cancel,
      step(time: number) {
        const entry = pending.entries().next().value;
        if (entry) { pending.delete(entry[0]); entry[1](time); }
      },
    };
  }

  it("eases only between the resting and front poses, independent of pointer position", () => {
    const clock = frames();
    const { container } = render(<TypewriterVisual interaction="hover" paper={<p>Paper</p>} />);
    const visual = container.querySelector(".typewriter-visual")!;
    const scene = container.querySelector<HTMLElement>(".typewriter-scene")!;
    fireEvent.mouseEnter(visual);
    clock.step(16);
    expect(scene.style.transform).toMatch(/rotateY\(-1[0-9]\.\d+deg\) rotateX\([1-9]\.\d+deg\)/);
    for (let time = 48; time < 1600; time += 32) clock.step(time);
    expect(scene.style.transform).toBe("rotateY(0.00deg) rotateX(0.00deg)");
    fireEvent.mouseMove(visual, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(visual, { clientX: 900, clientY: 900 });
    expect(clock.pending.size).toBe(0);
    expect(scene.style.transform).toBe("rotateY(0.00deg) rotateX(0.00deg)");
    fireEvent.mouseLeave(visual);
    clock.step(1700);
    expect(scene.style.transform).not.toBe("");
    for (let time = 1732; time < 3300; time += 32) clock.step(time);
    expect(scene.style.transform).toBe("");
  });

  it("combines the primary CTA request with hovering the machine", () => {
    const clock = frames();
    const { container, rerender } = render(<TypewriterVisual interaction="hover" frontFacing paper={<p>Paper</p>} />);
    const visual = container.querySelector(".typewriter-visual")!;
    const scene = container.querySelector<HTMLElement>(".typewriter-scene")!;
    for (let time = 16; time < 1600; time += 32) clock.step(time);
    expect(scene.style.transform).toBe("rotateY(0.00deg) rotateX(0.00deg)");
    fireEvent.mouseEnter(visual);
    rerender(<TypewriterVisual interaction="hover" frontFacing={false} paper={<p>Paper</p>} />);
    expect(clock.pending.size).toBe(0);
    expect(scene.style.transform).toBe("rotateY(0.00deg) rotateX(0.00deg)");
    fireEvent.mouseLeave(visual);
    for (let time = 1700; time < 3300; time += 32) clock.step(time);
    expect(scene.style.transform).toBe("");
  });

  it("does not animate hover when reduced motion is requested", () => {
    const clock = frames(true);
    const { container } = render(<TypewriterVisual interaction="hover" paper={<p>Paper</p>} />);
    fireEvent.mouseEnter(container.querySelector(".typewriter-visual")!);
    expect(clock.pending.size).toBe(0);
    expect(container.querySelector<HTMLElement>(".typewriter-scene")!.style.transform).toBe("");
  });

  it("cancels an in-flight hover frame when removed", () => {
    const clock = frames();
    const { container, unmount } = render(<TypewriterVisual interaction="hover" paper={<p>Paper</p>} />);
    fireEvent.mouseEnter(container.querySelector(".typewriter-visual")!);
    expect(clock.pending.size).toBe(1);
    unmount();
    expect(clock.cancel).toHaveBeenCalledTimes(1);
    expect(clock.pending.size).toBe(0);
  });
});

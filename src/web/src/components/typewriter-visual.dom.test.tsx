import React from "react";
import { renderToString } from "react-dom/server";
import { act, fireEvent, render, screen } from "@/test/react-dom-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@gsap/react", () => ({ useGSAP: vi.fn() }));

import { TypewriterVisual } from "./typewriter-visual";

const initialDarkMode = document.documentElement.classList.contains("dark");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.classList.toggle("dark", initialDarkMode);
});

describe("typewriter paper", () => {
  it.each([
    ["light", "/landing/typewriter-workspace.webp"],
    ["dark", "/landing/typewriter-workspace-dark.webp"],
  ])("releases the hero after the %s workspace image decodes", async (theme, expectedImage) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    let finishDecode!: () => void;
    const decoded = new Promise<void>((resolve) => {
      finishDecode = resolve;
    });
    const setSource = vi.fn();
    vi.stubGlobal("Image", class {
      set src(value: string) { setSource(value); }
      decode() { return decoded; }
    });
    const settled = vi.fn();
    render(<TypewriterVisual animateEntrance={false} onPaperSettled={settled} />);
    expect(screen.getByRole("img", { name: /Alook workspace/ })).toBeInTheDocument();
    expect(setSource).toHaveBeenCalledExactlyOnceWith(expectedImage);
    expect(settled).not.toHaveBeenCalled();
    await act(async () => { finishDecode(); await decoded; });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("releases the hero when the printed image cannot be decoded", async () => {
    vi.stubGlobal("Image", class { async decode() { throw new Error("Image unavailable"); } });
    const settled = vi.fn();
    render(<TypewriterVisual animateEntrance={false} onPaperSettled={settled} />);
    await act(async () => {});
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("references both themed workspace images from the initial SVG markup", () => {
    const settled = vi.fn();
    const html = renderToString(<TypewriterVisual animateEntrance={false} onPaperSettled={settled} />);
    expect(html).toContain("<svg");
    expect(html).toContain("Alook workspace with two people and two bots");
    expect(html).toContain('href="/landing/typewriter-workspace.webp"');
    expect(html).toContain('href="/landing/typewriter-workspace-dark.webp"');
    expect(html).not.toContain("<canvas");
    expect(settled).not.toHaveBeenCalled();
  });

  it("renders static hero paper visible before effects", () => {
    const { container } = render(<TypewriterVisual animateEntrance={false} />);
    expect((container.querySelector(".tw-paper") as HTMLElement).style.opacity).toBe("1");
    expect(screen.getByRole("img", { name: /Alook workspace/ })).toBeInTheDocument();
  });

  it.each([false, true])("keeps keyboard on the front and seats the paper in the top deck with animated paper=%s", (animateEntrance) => {
    const { container } = render(<TypewriterVisual animateEntrance={animateEntrance} />);
    const front = container.querySelector(".tw-body-front")!;
    const track = container.querySelector(".tw-paper-track")!;
    expect(front.querySelectorAll(".tw-key")).toHaveLength(26);
    expect(track.parentElement).toBe(container.querySelector(".tw-body"));
  });

  it("shows the illustration without capturing keyboard input", () => {
    render(<TypewriterVisual />);
    const illustration = screen.getByRole("img", { name: /Alook workspace/ });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    document.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(illustration).toBeInTheDocument();
  });

  it("links the illustration when its caller supplies a workspace destination", () => {
    render(<TypewriterVisual paperHref="#workspace" />);
    const link = screen.getByRole("link", { name: "Explore the Alook workspace" });
    expect(link).toHaveAttribute("href", "#workspace");
    expect(link.querySelector("svg")).toBeInTheDocument();
  });

  it("keeps custom error-page paper", () => {
    render(<TypewriterVisual paper={<p>Undeliverable — page not found</p>} />);
    expect(screen.getByText("Undeliverable — page not found")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Alook workspace/ })).toBeNull();
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, setupUser } from "@/test/react-dom-harness";
import { DeferredDemo } from "./deferred-demo";

const scene = vi.hoisted(() => ({
  create: vi.fn(),
  play: vi.fn(), pause: vi.fn(), restart: vi.fn(), kill: vi.fn(), progress: vi.fn(),
}));
vi.mock("./scenes/connect", () => ({ createScene: scene.create }));
vi.mock("./scenes/bots", () => ({ createScene: scene.create }));
let reduced = false;
const observers: Array<(entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void> = [];
let intersect: (entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void;
const disconnect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 420, height: 320, width: 600, left: 0, right: 600, x: 0, y: 100, toJSON: () => ({}) });
  reduced = false;
  observers.length = 0;
  scene.create.mockReturnValue(scene);
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof intersect, options: IntersectionObserverInit) {
      intersect = callback;
      observers.push(callback);
      expect(options.rootMargin).toBe("0px");
    }
    observe() {}
    disconnect = disconnect;
  });
});

describe("deferred guide demos", () => {
  it("keeps static content until visible, then supports play, offscreen pause, replay and cleanup", async () => {
    const user = setupUser();
    const view = render(<DeferredDemo scene="connect" label="Connection"><p>Static command</p></DeferredDemo>);
    expect(screen.getByText("Static command")).toBeVisible();
    expect(screen.queryByText(/Illustrative demo/)).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Connection playback" })).toBeVisible();
    expect(scene.create).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play Connection" })).toBeDisabled();
    await act(async () => intersect([{ isIntersecting: true, intersectionRatio: 1 }]));
    await waitFor(() => expect(scene.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(scene.play).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Pause Connection" })).toBeVisible();
    act(() => intersect([{ isIntersecting: false, intersectionRatio: 0 }]));
    expect(scene.pause).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play Connection" })).toBeVisible();
    act(() => intersect([{ isIntersecting: true, intersectionRatio: 1 }]));
    await waitFor(() => expect(scene.play).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Pause Connection" }));
    act(() => intersect([{ isIntersecting: false, intersectionRatio: 0 }]));
    act(() => intersect([{ isIntersecting: true, intersectionRatio: 1 }]));
    expect(scene.play).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Replay Connection" }));
    expect(scene.restart).toHaveBeenCalledOnce();
    view.unmount();
    expect(scene.kill).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("hands playback to the centered demo on scroll without another intersection event", async () => {
    let tops = { connect: 200, bots: 650 };
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 938 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      const sceneId = this.parentElement?.dataset.guideDemo as keyof typeof tops;
      const top = tops[sceneId] ?? 0;
      return { top, bottom: top + 320, height: 320, width: 600, left: 0, right: 600, x: 0, y: top, toJSON: () => ({}) };
    });
    const first = { ...scene, play: vi.fn(), pause: vi.fn() };
    const second = { ...scene, play: vi.fn(), pause: vi.fn() };
    scene.create.mockReturnValueOnce(first).mockReturnValueOnce(second);
    render(<><DeferredDemo scene="connect" label="Connection">Connect</DeferredDemo><DeferredDemo scene="bots" label="Bots">Bots</DeferredDemo></>);
    await act(async () => observers.forEach(callback => callback([{ isIntersecting: true, intersectionRatio: 0.9 }])));
    await waitFor(() => expect(first.play).toHaveBeenCalled());
    expect(second.play).not.toHaveBeenCalled();
    tops = { connect: -70, bots: 380 };
    act(() => window.dispatchEvent(new Event("scroll")));
    await waitFor(() => expect(second.play).toHaveBeenCalled());
    expect(first.pause).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pause Bots" })).toBeVisible();
  });

  it("does not create animation for reduced motion", async () => {
    reduced = true;
    render(<DeferredDemo scene="bots" label="Bots"><p>Both runtimes</p></DeferredDemo>);
    await act(async () => intersect([{ isIntersecting: true, intersectionRatio: 1 }]));
    expect(scene.create).not.toHaveBeenCalled();
    expect(screen.getByText("Both runtimes")).toBeVisible();
  });

  it("retains the static scene if animation setup fails and permits retry", async () => {
    scene.create.mockImplementationOnce(() => { throw new Error("chunk failed"); });
    const user = setupUser();
    render(<DeferredDemo scene="connect" label="Connection"><p>Static command</p></DeferredDemo>);
    await act(async () => intersect([{ isIntersecting: true, intersectionRatio: 1 }]));
    await user.click(await screen.findByRole("button", { name: "Retry animation" }));
    await waitFor(() => expect(scene.create).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Static command")).toBeVisible();
    expect(screen.queryByText(/Illustrative demo/)).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Connection playback" })).toBeVisible();
  });
});

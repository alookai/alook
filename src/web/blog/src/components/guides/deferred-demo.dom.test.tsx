import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test/react-dom-harness";
import userEvent from "@testing-library/user-event";
import { DeferredDemo } from "./deferred-demo";

const scene = vi.hoisted(() => ({
  create: vi.fn(),
  play: vi.fn(), pause: vi.fn(), restart: vi.fn(), kill: vi.fn(), progress: vi.fn(),
}));
vi.mock("./scenes/connect", () => ({ createScene: scene.create }));
vi.mock("./scenes/bots", () => ({ createScene: scene.create }));
let reduced = false;
let intersect: (entries: { isIntersecting: boolean }[]) => void;
const disconnect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  reduced = false;
  scene.create.mockReturnValue(scene);
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof intersect, options: IntersectionObserverInit) {
      intersect = callback;
      expect(options.rootMargin).toBe("0px");
    }
    observe() {}
    disconnect = disconnect;
  });
});

describe("deferred guide demos", () => {
  it("keeps static content until visible, then supports play, offscreen pause, replay and cleanup", async () => {
    const user = userEvent.setup();
    const view = render(<DeferredDemo scene="connect" label="Connection"><p>Static command</p></DeferredDemo>);
    expect(screen.getByText("Static command")).toBeVisible();
    expect(screen.queryByText(/Illustrative demo/)).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Connection playback" })).toBeVisible();
    expect(scene.create).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play Connection" })).toBeDisabled();
    await act(async () => intersect([{ isIntersecting: true }]));
    await waitFor(() => expect(scene.create).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Play Connection" }));
    expect(scene.play).toHaveBeenCalledOnce();
    act(() => intersect([{ isIntersecting: false }]));
    expect(scene.pause).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play Connection" })).toBeVisible();
    act(() => intersect([{ isIntersecting: true }]));
    await user.click(screen.getByRole("button", { name: "Replay Connection" }));
    expect(scene.restart).toHaveBeenCalledOnce();
    view.unmount();
    expect(scene.kill).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("does not create animation for reduced motion", async () => {
    reduced = true;
    render(<DeferredDemo scene="bots" label="Bots"><p>Both runtimes</p></DeferredDemo>);
    await act(async () => intersect([{ isIntersecting: true }]));
    expect(scene.create).not.toHaveBeenCalled();
    expect(screen.getByText("Both runtimes")).toBeVisible();
  });

  it("retains the static scene if animation setup fails and permits retry", async () => {
    scene.create.mockImplementationOnce(() => { throw new Error("chunk failed"); });
    const user = userEvent.setup();
    render(<DeferredDemo scene="connect" label="Connection"><p>Static command</p></DeferredDemo>);
    await act(async () => intersect([{ isIntersecting: true }]));
    await user.click(await screen.findByRole("button", { name: "Retry animation" }));
    await waitFor(() => expect(scene.create).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Static command")).toBeVisible();
    expect(screen.queryByText(/Illustrative demo/)).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Connection playback" })).toBeVisible();
  });
});

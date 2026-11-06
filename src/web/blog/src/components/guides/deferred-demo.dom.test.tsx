import { aroundEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, setupUser } from "@/test/react-dom-harness";
import { DeferredDemo } from "./deferred-demo";
import { demoMotion } from "./scenes/motion";

const factories = vi.hoisted(() => ({ connect: vi.fn(), bots: vi.fn(), server: vi.fn(), message: vi.fn() }));
vi.mock("./scenes/connect", () => ({ createScene: factories.connect }));
vi.mock("./scenes/bots", () => ({ createScene: factories.bots }));
vi.mock("./scenes/server", () => ({ createScene: factories.server }));
vi.mock("./scenes/message", () => ({ createScene: factories.message }));

type Kind = keyof typeof factories;
class OwnedTimeline {
  active = false;
  retired = false;
  position = 0;
  constructor(readonly root: HTMLElement, readonly complete: () => void) {}
  play = vi.fn(() => { this.active = true; return this; });
  pause = vi.fn(() => { this.active = false; return this; });
  restart = vi.fn(() => { this.active = true; return this; });
  kill = vi.fn(() => { this.active = false; this.retired = true; return this; });
  progress = vi.fn((value?: number): number | OwnedTimeline => {
    if (value === undefined) return this.position;
    this.position = value;
    return this;
  });
}
const instances: Record<Kind, OwnedTimeline[]> = { connect: [], bots: [], server: [], message: [] };
const realTimelines: ReturnType<typeof demoMotion>["timeline"][] = [];
const observers: GuideObserver[] = [];
const boxes = new Map<Element, DOMRect>();
const motionListeners = new Set<() => void>();
const restores: Array<() => void> = [];
let reduced = false;
let initialWidth = 600;

function box(top: number, width = initialWidth): DOMRect {
  return { top, bottom: top + 320, height: 320, width, left: 0, right: width, x: 0, y: top, toJSON: () => ({}) };
}
class GuideObserver {
  readonly targets = new Set<Element>();
  disconnected = false;
  readonly rootMargin: string;
  constructor(readonly callback: (entries: { target: Element; isIntersecting: boolean; intersectionRatio: number }[]) => void, options?: IntersectionObserverInit) {
    this.rootMargin = options?.rootMargin ?? "0px";
    observers.push(this);
  }
  observe(element: Element) {
    this.targets.add(element);
    boxes.set(element, box(1300));
  }
  disconnect = vi.fn(() => { this.targets.clear(); this.disconnected = true; });
  notify() {
    if (this.disconnected) return;
    this.callback([...this.targets].map(target => {
      const rect = boxes.get(target)!;
      const intersection = Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top));
      return { target, isIntersecting: intersection > 0, intersectionRatio: intersection / rect.height };
    }));
  }
}
function target(observer = observers[0]) {
  const element = [...observer.targets][0];
  expect(element).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}
function move(observer: GuideObserver, top: number, width = boxes.get(target(observer))!.width) {
  boxes.set(target(observer), box(top, width));
}
function enter(observer = observers[0], top = 100) {
  move(observer, top);
  observer.notify();
}
function changeMotion(value: boolean) {
  reduced = value;
  for (const listener of motionListeners) listener();
}
async function settlePlayback() {
  await act(async () => {
    await vi.dynamicImportSettled();
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    await vi.dynamicImportSettled();
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
  });
}
function owned(kind: Kind, index = 0) {
  expect(instances[kind][index]).toBeDefined();
  return instances[kind][index]!;
}

function replaceProperty(owner: object, name: string, descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(owner, name);
  Object.defineProperty(owner, name, descriptor);
  restores.push(() => {
    if (original) Object.defineProperty(owner, name, original);
    else delete (owner as Record<string, unknown>)[name];
  });
}

aroundEach(async (run) => {
  const nativeRect = HTMLElement.prototype.getBoundingClientRect;
  const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
  restores.length = 0;
  restores.push(() => {
    if (hidden) Object.defineProperty(document, "hidden", hidden);
    else delete (document as unknown as Record<string, unknown>).hidden;
  });
  reduced = false;
  initialWidth = 600;
  observers.length = 0;
  boxes.clear();
  motionListeners.clear();
  realTimelines.length = 0;
  for (const kind of Object.keys(factories) as Kind[]) {
    instances[kind].length = 0;
    factories[kind].mockReset().mockImplementation((root: HTMLElement, complete: () => void) => {
      const timeline = new OwnedTimeline(root, complete);
      instances[kind].push(timeline);
      return timeline;
    });
  }
  const failures: unknown[] = [];
  try {
    replaceProperty(HTMLElement.prototype, "getBoundingClientRect", { configurable: true, writable: true, value(this: HTMLElement) {
      return boxes.get(this) ?? nativeRect.call(this);
    } });
    replaceProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return boxes.get(this)?.width ?? 0; } });
    replaceProperty(window, "innerHeight", { configurable: true, value: 938 });
    const media = () => ({
      get matches() { return reduced; },
      addEventListener: (_type: string, callback: () => void) => { motionListeners.add(callback); },
      removeEventListener: (_type: string, callback: () => void) => { motionListeners.delete(callback); },
    });
    for (const owner of new Set([globalThis, window])) {
      replaceProperty(owner, "matchMedia", { configurable: true, writable: true, value: media });
      replaceProperty(owner, "IntersectionObserver", { configurable: true, writable: true, value: GuideObserver });
    }
    await run();
  } catch (error) { failures.push(error); }
  try { await settlePlayback(); } catch (error) { failures.push(error); }
  finally {
    try {
      for (const timeline of realTimelines) {
        try { timeline.kill(); } catch (error) { failures.push(error); }
      }
    } finally {
      for (const restore of restores.reverse()) {
        try { restore(); } catch (error) { failures.push(error); }
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Guide demo body and cleanup failed");
});

describe("deferred guide demos", () => {
  it("keeps static content until visible, then supports play, offscreen pause, replay and cleanup", async () => {
    const user = setupUser();
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    restores.push(() => { windowAdd.mockRestore(); windowRemove.mockRestore(); documentAdd.mockRestore(); documentRemove.mockRestore(); });
    const view = render(<DeferredDemo scene="connect" label="Connection"><p>Static command</p></DeferredDemo>);
    const observer = observers[0];
    const root = target(observer);
    expect(screen.getByText("Static command")).toBeVisible();
    expect(screen.getByRole("group", { name: "Connection playback" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Play Connection" })).toBeDisabled();
    await settlePlayback();
    expect(factories.connect).not.toHaveBeenCalled();
    act(() => enter(observer));
    await waitFor(() => expect(owned("connect").active).toBe(true));
    const timeline = owned("connect");
    expect(timeline.root).toBe(root);
    expect(factories.bots).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pause Connection" })).toBeVisible();
    const playing = timeline.play.mock.calls.length;
    act(() => { move(observer, 1300); observer.notify(); });
    await settlePlayback();
    expect(timeline.active).toBe(false);
    expect(timeline.play).toHaveBeenCalledTimes(playing);
    expect(screen.getByRole("button", { name: "Play Connection" })).toBeEnabled();
    act(() => enter(observer));
    await waitFor(() => expect(timeline.active).toBe(true));
    await user.click(screen.getByRole("button", { name: "Pause Connection" }));
    const manuallyPaused = timeline.play.mock.calls.length;
    act(() => { move(observer, 1300); observer.notify(); });
    await settlePlayback();
    act(() => enter(observer));
    await settlePlayback();
    expect(timeline.active).toBe(false);
    expect(timeline.play).toHaveBeenCalledTimes(manuallyPaused);
    await user.click(screen.getByRole("button", { name: "Replay Connection" }));
    expect(timeline.restart).toHaveBeenCalledOnce();
    expect(timeline.active).toBe(true);
    const windowOwners = windowAdd.mock.calls.filter(([type]) => type === "scroll" || type === "resize");
    const documentOwners = documentAdd.mock.calls.filter(([type]) => type === "visibilitychange");
    expect(windowOwners.length).toBeGreaterThan(0);
    expect(documentOwners.length).toBeGreaterThan(0);
    view.unmount();
    expect(timeline.retired).toBe(true);
    expect(timeline.active).toBe(false);
    expect(observer.disconnected).toBe(true);
    expect(motionListeners.size).toBe(0);
    for (const [type, listener] of windowOwners) expect(windowRemove).toHaveBeenCalledWith(type, listener);
    for (const [type, listener] of documentOwners) expect(documentRemove).toHaveBeenCalledWith(type, listener);
    const plays = timeline.play.mock.calls.length;
    const creations = factories.connect.mock.calls.length;
    act(() => { observer.notify(); window.dispatchEvent(new Event("scroll")); window.dispatchEvent(new Event("resize")); changeMotion(false); });
    await settlePlayback();
    expect(factories.connect).toHaveBeenCalledTimes(creations);
    expect(timeline.play).toHaveBeenCalledTimes(plays);
    expect(timeline.active).toBe(false);
  });

  it("hands playback to the centered demo on scroll without another intersection event", async () => {
    render(<><DeferredDemo scene="connect" label="Connection">Connect</DeferredDemo><DeferredDemo scene="bots" label="Bots">Bots</DeferredDemo></>);
    const [connection, bots] = observers;
    act(() => { enter(connection, 200); enter(bots, 650); });
    await waitFor(() => expect(owned("connect").active).toBe(true));
    await settlePlayback();
    const first = owned("connect");
    const second = owned("bots");
    expect(first.root).toBe(target(connection));
    expect(second.root).toBe(target(bots));
    expect(second.play).not.toHaveBeenCalled();
    act(() => { move(connection, -70); move(bots, 380); window.dispatchEvent(new Event("scroll")); });
    await waitFor(() => expect(second.active).toBe(true));
    await settlePlayback();
    expect(first.active).toBe(false);
    expect(first.pause).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pause Bots" })).toBeVisible();
  });

  it("does not create animation for reduced motion", async () => {
    reduced = true;
    render(<DeferredDemo scene="bots" label="Bots"><p>Both runtimes</p></DeferredDemo>);
    act(() => enter());
    await settlePlayback();
    for (const factory of Object.values(factories)) expect(factory).not.toHaveBeenCalled();
    expect(screen.getByText("Both runtimes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Play Bots" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Replay Bots" })).toBeDisabled();
  });

  it("retains the static scene if animation setup fails and permits retry", async () => {
    const failure = new Error("scene setup failed");
    factories.connect.mockImplementation(() => { throw failure; });
    const user = setupUser();
    render(<DeferredDemo scene="connect" label="Connection"><p>Static command</p></DeferredDemo>);
    act(() => enter());
    await settlePlayback();
    const retry = await screen.findByRole("button", { name: "Retry animation" });
    expect(factories.connect.mock.results.some(result => result.type === "throw" && result.value === failure)).toBe(true);
    expect(instances.connect).toHaveLength(0);
    expect(screen.getByText("Static command")).toBeVisible();
    expect(screen.getByRole("group", { name: "Connection playback" })).toBeVisible();
    factories.connect.mockImplementation((root: HTMLElement, complete: () => void) => {
      const timeline = new OwnedTimeline(root, complete);
      instances.connect.push(timeline);
      return timeline;
    });
    await user.click(retry);
    await waitFor(() => expect(owned("connect").active).toBe(true));
    expect(owned("connect").root).toBe(target());
    expect(screen.getByRole("button", { name: "Pause Connection" })).toBeVisible();
    expect(screen.getByText("Static command")).toBeVisible();
    expect(screen.getByRole("group", { name: "Connection playback" })).toBeVisible();
  });
});

describe("animation lifecycle changes", () => {
  it.each(["server", "message"] as const)("loads and resumes the %s scene, then replays after completion", async (kind) => {
    const user = setupUser();
    render(<DeferredDemo scene={kind} label="Demo">Static</DeferredDemo>);
    act(() => enter());
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause Demo" })).toBeEnabled());
    expect(factories[kind]).toHaveBeenCalledOnce();
    const timeline = owned(kind);
    expect(timeline.active).toBe(true);
    expect(timeline.root).toBe(target());
    expect(factories[kind === "server" ? "message" : "server"]).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Pause Demo" }));
    expect(timeline.active).toBe(false);
    const plays = timeline.play.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Play Demo" }));
    expect(timeline.play).toHaveBeenCalledTimes(plays + 1);
    expect(timeline.active).toBe(true);
    act(() => { timeline.active = false; timeline.complete(); });
    await user.click(screen.getByRole("button", { name: "Play Demo" }));
    expect(timeline.restart).toHaveBeenCalledOnce();
    expect(timeline.active).toBe(true);
  });

  it("returns to static content when reduced motion is enabled and reloads when disabled", async () => {
    render(<DeferredDemo scene="connect" label="Demo">Static</DeferredDemo>);
    act(() => enter());
    await waitFor(() => expect(owned("connect").active).toBe(true));
    const first = owned("connect");
    act(() => changeMotion(true));
    await settlePlayback();
    expect(first.retired).toBe(true);
    expect(first.active).toBe(false);
    expect(screen.getByText("Static")).toBeVisible();
    expect(screen.getByRole("button", { name: "Play Demo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Replay Demo" })).toBeDisabled();
    act(() => changeMotion(false));
    await waitFor(() => expect(owned("connect", 1).active).toBe(true));
    expect(owned("connect", 1).root).toBe(target());
    expect(first.active).toBe(false);
  });

  it("keeps a rebuilt manually paused demo readable without resuming", async () => {
    initialWidth = 720;
    factories.message.mockImplementation((root: HTMLElement, complete: () => void) => {
      const frame = root.querySelector<HTMLElement>("[data-demo-frame]")!;
      frame.style.visibility = "hidden";
      frame.style.opacity = "0";
      const { timeline } = demoMotion(root, complete);
      timeline.to({}, { duration: 1 });
      realTimelines.push(timeline);
      return timeline;
    });
    const user = setupUser();
    render(<DeferredDemo scene="message" label="Message"><p data-demo-frame>Paused message frame</p><span data-demo-pointer /></DeferredDemo>);
    act(() => enter());
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause Message" })).toBeEnabled());
    await waitFor(() => expect(screen.getByText("Paused message frame")).toBeVisible());
    expect(realTimelines).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Pause Message" }));
    const first = realTimelines[0];
    expect(first.paused()).toBe(true);
    const kill = vi.spyOn(first, "kill");
    restores.push(() => kill.mockRestore());
    act(() => { move(observers[0], 100, 393); window.dispatchEvent(new Event("resize")); });
    await waitFor(() => expect(realTimelines).toHaveLength(2));
    await settlePlayback();
    const rebuilt = realTimelines[1];
    expect(kill).toHaveBeenCalled();
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.paused()).toBe(true);
    expect(screen.getByText("Paused message frame")).toBeVisible();
    expect(screen.getByRole("button", { name: "Play Message" })).toBeEnabled();
  });

  it("rebuilds only on width changes and pauses in a hidden tab", async () => {
    initialWidth = 390;
    render(<DeferredDemo scene="connect" label="Demo">Static</DeferredDemo>);
    act(() => { move(observers[0], 1300, 400); window.dispatchEvent(new Event("resize")); });
    await settlePlayback();
    expect(factories.connect).not.toHaveBeenCalled();
    act(() => enter());
    await waitFor(() => expect(owned("connect").active).toBe(true));
    const first = owned("connect");
    act(() => window.dispatchEvent(new Event("resize")));
    await settlePlayback();
    expect(first.retired).toBe(false);
    expect(instances.connect).toHaveLength(1);
    act(() => { move(observers[0], 100, 600); window.dispatchEvent(new Event("resize")); });
    await waitFor(() => expect(owned("connect", 1).active).toBe(true));
    const current = owned("connect", 1);
    expect(first.retired).toBe(true);
    expect(first.active).toBe(false);
    expect(current.root).toBe(target());
    const plays = current.play.mock.calls.length;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settlePlayback();
    expect(current.pause).toHaveBeenCalled();
    expect(current.active).toBe(false);
    expect(current.play).toHaveBeenCalledTimes(plays);
    expect(screen.getByRole("button", { name: "Play Demo" })).toBeEnabled();
  });
});

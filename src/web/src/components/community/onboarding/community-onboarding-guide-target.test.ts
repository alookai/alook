import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adjacentAvatarLayout,
  dismissGuideOnTargetClick,
  findGuideTarget,
  guidePopoverSide,
  guideTargetControl,
  isGuideTargetUsable,
  nextFrame,
  nonOverlappingPopoverLayout,
  pinPopoverAwayFromTarget,
  positionFocusAvatar,
  rectFitsViewport,
  targetIsInViewport,
  waitForTarget,
} from "./community-onboarding-guide-target";

type FakeElement = HTMLElement & {
  styleState?: Record<string, string>;
};

const controlSelector = "button:not([disabled]), [role=button], .ProseMirror";

function element({
  id,
  connected = true,
  direct = true,
  control,
  rect = { top: 10, right: 110, bottom: 50, left: 10, width: 100, height: 40 },
}: {
  id?: string;
  connected?: boolean;
  direct?: boolean;
  control?: HTMLElement | null;
  rect?: Record<string, number>;
} = {}) {
  const matches = vi.fn(() => direct);
  const querySelector = vi.fn(() => control ?? null);
  return {
    isConnected: connected,
    dataset: id ? { onboardingId: id } : {},
    matches,
    querySelector,
    getBoundingClientRect: () => rect,
  } as unknown as FakeElement;
}

describe("community onboarding target helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the exact selector for direct button, role, ProseMirror, and nested controls", () => {
    for (const direct of [element(), element(), element()]) {
      expect(guideTargetControl(direct)).toBe(direct);
      expect(direct.matches).toHaveBeenCalledWith(controlSelector);
      expect(direct.querySelector).not.toHaveBeenCalled();
    }
    const control = element();
    const wrapper = element({ direct: false, control });
    expect(guideTargetControl(wrapper)).toBe(control);
    expect(wrapper.matches).toHaveBeenCalledWith(controlSelector);
    expect(wrapper.querySelector).toHaveBeenCalledWith(controlSelector);
  });

  it("selects the first usable exact resource and measures the inner control for viewport", () => {
    const hiddenControl = element();
    const hidden = element({ id: "machine-1", direct: false, control: hiddenControl });
    const wrong = element({ id: "machine-2" });
    const control = element({
      rect: { top: 5, right: 119, bottom: 79, left: 5, width: 114, height: 74 },
    });
    const matching = element({
      id: "machine-1",
      direct: false,
      control,
      rect: { top: 500, right: 600, bottom: 540, left: 500, width: 100, height: 40 },
    });
    const querySelectorAll = vi.fn(() => [hidden, wrong, matching]);
    vi.stubGlobal("document", { querySelectorAll });
    vi.stubGlobal("window", {
      getComputedStyle: (node: HTMLElement) => ({
        display: node === hiddenControl ? "none" : "block",
        visibility: "visible",
        pointerEvents: "auto",
      }),
      innerWidth: 120,
      innerHeight: 80,
    });

    expect(guideTargetControl(matching)).toBe(control);
    expect(isGuideTargetUsable(hidden)).toBe(false);
    expect(findGuideTarget({ name: "reconnect-machine", resourceId: "machine-1" }))
      .toBe(control);
    expect(querySelectorAll).toHaveBeenCalledWith(
      '[data-onboarding-target="reconnect-machine"]',
    );
    expect(targetIsInViewport(matching)).toBe(true);
    expect(rectFitsViewport({
      top: -1,
      left: -1,
      right: 121,
      bottom: 81,
      width: 122,
      height: 82,
    }, 120, 80)).toBe(true);
    expect(rectFitsViewport({
      top: -2,
      left: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
    }, 120, 80)).toBe(false);
  });

  it("rejects every wrapper/control usability gate independently", () => {
    const disconnected = element({ connected: false });
    const zero = element({ rect: { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 } });
    const wrapperDisplay = element();
    const wrapperVisibility = element();
    const controlDisplay = element();
    const displayWrapper = element({ direct: false, control: controlDisplay });
    const controlVisibility = element();
    const visibilityWrapper = element({ direct: false, control: controlVisibility });
    const controlPointer = element();
    const pointerWrapper = element({ direct: false, control: controlPointer });
    vi.stubGlobal("window", {
      getComputedStyle: (node: HTMLElement) => ({
        display:
          node === wrapperDisplay || node === controlDisplay ? "none" : "block",
        visibility:
          node === wrapperVisibility || node === controlVisibility ? "hidden" : "visible",
        pointerEvents: node === controlPointer ? "none" : "auto",
      }),
    });
    expect(isGuideTargetUsable(disconnected)).toBe(false);
    expect(isGuideTargetUsable(zero)).toBe(false);
    expect(isGuideTargetUsable(wrapperDisplay)).toBe(false);
    expect(isGuideTargetUsable(wrapperVisibility)).toBe(false);
    expect(isGuideTargetUsable(displayWrapper)).toBe(false);
    expect(isGuideTargetUsable(visibilityWrapper)).toBe(false);
    expect(isGuideTargetUsable(pointerWrapper)).toBe(false);
  });

  it("settles an initial candidate after 200ms without an observer notification", async () => {
    vi.useFakeTimers();
    const initial = element();
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("document", { body: {}, querySelectorAll: () => [initial] });
    vi.stubGlobal("window", {
      getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("MutationObserver", class {
      observe = observe;
      disconnect = disconnect;
    });

    let result: HTMLElement | null | undefined;
    void waitForTarget({ name: "connect-machine" }).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(199);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(initial);
    expect(observe).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the full 200ms settle window on direct candidate identity replacement", async () => {
    vi.useFakeTimers();
    const first = element();
    const second = element();
    let current = first;
    let notify!: () => void;
    vi.stubGlobal("document", { body: {}, querySelectorAll: () => [current] });
    vi.stubGlobal("window", {
      getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe() {}
      disconnect() {}
    });

    let result: HTMLElement | null | undefined;
    void waitForTarget({ name: "connect-machine" }).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(100);
    current = second;
    notify();
    await vi.advanceTimersByTimeAsync(199);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(second);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels settle on candidate loss, rearms identity changes, and finishes once", async () => {
    vi.useFakeTimers();
    const first = element();
    const second = element();
    let current: FakeElement | null = first;
    let notify!: () => void;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const removeAbort = vi.fn();
    vi.stubGlobal("document", {
      body: {},
      querySelectorAll: () => current ? [current] : [],
    });
    vi.stubGlobal("window", {
      getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: removeAbort,
    } as unknown as AbortSignal;

    const pending = waitForTarget({ name: "connect-machine" }, 2000, signal);
    await vi.advanceTimersByTimeAsync(100);
    current = null;
    notify();
    await vi.advanceTimersByTimeAsync(500);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    current = second;
    notify();
    await vi.advanceTimersByTimeAsync(199);
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(second);
    expect(observe).toHaveBeenCalledWith(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    notify();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("uses the default 2000ms timeout and cleans a one-shot timeout finish", async () => {
    vi.useFakeTimers();
    let notify!: () => void;
    const disconnect = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", { body: {}, querySelectorAll: () => [] });
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe() {}
      disconnect() { disconnect(); }
    });
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener,
    } as unknown as AbortSignal;
    const pending = waitForTarget({ name: "connect-machine" }, undefined, signal);
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    notify();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does no observer/timer work when already aborted and cleans mid-wait abort", async () => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    const constructObserver = vi.fn();
    let abort!: () => void;
    vi.stubGlobal("document", { body: {}, querySelectorAll: () => [] });
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("MutationObserver", class {
      constructor() { constructObserver(); }
      observe() {}
      disconnect() { disconnect(); }
    });
    await expect(waitForTarget(
      { name: "connect-machine" },
      2000,
      { aborted: true } as AbortSignal,
    )).resolves.toBeNull();
    expect(constructObserver).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const signal = {
      aborted: false,
      addEventListener: vi.fn((_name: string, handler: () => void) => { abort = handler; }),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const pending = waitForTarget({ name: "connect-machine" }, 2000, signal);
    abort();
    await expect(pending).resolves.toBeNull();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps side preferences and exhaustive four-way avatar/popover geometry", () => {
    expect(guidePopoverSide({ name: "dm-composer" })).toBe("top");
    expect(guidePopoverSide({ name: "channel-composer" })).toBe("top");
    expect(guidePopoverSide({ name: "add-server" })).toBe("right");
    expect(guidePopoverSide({ name: "create-bot" })).toBe("bottom");
    expect(dismissGuideOnTargetClick({ name: "dm-composer" })).toBe(false);
    expect(dismissGuideOnTargetClick({ name: "channel-composer" })).toBe(true);

    const viewport = { top: 0, left: 0, width: 400, height: 300 };
    const centered = { top: 100, right: 220, bottom: 140, left: 100 };
    expect(adjacentAvatarLayout(
      centered, 28, viewport, "right",
    )).toEqual({ top: 150, left: 108 });
    expect(adjacentAvatarLayout(
      { top: 250, right: 220, bottom: 280, left: 100 }, 28, viewport, "right",
    )).toEqual({ top: 212, left: 108 });
    expect(adjacentAvatarLayout(
      centered, 28, viewport, "bottom",
    )).toEqual({ top: 108, left: 230 });
    expect(adjacentAvatarLayout(
      { top: 100, right: 390, bottom: 140, left: 350 }, 28, viewport, "top",
    )).toEqual({ top: 108, left: 312 });
    expect(adjacentAvatarLayout(
      { top: 15, right: 25, bottom: 25, left: 15 },
      28,
      { top: 0, left: 0, width: 40, height: 40 },
      "top",
    )).toEqual({ top: 4, left: 4 });

    const targetRect = {
      top: 200, right: 260, bottom: 240, left: 140, width: 120, height: 40,
    };
    const popoverRect = { width: 80, height: 60 };
    const popoverViewport = { top: 0, left: 0, width: 600, height: 600 };
    expect(nonOverlappingPopoverLayout(
      targetRect, popoverRect, popoverViewport, "top",
    )).toEqual({ top: 128, left: 160 });
    expect(nonOverlappingPopoverLayout(
      targetRect, popoverRect, popoverViewport, "bottom",
    )).toEqual({ top: 252, left: 160 });
    expect(nonOverlappingPopoverLayout(
      targetRect, popoverRect, popoverViewport, "right",
    )).toEqual({ top: 190, left: 272 });
    expect(nonOverlappingPopoverLayout(
      { top: 200, right: 580, bottom: 240, left: 460, width: 120, height: 40 },
      popoverRect,
      popoverViewport,
      "right",
    )).toEqual({ top: 190, left: 368 });
    expect(nonOverlappingPopoverLayout(
      { top: 200, right: 20, bottom: 240, left: 0, width: 20, height: 40 },
      popoverRect,
      popoverViewport,
      "top",
    )).toEqual({ top: 128, left: 12 });
    expect(nonOverlappingPopoverLayout(
      { top: 100, right: 120, bottom: 140, left: 0, width: 120, height: 40 },
      { width: 700, height: 700 },
      popoverViewport,
      "top",
    )).toEqual({ top: -112, left: -112 });
  });

  it("positions with visualViewport, falls back to window, no-ops safely, and uses one RAF", async () => {

    const writes: unknown[][] = [];
    const wrapper = {
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
      style: { setProperty: (...args: unknown[]) => writes.push(args) },
    };
    const target = element({ rect: { top: 50, right: 120, bottom: 90, left: 20, width: 100, height: 40 } });
    const popover = { closest: () => wrapper } as unknown as HTMLElement;
    const driver = { getActiveElement: () => target };
    const avatar = { style: {} } as HTMLElement;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(7);
      return 7;
    });
    vi.stubGlobal("window", {
      innerWidth: 500,
      innerHeight: 400,
      visualViewport: { offsetTop: 10, offsetLeft: 5, width: 480, height: 360 },
      requestAnimationFrame,
    });
    pinPopoverAwayFromTarget(popover, driver as never, "top");
    positionFocusAvatar(avatar, target, "top");
    await nextFrame();
    expect(writes).toEqual([
      ["top", "102px", "important"],
      ["left", "20px", "important"],
      ["right", "auto", "important"],
      ["bottom", "auto", "important"],
    ]);
    expect(avatar.style.top).toBe("58px");
    expect(avatar.style.left).toBe("130px");

    const fallbackWrites: unknown[][] = [];
    const fallbackWrapper = {
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
      style: { setProperty: (...args: unknown[]) => fallbackWrites.push(args) },
    };
    const fallbackTarget = element({
      rect: { top: 100, right: 200, bottom: 140, left: 100, width: 100, height: 40 },
    });
    vi.stubGlobal("window", {
      innerWidth: 500,
      innerHeight: 400,
      requestAnimationFrame,
    });
    pinPopoverAwayFromTarget(
      { closest: () => fallbackWrapper } as unknown as HTMLElement,
      { getActiveElement: () => fallbackTarget } as never,
      "top",
    );
    const fallbackAvatar = { style: {} } as HTMLElement;
    positionFocusAvatar(fallbackAvatar, fallbackTarget, "top");
    expect(fallbackWrites).toEqual([
      ["top", "48px", "important"],
      ["left", "100px", "important"],
      ["right", "auto", "important"],
      ["bottom", "auto", "important"],
    ]);
    expect(fallbackAvatar.style.top).toBe("108px");
    expect(fallbackAvatar.style.left).toBe("210px");

    const noOpWrites = vi.fn();
    pinPopoverAwayFromTarget(
      { closest: () => null } as unknown as HTMLElement,
      { getActiveElement: () => fallbackTarget } as never,
      "top",
    );
    pinPopoverAwayFromTarget(
      {
        closest: () => ({
          style: { setProperty: noOpWrites },
          getBoundingClientRect: () => ({ width: 1, height: 1 }),
        }),
      } as unknown as HTMLElement,
      { getActiveElement: () => null } as never,
      "top",
    );
    expect(noOpWrites).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
  });
});

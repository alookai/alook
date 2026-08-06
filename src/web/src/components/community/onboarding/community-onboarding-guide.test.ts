import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adjacentAvatarLayout,
  dismissGuideOnTargetClick,
  guideCopy,
  findGuideTarget,
  guidePopoverSide,
  nonOverlappingPopoverLayout,
  rectFitsViewport,
  shouldAutoRouteGuide,
  waitForTarget,
} from "./community-onboarding-guide";

const botStage = { status: "active", stage: "bot" } as const;
const machine = (id: string, status: "online" | "offline") => ({ id, status });

describe("community onboarding guide routing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("routes a zero-machine bot step to Pair", () => {
    const copy = guideCopy(botStage, { machines: [], bots: [] });

    expect(copy).toMatchObject({
      target: { name: "connect-machine" },
      route: "/c/me/machines",
    });
  });

  it("routes an offline-only bot step to the exact Reconnect control", () => {
    const copy = guideCopy(botStage, {
      machines: [machine("machine-b", "offline"), machine("machine-a", "offline")],
      bots: [],
    });

    expect(copy).toMatchObject({
      target: { name: "reconnect-machine", resourceId: "machine-a" },
      route: "/c/me/machines",
    });
  });

  it("keeps the normal bot step when an online machine is available", () => {
    const copy = guideCopy(botStage, {
      machines: [machine("offline", "offline"), machine("online", "online")],
      bots: [],
    });

    expect(copy).toMatchObject({
      target: { name: "create-bot" },
      route: "/c/me/bots",
    });
  });

  it("prefers the pending bot's bound offline machine over another online machine", () => {
    const copy = guideCopy(
      { ...botStage, botId: "bot-7" },
      {
        machines: [machine("online", "online"), machine("bound", "offline")],
        bots: [{ id: "bot-7", machineId: "bound" }],
      },
    );

    expect(copy).toMatchObject({
      target: { name: "reconnect-machine", resourceId: "bound" },
      route: "/c/me/machines",
    });
  });

  it("cleans up and resolves null when a target times out", async () => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    vi.stubGlobal("document", {
      body: {},
      querySelectorAll: () => [],
    });
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("MutationObserver", class {
      observe() {}
      disconnect() {
        disconnect();
      }
    });

    const pending = waitForTarget({ name: "connect-machine" }, 50);
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toBeNull();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("accepts a full-width composer that legitimately touches viewport edges", () => {
    expect(rectFitsViewport({
      top: 780,
      right: 390,
      bottom: 844,
      left: 0,
      width: 390,
      height: 64,
    }, 390, 844)).toBe(true);
  });

  it("auto-routes a stage once without trapping later navigation", () => {
    const route = "/c/me/dm-7";
    const routeKey = `active:dm:${route}`;

    expect(shouldAutoRouteGuide(route, "/c/me/bots", routeKey, null)).toBe(true);
    expect(shouldAutoRouteGuide(route, "/c/me/bots", routeKey, routeKey)).toBe(false);
  });

  it("places bottom-edge composer cards above their targets", () => {
    expect(guidePopoverSide({ name: "dm-composer" })).toBe("top");
    expect(guidePopoverSide({ name: "channel-composer" })).toBe("top");
    expect(guidePopoverSide({ name: "add-server" })).toBe("right");
    expect(guidePopoverSide({ name: "reconnect-machine", resourceId: "machine-1" })).toBe("bottom");
  });

  it("hands Driver the inner interactive control instead of its large wrapper", () => {
    const control = {
      isConnected: true,
      matches: () => true,
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 320, height: 48 }),
      dataset: {},
    } as unknown as HTMLElement;
    const wrapper = {
      isConnected: true,
      matches: () => false,
      querySelector: () => control,
      getBoundingClientRect: () => ({ width: 1214, height: 136 }),
      dataset: {},
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      querySelectorAll: () => [wrapper],
    });
    vi.stubGlobal("window", {
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        pointerEvents: "auto",
      }),
    });

    expect(findGuideTarget({ name: "dm-composer" })).toBe(control);
  });

  it("places a compact card entirely away from a lower-screen button", () => {
    const layout = nonOverlappingPopoverLayout(
      { top: 170, right: 220, bottom: 210, left: 100, width: 120, height: 40 },
      { width: 390, height: 90 },
      { top: 0, left: 0, width: 430, height: 240 },
    );

    expect(layout).toEqual({ top: 68, left: 12 });
    expect(layout.top + 90).toBeLessThan(170);
  });

  it("places a compact card below an upper-screen button when above is unavailable", () => {
    const layout = nonOverlappingPopoverLayout(
      { top: 20, right: 220, bottom: 60, left: 100, width: 120, height: 40 },
      { width: 390, height: 90 },
      { top: 0, left: 0, width: 430, height: 240 },
    );

    expect(layout).toEqual({ top: 72, left: 12 });
    expect(layout.top).toBeGreaterThan(60);
  });

  it("prefers step 1 and 2 cards below their buttons when both sides fit", () => {
    const layout = nonOverlappingPopoverLayout(
      { top: 200, right: 260, bottom: 240, left: 140, width: 120, height: 40 },
      { width: 300, height: 90 },
      { top: 0, left: 0, width: 600, height: 600 },
      "bottom",
    );

    expect(layout).toEqual({ top: 252, left: 50 });
  });

  it("keeps the companion beside a button and away from its bottom popover", () => {
    const layout = adjacentAvatarLayout(
      { top: 100, right: 220, bottom: 140, left: 100 },
      28,
      { top: 0, left: 0, width: 400, height: 300 },
      "bottom",
    );

    expect(layout).toEqual({ top: 108, left: 230 });
  });

  it("puts the companion above a full-width bottom composer when needed", () => {
    const layout = adjacentAvatarLayout(
      { top: 780, right: 390, bottom: 844, left: 0 },
      28,
      { top: 0, left: 0, width: 390, height: 844 },
      "top",
    );

    expect(layout).toEqual({ top: 742, left: 8 });
  });

  it("keeps step 3 visible while the user focuses and types in the composer", () => {
    expect(dismissGuideOnTargetClick({ name: "dm-composer" })).toBe(false);
    expect(dismissGuideOnTargetClick({ name: "create-bot" })).toBe(true);
  });
});

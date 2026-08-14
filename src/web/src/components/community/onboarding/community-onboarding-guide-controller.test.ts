import { readFileSync } from "node:fs";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityOnboardingState } from "@/lib/community-onboarding";
import type { CommunityOnboardingGuideController } from "./community-onboarding-guide-types";

const mocks = vi.hoisted(() => ({
  hookOrder: [] as string[],
  pathname: "/c/me",
  machines: [] as Array<{ id: string; status: "online" | "offline" }>,
  machinesSuccess: false,
  bots: [] as Array<{ id: string; machineId: string }>,
  botsSuccess: false,
  state: null as CommunityOnboardingState | null,
  router: { replace: vi.fn(), push: vi.fn() },
  advance: vi.fn(),
  recover: vi.fn(),
  skip: vi.fn(),
  driverFactory: vi.fn(),
  waitForTarget: vi.fn(),
  isUsable: vi.fn(),
  inViewport: vi.fn(),
  nextFrame: vi.fn(),
  side: vi.fn(),
  pin: vi.fn(),
  position: vi.fn(),
  shouldRoute: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => {
    mocks.hookOrder.push("router");
    return mocks.router;
  },
  usePathname: () => {
    mocks.hookOrder.push("pathname");
    return mocks.pathname;
  },
}));
vi.mock("@/hooks/community/use-machines", () => ({
  useMachines: () => {
    mocks.hookOrder.push("machines");
    return { machines: mocks.machines, isSuccess: mocks.machinesSuccess };
  },
}));
vi.mock("@/hooks/community/use-bots", () => ({
  useBots: () => {
    mocks.hookOrder.push("bots");
    return { bots: mocks.bots, isSuccess: mocks.botsSuccess };
  },
}));
vi.mock("@/lib/community-onboarding", () => ({
  useCommunityOnboarding: () => {
    mocks.hookOrder.push("onboarding");
    return mocks.state;
  },
  advanceCommunityOnboarding: mocks.advance,
  recoverCommunityOnboardingMachine: mocks.recover,
  skipCommunityOnboarding: mocks.skip,
}));
vi.mock("driver.js", () => ({ driver: mocks.driverFactory }));
vi.mock("./community-onboarding-guide-target", () => ({
  dismissGuideOnTargetClick: mocks.dismiss,
  guidePopoverSide: mocks.side,
  isGuideTargetUsable: mocks.isUsable,
  nextFrame: mocks.nextFrame,
  pinPopoverAwayFromTarget: mocks.pin,
  positionFocusAvatar: mocks.position,
  shouldAutoRouteGuide: mocks.shouldRoute,
  targetIsInViewport: mocks.inViewport,
  waitForTarget: mocks.waitForTarget,
}));

import { useCommunityOnboardingGuideController } from "./community-onboarding-guide-controller";

let latest!: CommunityOnboardingGuideController;
const renderers: TestRenderer.ReactTestRenderer[] = [];
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Probe() {
  const controller = useCommunityOnboardingGuideController();
  React.useEffect(() => {
    latest = controller;
  }, [controller]);
  return null;
}

describe("useCommunityOnboardingGuideController", () => {
  const bodyAdd = vi.fn();
  const bodyRemove = vi.fn();
  const appendChild = vi.fn();
  const windowAdd = vi.fn();
  const windowRemove = vi.fn();
  const viewportAdd = vi.fn();
  const viewportRemove = vi.fn();
  const cancelAnimationFrame = vi.fn();
  const avatarRemove = vi.fn();
  const avatar = { className: "", style: {}, remove: avatarRemove } as unknown as HTMLElement;
  const candidate = {
    scrollIntoView: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLElement;
  const instance = {
    destroy: vi.fn(),
    refresh: vi.fn(),
    highlight: vi.fn(),
    getActiveElement: vi.fn(() => candidate),
  };
  let driverOptions: Record<string, unknown> | undefined;
  let rafCallback: FrameRequestCallback | undefined;
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    rafCallback = callback;
    return 41;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hookOrder.length = 0;
    mocks.pathname = "/c/me";
    mocks.machines = [];
    mocks.machinesSuccess = false;
    mocks.bots = [];
    mocks.botsSuccess = false;
    mocks.state = null;
    mocks.waitForTarget.mockImplementation(() => new Promise(() => {}));
    mocks.isUsable.mockReturnValue(true);
    mocks.inViewport.mockReturnValue(true);
    mocks.nextFrame.mockResolvedValue(undefined);
    mocks.side.mockImplementation((target: { name: string }) =>
      target.name === "dm-composer" ? "top" : target.name === "add-server" ? "right" : "bottom");
    mocks.shouldRoute.mockImplementation(
      (route: string | undefined, pathname: string, routeKey: string, routedKey: string | null) =>
        Boolean(route && pathname !== route && routedKey !== routeKey),
    );
    mocks.dismiss.mockImplementation((target: { name: string }) => target.name !== "dm-composer");
    instance.getActiveElement.mockReturnValue(candidate);
    mocks.driverFactory.mockImplementation((options: Record<string, unknown>) => {
      driverOptions = options;
      return instance;
    });
    driverOptions = undefined;
    rafCallback = undefined;
    vi.stubGlobal("document", {
      body: {
        appendChild,
        classList: { add: bodyAdd, remove: bodyRemove },
      },
      createElement: () => avatar,
    });
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame,
      cancelAnimationFrame,
      addEventListener: windowAdd,
      removeEventListener: windowRemove,
      visualViewport: {
        addEventListener: viewportAdd,
        removeEventListener: viewportRemove,
      },
    });
    vi.stubGlobal("ResizeObserver", undefined);
  });

  afterEach(() => {
    for (const renderer of renderers.splice(0)) {
      act(() => renderer.unmount());
    }
    vi.unstubAllGlobals();
  });

  const render = () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(React.createElement(Probe)); });
    renderers.push(renderer);
    return renderer;
  };

  it("keeps the complete global hook order, phases, dependencies, and helper boundary", () => {
    render();
    expect(mocks.hookOrder.slice(0, 5)).toEqual([
      "router",
      "pathname",
      "machines",
      "bots",
      "onboarding",
    ]);
    const source = readFileSync(
      "src/components/community/onboarding/community-onboarding-guide-controller.ts",
      "utf8",
    );
    const owners = [
      "const router = useRouter();",
      "const pathname = usePathname();",
      "const machinesQuery = useMachines();",
      "const botsQuery = useBots();",
      "const state = useCommunityOnboarding();",
      "const [popoverContainer",
      "const [targetAvatarContainer",
      "const driverRef = useRef",
      "const targetAvatarRef = useRef",
      "const routedGuideRef = useRef",
      "const copy = useMemo",
      "const destroyGuide = useCallback",
    ];
    const ownerPositions = owners.map((needle) => source.indexOf(needle));
    expect(ownerPositions.every((position) => position >= 0)).toBe(true);
    expect(ownerPositions).toEqual([...ownerPositions].sort((a, b) => a - b));
    const effectKinds = [...source.matchAll(/\n  (useEffect|useLayoutEffect)\(\(\) =>/g)]
      .map((match) => match[1]);
    expect(effectKinds).toEqual(["useEffect", "useEffect", "useLayoutEffect", "useEffect"]);
    expect(source).toContain("}, [state, machinesQuery.isSuccess, machinesQuery.machines]);");
    expect(source).toContain("}, [copy, state]);");
    expect(source).toContain("}, [popoverContainer, copy]);");
    expect(source).toContain("}, [copy, destroyGuide, pathname, router, state]);");
    expect(source).toContain(
      "[state, machinesQuery.isSuccess, machinesQuery.machines, botsQuery.isSuccess, botsQuery.bots]",
    );
    expect(source).toMatch(/const destroyGuide = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[\]\);/);
    expect(source).toContain("if (!popoverContainer) return;");
    expect(source).toContain("if (!instance) return;");
    expect(source).toContain("if (!copy) return;");
    expect(source).toContain("if (targetAvatarRef.current && activeTarget) {");
    for (const path of [
      "src/components/community/onboarding/community-onboarding-guide-copy.ts",
      "src/components/community/onboarding/community-onboarding-guide-target.ts",
    ]) {
      expect(readFileSync(path, "utf8")).not.toMatch(/\buse[A-Z]\w*\(/);
    }
    const view = readFileSync(
      "src/components/community/onboarding/community-onboarding-guide-view.tsx",
      "utf8",
    );
    expect(view.match(/useEffect\(/g)).toHaveLength(1);
    expect(view.indexOf("function GuideCard")).toBeLessThan(view.indexOf("useEffect("));
    expect(view.indexOf("export function renderCommunityOnboardingGuide"))
      .toBeGreaterThan(view.indexOf("useEffect("));
  });

  it("gates copy readiness and preserves every advance/recovery conjunction", () => {
    mocks.state = { status: "active", stage: "machine" };
    mocks.machines = [{ id: "machine-1", status: "online" }];
    const renderer = render();
    expect(latest.copy).toBeNull();
    expect(mocks.advance).not.toHaveBeenCalled();

    mocks.machinesSuccess = true;
    act(() => renderer.update(React.createElement(Probe)));
    expect(latest.copy).toBeNull();
    expect(mocks.advance).toHaveBeenCalledOnce();
    expect(mocks.advance).toHaveBeenCalledWith("machine", "bot");

    mocks.advance.mockClear();
    mocks.machines = [{ id: "machine-1", status: "offline" }];
    act(() => renderer.update(React.createElement(Probe)));
    expect(mocks.advance).not.toHaveBeenCalled();

    mocks.machines = [{ id: "machine-1", status: "online" }];
    mocks.machinesSuccess = false;
    act(() => renderer.update(React.createElement(Probe)));
    expect(mocks.advance).not.toHaveBeenCalled();

    mocks.machinesSuccess = true;
    mocks.state = { status: "active", stage: "bot" };
    mocks.machines = [];
    act(() => renderer.update(React.createElement(Probe)));
    expect(mocks.advance).not.toHaveBeenCalled();
    expect(latest.copy?.target).toEqual({ name: "connect-machine" });
    expect(mocks.recover).toHaveBeenCalledOnce();

    mocks.recover.mockClear();
    mocks.machines = [{ id: "offline", status: "offline" }];
    act(() => renderer.update(React.createElement(Probe)));
    expect(latest.copy?.target).toEqual({ name: "reconnect-machine", resourceId: "offline" });
    expect(mocks.recover).toHaveBeenCalledOnce();

    mocks.recover.mockClear();
    mocks.state = { status: "active", stage: "bot", machineRecovery: true };
    act(() => renderer.update(React.createElement(Probe)));
    expect(mocks.recover).not.toHaveBeenCalled();

    mocks.state = { status: "active", stage: "machine" };
    act(() => renderer.update(React.createElement(Probe)));
    expect(latest.copy?.target.name).toBe("reconnect-machine");
    expect(mocks.recover).not.toHaveBeenCalled();

    mocks.state = { status: "active", stage: "bot" };
    mocks.machines = [{ id: "online", status: "online" }];
    act(() => renderer.update(React.createElement(Probe)));
    expect(latest.copy?.target.name).toBe("create-bot");
    expect(mocks.recover).not.toHaveBeenCalled();

    mocks.state = { status: "active", stage: "bot", botId: "bot-1" };
    mocks.botsSuccess = false;
    act(() => renderer.update(React.createElement(Probe)));
    expect(latest.copy).toBeNull();
    expect(mocks.recover).not.toHaveBeenCalled();

    mocks.state = null;
    act(() => renderer.update(React.createElement(Probe)));
    expect(mocks.advance).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("routes each key once without clearing the routed ref when copy loses its route", () => {
    mocks.state = { status: "active", stage: "bot" };
    mocks.machines = [{ id: "machine-1", status: "online" }];
    mocks.machinesSuccess = true;
    mocks.pathname = "/c/me";
    const renderer = render();
    expect(mocks.router.replace).toHaveBeenCalledWith("/c/me/bots");

    mocks.pathname = "/c/elsewhere";
    act(() => renderer.update(React.createElement(Probe)));
    expect(mocks.router.replace).toHaveBeenCalledTimes(1);

    mocks.state = { status: "active", stage: "server" };
    act(() => renderer.update(React.createElement(Probe)));
    expect(mocks.router.replace).toHaveBeenCalledTimes(1);

    mocks.state = { status: "active", stage: "bot" };
    act(() => renderer.update(React.createElement(Probe)));
    expect(mocks.router.replace).toHaveBeenCalledTimes(1);

    mocks.state = { status: "active", stage: "dm", dmId: "dm-7" };
    act(() => renderer.update(React.createElement(Probe)));
    expect(mocks.router.replace).toHaveBeenLastCalledWith("/c/me/dm-7");
    expect(mocks.router.replace).toHaveBeenCalledTimes(2);
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(mocks.shouldRoute).toHaveBeenCalledWith(
      "/c/me/dm-7",
      "/c/elsewhere",
      "active:dm:/c/me/dm-7",
      "active:bot:/c/me/bots",
    );
  });

  it("marks a current route key and early-returns on a later wrong path for that key", () => {
    mocks.state = { status: "active", stage: "bot" };
    mocks.machines = [{ id: "machine-1", status: "online" }];
    mocks.machinesSuccess = true;
    mocks.pathname = "/c/me/bots";
    const renderer = render();
    expect(mocks.shouldRoute).toHaveBeenLastCalledWith(
      "/c/me/bots",
      "/c/me/bots",
      "active:bot:/c/me/bots",
      "active:bot:/c/me/bots",
    );
    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(mocks.waitForTarget).toHaveBeenCalledOnce();

    mocks.waitForTarget.mockClear();
    mocks.driverFactory.mockClear();
    mocks.pathname = "/c/elsewhere";
    act(() => renderer.update(React.createElement(Probe)));
    expect(mocks.shouldRoute).toHaveBeenLastCalledWith(
      "/c/me/bots",
      "/c/elsewhere",
      "active:bot:/c/me/bots",
      "active:bot:/c/me/bots",
    );
    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(mocks.waitForTarget).not.toHaveBeenCalled();
    expect(mocks.driverFactory).not.toHaveBeenCalled();
  });

  it("retries target waits, then preserves two-frame Driver and DOM/ref ordering", async () => {
    mocks.state = { status: "active", stage: "server" };
    mocks.waitForTarget.mockResolvedValueOnce(null).mockResolvedValueOnce(candidate);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    renderers.push(renderer);
    expect(mocks.waitForTarget).toHaveBeenCalledTimes(2);
    expect(mocks.waitForTarget.mock.calls[0]![1]).toBe(2000);
    expect(candidate.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
    expect(mocks.nextFrame).toHaveBeenCalledTimes(2);
    expect(candidate.scrollIntoView.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.nextFrame.mock.invocationCallOrder[0]!);
    expect(mocks.nextFrame.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.driverFactory.mock.invocationCallOrder[0]!);
    expect(mocks.isUsable).toHaveBeenCalledWith(candidate);
    expect(mocks.inViewport).toHaveBeenCalledWith(candidate);
    expect(driverOptions).toMatchObject({
      animate: true,
      allowClose: false,
      overlayColor: "var(--community-onboarding-overlay)",
      overlayOpacity: 0.46,
      stagePadding: 8,
      stageRadius: 12,
      disableActiveInteraction: false,
      showButtons: [],
      popoverClass: "community-onboarding-popover community-onboarding-popover-right",
    });
    expect((driverOptions!.overlayClickBehavior as () => unknown)()).toBeUndefined();
    expect(instance.highlight).toHaveBeenCalledWith({
      element: candidate,
      popover: { description: "Loading", side: "right", align: "center" },
    });
    expect(appendChild).toHaveBeenCalledWith(avatar);
    expect(avatar.className).toBe("community-onboarding-focus-avatar");
    expect(mocks.position).toHaveBeenCalledWith(avatar, candidate, "right");
    expect(bodyAdd).toHaveBeenCalledWith("community-onboarding-active");
    expect(candidate.addEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      { once: true },
    );
    expect(instance.highlight.mock.invocationCallOrder[0])
      .toBeLessThan(appendChild.mock.invocationCallOrder[0]!);
    expect(appendChild.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.position.mock.invocationCallOrder[0]!);
    expect(mocks.position.mock.invocationCallOrder[0])
      .toBeLessThan(bodyAdd.mock.invocationCallOrder[0]!);
    expect(bodyAdd.mock.invocationCallOrder[0])
      .toBeLessThan(candidate.addEventListener.mock.invocationCallOrder[0]!);

    const description = {
      replaceChildren: vi.fn(() => {
        expect(latest.popoverContainer).toBeNull();
      }),
      parentElement: null,
    } as unknown as HTMLElement;
    act(() => {
      (driverOptions!.onPopoverRender as (popover: { description: HTMLElement }) => void)({
        description,
      });
    });
    expect(description.replaceChildren).toHaveBeenCalledOnce();
    expect(instance.refresh).toHaveBeenCalledOnce();
    expect(rafCallback).toEqual(expect.any(Function));
    act(() => rafCallback?.(41));
    expect(mocks.pin).toHaveBeenCalledWith(description, instance, "right");
    expect(mocks.position).toHaveBeenLastCalledWith(avatar, candidate, "right");
    expect(latest.popoverContainer).toBe(description);
    expect(latest.targetAvatarContainer).toBe(avatar);

    act(() => renderer.update(React.createElement(Probe)));
    expect(latest.popoverContainer).toBe(description);
    expect(latest.targetAvatarContainer).toBe(avatar);
    expect(instance.destroy).not.toHaveBeenCalled();

    const source = readFileSync(
      "src/components/community/onboarding/community-onboarding-guide-controller.ts",
      "utf8",
    );
    const lifecycleOrder = [
      "instance = driver({",
      "driverRef.current = instance;",
      "instance.highlight({",
      'avatarContainer = document.createElement("div");',
      'avatarContainer.className = "community-onboarding-focus-avatar";',
      "document.body.appendChild(avatarContainer);",
      "targetAvatarRef.current = avatarContainer;",
      "positionFocusAvatar(avatarContainer, target, popoverSide);",
      "setTargetAvatarContainer(avatarContainer);",
      'document.body.classList.add("community-onboarding-active");',
      "if (dismissGuideOnTargetClick(copy.target)) {",
      'target.addEventListener("click", handleTargetClick, { once: true });',
    ].map((needle) => source.indexOf(needle));
    expect(lifecycleOrder.every((position) => position >= 0)).toBe(true);
    expect(lifecycleOrder).toEqual([...lifecycleOrder].sort((a, b) => a - b));
    expect(source.indexOf("popover.description.replaceChildren();"))
      .toBeLessThan(source.indexOf("setPopoverContainer(popover.description);"));
  });

  it("uses reduced-motion Driver configuration without changing startup", async () => {
    mocks.state = { status: "active", stage: "server" };
    mocks.waitForTarget.mockResolvedValue(candidate);
    window.matchMedia = vi.fn(() => ({ matches: true })) as never;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    renderers.push(renderer);
    expect(driverOptions).toMatchObject({
      animate: false,
      allowClose: false,
      disableActiveInteraction: false,
    });
    expect(instance.highlight).toHaveBeenCalledOnce();
  });

  it("aborts a pending wait and ignores its stale completion after unmount", async () => {
    const wait = deferred<HTMLElement | null>();
    let signal!: AbortSignal;
    mocks.state = { status: "active", stage: "server" };
    mocks.waitForTarget.mockImplementation(
      (_target, timeout: number, nextSignal: AbortSignal) => {
        expect(timeout).toBe(2000);
        signal = nextSignal;
        return wait.promise;
      },
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    expect(signal.aborted).toBe(false);
    act(() => renderer.unmount());
    expect(signal.aborted).toBe(true);

    await act(async () => {
      wait.resolve(candidate);
      await wait.promise;
      await Promise.resolve();
    });
    expect(candidate.scrollIntoView).not.toHaveBeenCalled();
    expect(mocks.nextFrame).not.toHaveBeenCalled();
    expect(mocks.driverFactory).not.toHaveBeenCalled();
    expect(appendChild).not.toHaveBeenCalled();
    expect(bodyAdd).not.toHaveBeenCalled();
  });

  it("finishes both sequential frames but rejects stale post-abort Driver work", async () => {
    const firstFrame = deferred<void>();
    const secondFrame = deferred<void>();
    mocks.state = { status: "active", stage: "server" };
    mocks.waitForTarget.mockResolvedValue(candidate);
    mocks.nextFrame
      .mockReturnValueOnce(firstFrame.promise)
      .mockReturnValueOnce(secondFrame.promise);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(candidate.scrollIntoView).toHaveBeenCalledOnce();
    expect(mocks.nextFrame).toHaveBeenCalledOnce();
    act(() => renderer.unmount());

    await act(async () => {
      firstFrame.resolve();
      await firstFrame.promise;
      await Promise.resolve();
    });
    expect(mocks.nextFrame).toHaveBeenCalledTimes(2);
    await act(async () => {
      secondFrame.resolve();
      await secondFrame.promise;
      await Promise.resolve();
    });
    expect(mocks.isUsable).toHaveBeenCalledWith(candidate);
    expect(mocks.inViewport).toHaveBeenCalledWith(candidate);
    expect(mocks.driverFactory).not.toHaveBeenCalled();
    expect(appendChild).not.toHaveBeenCalled();
    expect(bodyAdd).not.toHaveBeenCalled();
  });

  it("cleans an active run once across replacement and unmount, then leading-destroys popover", async () => {
    mocks.state = { status: "active", stage: "server" };
    mocks.waitForTarget.mockResolvedValueOnce(candidate)
      .mockImplementation(() => new Promise(() => {}));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const description = {
      replaceChildren: vi.fn(),
      parentElement: null,
    } as unknown as HTMLElement;
    act(() => {
      (driverOptions!.onPopoverRender as (popover: { description: HTMLElement }) => void)({
        description,
      });
    });
    expect(latest.popoverContainer).toBe(description);
    const clickHandler = candidate.addEventListener.mock.calls[0]![1];

    mocks.state = { status: "active", stage: "server", serverId: "server-1" };
    act(() => renderer.update(React.createElement(Probe)));
    expect(candidate.removeEventListener).toHaveBeenCalledWith("click", clickHandler);
    expect(instance.destroy).toHaveBeenCalledOnce();
    expect(avatarRemove).toHaveBeenCalledOnce();
    expect(bodyRemove).toHaveBeenCalledWith("community-onboarding-active");
    expect(latest.popoverContainer).toBeNull();
    expect(latest.targetAvatarContainer).toBeNull();

    act(() => renderer.unmount());
    expect(instance.destroy).toHaveBeenCalledOnce();
    expect(avatarRemove).toHaveBeenCalledOnce();
    expect(candidate.removeEventListener).toHaveBeenCalledOnce();
  });

  it("keeps DM click persistence, narrow cleanup, leading destroy, and destroy-before-skip", async () => {
    mocks.state = { status: "active", stage: "dm" };
    mocks.waitForTarget.mockResolvedValue(candidate);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
    });
    renderers.push(renderer);
    expect(candidate.addEventListener).not.toHaveBeenCalled();

    const description = {
      replaceChildren: vi.fn(),
      parentElement: null,
    } as unknown as HTMLElement;
    act(() => {
      (driverOptions!.onPopoverRender as (popover: { description: HTMLElement }) => void)({
        description,
      });
    });
    expect(latest.popoverContainer).toBe(description);
    act(() => latest.onSkip());
    expect(instance.destroy.mock.invocationCallOrder.at(-1))
      .toBeLessThan(mocks.skip.mock.invocationCallOrder[0]!);
    expect(avatarRemove).toHaveBeenCalled();
    expect(bodyRemove).toHaveBeenCalledWith("community-onboarding-active");
    expect(latest.popoverContainer).toBeNull();

    const source = readFileSync(
      "src/components/community/onboarding/community-onboarding-guide-controller.ts",
      "utf8",
    );
    const destroyBlock = source.slice(
      source.indexOf("const destroyGuide = useCallback"),
      source.indexOf("  useEffect(() => {"),
    );
    const destroyOrder = [
      "const instance = driverRef.current;",
      "driverRef.current = null;",
      "instance?.destroy();",
      "targetAvatarRef.current?.remove();",
      "targetAvatarRef.current = null;",
      'document.body.classList.remove("community-onboarding-active");',
      "setPopoverContainer(null);",
      "setTargetAvatarContainer(null);",
    ].map((needle) => destroyBlock.indexOf(needle));
    expect(destroyOrder.every((position) => position >= 0)).toBe(true);
    expect(destroyOrder).toEqual([...destroyOrder].sort((a, b) => a - b));
    const lifecycle = source.slice(source.lastIndexOf("useEffect(() => {"));
    const cleanup = lifecycle.slice(lifecycle.indexOf("return () => {"));
    expect(lifecycle.indexOf("destroyGuide();")).toBeLessThan(lifecycle.indexOf("if (!copy"));
    const cleanupOrder = [
      "abortController.abort();",
      'target?.removeEventListener("click", handleTargetClick)',
      "if (driverRef.current === instance) driverRef.current = null;",
      "if (targetAvatarRef.current === avatarContainer) targetAvatarRef.current = null;",
      "avatarContainer?.remove();",
      "instance?.destroy();",
      'document.body.classList.remove("community-onboarding-active");',
      "setTargetAvatarContainer(null);",
      "instance = null;",
    ].map((needle) => cleanup.indexOf(needle));
    expect(cleanupOrder.every((position) => position >= 0)).toBe(true);
    expect(cleanupOrder).toEqual([...cleanupOrder].sort((a, b) => a - b));
    expect(cleanup).toContain("setTargetAvatarContainer(null);");
    expect(cleanup).not.toContain("setPopoverContainer(null);");
  });

  it("uses the ResizeObserver-absent cleanup branch without registering listeners", async () => {
    mocks.state = { status: "active", stage: "server" };
    mocks.waitForTarget.mockResolvedValue(candidate);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const description = {
      replaceChildren: vi.fn(),
      parentElement: null,
    } as unknown as HTMLElement;
    act(() => {
      (driverOptions!.onPopoverRender as (popover: { description: HTMLElement }) => void)({
        description,
      });
    });
    expect(instance.refresh).toHaveBeenCalledOnce();
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(windowAdd).not.toHaveBeenCalled();
    expect(viewportAdd).not.toHaveBeenCalled();

    act(() => renderer.unmount());
    expect(cancelAnimationFrame).toHaveBeenCalledWith(41);
    expect(windowRemove).not.toHaveBeenCalled();
    expect(viewportRemove).not.toHaveBeenCalled();
  });

  it("keeps a null popover container as a complete positioning no-op", () => {
    mocks.state = null;
    render();
    expect(instance.refresh).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(windowAdd).not.toHaveBeenCalled();
    expect(viewportAdd).not.toHaveBeenCalled();
  });

  it("keeps a stale popover callback harmless after the Driver ref is cleared", async () => {
    mocks.state = { status: "active", stage: "server" };
    mocks.waitForTarget.mockResolvedValue(candidate);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    renderers.push(renderer);
    const onPopoverRender = driverOptions!.onPopoverRender as (
      popover: { description: HTMLElement }
    ) => void;
    act(() => latest.onSkip());
    instance.refresh.mockClear();
    requestAnimationFrame.mockClear();
    const staleDescription = {
      replaceChildren: vi.fn(),
      parentElement: null,
    } as unknown as HTMLElement;
    act(() => onPopoverRender({ description: staleDescription }));
    expect(latest.popoverContainer).toBe(staleDescription);
    expect(instance.refresh).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("observes only the popover when its optional parent is absent", async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe = observe;
      disconnect = disconnect;
    });
    mocks.state = { status: "active", stage: "server" };
    mocks.waitForTarget.mockResolvedValue(candidate);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const description = {
      replaceChildren: vi.fn(),
      parentElement: null,
    } as unknown as HTMLElement;
    act(() => {
      (driverOptions!.onPopoverRender as (popover: { description: HTMLElement }) => void)({
        description,
      });
    });
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(description);
    act(() => renderer.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps the observer-present positioning listener and cleanup matrix", async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe = observe;
      disconnect = disconnect;
    });
    mocks.state = { status: "active", stage: "server" };
    mocks.waitForTarget.mockResolvedValue(candidate);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    renderers.push(renderer);
    const description = {
      replaceChildren: vi.fn(),
      parentElement: { id: "parent" },
    } as unknown as HTMLElement;
    act(() => {
      (driverOptions!.onPopoverRender as (popover: { description: HTMLElement }) => void)({
        description,
      });
    });
    expect(observe).toHaveBeenNthCalledWith(1, description);
    expect(observe).toHaveBeenNthCalledWith(2, description.parentElement);
    expect(windowAdd).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(windowAdd).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    expect(viewportAdd).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(viewportAdd).toHaveBeenCalledWith("scroll", expect.any(Function));

    const refresh = windowAdd.mock.calls.find(([name]) => name === "resize")![1] as () => void;
    instance.refresh.mockClear();
    cancelAnimationFrame.mockClear();
    requestAnimationFrame.mockClear();
    act(() => refresh());
    expect(instance.refresh).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(41);
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(instance.refresh.mock.invocationCallOrder[0])
      .toBeLessThan(cancelAnimationFrame.mock.invocationCallOrder[0]!);
    expect(cancelAnimationFrame.mock.invocationCallOrder[0])
      .toBeLessThan(requestAnimationFrame.mock.invocationCallOrder[0]!);

    mocks.pin.mockClear();
    mocks.position.mockClear();
    instance.getActiveElement.mockReturnValue(null);
    act(() => rafCallback?.(41));
    expect(mocks.pin).toHaveBeenCalledWith(description, instance, "right");
    expect(mocks.position).not.toHaveBeenCalled();

    act(() => renderer.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
    expect(windowRemove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    expect(viewportRemove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(viewportRemove).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(cancelAnimationFrame).toHaveBeenCalledWith(41);
  });
});

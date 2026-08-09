"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { GeneratedAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { driver, type Driver } from "driver.js";
import { isPresenceOnline, type CommunityMachineSummary } from "@alook/shared";
import { useMachines } from "@/hooks/community/use-machines";
import { useBots, type BotSummary } from "@/hooks/community/use-bots";
import {
  advanceCommunityOnboarding,
  recoverCommunityOnboardingMachine,
  skipCommunityOnboarding,
  type CommunityOnboardingState,
  useCommunityOnboarding,
} from "@/lib/community-onboarding";

type GuideCopy = {
  target: GuideTarget;
  eyebrow: string;
  title: string;
  route?: string;
};

type GuideTarget = {
  name: "channel-composer" | "connect-machine" | "reconnect-machine" | "create-bot" | "dm-composer" | "add-server";
  resourceId?: string;
};

type GuidePopoverSide = "top" | "right" | "bottom";

type GuideContext = {
  machines: Pick<CommunityMachineSummary, "id" | "status">[];
  bots: Pick<BotSummary, "id" | "machineId">[];
};

const target = (name: GuideTarget["name"], resourceId?: string): GuideTarget => ({
  name,
  ...(resourceId ? { resourceId } : {}),
});

function stableOfflineMachine(machines: GuideContext["machines"]) {
  return machines
    .filter((machine) => !isPresenceOnline(machine.status))
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}

function recoveryCopy(machine: GuideContext["machines"][number], eyebrow: string): GuideCopy {
  return {
    target: target("reconnect-machine", machine.id),
    eyebrow,
    title: "Bring your machine back online",
    route: "/c/me/machines",
  };
}

export function guideCopy(
  state: CommunityOnboardingState,
  { machines, bots }: GuideContext,
): GuideCopy | null {
  if (state.stage === "machine") {
    if (machines.some((machine) => isPresenceOnline(machine.status))) return null;
    const offlineMachine = stableOfflineMachine(machines);
    if (offlineMachine) return recoveryCopy(offlineMachine, "Step 1 of 4");
    return {
      target: target("connect-machine"),
      eyebrow: "Step 1 of 4",
      title: "Give your bot a place to run",
      route: "/c/me/machines",
    };
  }
  if (state.stage === "bot") {
    const boundMachineId = state.botId
      ? bots.find((bot) => bot.id === state.botId)?.machineId
      : undefined;
    const boundMachine = boundMachineId
      ? machines.find((machine) => machine.id === boundMachineId)
      : undefined;
    if (boundMachine && !isPresenceOnline(boundMachine.status)) {
      return recoveryCopy(boundMachine, "Step 2 of 4");
    }
    if (!machines.some((machine) => isPresenceOnline(machine.status))) {
      const offlineMachine = stableOfflineMachine(machines);
      if (offlineMachine) return recoveryCopy(offlineMachine, "Step 2 of 4");
      return {
        target: target("connect-machine"),
        eyebrow: "Step 2 of 4",
        title: "Give your bot a place to run",
        route: "/c/me/machines",
      };
    }
    if (state.botId) {
      return {
        target: target("create-bot"),
        eyebrow: "Step 2 of 4",
        title: "Meet your bot in chat",
        route: "/c/me/bots",
      };
    }
    return {
      target: target("create-bot"),
      eyebrow: "Step 2 of 4",
      title: "Create a bot with a voice of its own",
      route: "/c/me/bots",
    };
  }
  if (state.stage === "dm") {
    return {
      target: target("dm-composer"),
      eyebrow: "Step 3 of 4",
      title: "Start a conversation with your bot",
      route: state.dmId ? `/c/me/${state.dmId}` : undefined,
    };
  }
  const recovering = Boolean(state.serverId);
  return {
    target: target("add-server"),
    eyebrow: "Step 4 of 4",
    title: recovering
      ? "Bring your bot into the server"
      : "Make a shared home for friends and family",
  };
}

function guideTargetControl(element: HTMLElement) {
  if (element.matches("button:not([disabled]), [role=button], .ProseMirror")) return element;
  return element.querySelector<HTMLElement>("button:not([disabled]), [role=button], .ProseMirror");
}

function isGuideTargetUsable(element: HTMLElement) {
  if (!element.isConnected) return false;
  const control = guideTargetControl(element);
  if (!control) return false;
  const elementStyle = window.getComputedStyle(element);
  const controlStyle = window.getComputedStyle(control);
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    elementStyle.display !== "none" &&
    elementStyle.visibility !== "hidden" &&
    controlStyle.display !== "none" &&
    controlStyle.visibility !== "hidden" &&
    controlStyle.pointerEvents !== "none"
  );
}

export function findGuideTarget(guideTarget: GuideTarget) {
  const candidates = document.querySelectorAll<HTMLElement>(
    `[data-onboarding-target="${guideTarget.name}"]`,
  );
  for (const candidate of candidates) {
    if (guideTarget.resourceId && candidate.dataset.onboardingId !== guideTarget.resourceId) {
      continue;
    }
    if (!isGuideTargetUsable(candidate)) continue;
    const control = guideTargetControl(candidate);
    if (control) return control;
  }
  return null;
}

export function waitForTarget(
  guideTarget: GuideTarget,
  timeoutMs = 2000,
  signal?: AbortSignal,
) {
  return new Promise<HTMLElement | null>((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    let candidate: HTMLElement | null = null;
    let settleTimer: number | null = null;
    let observer: MutationObserver | null = null;
    let timeout: number | null = null;
    let finished = false;
    const finish = (target: HTMLElement | null) => {
      if (finished) return;
      finished = true;
      observer?.disconnect();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (timeout !== null) window.clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      resolve(target);
    };
    const handleAbort = () => finish(null);
    const check = () => {
      const next = findGuideTarget(guideTarget);
      if (next === candidate) return;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      candidate = next;
      if (!candidate) return;
      settleTimer = window.setTimeout(() => {
        const current = findGuideTarget(guideTarget);
        if (current && current === candidate) finish(current);
        else check();
      }, 200);
    };
    observer = new MutationObserver(check);
    timeout = window.setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener("abort", handleAbort, { once: true });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    check();
  });
}

export function rectFitsViewport(
  rect: Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">,
  viewportWidth: number,
  viewportHeight: number,
) {
  const tolerance = 1;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= -tolerance &&
    rect.left >= -tolerance &&
    rect.bottom <= viewportHeight + tolerance &&
    rect.right <= viewportWidth + tolerance
  );
}

function targetIsInViewport(element: HTMLElement) {
  const control = guideTargetControl(element) ?? element;
  return rectFitsViewport(control.getBoundingClientRect(), window.innerWidth, window.innerHeight);
}

export function shouldAutoRouteGuide(
  route: string | undefined,
  pathname: string,
  routeKey: string,
  routedKey: string | null,
) {
  return Boolean(route && pathname !== route && routedKey !== routeKey);
}

export function guidePopoverSide(guideTarget: GuideTarget): GuidePopoverSide {
  if (guideTarget.name === "dm-composer" || guideTarget.name === "channel-composer") {
    return "top";
  }
  if (guideTarget.name === "add-server") return "right";
  return "bottom";
}

export function dismissGuideOnTargetClick(guideTarget: GuideTarget) {
  return guideTarget.name !== "dm-composer";
}

type ViewportRect = { top: number; left: number; width: number; height: number };

export function adjacentAvatarLayout(
  targetRect: Pick<DOMRect, "top" | "right" | "bottom" | "left">,
  avatarSize: number,
  viewport: ViewportRect,
  popoverSide: GuidePopoverSide,
) {
  const margin = 8;
  const gap = 10;
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;
  const clampLeft = (left: number) =>
    Math.min(Math.max(left, viewport.left + margin), viewportRight - avatarSize - margin);
  const clampTop = (top: number) =>
    Math.min(Math.max(top, viewport.top + margin), viewportBottom - avatarSize - margin);
  const positions = {
    right: { top: clampTop(targetRect.top + 8), left: targetRect.right + gap },
    left: { top: clampTop(targetRect.top + 8), left: targetRect.left - gap - avatarSize },
    top: { top: targetRect.top - gap - avatarSize, left: clampLeft(targetRect.left + 8) },
    bottom: { top: targetRect.bottom + gap, left: clampLeft(targetRect.left + 8) },
  };
  const candidates =
    popoverSide === "right"
      ? [positions.bottom, positions.top, positions.left, positions.right]
      : popoverSide === "bottom"
        ? [positions.right, positions.left, positions.top, positions.bottom]
        : [positions.right, positions.left, positions.bottom, positions.top];
  const fits = ({ top, left }: { top: number; left: number }) =>
    top >= viewport.top + margin &&
    left >= viewport.left + margin &&
    top + avatarSize <= viewportBottom - margin &&
    left + avatarSize <= viewportRight - margin;

  return candidates.find(fits) ?? {
    top: clampTop(targetRect.top - avatarSize - gap),
    left: clampLeft(targetRect.left + 8),
  };
}

export function nonOverlappingPopoverLayout(
  targetRect: Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">,
  popoverRect: Pick<DOMRect, "width" | "height">,
  viewport: ViewportRect,
  preferredSide: GuidePopoverSide = "top",
) {
  const margin = 12;
  const gap = 12;
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;
  const centeredLeft = Math.min(
    Math.max(
      targetRect.left + targetRect.width / 2 - popoverRect.width / 2,
      viewport.left + margin,
    ),
    viewportRight - popoverRect.width - margin,
  );
  const centeredTop = Math.min(
    Math.max(
      targetRect.top + targetRect.height / 2 - popoverRect.height / 2,
      viewport.top + margin,
    ),
    viewportBottom - popoverRect.height - margin,
  );
  const above = { top: targetRect.top - gap - popoverRect.height, left: centeredLeft };
  const below = { top: targetRect.bottom + gap, left: centeredLeft };
  const right = { top: centeredTop, left: targetRect.right + gap };
  const left = { top: centeredTop, left: targetRect.left - gap - popoverRect.width };
  const candidates =
    preferredSide === "bottom"
      ? [below, above, right, left]
      : preferredSide === "right"
        ? [right, left, below, above]
        : [above, below, right, left];
  const fits = ({ top, left }: { top: number; left: number }) =>
    top >= viewport.top + margin &&
    left >= viewport.left + margin &&
    top + popoverRect.height <= viewportBottom - margin &&
    left + popoverRect.width <= viewportRight - margin;
  const fittingCandidate = candidates.find(fits);
  if (fittingCandidate) return fittingCandidate;

  const targetCenterY = targetRect.top + targetRect.height / 2;
  return {
    top:
      targetCenterY >= viewport.top + viewport.height / 2
        ? viewport.top + margin
        : viewportBottom - popoverRect.height - margin,
    left: centeredLeft,
  };
}

function pinPopoverAwayFromTarget(
  popoverContainer: HTMLElement,
  instance: Driver,
  preferredSide: GuidePopoverSide,
) {
  const wrapper = popoverContainer.closest<HTMLElement>(".driver-popover");
  const activeTarget = instance.getActiveElement();
  if (!wrapper || !activeTarget) return;
  const visualViewport = window.visualViewport;
  const viewport = {
    top: visualViewport?.offsetTop ?? 0,
    left: visualViewport?.offsetLeft ?? 0,
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
  };
  const layout = nonOverlappingPopoverLayout(
    activeTarget.getBoundingClientRect(),
    wrapper.getBoundingClientRect(),
    viewport,
    preferredSide,
  );
  wrapper.style.setProperty("top", `${layout.top}px`, "important");
  wrapper.style.setProperty("left", `${layout.left}px`, "important");
  wrapper.style.setProperty("right", "auto", "important");
  wrapper.style.setProperty("bottom", "auto", "important");
}

function positionFocusAvatar(
  avatarContainer: HTMLElement,
  activeTarget: Element,
  popoverSide: GuidePopoverSide,
) {
  const visualViewport = window.visualViewport;
  const viewport = {
    top: visualViewport?.offsetTop ?? 0,
    left: visualViewport?.offsetLeft ?? 0,
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
  };
  const layout = adjacentAvatarLayout(
    activeTarget.getBoundingClientRect(),
    28,
    viewport,
    popoverSide,
  );
  avatarContainer.style.top = `${layout.top}px`;
  avatarContainer.style.left = `${layout.left}px`;
}

function nextFrame() {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function GuideCard({
  copy,
  onSkip,
}: {
  copy: GuideCopy;
  onSkip: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onSkip();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onSkip]);
  return (
    <div className="community-onboarding-card">
      <div className="community-onboarding-content">
        <div className="community-onboarding-meta">
          <p className="community-onboarding-eyebrow">{copy.eyebrow}</p>
          <Button variant="ghost" className="community-onboarding-skip" onClick={onSkip}>
            Skip guide
          </Button>
        </div>
        <h2>{copy.title}</h2>
      </div>
    </div>
  );
}

export function CommunityOnboardingGuide() {
  const router = useRouter();
  const pathname = usePathname();
  const machinesQuery = useMachines();
  const botsQuery = useBots();
  const state = useCommunityOnboarding();
  const [popoverContainer, setPopoverContainer] = useState<HTMLElement | null>(null);
  const [targetAvatarContainer, setTargetAvatarContainer] = useState<HTMLElement | null>(null);
  const driverRef = useRef<Driver | null>(null);
  const targetAvatarRef = useRef<HTMLElement | null>(null);
  const routedGuideRef = useRef<string | null>(null);

  const copy = useMemo(
    () => {
      if (!state) return null;
      if ((state.stage === "machine" || state.stage === "bot") && !machinesQuery.isSuccess) {
        return null;
      }
      if (
        state.stage === "bot" &&
        state.botId &&
        !botsQuery.isSuccess
      ) {
        return null;
      }
      return guideCopy(state, {
        machines: machinesQuery.machines,
        bots: botsQuery.bots,
      });
    },
    [state, machinesQuery.isSuccess, machinesQuery.machines, botsQuery.isSuccess, botsQuery.bots],
  );
  const destroyGuide = useCallback(() => {
    const instance = driverRef.current;
    driverRef.current = null;
    instance?.destroy();
    targetAvatarRef.current?.remove();
    targetAvatarRef.current = null;
    document.body.classList.remove("community-onboarding-active");
    setPopoverContainer(null);
    setTargetAvatarContainer(null);
  }, []);

  useEffect(() => {
    if (
      state?.status !== "active" ||
      state.stage !== "machine" ||
      !machinesQuery.isSuccess ||
      !machinesQuery.machines.some((machine) => isPresenceOnline(machine.status))
    ) {
      return;
    }
    advanceCommunityOnboarding("machine", "bot");
  }, [state, machinesQuery.isSuccess, machinesQuery.machines]);

  useEffect(() => {
    const recoveryTarget =
      copy?.target.name === "connect-machine" || copy?.target.name === "reconnect-machine";
    if (!recoveryTarget || state?.status !== "active" || state.stage !== "bot" || state.machineRecovery) return;
    recoverCommunityOnboardingMachine();
  }, [copy, state]);

  useLayoutEffect(() => {
    if (!popoverContainer) return;
    let positionFrame: number | null = null;
    const refresh = () => {
      const instance = driverRef.current;
      if (!instance) return;
      instance.refresh();
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      positionFrame = window.requestAnimationFrame(() => {
        positionFrame = null;
        if (!copy) return;
        const popoverSide = guidePopoverSide(copy.target);
        pinPopoverAwayFromTarget(popoverContainer, instance, popoverSide);
        const activeTarget = instance.getActiveElement();
        if (targetAvatarRef.current && activeTarget) {
          positionFocusAvatar(targetAvatarRef.current, activeTarget, popoverSide);
        }
      });
    };
    refresh();
    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      };
    }
    const observer = new ResizeObserver(refresh);
    observer.observe(popoverContainer);
    if (popoverContainer.parentElement) observer.observe(popoverContainer.parentElement);
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    window.visualViewport?.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("scroll", refresh);
    return () => {
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      observer.disconnect();
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      window.visualViewport?.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("scroll", refresh);
    };
  }, [popoverContainer, copy]);

  useEffect(() => {
    destroyGuide();
    if (!copy || !state) return;
    const stageKey = state.stage;
    const routeKey = `${state.status}:${stageKey}:${copy.route ?? ""}`;
    if (copy.route && pathname === copy.route) routedGuideRef.current = routeKey;
    if (
      copy.route &&
      shouldAutoRouteGuide(copy.route, pathname, routeKey, routedGuideRef.current)
    ) {
      routedGuideRef.current = routeKey;
      router.replace(copy.route);
      return;
    }
    if (copy.route && pathname !== copy.route) {
      return;
    }

    const abortController = new AbortController();
    let target: HTMLElement | null = null;
    let instance: Driver | null = null;
    let avatarContainer: HTMLElement | null = null;
    let handleTargetClick: (() => void) | null = null;

    void (async () => {
      while (!abortController.signal.aborted && !target) {
        const candidate = await waitForTarget(copy.target, 2000, abortController.signal);
        if (!candidate || abortController.signal.aborted) continue;
        candidate.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
        await nextFrame();
        await nextFrame();
        if (isGuideTargetUsable(candidate) && targetIsInViewport(candidate)) target = candidate;
      }
      if (abortController.signal.aborted || !target) return;
      const popoverSide = guidePopoverSide(copy.target);
      instance = driver({
        animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        allowClose: false,
        overlayClickBehavior: () => undefined,
        overlayColor: "var(--community-onboarding-overlay)",
        overlayOpacity: 0.46,
        stagePadding: 8,
        stageRadius: 12,
        disableActiveInteraction: false,
        showButtons: [],
        popoverClass: `community-onboarding-popover community-onboarding-popover-${popoverSide}`,
        onPopoverRender: (popover) => {
          popover.description.replaceChildren();
          setPopoverContainer(popover.description);
        },
      });
      driverRef.current = instance;
      instance.highlight({
        element: target,
        popover: {
          description: "Loading",
          side: popoverSide,
          align: "center",
        },
      });
      avatarContainer = document.createElement("div");
      avatarContainer.className = "community-onboarding-focus-avatar";
      document.body.appendChild(avatarContainer);
      targetAvatarRef.current = avatarContainer;
      positionFocusAvatar(avatarContainer, target, popoverSide);
      setTargetAvatarContainer(avatarContainer);
      document.body.classList.add("community-onboarding-active");
      if (dismissGuideOnTargetClick(copy.target)) {
        handleTargetClick = () => {
          destroyGuide();
        };
        target.addEventListener("click", handleTargetClick, { once: true });
      }
    })();

    return () => {
      abortController.abort();
      if (handleTargetClick) target?.removeEventListener("click", handleTargetClick);
      if (driverRef.current === instance) driverRef.current = null;
      if (targetAvatarRef.current === avatarContainer) targetAvatarRef.current = null;
      avatarContainer?.remove();
      instance?.destroy();
      document.body.classList.remove("community-onboarding-active");
      setTargetAvatarContainer(null);
      instance = null;
    };
  }, [copy, destroyGuide, pathname, router, state]);

  if (!copy || !state) return null;
  return (
    <>
      {popoverContainer
        ? createPortal(
            <GuideCard
              copy={copy}
              onSkip={() => {
                destroyGuide();
                skipCommunityOnboarding();
              }}
            />,
            popoverContainer,
          )
        : null}
      {targetAvatarContainer
        ? createPortal(
            <GeneratedAvatar
              seed={state.guideAvatarSeed ?? "alook-guide"}
              size={28}
              className="rounded-full ring-2 ring-background shadow-md"
            />,
            targetAvatarContainer,
          )
        : null}
    </>
  );
}

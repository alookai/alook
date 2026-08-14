import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { driver, type Driver } from "driver.js";
import { isPresenceOnline } from "@alook/shared";
import { useMachines } from "@/hooks/community/use-machines";
import { useBots } from "@/hooks/community/use-bots";
import {
  advanceCommunityOnboarding,
  recoverCommunityOnboardingMachine,
  skipCommunityOnboarding,
  useCommunityOnboarding,
} from "@/lib/community-onboarding";
import { guideCopy } from "./community-onboarding-guide-copy";
import {
  dismissGuideOnTargetClick,
  guidePopoverSide,
  isGuideTargetUsable,
  nextFrame,
  pinPopoverAwayFromTarget,
  positionFocusAvatar,
  shouldAutoRouteGuide,
  targetIsInViewport,
  waitForTarget,
} from "./community-onboarding-guide-target";
import type { CommunityOnboardingGuideController } from "./community-onboarding-guide-types";

export function useCommunityOnboardingGuideController(): CommunityOnboardingGuideController {
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

  return {
    copy,
    state,
    popoverContainer,
    targetAvatarContainer,
    onSkip: () => {
      destroyGuide();
      skipCommunityOnboarding();
    },
  };
}

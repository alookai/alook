import type { Driver } from "driver.js";
import type {
  GuidePopoverSide,
  GuideTarget,
  ViewportRect,
} from "./community-onboarding-guide-types";

export function guideTargetControl(element: HTMLElement) {
  if (element.matches("button:not([disabled]), [role=button], .ProseMirror")) return element;
  return element.querySelector<HTMLElement>("button:not([disabled]), [role=button], .ProseMirror");
}

export function isGuideTargetUsable(element: HTMLElement) {
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

export function targetIsInViewport(element: HTMLElement) {
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

export function pinPopoverAwayFromTarget(
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

export function positionFocusAvatar(
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

export function nextFrame() {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

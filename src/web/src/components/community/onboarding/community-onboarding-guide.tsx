"use client";

import { useCommunityOnboardingGuideController } from "./community-onboarding-guide-controller";
import { renderCommunityOnboardingGuide } from "./community-onboarding-guide-view";

export { guideCopy } from "./community-onboarding-guide-copy";
export {
  adjacentAvatarLayout,
  dismissGuideOnTargetClick,
  findGuideTarget,
  guidePopoverSide,
  nonOverlappingPopoverLayout,
  rectFitsViewport,
  shouldAutoRouteGuide,
  waitForTarget,
} from "./community-onboarding-guide-target";

export function CommunityOnboardingGuide() {
  const controller = useCommunityOnboardingGuideController();
  return renderCommunityOnboardingGuide(controller);
}

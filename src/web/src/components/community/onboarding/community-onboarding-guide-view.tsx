import { useEffect } from "react";
import { createPortal } from "react-dom";
import { GeneratedAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import type {
  CommunityOnboardingGuideController,
  GuideCopy,
} from "./community-onboarding-guide-types";

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

export function renderCommunityOnboardingGuide({
  copy,
  state,
  popoverContainer,
  targetAvatarContainer,
  onSkip,
}: CommunityOnboardingGuideController) {
  if (!copy || !state) return null;
  return (
    <>
      {popoverContainer
        ? createPortal(
            <GuideCard copy={copy} onSkip={onSkip} />,
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

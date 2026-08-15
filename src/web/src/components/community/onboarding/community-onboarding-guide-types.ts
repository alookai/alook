import type { CommunityMachineSummary } from "@alook/shared";
import type { BotSummary } from "@/hooks/community/use-bots";
import type { CommunityOnboardingState } from "@/lib/community-onboarding";

export type GuideTarget = {
  name:
    | "channel-composer"
    | "connect-machine"
    | "reconnect-machine"
    | "create-bot"
    | "dm-composer"
    | "add-server";
  resourceId?: string;
};

export type GuideCopy = {
  target: GuideTarget;
  eyebrow: string;
  title: string;
  route?: string;
};

export type GuidePopoverSide = "top" | "right" | "bottom";

export type GuideContext = {
  machines: Pick<CommunityMachineSummary, "id" | "status">[];
  bots: Pick<BotSummary, "id" | "machineId">[];
};

export type ViewportRect = { top: number; left: number; width: number; height: number };

export type CommunityOnboardingGuideController = {
  copy: GuideCopy | null;
  state: CommunityOnboardingState | null;
  popoverContainer: HTMLElement | null;
  targetAvatarContainer: HTMLElement | null;
  onSkip: () => void;
};

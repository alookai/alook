"use client";

import { type RefObject } from "react";
import dynamic from "next/dynamic";

import { useAgentContext } from "@/contexts/agent-context";
import { useInboxCount } from "@/contexts/inbox-count-context";
import { useHomePetSettings } from "@/lib/home-pet-settings";
import type { CloudCodeMonsterPetProps } from "./cloud-code-monster-pet";

const CloudCodeMonsterPet = dynamic<CloudCodeMonsterPetProps>(
  () =>
    import("./cloud-code-monster-pet").then(
      (module) => module.CloudCodeMonsterPet
    ),
  { ssr: false }
);

type WorkspacePetLayerProps = {
  boundaryRef: RefObject<HTMLElement | null>;
  slug?: string;
};

export function WorkspacePetLayer({ boundaryRef }: WorkspacePetLayerProps) {
  const { activeTaskDetails, subscribeWs } = useAgentContext();
  const petSettings = useHomePetSettings();
  const { notificationToken, count: inboxCount } = useInboxCount();

  if (!petSettings.enabled) {
    return null;
  }

  return (
    <CloudCodeMonsterPet
      inboxCount={inboxCount}
      activeAgentTaskCount={activeTaskDetails.length}
      subscribeWs={subscribeWs}
      boundaryRef={boundaryRef}
      notificationToken={notificationToken}
    />
  );
}

"use client";

import { useSyncExternalStore } from "react";

import {
  trackCommunityOnboardingCompleted,
  trackCommunityOnboardingSkipped,
  trackCommunityOnboardingStageCompleted,
  trackCommunityOnboardingStarted,
  type CommunityOnboardingStage,
} from "@/lib/analytics";

type JourneyResources = {
  botId?: string;
  dmId?: string;
  serverId?: string;
  generalId?: string;
  machineRecovery?: boolean;
  guideAvatarSeed?: string;
};

export type CommunityOnboardingState = {
  status: "active";
  stage: CommunityOnboardingStage;
} & JourneyResources;

let currentState: CommunityOnboardingState | null = null;
const listeners = new Set<(state: CommunityOnboardingState | null) => void>();

function publish(state: CommunityOnboardingState | null) {
  currentState = state;
  for (const listener of listeners) listener(state);
  return state;
}

export function readCommunityOnboardingState() {
  return currentState;
}

export function startCommunityOnboarding(resources: Pick<JourneyResources, "guideAvatarSeed"> = {}) {
  if (currentState) return currentState;
  const next: CommunityOnboardingState = { ...resources, status: "active", stage: "machine" };
  publish(next);
  trackCommunityOnboardingStarted();
  return next;
}

export function advanceCommunityOnboarding(
  expected: CommunityOnboardingStage,
  nextStage: CommunityOnboardingStage,
  resources: JourneyResources = {},
) {
  if (currentState?.status !== "active" || currentState.stage !== expected) {
    return currentState;
  }
  const next: CommunityOnboardingState = {
    ...currentState,
    ...resources,
    status: "active",
    stage: nextStage,
  };
  publish(next);
  trackCommunityOnboardingStageCompleted(expected);
  return next;
}

export function updateCommunityOnboardingResources(resources: JourneyResources) {
  if (currentState?.status !== "active") return currentState;
  return publish({ ...currentState, ...resources });
}

export function recoverCommunityOnboardingMachine() {
  if (currentState?.status !== "active" || currentState.stage !== "bot") {
    return currentState;
  }
  return publish({ ...currentState, machineRecovery: true });
}

export function completeCommunityOnboarding() {
  if (currentState?.status !== "active" || currentState.stage !== "server") {
    return currentState;
  }
  publish(null);
  trackCommunityOnboardingStageCompleted("server");
  trackCommunityOnboardingCompleted();
  return null;
}

export function skipCommunityOnboarding() {
  if (!currentState) return null;
  const stage = currentState.stage;
  publish(null);
  trackCommunityOnboardingSkipped(stage);
  return null;
}

export function isCommunityOnboardingStage(stage: CommunityOnboardingStage) {
  return currentState?.status === "active" && currentState.stage === stage;
}

export function subscribeCommunityOnboarding(
  listener: (state: CommunityOnboardingState | null) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function subscribeCommunityOnboardingStore(onStoreChange: () => void) {
  return subscribeCommunityOnboarding(onStoreChange);
}

export function useCommunityOnboarding() {
  return useSyncExternalStore(
    subscribeCommunityOnboardingStore,
    readCommunityOnboardingState,
    () => null,
  );
}

"use client";

import { useSelector } from "@tanstack/react-store";
import { useCommunityRuntime, type CommunityRuntime } from "@/stores/community/runtime";
import type { OnboardingInitializationProtocol } from "./community/models/onboarding";

import {
  trackCommunityOnboardingCompleted,
  trackCommunityOnboardingSkipped,
  trackCommunityOnboardingStageCompleted,
  trackCommunityOnboardingStarted,
  type CommunityOnboardingStage,
} from "@/lib/analytics";

type JourneyResources = {
  harness?: string;
  machineId?: string;
  identity?: string;
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
  initialization?: OnboardingInitializationProtocol;
} & JourneyResources;

function publish(runtime: CommunityRuntime, state: CommunityOnboardingState | null) {
  if (!runtime.lifecycle.get().active) throw new DOMException("Retired onboarding owner", "AbortError");
  runtime.ui.setState((current) => ({ ...current, onboardingState: state }));
  return state;
}

export function readCommunityOnboardingState(runtime: CommunityRuntime) {
  return runtime.ui.get().onboardingState;
}

export function startCommunityOnboarding(runtime: CommunityRuntime, resources: Pick<JourneyResources, "guideAvatarSeed"> = {}) {
  const currentState = readCommunityOnboardingState(runtime);
  if (currentState) return currentState;
  const next: CommunityOnboardingState = { ...resources, status: "active", stage: "harness" };
  publish(runtime, next);
  trackCommunityOnboardingStarted();
  return next;
}

export function advanceCommunityOnboarding(
  runtime: CommunityRuntime,
  expected: CommunityOnboardingStage,
  nextStage: CommunityOnboardingStage,
  resources: JourneyResources = {},
) {
  const currentState = readCommunityOnboardingState(runtime);
  if (currentState?.status !== "active" || currentState.stage !== expected) {
    return currentState;
  }
  const next: CommunityOnboardingState = {
    ...currentState,
    ...resources,
    status: "active",
    stage: nextStage,
  };
  publish(runtime, next);
  trackCommunityOnboardingStageCompleted(expected);
  return next;
}

export function updateCommunityOnboardingResources(runtime: CommunityRuntime, resources: JourneyResources) {
  const currentState = readCommunityOnboardingState(runtime);
  if (currentState?.status !== "active") return currentState;
  return publish(runtime, { ...currentState, ...resources });
}

export function updateCommunityOnboardingInitialization(runtime: CommunityRuntime, update: (current: OnboardingInitializationProtocol) => OnboardingInitializationProtocol) {
  const current = readCommunityOnboardingState(runtime);
  if (current?.stage !== "initializing") throw new DOMException("Retired onboarding initialization", "AbortError");
  return publish(runtime, { ...current, initialization: update(current.initialization ?? { checkpoint: {}, step: "creating-bots", result: null, pendingDestination: null }) });
}

export function recoverCommunityOnboardingHarness(runtime: CommunityRuntime) {
  const currentState = readCommunityOnboardingState(runtime);
  if (currentState?.status !== "active" || currentState.stage !== "machine") {
    return currentState;
  }
  const {
    harness: _harness,
    machineId: _machineId,
    ...retainedState
  } = currentState;
  return publish(runtime, { ...retainedState, stage: "harness" });
}

export function recoverCommunityOnboardingMachine(runtime: CommunityRuntime) {
  const currentState = readCommunityOnboardingState(runtime);
  if (currentState?.status !== "active" || currentState.stage !== "bot") {
    return currentState;
  }
  return publish(runtime, { ...currentState, machineRecovery: true });
}

export function completeCommunityOnboarding(runtime: CommunityRuntime) {
  const currentState = readCommunityOnboardingState(runtime);
  if (currentState?.status !== "active" || currentState.stage !== "initializing") {
    return currentState;
  }
  publish(runtime, null);
  trackCommunityOnboardingStageCompleted("initializing");
  trackCommunityOnboardingCompleted();
  return null;
}

export function skipCommunityOnboarding(runtime: CommunityRuntime) {
  const currentState = readCommunityOnboardingState(runtime);
  if (!currentState) return null;
  const stage = currentState.stage;
  publish(runtime, null);
  trackCommunityOnboardingSkipped(stage);
  return null;
}

export function isCommunityOnboardingStage(runtime: CommunityRuntime, stage: CommunityOnboardingStage) {
  const currentState = readCommunityOnboardingState(runtime);
  return currentState?.status === "active" && currentState.stage === stage;
}

export function subscribeCommunityOnboarding(
  runtime: CommunityRuntime,
  listener: (state: CommunityOnboardingState | null) => void,
) {
  const subscription = runtime.ui.subscribe(() => listener(readCommunityOnboardingState(runtime)));
  return () => subscription.unsubscribe();
}

export function useCommunityOnboarding() {
  return useSelector(useCommunityRuntime().ui, (state) => state.onboardingState);
}

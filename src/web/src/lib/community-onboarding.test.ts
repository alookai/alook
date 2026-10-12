import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analytics = vi.hoisted(() => ({
  started: vi.fn(),
  stageCompleted: vi.fn(),
  completed: vi.fn(),
  skipped: vi.fn(),
}));

vi.mock("@/lib/analytics", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    trackCommunityOnboardingStarted: () => { analytics.started(); actual.trackCommunityOnboardingStarted(); },
    trackCommunityOnboardingStageCompleted: (stage: Parameters<typeof actual.trackCommunityOnboardingStageCompleted>[0]) => { analytics.stageCompleted(stage); actual.trackCommunityOnboardingStageCompleted(stage); },
    trackCommunityOnboardingCompleted: () => { analytics.completed(); actual.trackCommunityOnboardingCompleted(); },
    trackCommunityOnboardingSkipped: (stage: Parameters<typeof actual.trackCommunityOnboardingSkipped>[0]) => { analytics.skipped(stage); actual.trackCommunityOnboardingSkipped(stage); },
  };
});

import { QueryClient } from "@tanstack/react-query";
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections";

import {
  advanceCommunityOnboarding,
  completeCommunityOnboarding,
  readCommunityOnboardingState,
  recoverCommunityOnboardingHarness,
  recoverCommunityOnboardingMachine,
  skipCommunityOnboarding,
  startCommunityOnboarding,
  subscribeCommunityOnboarding,
  updateCommunityOnboardingResources,
} from "./community-onboarding";

describe("community onboarding journey", () => {
  let registry: CommunityDbRegistry;
  const runtime = () => registry.runtime;
  beforeEach(() => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer");
    vi.clearAllMocks();
  });

  afterEach(() => {
    void registry.cleanup();
    registry.queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("starts once per explicit owner and never shares another account journey", () => {
    expect(readCommunityOnboardingState(runtime())).toBeNull();
    expect(startCommunityOnboarding(runtime())).toEqual({ status: "active", stage: "harness" });
    expect(startCommunityOnboarding(runtime())).toEqual({ status: "active", stage: "harness" });
    expect(analytics.started).toHaveBeenCalledOnce();
    const other = createCommunityDbRegistry(new QueryClient(), "other");
    expect(readCommunityOnboardingState(other.runtime)).toBeNull();
    void other.cleanup();
    other.queryClient.clear();
  });

  it("advances only from the expected stage and keeps the chosen onboarding context", () => {
    startCommunityOnboarding(runtime());
    advanceCommunityOnboarding(runtime(), "machine", "identity", { machineId: "wrong" });
    expect(readCommunityOnboardingState(runtime())).toMatchObject({ stage: "harness" });
    advanceCommunityOnboarding(runtime(), "harness", "machine", { harness: "codex" });
    advanceCommunityOnboarding(runtime(), "machine", "identity", { machineId: "machine-7" });
    advanceCommunityOnboarding(runtime(), "identity", "initializing", {
      identity: "developer",
    });
    expect(readCommunityOnboardingState(runtime())).toEqual({
      status: "active",
      stage: "initializing",
      harness: "codex",
      machineId: "machine-7",
      identity: "developer",
    });
  });

  it("keeps the same companion avatar through every guide stage", () => {
    startCommunityOnboarding(runtime(), { guideAvatarSeed: "guide-face-7" });
    advanceCommunityOnboarding(runtime(), "harness", "machine");
    advanceCommunityOnboarding(runtime(), "machine", "identity");
    advanceCommunityOnboarding(runtime(), "identity", "initializing");

    expect(readCommunityOnboardingState(runtime())).toMatchObject({
      stage: "initializing",
      guideAvatarSeed: "guide-face-7",
    });
  });

  it("recovers a missing machine without falsely completing the bot stage", () => {
    startCommunityOnboarding(runtime());
    advanceCommunityOnboarding(runtime(), "harness", "machine");
    advanceCommunityOnboarding(runtime(), "machine", "bot");
    recoverCommunityOnboardingMachine(runtime());
    expect(readCommunityOnboardingState(runtime())).toEqual({
      status: "active",
      stage: "bot",
      machineRecovery: true,
    });
    expect(analytics.stageCompleted).toHaveBeenCalledTimes(2);
  });

  it("returns to harness selection without completing machine or retaining stale choices", () => {
    startCommunityOnboarding(runtime(), { guideAvatarSeed: "guide-face-7" });
    advanceCommunityOnboarding(runtime(), "harness", "machine", { harness: "codex" });
    updateCommunityOnboardingResources(runtime(), { machineId: "stale-machine" });

    recoverCommunityOnboardingHarness(runtime());

    expect(readCommunityOnboardingState(runtime())).toEqual({
      status: "active",
      stage: "harness",
      guideAvatarSeed: "guide-face-7",
    });
    expect(analytics.stageCompleted).toHaveBeenCalledOnce();
    expect(analytics.stageCompleted).toHaveBeenCalledWith("harness");

    recoverCommunityOnboardingHarness(runtime());
    expect(analytics.stageCompleted).toHaveBeenCalledOnce();
  });

  it("clears an explicit skip and allows manual retry", () => {
    startCommunityOnboarding(runtime());
    skipCommunityOnboarding(runtime());
    expect(readCommunityOnboardingState(runtime())).toBeNull();
    expect(analytics.skipped).toHaveBeenCalledWith("harness");
    expect(startCommunityOnboarding(runtime())).toEqual({ status: "active", stage: "harness" });
  });

  it("completes only after initialization finishes", () => {
    startCommunityOnboarding(runtime());
    advanceCommunityOnboarding(runtime(), "harness", "machine");
    advanceCommunityOnboarding(runtime(), "machine", "identity");
    advanceCommunityOnboarding(runtime(), "identity", "initializing");
    completeCommunityOnboarding(runtime());
    expect(readCommunityOnboardingState(runtime())).toBeNull();
    expect(analytics.stageCompleted).toHaveBeenLastCalledWith("initializing");
    expect(analytics.completed).toHaveBeenCalledOnce();
  });

  it.each(["", "v1.denied", "v1.granted"])("queues actual completion once after initialization on private Web with Cookie %s", cookie => {
    const browser = { location: new URL("https://alook.ai/c/channels/private-server/private-room"), dataLayer: [] as unknown[] };
    vi.stubGlobal("window", browser);
    vi.stubGlobal("document", { cookie: `alook_analytics_consent=${cookie}` });
    completeCommunityOnboarding(runtime());
    startCommunityOnboarding(runtime());
    completeCommunityOnboarding(runtime());
    expect(browser.dataLayer).toEqual([{ event: "community_onboarding_started" }]);
    advanceCommunityOnboarding(runtime(), "harness", "machine");
    advanceCommunityOnboarding(runtime(), "machine", "identity");
    advanceCommunityOnboarding(runtime(), "identity", "initializing");
    completeCommunityOnboarding(runtime());
    completeCommunityOnboarding(runtime());
    expect(browser.dataLayer).toEqual([
      { event: "community_onboarding_started" },
      { event: "community_onboarding_stage_completed", stage: "harness" },
      { event: "community_onboarding_stage_completed", stage: "machine" },
      { event: "community_onboarding_stage_completed", stage: "identity" },
      { event: "community_onboarding_stage_completed", stage: "initializing" },
      { event: "community_onboarding_completed" },
    ]);
    expect(JSON.stringify(browser.dataLayer)).not.toMatch(/private|viewer|machineId/);
  });

  it("does not complete before initialization finishes", () => {
    startCommunityOnboarding(runtime());
    expect(completeCommunityOnboarding(runtime())).toEqual({ status: "active", stage: "harness" });
    expect(analytics.completed).not.toHaveBeenCalled();
  });

  it("publishes in-memory state changes to mounted consumers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCommunityOnboarding(runtime(), listener);
    startCommunityOnboarding(runtime());
    advanceCommunityOnboarding(runtime(), "harness", "machine");
    skipCommunityOnboarding(runtime());
    unsubscribe();
    expect(listener).toHaveBeenNthCalledWith(1, { status: "active", stage: "harness" });
    expect(listener).toHaveBeenNthCalledWith(2, { status: "active", stage: "machine" });
    expect(listener).toHaveBeenNthCalledWith(3, null);
  });
});

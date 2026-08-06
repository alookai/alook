import { beforeEach, describe, expect, it, vi } from "vitest";

const analytics = vi.hoisted(() => ({
  started: vi.fn(),
  stageCompleted: vi.fn(),
  completed: vi.fn(),
  skipped: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  trackCommunityOnboardingStarted: analytics.started,
  trackCommunityOnboardingStageCompleted: analytics.stageCompleted,
  trackCommunityOnboardingCompleted: analytics.completed,
  trackCommunityOnboardingSkipped: analytics.skipped,
}));

import {
  advanceCommunityOnboarding,
  completeCommunityOnboarding,
  readCommunityOnboardingState,
  recoverCommunityOnboardingMachine,
  skipCommunityOnboarding,
  startCommunityOnboarding,
  subscribeCommunityOnboarding,
  updateCommunityOnboardingResources,
} from "./community-onboarding";

describe("community onboarding journey", () => {
  beforeEach(() => {
    skipCommunityOnboarding();
    vi.clearAllMocks();
  });

  it("starts only from an explicit trigger", () => {
    expect(readCommunityOnboardingState()).toBeNull();
    expect(startCommunityOnboarding()).toEqual({ status: "active", stage: "machine" });
    expect(startCommunityOnboarding()).toEqual({ status: "active", stage: "machine" });
    expect(analytics.started).toHaveBeenCalledOnce();
  });

  it("advances only from the expected real-success stage and keeps exact ids", () => {
    startCommunityOnboarding();
    advanceCommunityOnboarding("bot", "dm", { botId: "wrong" });
    expect(readCommunityOnboardingState()).toMatchObject({ stage: "machine" });
    advanceCommunityOnboarding("machine", "bot");
    advanceCommunityOnboarding("bot", "dm", { botId: "bot-7", dmId: "dm-4" });
    advanceCommunityOnboarding("dm", "server");
    expect(readCommunityOnboardingState()).toEqual({
      status: "active",
      stage: "server",
      botId: "bot-7",
      dmId: "dm-4",
    });
  });

  it("keeps the same companion avatar through every guide stage", () => {
    startCommunityOnboarding({ guideAvatarSeed: "guide-face-7" });
    advanceCommunityOnboarding("machine", "bot");
    advanceCommunityOnboarding("bot", "dm", { botId: "bot-7" });
    advanceCommunityOnboarding("dm", "server");

    expect(readCommunityOnboardingState()).toMatchObject({
      stage: "server",
      guideAvatarSeed: "guide-face-7",
    });
  });

  it("recovers a missing machine without falsely completing the bot stage", () => {
    startCommunityOnboarding();
    advanceCommunityOnboarding("machine", "bot");
    recoverCommunityOnboardingMachine();
    expect(readCommunityOnboardingState()).toEqual({
      status: "active",
      stage: "bot",
      machineRecovery: true,
    });
    expect(analytics.stageCompleted).toHaveBeenCalledTimes(1);
  });

  it("clears an explicit skip and allows manual retry", () => {
    startCommunityOnboarding();
    skipCommunityOnboarding();
    expect(readCommunityOnboardingState()).toBeNull();
    expect(analytics.skipped).toHaveBeenCalledWith("machine");
    expect(startCommunityOnboarding()).toEqual({ status: "active", stage: "machine" });
  });

  it("completes as soon as the user opens new-server creation", () => {
    startCommunityOnboarding();
    advanceCommunityOnboarding("machine", "bot");
    advanceCommunityOnboarding("bot", "dm");
    advanceCommunityOnboarding("dm", "server");
    completeCommunityOnboarding();
    expect(readCommunityOnboardingState()).toBeNull();
    expect(analytics.stageCompleted).toHaveBeenLastCalledWith("server");
    expect(analytics.completed).toHaveBeenCalledOnce();
  });

  it("publishes in-memory state changes to mounted consumers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCommunityOnboarding(listener);
    startCommunityOnboarding();
    advanceCommunityOnboarding("machine", "bot");
    skipCommunityOnboarding();
    unsubscribe();
    expect(listener).toHaveBeenNthCalledWith(1, { status: "active", stage: "machine" });
    expect(listener).toHaveBeenNthCalledWith(2, { status: "active", stage: "bot" });
    expect(listener).toHaveBeenNthCalledWith(3, null);
  });
});

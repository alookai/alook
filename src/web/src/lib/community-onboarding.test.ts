import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  consumeQueuedCommunityOnboarding,
  queueCommunityOnboarding,
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists a pending signup journey until it is consumed once", () => {
    const pending = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => pending.get(key) ?? null,
        removeItem: (key: string) => pending.delete(key),
        setItem: (key: string, value: string) => pending.set(key, value),
      },
    });

    queueCommunityOnboarding();
    expect(consumeQueuedCommunityOnboarding()).toBe(true);
    expect(consumeQueuedCommunityOnboarding()).toBe(false);
  });

  it("keeps signup navigation usable when session storage is blocked", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("storage blocked");
      },
    });

    expect(() => queueCommunityOnboarding()).not.toThrow();
    expect(consumeQueuedCommunityOnboarding()).toBe(false);
  });

  it("starts only from an explicit trigger", () => {
    expect(readCommunityOnboardingState()).toBeNull();
    expect(startCommunityOnboarding()).toEqual({ status: "active", stage: "harness" });
    expect(startCommunityOnboarding()).toEqual({ status: "active", stage: "harness" });
    expect(analytics.started).toHaveBeenCalledOnce();
  });

  it("advances only from the expected stage and keeps the chosen onboarding context", () => {
    startCommunityOnboarding();
    advanceCommunityOnboarding("machine", "identity", { machineId: "wrong" });
    expect(readCommunityOnboardingState()).toMatchObject({ stage: "harness" });
    advanceCommunityOnboarding("harness", "machine", { harness: "codex" });
    advanceCommunityOnboarding("machine", "identity", { machineId: "machine-7" });
    advanceCommunityOnboarding("identity", "initializing", {
      identity: "developer",
    });
    expect(readCommunityOnboardingState()).toEqual({
      status: "active",
      stage: "initializing",
      harness: "codex",
      machineId: "machine-7",
      identity: "developer",
    });
  });

  it("keeps the same companion avatar through every guide stage", () => {
    startCommunityOnboarding({ guideAvatarSeed: "guide-face-7" });
    advanceCommunityOnboarding("harness", "machine");
    advanceCommunityOnboarding("machine", "identity");
    advanceCommunityOnboarding("identity", "initializing");

    expect(readCommunityOnboardingState()).toMatchObject({
      stage: "initializing",
      guideAvatarSeed: "guide-face-7",
    });
  });

  it("recovers a missing machine without falsely completing the bot stage", () => {
    startCommunityOnboarding();
    advanceCommunityOnboarding("harness", "machine");
    advanceCommunityOnboarding("machine", "bot");
    recoverCommunityOnboardingMachine();
    expect(readCommunityOnboardingState()).toEqual({
      status: "active",
      stage: "bot",
      machineRecovery: true,
    });
    expect(analytics.stageCompleted).toHaveBeenCalledTimes(2);
  });

  it("clears an explicit skip and allows manual retry", () => {
    startCommunityOnboarding();
    skipCommunityOnboarding();
    expect(readCommunityOnboardingState()).toBeNull();
    expect(analytics.skipped).toHaveBeenCalledWith("harness");
    expect(startCommunityOnboarding()).toEqual({ status: "active", stage: "harness" });
  });

  it("completes only after initialization finishes", () => {
    startCommunityOnboarding();
    advanceCommunityOnboarding("harness", "machine");
    advanceCommunityOnboarding("machine", "identity");
    advanceCommunityOnboarding("identity", "initializing");
    completeCommunityOnboarding();
    expect(readCommunityOnboardingState()).toBeNull();
    expect(analytics.stageCompleted).toHaveBeenLastCalledWith("initializing");
    expect(analytics.completed).toHaveBeenCalledOnce();
  });

  it("does not complete before initialization finishes", () => {
    startCommunityOnboarding();
    expect(completeCommunityOnboarding()).toEqual({ status: "active", stage: "harness" });
    expect(analytics.completed).not.toHaveBeenCalled();
  });

  it("publishes in-memory state changes to mounted consumers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCommunityOnboarding(listener);
    startCommunityOnboarding();
    advanceCommunityOnboarding("harness", "machine");
    skipCommunityOnboarding();
    unsubscribe();
    expect(listener).toHaveBeenNthCalledWith(1, { status: "active", stage: "harness" });
    expect(listener).toHaveBeenNthCalledWith(2, { status: "active", stage: "machine" });
    expect(listener).toHaveBeenNthCalledWith(3, null);
  });
});

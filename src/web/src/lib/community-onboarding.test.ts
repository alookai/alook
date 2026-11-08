import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analytics = vi.hoisted(() => ({
  started: vi.fn(),
  stageCompleted: vi.fn(),
  completed: vi.fn(),
  skipped: vi.fn(),
  product: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  trackCommunityOnboardingStarted: analytics.started,
  trackCommunityOnboardingStageCompleted: analytics.stageCompleted,
  trackCommunityOnboardingCompleted: analytics.completed,
  trackCommunityOnboardingSkipped: analytics.skipped,
}));

vi.mock("@/lib/product-analytics", () => ({ captureProductAnalytics: analytics.product }));

import { QueryClient } from "@tanstack/react-query";
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections";

import {
  finishCommunityOnboardingAgentSetup,
  switchCommunityOnboardingSetup,
  advanceCommunityOnboarding,
  completeCommunityOnboarding,
  readCommunityOnboardingState,
  recoverCommunityOnboardingHarness,
  skipCommunityOnboarding,
  startCommunityOnboarding,
  updateCommunityOnboardingInitialization,
} from "./community-onboarding";

describe("community onboarding journey", () => {
  let registry: CommunityDbRegistry;
  const runtime = () => registry.runtime;
  beforeEach(() => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer");
    vi.clearAllMocks();
  });

  it("completes an agent handoff once, only in agent machine setup", () => {
    startCommunityOnboarding(runtime());
    finishCommunityOnboardingAgentSetup(runtime());
    expect(readCommunityOnboardingState(runtime())?.stage).toBe("harness");
    advanceCommunityOnboarding(runtime(), "harness", "machine", { harness: "codex", setupMode: "manual" });
    finishCommunityOnboardingAgentSetup(runtime());
    expect(readCommunityOnboardingState(runtime())?.stage).toBe("machine");
    expect(analytics.product).not.toHaveBeenCalled();
    switchCommunityOnboardingSetup(runtime(), "agent");
    finishCommunityOnboardingAgentSetup(runtime());
    finishCommunityOnboardingAgentSetup(runtime());
    expect(readCommunityOnboardingState(runtime())).toBeNull();
    expect(analytics.skipped).not.toHaveBeenCalled();
    expect(analytics.product).toHaveBeenCalledExactlyOnceWith({ event: "community_onboarding_completed" }, expect.any(Function));
    expect(analytics.stageCompleted.mock.calls).toEqual([["harness"], ["machine"]]);
  });

  it("does not complete an agent setup after cancellation", () => {
    startCommunityOnboarding(runtime());
    advanceCommunityOnboarding(runtime(), "harness", "machine", { harness: "codex", setupMode: "agent" });
    skipCommunityOnboarding(runtime());
    finishCommunityOnboardingAgentSetup(runtime());
    expect(readCommunityOnboardingState(runtime())).toBeNull();
    expect(analytics.skipped).toHaveBeenCalledExactlyOnceWith("machine");
    expect(analytics.product).not.toHaveBeenCalled();
  });

  afterEach(() => {
    void registry.cleanup();
    registry.queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("switches setup methods before creation and preserves manual choices", () => {
    startCommunityOnboarding(runtime());
    advanceCommunityOnboarding(runtime(), "harness", "machine", { harness: "codex", setupMode: "agent" });
    switchCommunityOnboardingSetup(runtime(), "manual");
    expect(readCommunityOnboardingState(runtime())).toMatchObject({ stage: "machine", setupMode: "manual" });
    advanceCommunityOnboarding(runtime(), "machine", "identity", { machineId: "machine-1", model: "model-1" });
    switchCommunityOnboardingSetup(runtime(), "agent");
    expect(readCommunityOnboardingState(runtime())).toMatchObject({ stage: "machine", setupMode: "agent", machineId: "machine-1", model: "model-1" });
    advanceCommunityOnboarding(runtime(), "machine", "initializing");
    switchCommunityOnboardingSetup(runtime(), "manual");
    expect(readCommunityOnboardingState(runtime())).toMatchObject({ stage: "initializing", setupMode: "agent" });
    skipCommunityOnboarding(runtime());
    expect(readCommunityOnboardingState(runtime())).toBeNull();
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

  it("returns to harness selection without completing machine or retaining stale choices", () => {
    startCommunityOnboarding(runtime());
    advanceCommunityOnboarding(runtime(), "harness", "machine", { harness: "codex", machineId: "stale-machine" });

    recoverCommunityOnboardingHarness(runtime());

    expect(readCommunityOnboardingState(runtime())).toEqual({
      status: "active",
      stage: "harness",
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
    const result = { serverId: "server", publicChannelId: "channel", privateChannelId: "private", leadBotId: "lead", bots: [] };
    updateCommunityOnboardingInitialization(runtime(), current => ({ ...current, result, pendingDestination: "/c/channels/server/channel" }));
    completeCommunityOnboarding(runtime(), "/c/channels/server/channel");
    completeCommunityOnboarding(runtime(), "/c/channels/server/channel");
    expect(readCommunityOnboardingState(runtime())).toBeNull();
    expect(analytics.product).toHaveBeenCalledOnce();
    expect(analytics.product).toHaveBeenCalledWith({ event: "community_onboarding_completed" }, expect.any(Function));
    expect(analytics.stageCompleted).toHaveBeenLastCalledWith("initializing");
    expect(analytics.completed).not.toHaveBeenCalled();
  });

  it("does not clear or emit for a pending initialization or an uncommitted destination", () => {
    startCommunityOnboarding(runtime());
    advanceCommunityOnboarding(runtime(), "harness", "initializing");
    completeCommunityOnboarding(runtime(), "/c/channels/server/channel");
    expect(readCommunityOnboardingState(runtime())?.stage).toBe("initializing");
    const result = { serverId: "server", publicChannelId: "channel", privateChannelId: "private", leadBotId: "lead", bots: [] };
    updateCommunityOnboardingInitialization(runtime(), current => ({ ...current, result, pendingDestination: "/c/channels/server/channel" }));
    completeCommunityOnboarding(runtime(), "/c/me");
    expect(readCommunityOnboardingState(runtime())?.stage).toBe("initializing");
    skipCommunityOnboarding(runtime());
    completeCommunityOnboarding(runtime(), "/c/channels/server/channel");
    expect(analytics.product).not.toHaveBeenCalled();
  });

  it("does not complete before initialization finishes", () => {
    startCommunityOnboarding(runtime());
    expect(completeCommunityOnboarding(runtime())).toEqual({ status: "active", stage: "harness" });
    expect(analytics.completed).not.toHaveBeenCalled();
  });
});

import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  pathname: "/c/me/machines",
  complete: vi.fn(),
  navigate: vi.fn(),
  initialize: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}))
vi.mock("@/lib/community-onboarding", () => ({
  advanceCommunityOnboarding: vi.fn(),
  completeCommunityOnboarding: (...args: unknown[]) => mocks.complete(...args),
  consumeQueuedCommunityOnboarding: () => false,
  startCommunityOnboarding: vi.fn(),
  useCommunityOnboarding: () => ({
    status: "active",
    stage: "initializing",
    machineId: "machine-1",
    harness: "codex",
    identity: "work",
  }),
}))
vi.mock("@/stores/community", () => ({
  useCommunityStore: {
    getState: () => ({ uiHandlers: { navigate: mocks.navigate } }),
  },
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "user-1", name: "Ada" }),
}))
vi.mock("./initialize-community-onboarding", () => ({
  initializeCommunityOnboarding: (...args: unknown[]) => mocks.initialize(...args),
}))
vi.mock("./onboarding-machine-dialog", () => ({ OnboardingMachineDialog: () => null }))
vi.mock("./onboarding-select-dialog", () => ({ OnboardingSelectDialog: () => null }))
vi.mock("./onboarding-status-dialog", () => ({
  OnboardingStatusDialog: (props: Record<string, unknown>) =>
    createElement("onboarding-status-dialog", props),
}))

import { CommunityOnboardingForm } from "./community-onboarding-form"

describe("CommunityOnboardingForm room navigation", () => {
  beforeEach(() => {
    mocks.pathname = "/c/me/machines"
    mocks.complete.mockClear()
    mocks.navigate.mockClear()
    mocks.initialize.mockReset().mockResolvedValue({
      serverId: "server-1",
      publicChannelId: "channel-1",
      privateChannelId: "channel-2",
      botAId: "bot-1",
      botBId: "bot-2",
    })
  })

  it("completes only after the shell commits the public-channel pathname", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(CommunityOnboardingForm))
    })

    const status = renderer.root.findByType("onboarding-status-dialog")
    expect(status.props.status).toBe("success")
    expect(mocks.initialize).toHaveBeenCalledWith(expect.objectContaining({
      userName: "Ada",
    }))

    act(() => {
      status.props.onContinue()
    })
    expect(mocks.navigate).toHaveBeenCalledWith("server-1", "channel-1")
    expect(mocks.complete).not.toHaveBeenCalled()

    mocks.pathname = "/c/channels/server-1/channel-1"
    act(() => {
      renderer.update(createElement(CommunityOnboardingForm))
    })
    expect(mocks.complete).toHaveBeenCalledTimes(1)
  })
})

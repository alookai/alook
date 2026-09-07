import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"

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
  OnboardingStatusDialog: ({ status, onContinue }: {
    status: string
    onContinue: () => void
  }) => createElement("button", {
    "data-testid": "onboarding-status-dialog",
    "data-status": status,
    onClick: onContinue,
  }),
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
    const rendered = render(createElement(CommunityOnboardingForm))

    await waitFor(() => expect(screen.getByTestId("onboarding-status-dialog"))
      .toHaveAttribute("data-status", "success"))
    expect(mocks.initialize).toHaveBeenCalledWith(expect.objectContaining({ userName: "Ada" }))

    fireEvent.click(screen.getByTestId("onboarding-status-dialog"))
    expect(mocks.navigate).toHaveBeenCalledWith("server-1", "channel-1")
    expect(mocks.complete).not.toHaveBeenCalled()

    mocks.pathname = "/c/channels/server-1/channel-1"
    rendered.rerender(createElement(CommunityOnboardingForm))
    expect(mocks.complete).toHaveBeenCalledTimes(1)
  })
})

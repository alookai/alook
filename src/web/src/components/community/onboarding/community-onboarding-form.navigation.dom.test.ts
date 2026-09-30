import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  pathname: "/c/me/machines",
  complete: vi.fn(),
  navigate: vi.fn(),
  initialize: vi.fn(),
  recoverHarness: vi.fn(),
  state: {
    status: "active",
    stage: "initializing",
    machineId: "machine-1",
    harness: "codex",
    identity: "work",
  } as Record<string, unknown>,
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}))
vi.mock("@/lib/community-onboarding", () => ({
  advanceCommunityOnboarding: vi.fn(),
  completeCommunityOnboarding: (...args: unknown[]) => mocks.complete(...args),
  consumeQueuedCommunityOnboarding: () => false,
  recoverCommunityOnboardingHarness: (...args: unknown[]) => mocks.recoverHarness(...args),
  skipCommunityOnboarding: vi.fn(),
  startCommunityOnboarding: vi.fn(),
  useCommunityOnboarding: () => mocks.state,
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
vi.mock("./onboarding-machine-dialog", () => ({
  OnboardingMachineDialog: ({ onChooseAnotherHarness }: {
    onChooseAnotherHarness: () => void
  }) => createElement("button", {
    "data-testid": "recover-harness",
    onClick: onChooseAnotherHarness,
  }),
}))
vi.mock("./onboarding-select-dialog", () => ({
  OnboardingSelectDialog: ({ value, onValueChange }: {
    value: string
    onValueChange: (value: string) => void
  }) => createElement("button", {
    "data-testid": "select-harness",
    "data-value": value,
    onClick: () => onValueChange("codex"),
  }),
}))
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
    mocks.state = {
      status: "active",
      stage: "initializing",
      machineId: "machine-1",
      harness: "codex",
      identity: "work",
    }
    mocks.complete.mockClear()
    mocks.navigate.mockClear()
    mocks.recoverHarness.mockClear()
    mocks.initialize.mockReset().mockResolvedValue({
      serverId: "server-1",
      publicChannelId: "channel-1",
      privateChannelId: "channel-2",
      leadBotId: "bot-1",
      bots: [
        { key: "lead", id: "bot-1", name: "Nora" },
        { key: "doer", id: "bot-2", name: "June" },
      ],
    })
  })

  it("completes only after the shell commits the public-channel pathname", async () => {
    const rendered = render(createElement(CommunityOnboardingForm))

    await waitFor(() => expect(screen.getByTestId("onboarding-status-dialog"))
      .toHaveAttribute("data-status", "success"))
    expect(mocks.initialize).toHaveBeenCalledWith(expect.objectContaining({
      userName: "Ada",
      userDiscriminator: undefined,
    }))

    fireEvent.click(screen.getByTestId("onboarding-status-dialog"))
    expect(mocks.navigate).toHaveBeenCalledWith("server-1", "channel-1")
    expect(mocks.complete).not.toHaveBeenCalled()

    mocks.pathname = "/c/channels/server-1/channel-1"
    rendered.rerender(createElement(CommunityOnboardingForm))
    expect(mocks.complete).toHaveBeenCalledTimes(1)
  })

  it("clears the local harness choice when recovering from the machine limit", () => {
    mocks.state = { status: "active", stage: "harness" }
    const rendered = render(createElement(CommunityOnboardingForm))

    fireEvent.click(screen.getByTestId("select-harness"))
    expect(screen.getByTestId("select-harness")).toHaveAttribute("data-value", "codex")

    mocks.state = { status: "active", stage: "machine", harness: "codex" }
    rendered.rerender(createElement(CommunityOnboardingForm))
    fireEvent.click(screen.getByTestId("recover-harness"))
    expect(mocks.recoverHarness).toHaveBeenCalledOnce()

    mocks.state = { status: "active", stage: "harness" }
    rendered.rerender(createElement(CommunityOnboardingForm))
    expect(screen.getByTestId("select-harness")).toHaveAttribute("data-value", "")
  })
})

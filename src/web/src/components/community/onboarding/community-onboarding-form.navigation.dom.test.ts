import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen, waitFor  } from "@/test/react-dom-harness"
import { render as renderDom } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import type { CommunityOnboardingState } from "@/lib/community-onboarding"
let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
function render(node: React.ReactNode) {
  owner.runtime.ui.setState((state) => ({ ...state, onboardingState: mocks.state as CommunityOnboardingState }))
  owner.runtime.ui.actions.registerUiHandlers({ navigate: mocks.navigate })
  return renderDom(node, { wrapper: ({ children }) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "user-1", retainOwner: true }, children) })
}

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
vi.mock("@/lib/community-onboarding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/community-onboarding")>()
  return {
    ...actual,
    completeCommunityOnboarding: (...args: Parameters<typeof actual.completeCommunityOnboarding>) => { mocks.complete(...args); return actual.completeCommunityOnboarding(...args) },
    recoverCommunityOnboardingHarness: (...args: Parameters<typeof actual.recoverCommunityOnboardingHarness>) => { mocks.recoverHarness(...args); return actual.recoverCommunityOnboardingHarness(...args) },
  }
})
vi.mock("@/stores/community", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community")>(),
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
  OnboardingMachineDialog: ({ onChooseAnotherHarness, onConnected }: {
    onChooseAnotherHarness: () => void
    onConnected: (id: string) => void
  }) => createElement("div", {}, createElement("button", {
    "data-testid": "recover-harness",
    onClick: onChooseAnotherHarness,
  }), createElement("button", { onClick: () => onConnected("machine-1") }, "Machine connected")),
}))
vi.mock("./onboarding-select-dialog", () => ({
  OnboardingSelectDialog: ({ value, onValueChange, onSubmit }: {
    value: string
    onValueChange: (value: string) => void
    onSubmit: (value: string) => void
  }) => createElement("div", {}, createElement("button", {
    "data-testid": "select-harness",
    "data-value": value,
    onClick: () => onValueChange("codex"),
  }), createElement("button", { onClick: () => onSubmit("developer") }, "Finish setup")),
}))
vi.mock("@/hooks/community/use-machines", () => ({ useMachines: () => ({ machines: [] }) }))
vi.mock("../bots/model-field", () => ({ ModelField: ({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) => createElement("input", { "aria-label": "Model", value: value ?? "", onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value || null) }) }))
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
  beforeEach(async () => {
    owner = await createCommunityQueryOwner("user-1")
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

  it("clears the local harness choice when recovering from the machine limit", async () => {
    mocks.state = { status: "active", stage: "harness" }
    const rendered = render(createElement(CommunityOnboardingForm))

    fireEvent.click(screen.getByTestId("select-harness"))
    expect(screen.getByTestId("select-harness")).toHaveAttribute("data-value", "codex")

    mocks.state = { status: "active", stage: "machine", harness: "codex" }
    await act(async () => { owner.runtime.ui.setState((state) => ({ ...state, onboardingState: mocks.state as CommunityOnboardingState })) })
    rendered.rerender(createElement(CommunityOnboardingForm))
    fireEvent.click(screen.getByTestId("recover-harness"))
    expect(mocks.recoverHarness).toHaveBeenCalledOnce()

    mocks.state = { status: "active", stage: "harness" }
    rendered.rerender(createElement(CommunityOnboardingForm))
    expect(screen.getByTestId("select-harness")).toHaveAttribute("data-value", "")
  })

  it("blocks OpenCode setup until a model is chosen and passes it to initialization", async () => {
    mocks.state = { status: "active", stage: "model", machineId: "machine-1", harness: "opencode" }
    render(createElement(CommunityOnboardingForm))
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(mocks.initialize).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "custom/model" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(mocks.initialize).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }))
    await waitFor(() => expect(mocks.initialize).toHaveBeenCalledWith(expect.objectContaining({ runtime: "opencode", model: "custom/model" })))
  })

  it.each(["codex", "opencode"])("routes a connected %s machine through only its required steps", (harness) => {
    mocks.state = { status: "active", stage: "machine", harness }
    render(createElement(CommunityOnboardingForm))
    fireEvent.click(screen.getByRole("button", { name: "Machine connected" }))
    expect(owner.runtime.ui.get().onboardingState?.stage).toBe(harness === "opencode" ? "model" : "identity")
    expect(screen.queryByRole("textbox", { name: "Model" }) !== null).toBe(harness === "opencode")
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen, waitFor, render as renderDom } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import type { CommunityMachineSummary } from "@alook/shared"
const mocks = vi.hoisted(() => ({
  request: vi.fn(), refetch: vi.fn(), copy: vi.fn(),
  machines: [] as CommunityMachineSummary[],
}))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.request }))
vi.mock("@/hooks/community/use-machines", () => ({
  useMachines: () => ({ machines: mocks.machines, isSuccess: true, refetch: mocks.refetch }),
}))
vi.mock("../machines/pair-machine-sheet", () => ({ buildPairCommand: (key: string) => `pair ${key}` }))
import { OnboardingAgentDialog } from "./onboarding-agent-dialog"
const pair = () => ({ tokenId: "fixture-pair", expiresAt: new Date(Date.now() + 900_000).toISOString() })
const code = () => ({ secret: "fixture-code", accessCode: { id: "code-1", name: "onboard", expiresAt: new Date(Date.now() + 3_600_000).toISOString() } })
const props = () => ({ harness: "codex", harnessLabel: "Codex", onManual: vi.fn(), onChooseAgent: vi.fn(), onExit: vi.fn() })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.machines = []
  mocks.request.mockImplementation(async (path: string) => path.endsWith("/pair") ? pair() : code())
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.copy.mockResolvedValue(undefined) } })
})
describe("Agent Setup", () => {
  it("prepares only pairing and one-hour authorization, and copies the complete handoff", async () => {
    render(<OnboardingAgentDialog {...props()} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled())
    expect(mocks.request).toHaveBeenCalledTimes(2)
    const call = mocks.request.mock.calls.find(([path]) => path.includes("access-codes"))!
    expect(JSON.parse(call[1].body)).toEqual({
      name: "onboard", expiresIn: "1h",
      permissions: ["bot.create", "server.create", "server.invite", "message.send", "machine.read", "friend.read", "server.read"].map((permission) => ({ permission, limit: permission === "bot.create" ? 3 : 64, period: "hour" })),
    })
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }))
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce())
    expect(mocks.copy.mock.calls[0][0]).toContain("/agent.md first")
    expect(mocks.copy.mock.calls[0][0]).toContain("/onboard.md")
    expect(mocks.copy.mock.calls[0][0]).toContain("pair fixture-pair")
    expect(mocks.copy.mock.calls[0][0]).toContain("fixture-code")
    expect(mocks.copy.mock.calls[0][0]).toContain("confirm the requirements with me")
    expect(mocks.copy.mock.calls[0][0]).toContain("no more than 3 bots")
  })
  it("keeps Agent Setup open with an online machine and does not mint an unnecessary pair key", async () => {
    mocks.machines = [{ id: "machine-1", hostname: "Work Mac", status: "online", availableRuntimes: [{ id: "codex", status: "healthy" }] } as CommunityMachineSummary]
    const input = props()
    render(<OnboardingAgentDialog {...input} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled())
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText("Prompt for Codex") as HTMLTextAreaElement).value).toContain("Connected machine ID: machine-1")
    expect(screen.getByText(/Work Mac is connected/)).toBeInTheDocument()
    expect(input.onExit).not.toHaveBeenCalled()
  })
  it("reuses an unexpired pair key after an access-code failure", async () => {
    mocks.request.mockImplementationOnce(async () => pair()).mockRejectedValueOnce(new Error("network"))
    render(<OnboardingAgentDialog {...props()} />)
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t prepare"))
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled())
    expect(mocks.request.mock.calls.filter(([path]) => path.endsWith("/pair"))).toHaveLength(1)
  })
  it("retires pending generation when switching to Manual", async () => {
    let resolvePair!: (value: ReturnType<typeof pair>) => void
    mocks.request.mockImplementationOnce(() => new Promise((resolve) => { resolvePair = resolve }))
    const input = props()
    render(<OnboardingAgentDialog {...input} />)
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole("button", { name: "Manual" }))
    expect(input.onManual).toHaveBeenCalledOnce()
    await act(async () => resolvePair(pair()))
    expect(mocks.request).toHaveBeenCalledOnce()
    expect(screen.queryByLabelText("Prompt for Codex")).not.toBeInTheDocument()
  })
  it("hides the previous account credentials immediately when the owner changes", async () => {
    const first = await createCommunityQueryOwner("first")
    const second = await createCommunityQueryOwner("second")
    const input = props()
    const view = renderDom(<CommunityTestProvider client={first.client} registry={first.registry} userId="first" retainOwner><OnboardingAgentDialog {...input} /></CommunityTestProvider>)
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled())
    mocks.request.mockReturnValue(new Promise(() => undefined))
    view.rerender(<CommunityTestProvider client={second.client} registry={second.registry} userId="second" retainOwner><OnboardingAgentDialog {...input} /></CommunityTestProvider>)
    expect(screen.queryByLabelText("Prompt for Codex")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeDisabled()
    expect(mocks.copy).not.toHaveBeenCalled()
  })
  it("starts fresh credentials while the previous owner pair request is pending", async () => {
    const first = await createCommunityQueryOwner("first")
    const second = await createCommunityQueryOwner("second")
    let finishOld!: (value: ReturnType<typeof pair>) => void
    mocks.request.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
    const input = props()
    const view = renderDom(<CommunityTestProvider client={first.client} registry={first.registry} userId="first" retainOwner><OnboardingAgentDialog {...input} /></CommunityTestProvider>)
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce())
    view.rerender(<CommunityTestProvider client={second.client} registry={second.registry} userId="second" retainOwner><OnboardingAgentDialog {...input} /></CommunityTestProvider>)
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled())
    expect(mocks.request).toHaveBeenCalledTimes(3)
    await act(async () => finishOld({ ...pair(), tokenId: "old-owner-pair" }))
    expect((screen.getByLabelText("Prompt for Codex") as HTMLTextAreaElement).value).not.toContain("old-owner-pair")
    expect(mocks.request).toHaveBeenCalledTimes(3)
  })
  it("allows exit while setup is pending", async () => {
    mocks.request.mockReturnValue(new Promise(() => undefined))
    const input = props()
    render(<OnboardingAgentDialog {...input} />)
    fireEvent.click(screen.getByRole("button", { name: "Exit setup" }))
    expect(input.onExit).toHaveBeenCalledOnce()
  })
  it("disables copying when credentials expire", async () => {
    mocks.request.mockImplementation(async (path: string) => path.endsWith("/pair") ? { ...pair(), expiresAt: new Date(Date.now() - 1000).toISOString() } : code())
    render(<OnboardingAgentDialog {...props()} />)
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("expired"))
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeDisabled()
    expect(screen.queryByLabelText("Prompt for Codex")).not.toBeInTheDocument()
  })
})

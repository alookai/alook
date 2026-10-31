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
vi.mock("../machines/pair-machine-sheet", () => ({ buildPairCommand: (key: string, id?: string) => id ? `reconnect ${id} ${key}` : `pair ${key}` }))
import { OnboardingAgentDialog } from "./onboarding-agent-dialog"
const pair = () => ({ tokenId: "fixture-pair", expiresAt: new Date(Date.now() + 900_000).toISOString() })
const code = () => ({ secret: "fixture-code", accessCode: { id: "code-1", name: "onboard", expiresAt: new Date(Date.now() + 3_600_000).toISOString() } })
const props = () => ({ harness: "codex", harnessLabel: "Codex", onConnected: vi.fn(), onChooseAgent: vi.fn(), onExit: vi.fn() })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.machines = []
  mocks.request.mockImplementation(async (path: string) => path.endsWith("/pair") || path.endsWith("/reconnect") ? pair() : code())
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
    expect(mocks.copy.mock.calls[0][0]).toContain(`Follow ${location.origin}/onboard.md`)
    expect(mocks.copy.mock.calls[0][0]).toContain("/onboard.md")
    expect(mocks.copy.mock.calls[0][0]).toContain("pair fixture-pair")
    expect(mocks.copy.mock.calls[0][0]).toContain("fixture-code")
    expect(mocks.copy.mock.calls[0][0]).not.toContain("confirm the requirements with me")
    expect(mocks.copy.mock.calls[0][0]).not.toContain("no more than 3 bots")
  })
  it("waits for copy before ending setup with an already-online machine", async () => {
    mocks.machines = [{ id: "machine-1", hostname: "Work Mac", status: "online", availableRuntimes: [{ id: "codex", status: "healthy" }] } as CommunityMachineSummary]
    const input = props()
    render(<OnboardingAgentDialog {...input} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled())
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText("Prompt for Codex") as HTMLTextAreaElement).value).toContain("Connected machine ID: machine-1")
    expect(input.onConnected).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }))
    await waitFor(() => expect(input.onConnected).toHaveBeenCalledOnce())
  })
  it("reuses an unexpired pair key after an access-code failure", async () => {
    mocks.request.mockImplementationOnce(async () => pair()).mockRejectedValueOnce(new Error("network"))
    render(<OnboardingAgentDialog {...props()} />)
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t prepare"))
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled())
    expect(mocks.request.mock.calls.filter(([path]) => path.endsWith("/pair"))).toHaveLength(1)
  })
  it("retires pending generation when changing agent", async () => {
    let resolvePair!: (value: ReturnType<typeof pair>) => void
    mocks.request.mockImplementationOnce(() => new Promise((resolve) => { resolvePair = resolve }))
    const input = props()
    render(<OnboardingAgentDialog {...input} />)
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole("button", { name: "Change agent" }))
    expect(input.onChooseAgent).toHaveBeenCalledOnce()
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
    expect(screen.queryByRole("button", { name: "Copy prompt" })).not.toBeInTheDocument()
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
  it("disables copying when credentials expire", async () => {
    mocks.request.mockImplementation(async (path: string) => path.endsWith("/pair") ? { ...pair(), expiresAt: new Date(Date.now() - 1000).toISOString() } : code())
    render(<OnboardingAgentDialog {...props()} />)
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("expired"))
    expect(screen.queryByRole("button", { name: "Copy prompt" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Prompt for Codex")).not.toBeInTheDocument()
  })
  it("recovers when an online machine goes offline and reuses its valid code", async () => {
    mocks.machines = [{ id: "machine-1", status: "online", availableRuntimes: [{ id: "codex", status: "healthy" }] } as CommunityMachineSummary]
    const input = props()
    const view = render(<OnboardingAgentDialog {...input} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled())
    mocks.machines = [{ ...mocks.machines[0], status: "offline" } as CommunityMachineSummary]
    view.rerender(<OnboardingAgentDialog {...input} />)
    expect(screen.getByRole("alert")).toHaveTextContent("went offline")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled())
    expect(mocks.request.mock.calls.filter(([path]) => path.includes("access-codes"))).toHaveLength(1)
    expect(mocks.request.mock.calls.some(([path]) => path === "/api/community/machines/machine-1/reconnect")).toBe(true)
    expect((screen.getByLabelText("Prompt for Codex") as HTMLInputElement).value).toContain("reconnect machine-1 fixture-pair")
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }))
    await waitFor(() => expect(screen.getByTestId("onboarding-agent-waiting")).toBeInTheDocument())
    expect(input.onConnected).not.toHaveBeenCalled()
    mocks.machines = [{ id: "machine-1", status: "online", availableRuntimes: [{ id: "codex", status: "healthy" }] } as CommunityMachineSummary]
    view.rerender(<OnboardingAgentDialog {...input} />)
    await waitFor(() => expect(input.onConnected).toHaveBeenCalledOnce())
  })
  it("stays on the copy page when the clipboard fails", async () => {
    mocks.copy.mockRejectedValue(new Error("clipboard"))
    const input = props()
    render(<OnboardingAgentDialog {...input} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Copy failed"))
    expect(screen.queryByTestId("onboarding-agent-waiting")).not.toBeInTheDocument()
    expect(input.onConnected).not.toHaveBeenCalled()
  })

})

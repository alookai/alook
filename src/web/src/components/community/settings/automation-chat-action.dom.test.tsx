import { beforeEach, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { AutomationChatAction } from "./automation-chat-action"

const mocks = vi.hoisted(() => ({
  bots: [] as { id: string; isActive: boolean }[],
  profiles: new Map<string, { presence: string }>(),
  start: vi.fn(),
  pending: false,
}))
vi.mock("@/hooks/community/use-bots", () => ({ useBots: () => ({ bots: mocks.bots }) }))
vi.mock("@/lib/community-db/projections", () => ({ useCanonicalProfilesByUserId: () => mocks.profiles }))
vi.mock("@/hooks/community/use-community-view-source", () => ({ useCommunityViewSource: () => ({}) }))
vi.mock("@/hooks/community/use-start-bot-chat", () => ({ useStartBotChat: () => ({ start: mocks.start, pending: mocks.pending }) }))
beforeEach(() => {
  mocks.bots = [{ id: "first", isActive: false }, { id: "online", isActive: true }]
  mocks.profiles = new Map([["online", { presence: "online" }]])
  mocks.start.mockReset()
  mocks.pending = false
})
it("asks an active online bot to read the guide and explain Automation", () => {
  const onAccepted = vi.fn()
  render(<AutomationChatAction onAccepted={onAccepted} />)
  fireEvent.click(screen.getByRole("button", { name: "Ask your bot how to use Automation." }))
  expect(mocks.start).toHaveBeenCalledWith({
    botId: "online",
    content: "Read https://alook.ai/agent.md and explain how to use Automation, including access codes, permissions, limits, and CLI commands.",
    onAccepted,
    errorMessage: "Couldn’t start the Automation chat. Try again.",
  })
  expect(onAccepted).not.toHaveBeenCalled()
})
it("falls back to the first bot when none are active and online", () => {
  mocks.profiles.clear()
  render(<AutomationChatAction />)
  fireEvent.click(screen.getByRole("button"))
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ botId: "first" }))
})
it("hides the action with no bots and disables it while starting", () => {
  mocks.bots = []
  const view = render(<AutomationChatAction />)
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
  mocks.bots = [{ id: "first", isActive: true }]
  mocks.pending = true
  view.rerender(<AutomationChatAction />)
  expect(screen.getByRole("button")).toBeDisabled()
  expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true")
  fireEvent.click(screen.getByRole("button"))
  expect(mocks.start).not.toHaveBeenCalled()
})

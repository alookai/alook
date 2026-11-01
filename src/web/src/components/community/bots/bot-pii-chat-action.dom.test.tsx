import { beforeEach, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { BotPiiChatAction } from "./bot-pii-chat-action"

const mocks = vi.hoisted(() => ({ create: vi.fn(), accept: vi.fn(), push: vi.fn(), toast: vi.fn(), assert: vi.fn(), cancel: vi.fn() }))
vi.mock("@/contexts/community/current-user", () => ({ useCurrentUser: () => ({ id: "owner", name: "Owner", avatar: null }) }))
vi.mock("@/contexts/community/module-route", () => ({ useCommunityRouter: () => ({ push: mocks.push }) }))
vi.mock("@/hooks/community/mutations", () => ({ useCreateOrGetDm: () => ({ mutateAsync: mocks.create }) }))
vi.mock("@/hooks/community/use-dm-message-sender", () => ({ useDmMessageSender: () => ({ accept: mocks.accept }) }))
vi.mock("@/hooks/community/use-community-view-source", () => ({ useCommunityViewSource: () => ({ capture: () => mocks.assert }) }))
vi.mock("@/stores/community", () => ({ useUiHandlers: () => ({ cancelPendingNavigation: mocks.cancel }) }))
vi.mock("@/lib/api/client", () => ({ toastApiError: mocks.toast }))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.create.mockResolvedValue({ conversation: { id: "dm-selected" } })
  mocks.accept.mockReturnValue({ accepted: true, committed: Promise.resolve({ ok: true }) })
})
const click = () => fireEvent.click(screen.getByRole("button", { name: "Ask your bot to add a PII filter." }))
it("sends the requirements-first request to the selected bot before navigating", async () => {
  render(<BotPiiChatAction botId="selected-bot" />)
  click()
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/c/me/dm-selected"))
  expect(mocks.create).toHaveBeenCalledWith({ userId: "selected-bot", assertActive: mocks.assert })
  expect(mocks.accept).toHaveBeenCalledWith(expect.objectContaining({ dmId: "dm-selected", content: "Help me create and add a PII filter for yourself. First ask me what information I want you to filter.", author: expect.objectContaining({ id: "owner" }) }))
  expect(mocks.accept.mock.invocationCallOrder[0]).toBeLessThan(mocks.push.mock.invocationCallOrder[0])
})
it("prevents a second message while starting the chat", async () => {
  let resolve!: (value: unknown) => void
  mocks.create.mockReturnValue(new Promise(done => { resolve = done }))
  render(<BotPiiChatAction botId="selected-bot" />)
  click(); click()
  expect(mocks.create).toHaveBeenCalledOnce()
  resolve({ conversation: { id: "dm-selected" } })
  await waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce())
})
it("does not navigate if message acceptance fails and allows retry", async () => {
  mocks.accept.mockReturnValue({ accepted: false })
  render(<BotPiiChatAction botId="selected-bot" />)
  click()
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
  expect(mocks.push).not.toHaveBeenCalled()
  expect(screen.getByRole("button")).not.toBeDisabled()
})
it("does not send or navigate after the originating view retires", async () => {
  mocks.assert.mockImplementationOnce(() => {}).mockImplementation(() => { throw new DOMException("Retired", "AbortError") })
  render(<BotPiiChatAction botId="selected-bot" />)
  click()
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
  expect(mocks.accept).not.toHaveBeenCalled()
  expect(mocks.push).not.toHaveBeenCalled()
})

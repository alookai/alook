import { beforeEach, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { ConversationActivityContext } from "@/contexts/community/conversation-activity"
import { BotPiiView } from "./bot-pii-view"

const state = vi.hoisted(() => ({ botId: "b1", viewer: "owner", epoch: 0, clearPreview: vi.fn(), reload: vi.fn(), preview: vi.fn(), pending: false, previewPending: false }))
vi.mock("@/hooks/community/use-bots", () => ({ useBots: () => ({ bots: [{ id: state.botId, name: "Preview bot", machineId: "m1" }], isPending: false, profilesPending: false, isError: false }) }))
vi.mock("@/hooks/community/use-machines", () => ({ useMachines: () => ({ machines: [{ id: "m1", status: "online" }], isPending: false }) }))
vi.mock("@/stores/community/ws", () => ({ useCommunityWsStore: (select: (value: unknown) => unknown) => select({ profileViewerId: state.viewer, profileAccountEpoch: state.epoch }) }))
vi.mock("./bot-pii-chat-action", () => ({ BotPiiChatAction: () => <button>Ask your bot to add a PII filter.</button> }))
vi.mock("@/components/avatar", () => ({ AgentAvatar: () => <span /> }))
vi.mock("@/hooks/community/use-bot-pii", () => ({ useBotPii: () => ({ snapshot: { revision: 0, plugins: [] }, pending: state.pending, previewPending: state.previewPending, preview: state.preview, clearPreview: state.clearPreview, reload: state.reload }) }))
beforeEach(() => { state.pending = false; state.previewPending = false; state.botId = "b1"; state.viewer = "owner"; state.epoch = 0; state.reload.mockReset(); state.clearPreview.mockReset(); state.preview.mockReset() })

it("sends only an explicit run and clears a result when input changes", () => {
  render(<BotPiiView />)
  expect(screen.getByRole("textbox")).toBeVisible()
  fireEvent.change(screen.getByLabelText("Original message"), { target: { value: "sample@example.com" } })
  expect(state.clearPreview).toHaveBeenCalledOnce()
  expect(state.preview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Run test" }))
  expect(state.preview).toHaveBeenCalledWith("sample@example.com")
})

it("clears draft input when switching bots, account epochs, or leaving an inactive view", async () => {
  const page = (active = true) => <ConversationActivityContext.Provider value={active}><BotPiiView /></ConversationActivityContext.Provider>
  const h = render(page())
  const type = () => fireEvent.change(screen.getByLabelText("Original message"), { target: { value: "private draft" } })
  type()
  state.botId = "b2"
  h.rerender(page())
  expect(screen.getByLabelText("Original message")).toHaveValue("")
  type()
  state.epoch = 1
  h.rerender(page())
  expect(screen.getByLabelText("Original message")).toHaveValue("")
  type()
  h.rerender(page(false))
  await waitFor(() => expect(screen.getByLabelText("Original message")).toHaveValue(""))
  expect(state.clearPreview).toHaveBeenCalled()
})

it("shows filters and playground together and spins refresh while waiting", () => {
  const view = render(<BotPiiView />)
  expect(screen.getAllByRole("tab")).toHaveLength(1)
  expect(screen.getByRole("tab", { name: "PII Filters" })).toHaveAttribute("aria-selected", "true")
  expect(screen.queryByRole("tab", { name: "Playground" })).toBeNull()
  expect(screen.getByRole("heading", { name: "Filters for bot message", level: 2 })).toBeVisible()
  const headings = Array.from(screen.getByRole("tabpanel").querySelectorAll("h2,h3")).map(heading => heading.textContent)
  expect(headings).toEqual(["Filters for bot message", "Which bot to set up", "PII steps", "Playground"])
  expect(screen.getByRole("heading", { name: "Playground", level: 3 })).toBeVisible()
  expect(screen.getByLabelText("Original message")).toBeVisible()
  state.pending = true
  view.rerender(<BotPiiView />)
  const reload = screen.getByRole("button", { name: "Reload filters" })
  expect(reload).toBeDisabled()
  expect(reload).toHaveAttribute("aria-busy", "true")
  expect(reload.querySelector("svg")).toHaveClass("animate-spin", "motion-reduce:animate-none")
  expect(screen.queryByText("Waiting for this machine…")).toBeNull()
  state.previewPending = true
  view.rerender(<BotPiiView />)
  expect(reload).toHaveAttribute("aria-busy", "false")
  expect(reload.querySelector("svg")).not.toHaveClass("animate-spin")
  state.pending = false
  state.previewPending = false
  view.rerender(<BotPiiView />)
  expect(reload).toHaveAttribute("aria-busy", "false")
  expect(reload.querySelector("svg")).not.toHaveClass("animate-spin")
})

it("reloads on an enabled click and ignores clicks while configuration or preview is pending", () => {
  const view = render(<BotPiiView />)
  const reload = screen.getByRole("button", { name: "Reload filters" })
  fireEvent.click(reload)
  expect(state.reload).toHaveBeenCalledOnce()
  state.pending = true
  view.rerender(<BotPiiView />)
  expect(reload).toBeDisabled()
  fireEvent.click(reload)
  expect(state.reload).toHaveBeenCalledOnce()
  state.previewPending = true
  view.rerender(<BotPiiView />)
  fireEvent.click(reload)
  expect(state.reload).toHaveBeenCalledOnce()
  state.pending = false
  state.previewPending = false
  view.rerender(<BotPiiView />)
  expect(reload).toBeEnabled()
  fireEvent.click(reload)
  expect(state.reload).toHaveBeenCalledTimes(2)
})

import { beforeEach, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { ConversationActivityContext } from "@/contexts/community/conversation-activity"
import { BotPiiView } from "./bot-pii-view"

const state = vi.hoisted(() => ({ botId: "b1", viewer: "owner", epoch: 0, clearPreview: vi.fn(), preview: vi.fn() }))
vi.mock("@/hooks/community/use-bots", () => ({ useBots: () => ({ bots: [{ id: state.botId, name: "Preview bot", machineId: "m1" }], isPending: false, profilesPending: false, isError: false }) }))
vi.mock("@/hooks/community/use-machines", () => ({ useMachines: () => ({ machines: [{ id: "m1", status: "online" }], isPending: false }) }))
vi.mock("@/stores/community/ws", () => ({ useCommunityWsStore: (select: (value: unknown) => unknown) => select({ profileViewerId: state.viewer, profileAccountEpoch: state.epoch }) }))
vi.mock("@/components/avatar", () => ({ AgentAvatar: () => <span /> }))
vi.mock("@/hooks/community/use-bot-pii", () => ({ useBotPii: () => ({ snapshot: { revision: 0, plugins: [] }, pending: false, previewPending: false, preview: state.preview, clearPreview: state.clearPreview, reload: vi.fn() }) }))
beforeEach(() => { state.botId = "b1"; state.viewer = "owner"; state.epoch = 0; state.clearPreview.mockReset(); state.preview.mockReset() })

it("sends only an explicit run and clears a result when input changes", () => {
  render(<BotPiiView />)
  fireEvent.change(screen.getByLabelText("Try a message"), { target: { value: "sample@example.com" } })
  expect(state.clearPreview).toHaveBeenCalledOnce()
  expect(state.preview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Run pipeline" }))
  expect(state.preview).toHaveBeenCalledWith("sample@example.com")
})

it("clears draft input when switching bots, account epochs, or leaving an inactive view", async () => {
  const page = (active = true) => <ConversationActivityContext.Provider value={active}><BotPiiView /></ConversationActivityContext.Provider>
  const h = render(page())
  const type = () => fireEvent.change(screen.getByLabelText("Try a message"), { target: { value: "private draft" } })
  type()
  state.botId = "b2"
  h.rerender(page())
  expect(screen.getByLabelText("Try a message")).toHaveValue("")
  type()
  state.epoch = 1
  h.rerender(page())
  expect(screen.getByLabelText("Try a message")).toHaveValue("")
  type()
  h.rerender(page(false))
  await waitFor(() => expect(screen.getByLabelText("Try a message")).toHaveValue(""))
  expect(state.clearPreview).toHaveBeenCalled()
})

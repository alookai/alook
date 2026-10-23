import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Message } from "../messages/message"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@/test/react-dom-harness"
import { botCreationFixture } from "@/test/bot-creation-fixtures"
import { tid } from "@/lib/community/testids"
import { BotCreationRequestCard } from "./bot-creation-request-card"

const profiles = vi.hoisted(() => new Map<string, { id: string; name: string; discriminator: string; avatar?: string | null }>())
const command = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, error: null as Error | null, variables: undefined as { decision: string } | undefined }))
vi.mock("@/hooks/community/mutations/bot-creation", () => ({ useBotCreationDecision: () => command }))
vi.mock("@/lib/community-db/projections", async (original) => ({ ...await original<typeof import("@/lib/community-db/projections")>(), useCanonicalCommunityProfile: (id?: string) => id ? profiles.get(id) : undefined }))
beforeEach(() => { profiles.clear(); command.mutate.mockReset(); command.isPending = false; command.error = null; command.variables = undefined })

describe("bot creation request gallery", () => {
  it("refreshes a memoized message when only its request resolution changes", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const request = botCreationFixture()
    const openThread = () => undefined
    const message = { id: "message-1", type: "chat" as const, grouped: false, content: "", botCreation: request }
    const view = render(<QueryClientProvider client={client}><Message m={message} viewerUserId="viewer" onOpenThread={openThread} /></QueryClientProvider>)
    expect(view.getByRole("button", { name: "Create bot" })).toBeVisible()
    view.rerender(<QueryClientProvider client={client}><Message m={{ ...message, botCreation: { ...request, status: "declined" } }} viewerUserId="viewer" onOpenThread={openThread} /></QueryClientProvider>)
    expect(view.queryByTestId(tid.botCreationApprove)).toBeNull()
    expect(view.getByRole("img", { name: "Declined" })).toHaveTextContent("NOT PASS")
    expect(view.queryByRole("status")).toBeNull()
    expect(view.queryByText("Declined")).toBeNull()
    client.clear()
  })

  it("leaves gallery touch panning native while normal messages still swipe to reply", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const request = botCreationFixture()
    const onReply = vi.fn()
    const tree = (botCreation?: typeof request) => <QueryClientProvider client={client}>
      <Message m={{ id: "touch-message", type: "chat", grouped: false, content: botCreation ? "" : "Plain message", botCreation }}
        viewerUserId="viewer" hoverCapable={false} onOpenThread={() => undefined} onReply={onReply} />
    </QueryClientProvider>
    const swipe = (target: HTMLElement) => {
      let move!: Event
      for (const [type, x] of [["pointerdown", 100], ["pointermove", 190], ["pointerup", 190]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true })
        Object.defineProperties(event, { pointerType: { value: "touch" }, pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: 100 } })
        fireEvent(target, event)
        if (type === "pointermove") move = event
      }
      return move
    }
    const view = render(tree(request))
    expect(swipe(view.getByText(request.bots[0]!.reason)).defaultPrevented).toBe(false)
    expect(onReply).not.toHaveBeenCalled()
    view.rerender(tree())
    expect(swipe(view.getByText("Plain message")).defaultPrevented).toBe(true)
    expect(onReply).toHaveBeenCalledOnce()
    view.unmount()
    client.clear()
  })

  it("renders one gallery and one whole-batch action group with visible reasons and configuration badges", () => {
    const first = botCreationFixture().bots[0]!
    const request = botCreationFixture({ bots: [first, { ...first, itemId: "item-2", name: "Reviewer", model: null, reasoningEffort: null, reason: "Review the result" }] })
    const view = render(<BotCreationRequestCard request={request} messageId="message-1" viewerUserId="viewer" />)
    expect(view.getAllByTestId(tid.botCreationRequestCard)).toHaveLength(1)
    expect(view.getAllByRole("article")).toHaveLength(2)
    expect(view.getByText("Check sources independently")).toBeVisible()
    expect(view.getByText("Review the result")).toBeVisible()
    expect(view.getByText("model-a")).toBeVisible()
    expect(view.getByText("high")).toBeVisible()
    expect(view.queryByText("Runtime default")).toBeNull()
    expect(view.queryByText("Local default")).toBeNull()
    expect(view.queryByText("Offline")).toBeNull()
    fireEvent.click(view.getByRole("button", { name: "Create 2 bots" }))
    expect(command.mutate).toHaveBeenCalledExactlyOnceWith({ requestId: "request-1", messageId: "message-1", decision: "approve" })
    fireEvent.click(view.getByRole("button", { name: "Decline" }))
    expect(command.mutate).toHaveBeenLastCalledWith({ requestId: "request-1", messageId: "message-1", decision: "decline" })
  })

  it("keeps single creation in the same gallery and displays untrusted text literally", () => {
    const request = botCreationFixture()
    request.bots[0]!.reason = '<img src=x onerror="alert(1)">'
    const view = render(<BotCreationRequestCard request={request} messageId="message-1" viewerUserId="viewer" />)
    expect(view.getAllByRole("article")).toHaveLength(1)
    expect(view.getByText(request.bots[0]!.reason)).toBeVisible()
    expect(view.container.querySelector("img[src=x]")).toBeNull()
    expect(view.getByRole("button", { name: "Create bot" })).toBeEnabled()
    expect(view.queryByText("Find sources and report uncertainty")).toBeNull()
    expect(view.queryByRole("tab")).toBeNull()
  })

  it("disables both decisions while creating and keeps a failed request actionable", () => {
    const request = botCreationFixture()
    command.isPending = true; command.variables = { decision: "approve" }
    const view = render(<BotCreationRequestCard request={request} messageId="message-1" viewerUserId="viewer" />)
    expect(view.getByRole("button", { name: "Creating…" })).toBeDisabled()
    expect(view.getByRole("button", { name: "Decline" })).toBeDisabled()
    fireEvent.click(view.getByTestId(tid.botCreationApprove))
    expect(command.mutate).not.toHaveBeenCalled()
    command.isPending = false; command.error = new Error("Not enough bot slots. Free a slot and try again.")
    view.rerender(<BotCreationRequestCard request={request} messageId="message-1" viewerUserId="viewer" />)
    expect(view.getByRole("alert")).toHaveTextContent("Free a slot")
    expect(view.getByRole("button", { name: "Create bot" })).toBeEnabled()
  })

  it("shows no decisions to the requester or on terminal cards, and hides a retired error", () => {
    const request = botCreationFixture()
    const view = render(<BotCreationRequestCard request={request} messageId="message-1" viewerUserId="requester" />)
    expect(view.queryByRole("button")).toBeNull()
    expect(view.getByRole("status")).toHaveTextContent("Waiting for your owner")
    view.rerender(<BotCreationRequestCard request={{ ...request, status: "declined" }} messageId="message-1" viewerUserId="viewer" />)
    expect(view.getByRole("img", { name: "Declined" })).toHaveTextContent("NOT PASS")
    expect(view.queryByRole("status")).toBeNull()
    expect(view.queryByText("Declined")).toBeNull()
    expect(view.queryByRole("img", { name: "Approved" })).toBeNull()
    const first = request.bots[0]!
    view.rerender(<BotCreationRequestCard request={{ ...request, status: "approved", bots: [first, { ...first, itemId: "item-2" }] }} messageId="message-1" viewerUserId="viewer" />)
    expect(view.getAllByRole("img", { name: "Approved" })).toHaveLength(2)
    expect(view.getAllByRole("img", { name: "Approved" }).every((stamp) => stamp.textContent === "PASS")).toBe(true)
    expect(view.queryByRole("status")).toBeNull()
    expect(view.queryByTestId(tid.botCreationApprove)).toBeNull()
    command.error = new DOMException("Retired account", "AbortError")
    view.rerender(<BotCreationRequestCard request={{ ...request }} messageId="message-1" viewerUserId="viewer" />)
    expect(view.queryByRole("alert")).toBeNull()
  })

  it("opens the actual created identity after approval rather than the proposal name", () => {
    const request = botCreationFixture({ status: "approved" })
    request.bots[0]!.createdBot = { id: "created-1", name: "Actual Bot", discriminator: "0042", image: null, avatarVersion: 0 }
    const open = vi.fn()
    const view = render(<BotCreationRequestCard request={request} messageId="message-1" viewerUserId="viewer" onOpenProfile={open} />)
    fireEvent.click(view.getByRole("button", { name: "Actual Bot#0042" }))
    expect(open).toHaveBeenCalledWith("Actual Bot", expect.anything(), "0042", "created-1")
    expect(view.queryByTestId(tid.botCreationApprove)).toBeNull()
    profiles.set("created-1", { id: "created-1", name: "Renamed Bot", discriminator: "0042", avatar: null })
    view.rerender(<BotCreationRequestCard request={request} messageId="message-1" viewerUserId="viewer" onOpenProfile={open} />)
    expect(view.getByRole("button", { name: "Renamed Bot#0042" })).toBeVisible()
    expect(view.queryByRole("button", { name: "Actual Bot#0042" })).toBeNull()
    request.bots[0]!.createdBot.image = "https://example.com/stale-avatar.png"
    view.rerender(<BotCreationRequestCard request={request} messageId="message-1" viewerUserId="viewer" onOpenProfile={open} />)
    expect(view.container.querySelector('[data-avatar-kind="photo"]')).toBeNull()
  })
})

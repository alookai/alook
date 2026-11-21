import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { DECISION_CARD_MESSAGE_TYPE, WS_EVENTS } from "@alook/shared"

const mocks = vi.hoisted(() => ({
  getMessage: vi.fn(),
  listReadableMessageChannelsForUser: vi.fn(),
  dismissQuestionTodoWithRevision: vi.fn(),
  broadcastToUserSafe: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("@/lib/middleware/auth", () => ({
  humanAuthPolicy: {
    resolve: async () => ({
      context: { env: { DB: {} }, userId: "u_gus", email: "gus@alook.test" },
    }),
  },
}))
vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...args: unknown[]) => mocks.broadcastToUserSafe(...args),
}))
vi.mock("@alook/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessage: (...args: unknown[]) => mocks.getMessage(...args),
      },
      communityChannel: {
        ...actual.queries.communityChannel,
        listReadableMessageChannelsForUser: (...args: unknown[]) =>
          mocks.listReadableMessageChannelsForUser(...args),
      },
      communityInbox: {
        ...actual.queries.communityInbox,
        dismissQuestionTodoWithRevision: (...args: unknown[]) =>
          mocks.dismissQuestionTodoWithRevision(...args),
      },
    },
  }
})

const { DELETE } = await import("./route")

describe("DELETE /api/community/users/me/inbox/todos/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMessage.mockResolvedValue({
      id: "m_q1",
      channelId: "ch_1",
      authorId: "bot_evan",
      type: DECISION_CARD_MESSAGE_TYPE,
    })
    mocks.listReadableMessageChannelsForUser.mockResolvedValue([{ id: "ch_1" }])
    mocks.dismissQuestionTodoWithRevision.mockResolvedValue({ changed: true, revision: 7 })
  })

  it("dismisses a readable question message and broadcasts INBOX_CHANGED(todo_dismiss)", async () => {
    const res = await DELETE(
      new NextRequest("http://localhost/api/community/users/me/inbox/todos/m_q1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "m_q1" }) },
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, changed: true, revision: 7 })
    expect(mocks.dismissQuestionTodoWithRevision).toHaveBeenCalledWith({}, "u_gus", "m_q1")
    expect(mocks.broadcastToUserSafe).toHaveBeenCalledWith("u_gus", {
      type: WS_EVENTS.INBOX_CHANGED,
      reason: "todo_dismiss",
      inboxChanged: true,
      revision: 7,
    })
  })

  it("is idempotent without rebroadcasting when already dismissed", async () => {
    mocks.dismissQuestionTodoWithRevision.mockResolvedValue({ changed: false, revision: 7 })
    const res = await DELETE(
      new NextRequest("http://localhost/api/community/users/me/inbox/todos/m_q1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "m_q1" }) },
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, changed: false, revision: 7 })
    expect(mocks.broadcastToUserSafe).not.toHaveBeenCalled()
  })

  it("returns 404 when the message is missing, not a question, self-authored, or in an unreadable channel", async () => {
    for (const setup of [
      () => mocks.getMessage.mockResolvedValueOnce(null),
      () => mocks.getMessage.mockResolvedValueOnce({ id: "m_chat", channelId: "ch_1", authorId: "bot_evan", type: "default" }),
      () => mocks.getMessage.mockResolvedValueOnce({ id: "m_self", channelId: "ch_1", authorId: "u_gus", type: DECISION_CARD_MESSAGE_TYPE }),
      () => mocks.listReadableMessageChannelsForUser.mockResolvedValueOnce([]),
    ]) {
      setup()
      const res = await DELETE(
        new NextRequest("http://localhost/api/community/users/me/inbox/todos/m_q1", { method: "DELETE" }),
        { params: Promise.resolve({ id: "m_q1" }) },
      )
      expect(res.status).toBe(404)
      expect(mocks.dismissQuestionTodoWithRevision).not.toHaveBeenCalled()
    }
  })
})

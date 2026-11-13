import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  latest: vi.fn(), read: vi.fn(), unread: vi.fn(), resolve: vi.fn(), replay: vi.fn(),
  create: vi.fn(), forum: vi.fn(), duplicate: vi.fn(), admit: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("@/lib/middleware/community-agent-runner-auth", () => ({
  resolveOwnedBotActor: async () => ({ kind: "bot", actor: { botUserId: "bot" } }),
}))
vi.mock("@alook/shared", async (original) => {
  const actual = await original<typeof import("@alook/shared")>()
  return { ...actual, queries: { ...actual.queries,
    automation: { ...actual.queries.automation, getOwnedBotByHandle: async () => ({ id: "bot" }) },
    communityAgentInbox: { ...actual.queries.communityAgentInbox,
      getLatestSeqForScope: m.latest, hasDeliverableUnreadForAgentScope: m.unread,
      toAgentMessage: async (_db: unknown, row: { seq: number }) => ({ ...row, seq: `#${row.seq}` }),
    },
    communityReadState: { ...actual.queries.communityReadState, getReadState: m.read },
    communityBot: { ...actual.queries.communityBot, bumpBotDailyActivityStatement: () => ({ sent: true }) },
  } }
})
vi.mock("./message-door", () => ({ resolveMessageTarget: m.resolve }))
vi.mock("./message-handler", () => ({ createCommunityMessage: m.create, getCommunityMessageReplay: m.replay }))
vi.mock("./create-channels", () => ({ createMessageWithThread: m.forum }))
vi.mock("./jev-send-dedup", () => ({ isDuplicateBotMessage: m.duplicate, DUPLICATE_MESSAGE_ERROR: "duplicate" }))
vi.mock("./fanout", () => ({ broadcastToUserSafe: vi.fn() }))

import { sendAutomationMessage } from "./automation-message.server"
import { handleBotSend } from "./message-send.server"
const ctx = { env: { DB: {} } as Env, userId: "owner", beforeCreate: m.admit }
const payload = { channel: "/team#0001/general", content: { text: "scheduled report" }, nonce: "job-1" }
const automation = () => sendAutomationMessage(new NextRequest("http://localhost/api/community/automation/messages", {
  method: "POST", body: JSON.stringify({ target: payload.channel, as: "@Helper#0001", content: payload.content.text, nonce: payload.nonce }),
}), ctx)

beforeEach(() => {
  vi.resetAllMocks()
  m.latest.mockResolvedValue(8)
  m.read.mockResolvedValue({ lastReadSeq: 2 })
  m.unread.mockResolvedValue(true)
  m.resolve.mockResolvedValue({ ok: true, value: { target: { kind: "channel", channelId: "channel", serverId: "server" } } })
  m.replay.mockResolvedValue(null)
  m.create.mockResolvedValue({ ok: true, row: { id: "message", seq: 9 }, deduped: false })
  m.forum.mockResolvedValue({ ok: true, message: { id: "opener", seq: 9 }, thread: { id: "thread" }, deduped: false })
  m.duplicate.mockResolvedValue(false)
  m.admit.mockResolvedValue(null)
})

it.each(["channel", "forum"])("Automation sends to unread %s without a waterline query or sequence guard", async (kind) => {
  m.resolve.mockResolvedValue({ ok: true, value: { target: { kind, channelId: "channel", serverId: "server" } } })
  expect(await (await automation()).json()).toMatchObject({ state: "sent", seq: "#9" })
  expect(m.latest).not.toHaveBeenCalled()
  expect(m.read).not.toHaveBeenCalled()
  expect(m.unread).not.toHaveBeenCalled()
  const writer = kind === "forum" ? m.forum : m.create
  expect(writer).toHaveBeenCalledOnce()
  expect(writer.mock.calls[0][0]).not.toHaveProperty("expectedSeq")
  expect(m.duplicate).toHaveBeenCalledOnce()
})

it("ordinary bot sends still block unread even if the body tries to disable alignment", async () => {
  const result = await handleBotSend({} as never, "bot", ctx.env, { ...payload, requireAlignment: false, force: true })
  expect(await result.json()).toMatchObject({ state: "blocked", reason: "unaligned" })
  expect(m.create).not.toHaveBeenCalled()
})

it.each(["channel", "forum"])("ordinary bot %s sends retain the post-check sequence race guard", async (kind) => {
  m.unread.mockResolvedValue(false)
  m.resolve.mockResolvedValue({ ok: true, value: { target: { kind, channelId: "channel", serverId: "server" } } })
  const writer = kind === "forum" ? m.forum : m.create
  writer.mockResolvedValue({ ok: false, status: 409, error: "seq_conflict" })
  expect(await (await handleBotSend({} as never, "bot", ctx.env, payload)).json()).toMatchObject({ state: "blocked", reason: "unaligned" })
  expect(writer.mock.calls[0][0]).toHaveProperty("expectedSeq", 8)
})

it("Automation still rejects inaccessible targets and duplicate content", async () => {
  m.resolve.mockResolvedValueOnce({ ok: false, status: 403, error: "forbidden" })
  expect((await automation()).status).toBe(403)
  m.duplicate.mockResolvedValue(true)
  expect((await automation()).status).toBe(422)
  expect(m.create).not.toHaveBeenCalled()
})

it("Automation replays the existing nonce without another write or alignment check", async () => {
  m.replay.mockResolvedValue({ row: { id: "existing", seq: 4 }, attachments: [] })
  expect(await (await automation()).json()).toEqual({ state: "sent", seq: "#4", deduped: true })
  expect(m.create).not.toHaveBeenCalled()
  expect(m.unread).not.toHaveBeenCalled()
})

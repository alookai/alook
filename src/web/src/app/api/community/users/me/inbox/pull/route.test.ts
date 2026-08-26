import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
const mockGetDb = vi.fn(() => ({ session: "replica" }))
const mockGetPrimaryDb = vi.fn(() => ({ session: "primary" }))
vi.mock("@/lib/db", () => ({
  getDb: (...a: unknown[]) => mockGetDb(...a),
  getPrimaryDb: (...a: unknown[]) => mockGetPrimaryDb(...a),
}))
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: vi.fn(async () => ({ headers: new Headers(), response: null })) },
  })),
}))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockListUnreadMessagesForAgent = vi.fn()
const mockListAlignmentUnreadMessagesForAgentScope = vi.fn()
const mockListAccessVisibleChannelIdsForUser = vi.fn()
const mockToAgentMessages = vi.fn()
const mockListByMessageIds = vi.fn()
const mockCountMarksForUser = vi.fn()
const mockGetReadState = vi.fn()
const mockResolveMessageTarget = vi.fn()

vi.mock("@/lib/community/message-door", () => ({
  resolveMessageTarget: (...a: unknown[]) => mockResolveMessageTarget(...a),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityAgentInbox: {
        listAccessVisibleChannelIdsForUser: (...a: unknown[]) => mockListAccessVisibleChannelIdsForUser(...a),
        listUnreadMessagesForAgent: (...a: unknown[]) => mockListUnreadMessagesForAgent(...a),
        listAlignmentUnreadMessagesForAgentScope: (...a: unknown[]) => mockListAlignmentUnreadMessagesForAgentScope(...a),
        toAgentMessages: (...a: unknown[]) => mockToAgentMessages(...a),
      },
      communityReadState: {
        getReadState: (...a: unknown[]) => mockGetReadState(...a),
      },
      communityMessageMark: {
        countMarksForUser: (...a: unknown[]) => mockCountMarksForUser(...a),
      },
      communityAttachment: {
        listByMessageIds: (...a: unknown[]) => mockListByMessageIds(...a),
      },
    },
  }
})

import { POST } from "./route"

// Bot arm of POST users/me/inbox/pull (folds the flat inboxPull verb). The pull
// is self-scoped to the voucher's bot (users/me/* family invariant): the body
// schema is `{ max? }` only — NO target-user param — so a bot can only pull its
// own inbox. Its optional channel narrows only that same bot's pull to one
// exact accessible scope. A no-crk_ request falls to the human arm → 401.
function req(body?: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/users/me/inbox/pull", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body } : {}),
  })
}

describe("POST /api/community/users/me/inbox/pull — bot arm (folds inboxPull)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockToAgentMessages.mockImplementation((_db: unknown, rows: unknown[]) => Promise.resolve(rows))
    mockListByMessageIds.mockResolvedValue([])
    mockListAccessVisibleChannelIdsForUser.mockResolvedValue(["c_1"])
    mockCountMarksForUser.mockResolvedValue(0)
    mockGetReadState.mockResolvedValue(null)
    mockResolveMessageTarget.mockResolvedValue({
      ok: true,
      value: { target: { kind: "thread", channelId: "thread_1", parentChannelId: "c_1", serverId: "s_1" }, isDm: false },
    })
  })

  it("401 without Authorization (human arm, no session)", async () => {
    const res = await POST(req(undefined))
    expect(res.status).toBe(401)
  })

  it("400 on invalid JSON body", async () => {
    const res = await POST(req("not-json", { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("self-scoped: pull always queries the caller's OWN userId (bot_1), never a body-supplied target", async () => {
    mockListUnreadMessagesForAgent.mockResolvedValue([{ id: "m_1" }])
    // A body carrying a rogue `userId` must be ignored — the scope comes from the
    // credential, not the payload (users/me/* family invariant).
    const res = await POST(req(JSON.stringify({ max: 5, userId: "someone_else" }), { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(mockListUnreadMessagesForAgent).toHaveBeenCalledWith(expect.anything(), "bot_1", {
      max: 6,
      visibleChannelIds: ["c_1"],
    })
    expect(mockListAccessVisibleChannelIdsForUser).toHaveBeenCalledOnce()
    expect(mockCountMarksForUser).toHaveBeenCalledWith(expect.anything(), "bot_1", {
      visibleChannelIds: ["c_1"],
    })
    expect(mockListUnreadMessagesForAgent).toHaveBeenCalledWith(
      { session: "replica" },
      "bot_1",
      expect.anything(),
    )
  })

  it("hasMore + probe-row trim behave (unread > max)", async () => {
    mockListUnreadMessagesForAgent.mockResolvedValue([{ id: "m_1" }, { id: "m_2" }, { id: "m_3" }])
    const res = await POST(req(JSON.stringify({ max: 2 }), { Authorization: "Bearer crk_abc" }))
    const body = await res.json()
    expect(body.hasMore).toBe(true)
    expect(body.messages).toHaveLength(2)
  })

  it("exact-target pull resolves without create and uses the shared alignment row core after read state", async () => {
    mockGetReadState.mockResolvedValue({ lastReadSeq: 7 })
    mockListAlignmentUnreadMessagesForAgentScope.mockResolvedValue([{ id: "m_8", seq: 8 }])

    const res = await POST(req(
      JSON.stringify({ max: 5, channel: "/demo#0042/general/#12" }),
      { Authorization: "Bearer crk_abc" },
    ))

    expect(res.status).toBe(200)
    expect(mockResolveMessageTarget).toHaveBeenCalledWith(
      expect.anything(),
      "bot_1",
      { ref: "/demo#0042/general/#12" },
      "bot",
    )
    expect(mockListAlignmentUnreadMessagesForAgentScope).toHaveBeenCalledWith(
      { session: "primary" },
      "bot_1",
      "thread_1",
      { afterSeq: 7, max: 6 },
    )
    expect(mockListUnreadMessagesForAgent).not.toHaveBeenCalled()
    expect(mockResolveMessageTarget).toHaveBeenCalledWith(
      { session: "primary" },
      "bot_1",
      expect.anything(),
      "bot",
    )
  })

  it("exact-target pull preserves bounded pagination and trims only the probe row", async () => {
    mockListAlignmentUnreadMessagesForAgentScope.mockResolvedValue([
      { id: "m_1", seq: 1 },
      { id: "m_2", seq: 2 },
      { id: "m_3", seq: 3 },
    ])
    const res = await POST(req(
      JSON.stringify({ max: 2, channel: "/demo#0042/general" }),
      { Authorization: "Bearer crk_abc" },
    ))
    await expect(res.json()).resolves.toMatchObject({
      messages: [{ id: "m_1", seq: 1 }, { id: "m_2", seq: 2 }],
      hasMore: true,
    })
  })

  it("exact-target pull rejects an inaccessible target before unread queries", async () => {
    mockResolveMessageTarget.mockResolvedValue({ ok: false, status: 404, error: "channel not found" })
    const res = await POST(req(
      JSON.stringify({ channel: "/demo#0042/private" }),
      { Authorization: "Bearer crk_abc" },
    ))
    expect(res.status).toBe(404)
    expect(mockListAlignmentUnreadMessagesForAgentScope).not.toHaveBeenCalled()
    expect(mockListUnreadMessagesForAgent).not.toHaveBeenCalled()
  })

  it("returns the numeric markedCount in the HTTP response unchanged", async () => {
    mockListUnreadMessagesForAgent.mockResolvedValue([])
    mockCountMarksForUser.mockResolvedValue(3)
    const res = await POST(req(JSON.stringify({ max: 5 }), { Authorization: "Bearer crk_abc" }))
    await expect(res.json()).resolves.toEqual({
      messages: [],
      hasMore: false,
      markedCount: 3,
    })
  })

  it("retries a transient D1 error (withD1Retry armor carried over)", async () => {
    mockListUnreadMessagesForAgent
      .mockRejectedValueOnce(new Error("D1_ERROR: internal error; reference = abc123"))
      .mockResolvedValueOnce([{ id: "m_1" }])
    const res = await POST(req(JSON.stringify({ max: 5 }), { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(mockListUnreadMessagesForAgent).toHaveBeenCalledTimes(2)
  })

  it("fails open to numeric zero when mark count exhausts retries without changing unread delivery", async () => {
    mockListUnreadMessagesForAgent.mockResolvedValue([{ id: "m_1" }, { id: "m_2" }])
    mockCountMarksForUser.mockRejectedValue(new Error("D1_ERROR: SQLITE_BUSY: database is locked"))
    const res = await POST(req(JSON.stringify({ max: 1 }), { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      messages: [{ id: "m_1" }],
      hasMore: true,
      markedCount: 0,
    })
    expect(mockListUnreadMessagesForAgent).toHaveBeenCalledOnce()
    expect(mockCountMarksForUser).toHaveBeenCalledTimes(4)
    expect(mockToAgentMessages).toHaveBeenCalledWith(
      expect.anything(),
      [{ id: "m_1" }],
      "bot_1",
      expect.any(Map),
    )
  })

  it("keeps unread failures strict even when mark count succeeds", async () => {
    mockListUnreadMessagesForAgent.mockRejectedValue(new Error("unread hard failure"))
    const pull = POST(req(JSON.stringify({ max: 5 }), { Authorization: "Bearer crk_abc" }))
    await expect(pull).rejects.toThrow("unread hard failure")
    expect(mockToAgentMessages).not.toHaveBeenCalled()
  })

  it("keeps an orphan-DM message owed after a loud hydration failure and redelivers it after repair", async () => {
    const owed = { id: "owed_message_internal", channelId: "dm_channel_internal", seq: 7 }
    mockListUnreadMessagesForAgent.mockResolvedValue([owed])
    mockToAgentMessages
      .mockRejectedValueOnce(new Error("DM peer identity unavailable"))
      .mockResolvedValueOnce([{ seq: "#7", channel: "/.dm/Bob#0042", sender: "@Alice#1234", content: { text: "still owed" } }])

    const first = POST(req(JSON.stringify({ max: 5 }), { Authorization: "Bearer crk_abc" }))
    await expect(first).rejects.toThrow("DM peer identity unavailable")
    await expect(first).rejects.not.toThrow(/owed_message_internal|dm_channel_internal/)

    const repaired = await POST(req(JSON.stringify({ max: 5 }), { Authorization: "Bearer crk_abc" }))
    expect(repaired.status).toBe(200)
    expect(await repaired.json()).toMatchObject({
      messages: [{ seq: "#7", channel: "/.dm/Bob#0042", content: { text: "still owed" } }],
    })
    expect(mockListUnreadMessagesForAgent).toHaveBeenCalledTimes(2)
    expect(mockListUnreadMessagesForAgent.mock.results.map((r) => r.value)).toHaveLength(2)
  })
})

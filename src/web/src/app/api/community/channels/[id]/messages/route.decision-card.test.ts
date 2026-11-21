import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  DECISION_CARD_EMBED_KIND,
  DECISION_CARD_MESSAGE_TYPE,
  extractDecisionCardFromEmbeds,
  queries,
  type Database,
} from "@alook/shared"
import { communityWriteDb } from "../../../../../../../../shared/test/helpers/community-write-db"
import { enrichMessages } from "@/lib/community/enrich-messages"

const background: Promise<unknown>[] = []
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ ctx: { waitUntil: (work: Promise<unknown>) => background.push(work) } }),
}))

type Actor = { kind: "bot" | "human"; userId: string }
type Target =
  | { kind: "thread"; channelId: string; parentChannelId: string; serverId: string }
  | { kind: "channel"; channelId: string; serverId: string }
  | { kind: "dm"; channelId: string; otherUserId: string }

let fixture: ReturnType<typeof communityWriteDb>
let currentActor: Actor = { kind: "bot", userId: "bot_evan" }
let currentTarget: Target = { kind: "thread", channelId: "thread_1", parentChannelId: "chan_1", serverId: "srv_1" }

vi.mock("@/lib/db", () => ({ getDb: () => fixture.db, getPrimaryDb: () => fixture.db }))
vi.mock("@/lib/middleware/community-actor", () => ({
  communityActorPolicy: () => ({
    resolve: async () => ({ context: { env: { DB: {} }, actor: currentActor } }),
  }),
}))
vi.mock("@/lib/community/message-door", () => ({
  resolveMessageTarget: async () => ({ ok: true, value: { target: currentTarget } }),
}))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: vi.fn(),
  fanOutToChannel: vi.fn(),
  fanOutToServerMembers: vi.fn(),
}))
vi.mock("@/lib/community/message-dispatcher", () => ({ dispatchCommittedMessage: vi.fn() }))

function seedDb() {
  const created = communityWriteDb()
  const conn = created.sqlite
  conn.exec(`
    ALTER TABLE user ADD COLUMN name TEXT NOT NULL DEFAULT '';
    ALTER TABLE user ADD COLUMN email TEXT NOT NULL DEFAULT '';
    ALTER TABLE user ADD COLUMN emailVerified INTEGER;
    ALTER TABLE user ADD COLUMN image TEXT;
    ALTER TABLE user ADD COLUMN discriminator TEXT NOT NULL DEFAULT '0000';
    ALTER TABLE user ADD COLUMN avatarVersion INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE user ADD COLUMN avatarObjectKey TEXT;
    ALTER TABLE user ADD COLUMN createdAt TEXT NOT NULL DEFAULT '2026-11-20T00:00:00.000Z';
    ALTER TABLE user ADD COLUMN updatedAt TEXT NOT NULL DEFAULT '2026-11-20T00:00:00.000Z';
    ALTER TABLE user ADD COLUMN lastRefreshContextAt TEXT;
    CREATE INDEX idx_community_message_channel_reply_author ON community_message (channel_id, reply_to_id, author_id) WHERE reply_to_id IS NOT NULL;
    CREATE TABLE community_user_profile (
      user_id TEXT PRIMARY KEY REFERENCES user(id),
      about_me TEXT DEFAULT '',
      banner_color TEXT,
      status_emoji TEXT,
      status_text TEXT DEFAULT ''
    );
    CREATE TABLE community_server (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      discriminator TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT,
      official INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '2026-11-20T00:00:00.000Z'
    );
    ALTER TABLE community_server_member ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
    ALTER TABLE community_server_member ADD COLUMN nickname TEXT;
    ALTER TABLE community_server_member ADD COLUMN joined_at TEXT NOT NULL DEFAULT '2026-11-20T00:00:00.000Z';
    CREATE TABLE community_reaction (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES community_message(id),
      user_id TEXT NOT NULL REFERENCES user(id),
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '2026-11-20T00:00:00.000Z'
    );
    CREATE TABLE community_bot_daily_activity (
      bot_id TEXT NOT NULL,
      day TEXT NOT NULL,
      handled_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bot_id, day)
    );
    CREATE TABLE community_message_mark (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES community_message(id),
      user_id TEXT NOT NULL REFERENCES user(id),
      channel_id TEXT NOT NULL DEFAULT 'thread_1',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-11-20T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-11-20T00:00:00.000Z',
      UNIQUE(message_id, user_id)
    );
    CREATE TABLE community_notification_setting (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user(id),
      server_id TEXT,
      channel_id TEXT,
      level TEXT NOT NULL DEFAULT 'all'
    );
    INSERT INTO user (id, name, email, discriminator, isBot, ownerUserId) VALUES
      ('u_gus', 'gus', 'gus@alook.test', '1813', 0, NULL),
      ('u_alice', 'alice', 'alice@alook.test', '0001', 0, NULL),
      ('u_bystander', 'bystander', 'b@alook.test', '0002', 0, NULL),
      ('bot_evan', 'Evan You', 'evan@alook.test', '6524', 1, 'u_gus');
    INSERT INTO community_server (id, name, discriminator, owner_id) VALUES ('srv_1', 'Alook', '5620', 'u_gus');
    INSERT INTO community_server_member (id, server_id, user_id, role) VALUES
      ('sm_1', 'srv_1', 'u_gus', 'owner'),
      ('sm_2', 'srv_1', 'u_alice', 'member'),
      ('sm_3', 'srv_1', 'u_bystander', 'member'),
      ('sm_4', 'srv_1', 'bot_evan', 'member');
    INSERT INTO community_channel (id, server_id, name, type, created_at) VALUES
      ('chan_1', 'srv_1', 'general', 'text', '2026-11-20T00:00:00.000Z'),
      ('chan_2', 'srv_1', 'other', 'text', '2026-11-20T00:00:00.000Z'),
      ('dm_1', NULL, NULL, 'dm', '2026-11-20T00:00:00.000Z');
    INSERT INTO community_message (id, author_id, content, type, created_at, channel_id, seq) VALUES
      ('m_root', 'u_gus', 'root', 'default', '2026-11-20T00:00:00.000Z', 'chan_1', 1);
    INSERT INTO community_message_seq (channel_id, next_seq) VALUES ('chan_1', 1);
    INSERT INTO community_channel (id, server_id, name, type, parent_channel_id, parent_message_id, created_at) VALUES
      ('thread_1', 'srv_1', 'decision-thread', 'thread', 'chan_1', 'm_root', '2026-11-20T00:00:00.000Z');
    INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES
      ('dm_m1', 'dm_1', 'u_gus', 'access', 'added', '2026-11-20T00:00:00.000Z'),
      ('dm_m2', 'dm_1', 'bot_evan', 'access', 'added', '2026-11-20T00:00:00.000Z');
  `)
  return created
}

const { POST } = await import("./route")

describe("decision card end-to-end route + bot inbox + responder hydration", () => {
  beforeEach(() => {
    background.length = 0
    fixture = seedDb()
  })

  afterEach(() => {
    fixture.sqlite.close()
  })

  it("bot asks in thread → form + manual replies both count per-author on reload and reach bot inbox with replyTo", async () => {
    currentActor = { kind: "bot", userId: "bot_evan" }
    currentTarget = { kind: "thread", channelId: "thread_1", parentChannelId: "chan_1", serverId: "srv_1" }

    const askRes = await POST(
      new NextRequest("http://localhost/api/community/channels/resolve/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: "/Alook#5620/general/#1",
          content: { text: "" },
          nonce: "bot-ask-1",
          question: {
            mentions: ["@gus#1813", "@alice#0001"],
            summary: "Confirm release timing",
            questions: [
              {
                id: "timing",
                header: "Timing",
                question: "When should we publish? (do not ping @bystander#0002)",
                options: [
                  { id: "today", label: "Today", description: "Publish now", recommended: true },
                  { id: "next", label: "Next week", description: "Ask @bystander#0002 later" },
                ],
              },
            ],
          },
        }),
      }),
      { params: Promise.resolve({ id: "resolve" }) },
    )
    expect(askRes.status).toBe(200)
    const askJson = await askRes.json()
    expect(askJson.state).toBe("sent")
    expect(askJson.message.seq).toBe("#1")
    const expectedQuestionPayload = {
      mentions: ["@gus#1813", "@alice#0001"],
      summary: "Confirm release timing",
      questions: [
        {
          id: "timing",
          header: "Timing",
          question: "When should we publish? (do not ping @bystander#0002)",
          multiSelect: false,
          allowOther: true,
          options: [
            { id: "today", label: "Today", description: "Publish now", recommended: true },
            { id: "next", label: "Next week", description: "Ask @bystander#0002 later" },
          ],
        },
      ],
    }
    expect(askJson.message.content).toEqual({ question: expectedQuestionPayload })
    expect(askJson.message.content).not.toHaveProperty("text")
    expect(JSON.stringify(askJson.message.content)).not.toContain("u_gus")

    const qRow = fixture.sqlite
      .prepare("SELECT id, type, content, embeds FROM community_message WHERE channel_id = 'thread_1' AND seq = 1")
      .get() as { id: string; type: string; content: string; embeds: string }
    expect(qRow.type).toBe(DECISION_CARD_MESSAGE_TYPE)
    expect(qRow.content).toBe("Confirm release timing")
    expect(qRow.content).not.toContain("@gus#1813")
    expect(qRow.content).not.toContain("Today")
    const parsedEmbeds = JSON.parse(qRow.embeds)
    expect(parsedEmbeds).toHaveLength(1)
    expect(parsedEmbeds[0].kind).toBe(DECISION_CARD_EMBED_KIND)
    expect("title" in parsedEmbeds[0]).toBe(false)

    // Bot read paths (history, resolve, inbox pull, marks) all deliver structured content.question JSON.
    const historyPage = await queries.communityAgentInbox.listMessagesBySeq(fixture.db as Database, { channelId: "thread_1" }, {})
    const historyMessages = await queries.communityAgentInbox.toAgentMessages(fixture.db as Database, historyPage.items, "bot_evan")
    expect(historyMessages[0]?.content).toEqual({ question: expectedQuestionPayload })

    const resolvedRow = await queries.communityMessage.getMessageByChannelAndSeq(fixture.db as Database, { channelId: "thread_1" }, 1)
    const resolvedMessage = await queries.communityAgentInbox.toAgentMessage(fixture.db as Database, resolvedRow!, "bot_evan")
    expect(resolvedMessage.content).toEqual({ question: expectedQuestionPayload })

    fixture.sqlite.exec(`
      INSERT INTO user (id, name, email, discriminator, isBot, ownerUserId) VALUES ('bot_peer', 'Peer', 'peer@alook.test', '0099', 1, 'u_gus');
      INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES ('sm_peer', 'srv_1', 'bot_peer', 'member', '2026-11-19T00:00:00.000Z');
      INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES
        ('tm_peer', 'thread_1', 'bot_peer', 'notify', 'added', '2026-11-19T00:00:00.000Z');
    `)
    const peerUnread = await queries.communityAgentInbox.listUnreadMessagesForAgent(fixture.db as Database, "bot_peer", {})
    const peerPulled = await queries.communityAgentInbox.toAgentMessages(fixture.db as Database, peerUnread, "bot_peer")
    expect(peerPulled.find((m) => m.channel === "/Alook#5620/general/#1" && m.seq === "#1")?.content).toEqual({
      question: expectedQuestionPayload,
    })

    await queries.communityMessageMark.markMessage(fixture.db as Database, {
      userId: "bot_peer",
      messageId: qRow.id,
      channelId: "thread_1",
      note: "waiting on answer",
    })
    const markRows = await queries.communityMessageMark.listMarksForUser(fixture.db as Database, "bot_peer", {
      visibleChannelIds: ["thread_1"],
    })
    const markedMessages = await queries.communityAgentInbox.toAgentMessages(
      fixture.db as Database,
      markRows.map((row) => row.message),
      "bot_peer",
    )
    expect(markedMessages[0]?.content).toEqual({ question: expectedQuestionPayload })

    // Only explicit mentions received mention rows — @bystander#0002 in question/option prose did NOT.
    const mentions = fixture.sqlite
      .prepare("SELECT user_id, kind FROM community_mention WHERE message_id = ? ORDER BY user_id")
      .all(qRow.id)
    expect(mentions).toEqual([
      { user_id: "u_alice", kind: "mention" },
      { user_id: "u_gus", kind: "mention" },
    ])

    // Cross-channel replyToId in another channel cannot pollute thread_1's responder list.
    currentActor = { kind: "human", userId: "u_bystander" }
    currentTarget = { kind: "channel", channelId: "chan_2", serverId: "srv_1" }
    await POST(
      new NextRequest("http://localhost/api/community/channels/chan_2/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "cross-channel attempt", replyToId: qRow.id, nonce: "cross-1" }),
      }),
      { params: Promise.resolve({ id: "chan_2" }) },
    )

    // Before any same-channel reply, enrichment marks the card as checked-zero (respondedUserIds: []).
    const zeroRow = await queries.communityMessage.getMessage(fixture.db as Database, qRow.id)
    const zeroEnriched = await enrichMessages(
      fixture.db as Database,
      "u_gus",
      { channelId: "thread_1" },
      [zeroRow!],
    )
    expect(extractDecisionCardFromEmbeds(zeroEnriched.messages[0]!.embeds).card?.respondedUserIds).toEqual([])

    // Gus answers via form (ordinary reply message + nonce), then retries with same nonce (deduped).
    currentActor = { kind: "human", userId: "u_gus" }
    currentTarget = { kind: "thread", channelId: "thread_1", parentChannelId: "chan_1", serverId: "srv_1" }
    const gusBody = JSON.stringify({
      content: "Timing: Today",
      replyToId: qRow.id,
      nonce: "gus-answer-nonce-1",
    })
    const answerRes = await POST(
      new NextRequest("http://localhost/api/community/channels/thread_1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: gusBody,
      }),
      { params: Promise.resolve({ id: "thread_1" }) },
    )
    expect(answerRes.status).toBe(201)
    const answerJson = await answerRes.json()
    expect(answerJson.deduped).toBe(false)
    expect(answerJson.message.replyToId).toBe(qRow.id)

    const retryRes = await POST(
      new NextRequest("http://localhost/api/community/channels/thread_1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: gusBody,
      }),
      { params: Promise.resolve({ id: "thread_1" }) },
    )
    expect(retryRes.status).toBe(200)
    expect((await retryRes.json()).deduped).toBe(true)

    // Gus sends a second manual reply, and Alice sends a manual free-text reply — both citing qRow.id.
    await POST(
      new NextRequest("http://localhost/api/community/channels/thread_1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Actually let's do 6pm", replyToId: qRow.id, nonce: "gus-manual-2" }),
      }),
      { params: Promise.resolve({ id: "thread_1" }) },
    )
    currentActor = { kind: "human", userId: "u_alice" }
    const aliceRes = await POST(
      new NextRequest("http://localhost/api/community/channels/thread_1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Works for me next week", replyToId: qRow.id, nonce: "alice-manual-1" }),
      }),
      { params: Promise.resolve({ id: "thread_1" }) },
    )
    expect(aliceRes.status).toBe(201)
    const aliceJson = await aliceRes.json()
    const relatedCard = (aliceJson.relatedMessages ?? []).find((m: { id: string }) => m.id === qRow.id)
    expect(relatedCard).toBeDefined()
    expect(
      extractDecisionCardFromEmbeds(relatedCard.embeds).card?.respondedUserIds?.slice().sort(),
    ).toEqual(["u_alice", "u_gus"])

    // Verify covering index plan on listReplierUserIdsByReplyTargets with additional channel chatter.
    const insertNoise = fixture.sqlite.prepare(
      "INSERT INTO community_message (id, author_id, content, type, created_at, channel_id, seq) VALUES (?, 'u_gus', 'chatter', 'default', '2026-11-20T00:00:00.000Z', 'thread_1', ?)",
    )
    for (let i = 0; i < 100; i += 1) {
      insertNoise.run(`noise_${i}`, 100 + i)
    }
    const planRows = fixture.sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT DISTINCT reply_to_id, author_id FROM community_message WHERE channel_id = ? AND reply_to_id IN (?)",
      )
      .all("thread_1", qRow.id) as Array<{ detail: string }>
    expect(planRows.some((row) => row.detail.includes("COVERING INDEX idx_community_message_channel_reply_author"))).toBe(true)

    // Reload hydration on just the question message page (replies not in page!) resolves deduplicated responders.
    const pageRow = await queries.communityMessage.getMessage(fixture.db as Database, qRow.id)
    const enriched = await enrichMessages(
      fixture.db as Database,
      "u_gus",
      { channelId: "thread_1" },
      [pageRow!],
    )
    const hydrated = extractDecisionCardFromEmbeds(enriched.messages[0]!.embeds).card
    expect(hydrated?.respondedUserIds?.slice().sort()).toEqual(["u_alice", "u_gus"])

    // Original bot pulls inbox → receives all 3 thread replies with content.replyTo pointing to #1; cross-channel message has no replyTo.
    const unread = await queries.communityAgentInbox.listUnreadMessagesForAgent(fixture.db as Database, "bot_evan", {})
    const pulledMessages = await queries.communityAgentInbox.toAgentMessages(fixture.db as Database, unread, "bot_evan")
    const threadReplies = pulledMessages.filter((m) => m.channel === "/Alook#5620/general/#1")
    expect(threadReplies).toHaveLength(3)
    expect(threadReplies[0]).toMatchObject({
      seq: "#2",
      channel: "/Alook#5620/general/#1",
      sender: "@gus#1813",
      content: {
        text: "Timing: Today",
        replyTo: { seq: "#1", sender: "@Evan You#6524" },
      },
    })
    expect(threadReplies[2]).toMatchObject({
      seq: "#4",
      sender: "@alice#0001",
      content: {
        text: "Works for me next week",
        replyTo: { seq: "#1", sender: "@Evan You#6524" },
      },
    })
    const crossChannelMsg = pulledMessages.find((m) => m.channel === "/Alook#5620/other")
    expect(crossChannelMsg?.content.replyTo).toBeUndefined()
  })

  it("bot asks in DM → human answers → bot receives DM replyTo in inbox", async () => {
    currentActor = { kind: "bot", userId: "bot_evan" }
    currentTarget = { kind: "dm", channelId: "dm_1", otherUserId: "u_gus" }

    const askRes = await POST(
      new NextRequest("http://localhost/api/community/channels/resolve/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: "/.dm/gus#1813",
          content: { text: "" },
          nonce: "dm-ask-1",
          question: {
            summary: "Confirm deployment mode",
            questions: [
              {
                id: "mode",
                question: "Pick deployment mode",
                options: [
                  { id: "canary", label: "Canary" },
                  { id: "full", label: "Full rollout" },
                ],
              },
            ],
          },
        }),
      }),
      { params: Promise.resolve({ id: "resolve" }) },
    )
    expect(askRes.status).toBe(200)
    const qRow = fixture.sqlite
      .prepare("SELECT id FROM community_message WHERE channel_id = 'dm_1' AND seq = 1")
      .get() as { id: string }

    currentActor = { kind: "human", userId: "u_gus" }
    const answerRes = await POST(
      new NextRequest("http://localhost/api/community/channels/dm_1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Pick deployment mode: Other: Wait for QA",
          replyToId: qRow.id,
          nonce: "dm-answer-1",
        }),
      }),
      { params: Promise.resolve({ id: "dm_1" }) },
    )
    expect(answerRes.status).toBe(201)

    const unread = await queries.communityAgentInbox.listUnreadMessagesForAgent(fixture.db as Database, "bot_evan", {})
    const pulledMessages = await queries.communityAgentInbox.toAgentMessages(fixture.db as Database, unread, "bot_evan")
    expect(pulledMessages).toHaveLength(1)
    expect(pulledMessages[0]).toMatchObject({
      seq: "#2",
      channel: "/.dm/gus#1813",
      sender: "@gus#1813",
      content: {
        text: "Pick deployment mode: Other: Wait for QA",
        replyTo: { seq: "#1", sender: "@Evan You#6524" },
      },
    })
  })

  it("rejects mentioning an outsider in a thread under a private channel via targeted lookup", async () => {
    fixture.sqlite.exec(`
      INSERT INTO community_category (id, private) VALUES ('cat_priv', 1);
      INSERT INTO community_channel (id, server_id, category_id, name, type, created_at) VALUES
        ('priv_1', 'srv_1', 'cat_priv', 'secret', 'text', '2026-11-20T00:00:00.000Z');
      INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES
        ('pm_1', 'priv_1', 'u_gus', 'access', 'added', '2026-11-20T00:00:00.000Z'),
        ('pm_2', 'priv_1', 'bot_evan', 'access', 'added', '2026-11-20T00:00:00.000Z');
      INSERT INTO community_message (id, author_id, content, type, created_at, channel_id, seq) VALUES
        ('m_priv_root', 'u_gus', 'secret root', 'default', '2026-11-20T00:00:00.000Z', 'priv_1', 1);
      INSERT INTO community_channel (id, server_id, name, type, parent_channel_id, parent_message_id, created_at) VALUES
        ('priv_thread_1', 'srv_1', 'secret-thread', 'thread', 'priv_1', 'm_priv_root', '2026-11-20T00:00:00.000Z');
    `)
    currentActor = { kind: "bot", userId: "bot_evan" }
    currentTarget = { kind: "thread", channelId: "priv_thread_1", parentChannelId: "priv_1", serverId: "srv_1" }

    const res = await POST(
      new NextRequest("http://localhost/api/community/channels/resolve/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: "/Alook#5620/secret/#1",
          content: { text: "" },
          nonce: "priv-ask-1",
          question: {
            mentions: ["@gus#1813", "@bystander#0002"],
            summary: "Approve secret release",
            questions: [
              {
                id: "q1",
                question: "Approve?",
                options: [
                  { id: "yes", label: "Yes" },
                  { id: "no", label: "No" },
                ],
              },
            ],
          },
        }),
      }),
      { params: Promise.resolve({ id: "resolve" }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("@bystander#0002")
  })

  it("rejects new decision cards with missing or blank summary, while still reading and answering legacy cards without summary", async () => {
    currentActor = { kind: "bot", userId: "bot_evan" }
    currentTarget = { kind: "thread", channelId: "thread_1", parentChannelId: "chan_1", serverId: "srv_1" }

    for (const [nonce, question] of [
      ["missing-summary", { questions: [{ question: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }] }],
      ["blank-summary", { summary: "   ", questions: [{ question: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }] }],
    ] as const) {
      const res = await POST(
        new NextRequest("http://localhost/api/community/channels/resolve/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: "/Alook#5620/general/#1",
            content: { text: "" },
            nonce,
            question,
          }),
        }),
        { params: Promise.resolve({ id: "resolve" }) },
      )
      expect(res.status).toBe(400)
    }

    // Seed a legacy decision card stored before summary became required.
    const legacyEmbed = {
      kind: DECISION_CARD_EMBED_KIND,
      version: 1,
      assignees: [{ userId: "u_gus", handle: "gus#1813" }],
      questions: [
        {
          id: "q1",
          question: "Legacy ship?",
          multiSelect: false,
          allowOther: true,
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      ],
    }
    fixture.sqlite
      .prepare(
        "INSERT INTO community_message (id, author_id, content, type, embeds, created_at, channel_id, seq) VALUES (?, ?, ?, ?, ?, '2026-11-20T01:00:00.000Z', 'thread_1', 1)",
      )
      .run("m_legacy_card", "bot_evan", "@gus#1813 Legacy ship?\n   Yes / No", DECISION_CARD_MESSAGE_TYPE, JSON.stringify([legacyEmbed]))
    fixture.sqlite
      .prepare("INSERT OR REPLACE INTO community_message_seq (channel_id, next_seq) VALUES ('thread_1', 1)")
      .run()

    // Bot read path still returns structured content.question (omitting summary).
    const legacyRow = await queries.communityMessage.getMessage(fixture.db as Database, "m_legacy_card")
    const botMsg = await queries.communityAgentInbox.toAgentMessage(fixture.db as Database, legacyRow!, "bot_evan")
    expect(botMsg.content).toEqual({
      question: {
        mentions: ["@gus#1813"],
        questions: legacyEmbed.questions,
      },
    })
    expect(botMsg.content.question).not.toHaveProperty("summary")

    // Human can still answer the legacy card and Web enrichment hydrates responders.
    currentActor = { kind: "human", userId: "u_gus" }
    const replyRes = await POST(
      new NextRequest("http://localhost/api/community/channels/thread_1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Legacy ship?: Yes", replyToId: "m_legacy_card", nonce: "legacy-ans-1" }),
      }),
      { params: Promise.resolve({ id: "thread_1" }) },
    )
    expect(replyRes.status).toBe(201)

    const enriched = await enrichMessages(fixture.db as Database, "u_gus", { channelId: "thread_1" }, [legacyRow!])
    const hydrated = extractDecisionCardFromEmbeds(enriched.messages[0]!.embeds).card
    expect(hydrated?.summary).toBeUndefined()
    expect(hydrated?.respondedUserIds).toEqual(["u_gus"])
  })

  it("inbox Todo projection lists unread actionable questions and preserveReadState preserves sibling unread cards until the last one is answered", async () => {
    // Ensure u_gus joined before the messages so unread baseline counts them.
    fixture.sqlite.exec(`
      ALTER TABLE community_friendship ADD COLUMN created_at TEXT NOT NULL DEFAULT '2026-11-19T00:00:00.000Z';
      ALTER TABLE community_friendship ADD COLUMN needs_owner_approval INTEGER NOT NULL DEFAULT 0;
      UPDATE community_server_member SET joined_at = '2026-11-19T00:00:00.000Z' WHERE user_id = 'u_gus';
      INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at)
      VALUES ('tm_gus', 'thread_1', 'u_gus', 'notify', 'added', '2026-11-19T00:00:00.000Z');
    `)

    // Bot asks 2 questions for Gus and 1 for Alice-only in thread_1, plus 1 in DM.
    currentActor = { kind: "bot", userId: "bot_evan" }
    currentTarget = { kind: "thread", channelId: "thread_1", parentChannelId: "chan_1", serverId: "srv_1" }
    const ask = (nonce: string, channel: string, summary: string, mentions?: string[], seenUpToSeq?: number) =>
      POST(
        new NextRequest("http://localhost/api/community/channels/resolve/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel,
            content: { text: "" },
            nonce,
            ...(seenUpToSeq !== undefined ? { seenUpToSeq } : {}),
            question: {
              ...(mentions ? { mentions } : {}),
              summary,
              questions: [{
                id: "q1",
                question: summary,
                options: [
                  { id: "yes", label: "Yes" },
                  { id: "no", label: "No" },
                ],
              }],
            },
          }),
        }),
        { params: Promise.resolve({ id: "resolve" }) },
      )

    expect((await ask("todo-q1", "/Alook#5620/general/#1", "First decision", ["@gus#1813"])).status).toBe(200)
    expect((await ask("todo-q2", "/Alook#5620/general/#1", "Second decision", ["@gus#1813"])).status).toBe(200)
    expect((await ask("todo-alice", "/Alook#5620/general/#1", "Alice only", ["@alice#0001"])).status).toBe(200)

    currentTarget = { kind: "dm", channelId: "dm_1", otherUserId: "u_gus" }
    expect((await ask("todo-dm", "/.dm/gus#1813", "DM decision")).status).toBe(200)

    const [q1, q2] = fixture.sqlite
      .prepare("SELECT id, seq FROM community_message WHERE channel_id = 'thread_1' AND type = 'question' ORDER BY seq ASC")
      .all() as Array<{ id: string; seq: number }>
    const dmQ = fixture.sqlite
      .prepare("SELECT id FROM community_message WHERE channel_id = 'dm_1' AND type = 'question'")
      .get() as { id: string }

    const before = await queries.communityAttention.getAccountAttentionProjection(fixture.db as Database, "u_gus")
    const beforeQuestionIds = before.items.filter((item) => item.kind === "question").map((item) => item.messageId).sort()
    expect(beforeQuestionIds).toEqual([dmQ.id, q1!.id, q2!.id].sort())

    // Answer q1 from Inbox with preserveReadState: true — q2 and Alice-only remain unread, so lastReadSeq is preserved!
    currentActor = { kind: "human", userId: "u_gus" }
    currentTarget = { kind: "thread", channelId: "thread_1", parentChannelId: "chan_1", serverId: "srv_1" }
    const ans1 = await POST(
      new NextRequest("http://localhost/api/community/channels/thread_1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "First decision: Yes",
          replyToId: q1!.id,
          nonce: "inbox-ans-1",
          preserveReadState: true,
        }),
      }),
      { params: Promise.resolve({ id: "thread_1" }) },
    )
    expect(ans1.status).toBe(201)

    // q1 mention is marked read; thread_1 read_state was NOT bumped past q2.
    const q1Mention = fixture.sqlite
      .prepare("SELECT read FROM community_mention WHERE message_id = ? AND user_id = 'u_gus'")
      .get(q1!.id) as { read: number }
    expect(q1Mention.read).toBe(1)
    const midReadState = fixture.sqlite
      .prepare("SELECT last_read_seq FROM community_read_state WHERE channel_id = 'thread_1' AND user_id = 'u_gus'")
      .get() as { last_read_seq: number } | undefined
    expect(midReadState).toBeUndefined()

    const afterFirst = await queries.communityAttention.getAccountAttentionProjection(fixture.db as Database, "u_gus")
    const afterFirstQuestionIds = afterFirst.items.filter((item) => item.kind === "question").map((item) => item.messageId).sort()
    expect(afterFirstQuestionIds).toEqual([dmQ.id, q2!.id].sort())

    // Answering the DM question (the ONLY unread message in dm_1) advances dm_1's read watermark and clears dm_1 from Unreads too!
    currentTarget = { kind: "dm", channelId: "dm_1", otherUserId: "u_gus" }
    const ansDm = await POST(
      new NextRequest("http://localhost/api/community/channels/dm_1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "DM decision: Yes",
          replyToId: dmQ.id,
          nonce: "inbox-ans-dm",
          preserveReadState: true,
        }),
      }),
      { params: Promise.resolve({ id: "dm_1" }) },
    )
    expect(ansDm.status).toBe(201)

    const dmReadState = fixture.sqlite
      .prepare("SELECT last_read_seq FROM community_read_state WHERE channel_id = 'dm_1' AND user_id = 'u_gus'")
      .get() as { last_read_seq: number } | undefined
    expect(dmReadState?.last_read_seq).toBe(2)

    const afterDm = await queries.communityAttention.getAccountAttentionProjection(fixture.db as Database, "u_gus")
    expect(afterDm.items.filter((item) => item.kind === "question").map((item) => item.messageId)).toEqual([q2!.id])
    expect(afterDm.scopes.some((scope) => scope.channelId === "dm_1")).toBe(false)

    // With an existing community_read_state row on dm_1 (last_read_seq = 2), answering a new DM question
    // exercises the read-state cursor branch in hasOtherUnreadMessages and advances last_read_seq to 4.
    currentActor = { kind: "bot", userId: "bot_evan" }
    currentTarget = { kind: "dm", channelId: "dm_1", otherUserId: "u_gus" }
    const askDm2 = await ask("todo-dm-2", "/.dm/gus#1813", "Second DM decision", undefined, 2)
    expect(askDm2.status).toBe(200)
    expect((await askDm2.json()).state).toBe("sent")
    const dmQ2 = fixture.sqlite
      .prepare("SELECT id FROM community_message WHERE channel_id = 'dm_1' AND type = 'question' ORDER BY seq DESC LIMIT 1")
      .get() as { id: string }

    currentActor = { kind: "human", userId: "u_gus" }
    const ansDm2 = await POST(
      new NextRequest("http://localhost/api/community/channels/dm_1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Second DM decision: No",
          replyToId: dmQ2.id,
          nonce: "inbox-ans-dm-2",
          preserveReadState: true,
        }),
      }),
      { params: Promise.resolve({ id: "dm_1" }) },
    )
    expect(ansDm2.status).toBe(201)
    const dmReadState2 = fixture.sqlite
      .prepare("SELECT last_read_seq FROM community_read_state WHERE channel_id = 'dm_1' AND user_id = 'u_gus'")
      .get() as { last_read_seq: number } | undefined
    expect(dmReadState2?.last_read_seq).toBe(4)

    // Channel with ONLY two unread questions (chan_2): answering the 1st preserves lastReadSeq;
    // answering the 2nd sees the 1st is already answered and atomically advances lastReadSeq so chan_2 clears from Unreads too.
    currentActor = { kind: "bot", userId: "bot_evan" }
    currentTarget = { kind: "channel", channelId: "chan_2", serverId: "srv_1" }
    expect((await ask("chan2-q1", "/Alook#5620/other", "Chan2 Q1", ["@gus#1813"])).status).toBe(200)
    expect((await ask("chan2-q2", "/Alook#5620/other", "Chan2 Q2", ["@gus#1813"])).status).toBe(200)
    const [c2q1, c2q2] = fixture.sqlite
      .prepare("SELECT id FROM community_message WHERE channel_id = 'chan_2' AND type = 'question' ORDER BY seq ASC")
      .all() as Array<{ id: string }>

    currentActor = { kind: "human", userId: "u_gus" }
    expect((await POST(
      new NextRequest("http://localhost/api/community/channels/chan_2/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Chan2 Q1: Yes", replyToId: c2q1!.id, nonce: "c2-a1", preserveReadState: true }),
      }),
      { params: Promise.resolve({ id: "chan_2" }) },
    )).status).toBe(201)
    expect(
      fixture.sqlite.prepare("SELECT last_read_seq FROM community_read_state WHERE channel_id = 'chan_2' AND user_id = 'u_gus'").get(),
    ).toBeUndefined()

    expect((await POST(
      new NextRequest("http://localhost/api/community/channels/chan_2/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Chan2 Q2: No", replyToId: c2q2!.id, nonce: "c2-a2", preserveReadState: true }),
      }),
      { params: Promise.resolve({ id: "chan_2" }) },
    )).status).toBe(201)
    const chan2Read = fixture.sqlite
      .prepare("SELECT last_read_seq FROM community_read_state WHERE channel_id = 'chan_2' AND user_id = 'u_gus'")
      .get() as { last_read_seq: number } | undefined
    expect(chan2Read?.last_read_seq).toBe(4)

    const afterChan2 = await queries.communityAttention.getAccountAttentionProjection(fixture.db as Database, "u_gus")
    expect(afterChan2.scopes.some((scope) => scope.channelId === "chan_2")).toBe(false)

    // Option 2: reading thread_1 clears Unreads for thread_1, but unassigned/unanswered q2 (assigned to u_gus)
    // stays in Todo until answered or dismissed! Unassigned channel questions stay excluded.
    fixture.sqlite.prepare(
      "INSERT OR REPLACE INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq) VALUES ('rs_t1', 'u_gus', 'thread_1', '2026-11-21T00:00:00.000Z', ?, 99)",
    ).run(q2!.id)
    fixture.sqlite.prepare(
      "UPDATE community_mention SET read = 1 WHERE user_id = 'u_gus' AND message_id = ?",
    ).run(q2!.id)
    const afterReadThread = await queries.communityAttention.getAccountAttentionProjection(fixture.db as Database, "u_gus")
    expect(afterReadThread.scopes.some((scope) => scope.channelId === "thread_1")).toBe(false)
    expect(afterReadThread.items.filter((item) => item.kind === "question").map((item) => item.messageId)).toEqual([q2!.id])

    // Dismissing q2 removes it from Todo immediately and idempotently.
    const dismissed = await queries.communityInbox.dismissQuestionTodoWithRevision(fixture.db as Database, "u_gus", q2!.id)
    expect(dismissed.changed).toBe(true)
    const dismissedAgain = await queries.communityInbox.dismissQuestionTodoWithRevision(fixture.db as Database, "u_gus", q2!.id)
    expect(dismissedAgain.changed).toBe(false)
    const afterDismiss = await queries.communityAttention.getAccountAttentionProjection(fixture.db as Database, "u_gus")
    expect(afterDismiss.items.filter((item) => item.kind === "question")).toEqual([])

    // Cecilia #275: Todo submit (preserveReadState: true) targeting a missing/deleted or non-question message returns 404 and writes nothing.
    currentActor = { kind: "human", userId: "u_gus" }
    currentTarget = { kind: "channel", channelId: "chan_1", serverId: "srv_1" }
    const countBefore = (fixture.sqlite.prepare("SELECT COUNT(*) as c FROM community_message WHERE channel_id = 'chan_1'").get() as { c: number }).c
    for (const replyToId of ["missing_msg_id", "m_root", undefined]) {
      const badRes = await POST(
        new NextRequest("http://localhost/api/community/channels/chan_1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: "Orphan answer",
            ...(replyToId ? { replyToId } : {}),
            nonce: `bad-${replyToId ?? "none"}`,
            preserveReadState: true,
          }),
        }),
        { params: Promise.resolve({ id: "chan_1" }) },
      )
      expect(badRes.status).toBe(404)
    }
    const countAfter = (fixture.sqlite.prepare("SELECT COUNT(*) as c FROM community_message WHERE channel_id = 'chan_1'").get() as { c: number }).c
    expect(countAfter).toBe(countBefore)
  })
})

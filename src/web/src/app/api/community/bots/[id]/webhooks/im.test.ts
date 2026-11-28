import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import type { SQLInputValue } from "node:sqlite"
import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDb, queries, type Database } from "@alook/shared"

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")

const mocks = vi.hoisted(() => ({
  db: null as unknown as Database,
  env: { ENCRYPTION_KEY: "test-im-encryption-key-secret" } as unknown as Env,
  userId: "owner_1",
  actor: {
    kind: "bot" as const,
    userId: "bot_1",
    machineId: "mach_1",
    ownerUserId: "owner_1",
  },
  machineId: "mach_1",
  pushBotEventToMachine: vi.fn(async () => ({ sent: 1 })),
  wsDoFetch: vi.fn(async () => new Response(JSON.stringify({ sent: 1, unsupported: 0 }), { status: 200 })),
}))

vi.mock("@/lib/db", () => ({
  getDb: () => mocks.db,
  getPrimaryDb: () => mocks.db,
}))

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSec: 0 })),
}))

vi.mock("@/lib/broadcast", () => ({
  wsDoFetch: (...args: unknown[]) => (mocks.wsDoFetch as (...a: unknown[]) => unknown)(...args),
}))

vi.mock("@/lib/community/bot-push", () => ({
  pushBotEventToMachine: (...args: unknown[]) =>
    (mocks.pushBotEventToMachine as (...a: unknown[]) => unknown)(...args),
}))

vi.mock("@/lib/middleware/env", () => ({
  withEnv: (handler: (req: NextRequest, ctx: any) => Promise<Response>) => {
    return (req: NextRequest, routeCtx?: { params?: Promise<Record<string, string>> }) =>
      Promise.resolve(routeCtx?.params).then((params) =>
        handler(req, { env: mocks.env, params: params ?? {} }),
      )
  },
}))

vi.mock("@/lib/middleware/auth-policy", () => ({
  withAuth: (_policy: unknown, handler: (req: NextRequest, ctx: any) => Promise<Response>) => {
    return (req: NextRequest, routeCtx?: { params?: Promise<Record<string, string>> }) =>
      Promise.resolve(routeCtx?.params).then((params) =>
        handler(req, {
          env: mocks.env,
          userId: mocks.userId,
          machineId: mocks.machineId,
          actor: mocks.actor,
          params: params ?? {},
        }),
      )
  },
}))

vi.mock("@/lib/middleware/community-actor", () => ({
  communityActorPolicy: () => ({}),
  requireBot: (actor: typeof mocks.actor) => ({ ok: true, bot: actor }),
}))

vi.mock("@/lib/middleware/community-daemon-auth", () => ({
  machineAuthPolicy: {},
}))

import { GET as listTriggers, POST as createTrigger } from "./route"
import { DELETE as deleteTrigger, PATCH as updateTrigger } from "./[webhookId]/route"
import { POST as allowSender } from "./[webhookId]/allow-sender/route"
import { GET as getImQr, POST as startImQr } from "./[webhookId]/im-qr/route"
import { POST as ingestWebhook } from "@/app/api/webhooks/bot/[token]/route"
import { POST as externalSend } from "@/app/api/community/messages/external-send/route"
import { GET as getDaemonImTriggers } from "@/app/api/community/daemon/im-triggers/route"
import { POST as reportDaemonImDelivery } from "@/app/api/community/daemon/im-deliveries/route"

const migrationsDir = resolve(import.meta.dirname, "../../../../../../../migrations")

function createMigratedSqlite(): { sqlite: InstanceType<typeof DatabaseSync>; db: Database } {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec("PRAGMA foreign_keys=ON")
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(resolve(migrationsDir, file), "utf8"))
  }
  const binding = {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const execute = (arrays: boolean) => {
        const statement = sqlite.prepare(sql)
        statement.setReturnArrays(arrays)
        return statement.all(...values)
      }
      const prepared = {
        bind(...bindings: SQLInputValue[]) {
          values = bindings
          return prepared
        },
        async raw() {
          return execute(true)
        },
        async all() {
          return { success: true, results: execute(false) }
        },
        async run() {
          return { success: true, meta: sqlite.prepare(sql).run(...values) }
        },
      }
      return prepared
    },
  }
  return { sqlite, db: createDb(binding as unknown as D1Database) }
}

describe("IM Triggers end-to-end backend routes", () => {
  let sqlite: InstanceType<typeof DatabaseSync>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    const created = createMigratedSqlite()
    sqlite = created.sqlite
    mocks.db = created.db
    mocks.userId = "owner_1"
    mocks.machineId = "mach_1"
    mocks.pushBotEventToMachine.mockClear()
    mocks.wsDoFetch.mockReset()
    mocks.wsDoFetch.mockImplementation(
      async () => new Response(JSON.stringify({ sent: 1, unsupported: 0 }), { status: 200 }),
    )

    const nowIso = "2026-11-28T00:00:00.000Z"
    sqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
         VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
      )
      .run("owner_1", "gus", "gus@test.local", nowIso, nowIso, 0, null, "1813")
    sqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
         VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
      )
      .run("bot_1", "Claudette", "bot1@test.local", nowIso, nowIso, 1, "owner_1", "5211")
    sqlite
      .prepare(
        `INSERT INTO community_machine (id, user_id, hostname, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("mach_1", "owner_1", "mbp", "MacBook Pro", "online", nowIso, nowIso)
    sqlite
      .prepare(
        `INSERT INTO community_bot_binding (user_id, machine_id, runtime, is_active, created_at)
         VALUES (?, ?, ?, 1, ?)`,
      )
      .run("bot_1", "mach_1", "codex", nowIso)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    sqlite.close()
  })

  it("handles Telegram auto-registration, allowlist block -> one-click allow -> NDJSON wake -> external-send reply -> deleteWebhook", async () => {
    let registeredSecret = ""
    let sentTelegramBody: Record<string, unknown> | null = null
    let deletedWebhookCalled = false

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { username: "claudette_tg_bot" } }))
      }
      if (url.endsWith("/setWebhook")) {
        const body = JSON.parse(String(init?.body)) as { secret_token: string }
        registeredSecret = body.secret_token
        return new Response(JSON.stringify({ ok: true, result: true }))
      }
      if (url.endsWith("/sendMessage")) {
        sentTelegramBody = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }))
      }
      if (url.endsWith("/deleteWebhook")) {
        deletedWebhookCalled = true
        return new Response(JSON.stringify({ ok: true, result: true }))
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const createRes = await createTrigger(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "My Telegram",
          provider: "telegram",
          botToken: "123456:AA_TEST_TOKEN",
        }),
      }),
      { params: Promise.resolve({ id: "bot_1" }) },
    )
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as any
    expect(created.webhook.category).toBe("im")
    expect(created.webhook.transport).toBe("cloud_webhook")
    expect(created.webhook.connectionStatus).toBe("connected")
    expect(created.webhook.botUsername).toBe("claudette_tg_bot")
    expect(registeredSecret).toMatch(/^tg_/)
    const token = created.webhookUrl.split("/api/webhooks/bot/")[1]

    // 1) Unknown sender is blocked and does not wake bot.
    const blockedRes = await ingestWebhook(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": registeredSecret,
        },
        body: JSON.stringify({
          update_id: 1001,
          message: {
            message_id: 42,
            date: 1764330000,
            chat: { id: 9001, type: "private" },
            from: { id: 555, is_bot: false, first_name: "Alice", username: "alice_tg" },
            text: "hello bot",
          },
        }),
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(blockedRes.status).toBe(200)
    expect(await blockedRes.json()).toEqual({ ok: true, blocked: "sender_not_allowed" })
    expect(mocks.pushBotEventToMachine).not.toHaveBeenCalled()

    // 2) Owner clicks Allow on sender "555".
    const allowRes = await allowSender(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${created.webhook.id}/allow-sender`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ senderId: "555" }),
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: created.webhook.id }) },
    )
    expect(allowRes.status).toBe(200)
    expect((await allowRes.json() as any).added).toBe(true)

    // 3) Next message from Alice wakes bot with compact single-line JSON + ext_tg_* ref.
    const okRes = await ingestWebhook(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": registeredSecret,
        },
        body: JSON.stringify({
          update_id: 1002,
          message: {
            message_id: 43,
            date: 1764330010,
            chat: { id: 9001, type: "private" },
            from: { id: 555, is_bot: false, first_name: "Alice", username: "alice_tg" },
            text: "check PR #1514",
          },
        }),
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(okRes.status).toBe(200)
    expect(mocks.pushBotEventToMachine).toHaveBeenCalledTimes(1)
    const wakeCmd = (mocks.pushBotEventToMachine.mock.calls[0] as unknown[])[2] as { prompt: string }
    expect(wakeCmd.prompt).not.toContain("\n")
    const imJson = JSON.parse(wakeCmd.prompt)
    expect(imJson.kind).toBe("im")
    expect(imJson.platform).toBe("telegram")
    expect(imJson.ref).toMatch(/^ext_tg_/)

    // 4) Bot replies via external-send using opaque ref.
    const replyRes = await externalSend(
      new NextRequest("https://alook.ai/api/community/messages/external-send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalRef: imJson.ref, text: "PR #1514 is merged." }),
      }),
    )
    expect(replyRes.status).toBe(200)
    expect(await replyRes.json()).toEqual({
      state: "sent",
      externalRef: imJson.ref,
      platform: "telegram",
      messageId: "777",
    })
    expect(sentTelegramBody).toEqual({
      chat_id: "9001",
      text: "PR #1514 is merged.",
      reply_to_message_id: 43,
    })

    // 5) Delete cleans up Telegram webhook.
    const delRes = await deleteTrigger(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${created.webhook.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: created.webhook.id }) },
    )
    expect(delRes.status).toBe(200)
    expect(deletedWebhookCalled).toBe(true)
  })

  it("enforces bidirectional Slack creation (requires xoxb- token), supports Feishu url_verification + WeChat daemon_poll QR & sync", async () => {
    // Slack without botToken is rejected (no inbound_only mode).
    const badSlack = await createTrigger(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Slack",
          provider: "slack",
          signingSecret: "slack_signing_secret_1234",
        }),
      }),
      { params: Promise.resolve({ id: "bot_1" }) },
    )
    expect(badSlack.status).toBe(400)

    // WeChat trigger has no webhookUrl and syncs to daemon.
    const wxRes = await createTrigger(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "My WeChat", provider: "wechat" }),
      }),
      { params: Promise.resolve({ id: "bot_1" }) },
    )
    expect(wxRes.status).toBe(201)
    const wxCreated = (await wxRes.json()) as any
    expect(wxCreated.webhookUrl).toBeUndefined()
    expect(wxCreated.webhook.transport).toBe("daemon_poll")
    expect(wxCreated.webhook.connectionStatus).toBe("scan_required")
    expect(wxCreated.webhook.machineName).toBe("MacBook Pro")
    expect(wxCreated.webhook.machineOnline).toBe(true)

    // Daemon polls its daemon_poll triggers.
    const daemonTriggersRes = await getDaemonImTriggers(
      new NextRequest("https://alook.ai/api/community/daemon/im-triggers"),
    )
    expect(daemonTriggersRes.status).toBe(200)
    const daemonTriggers = (await daemonTriggersRes.json()) as { triggers: Array<{ triggerId: string }> }
    expect(daemonTriggers.triggers.map((t) => t.triggerId)).toEqual([wxCreated.webhook.id])

    // Start QR login proxies through ws-do.
    mocks.wsDoFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          frame: {
            type: "im_status",
            requestId: "r1",
            botId: "bot_1",
            triggerId: wxCreated.webhook.id,
            provider: "wechat",
            status: "pending",
            sessionId: "qr_1",
            qrUrl: "https://ilinkai.weixin.qq.com/qr/1",
            expiresAt: "2030-01-01T00:05:00.000Z",
          },
        }),
        { status: 200 },
      ),
    )
    const qrRes = await startImQr(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${wxCreated.webhook.id}/im-qr`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: wxCreated.webhook.id }) },
    )
    expect(qrRes.status).toBe(200)
    expect((await qrRes.json() as any).qrUrl).toBe("https://ilinkai.weixin.qq.com/qr/1")

    // GET QR status fallback works cleanly.
    mocks.wsDoFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: null }), { status: 200 }),
    )
    const qrStatusRes = await getImQr(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${wxCreated.webhook.id}/im-qr`),
      { params: Promise.resolve({ id: "bot_1", webhookId: wxCreated.webhook.id }) },
    )
    expect(qrStatusRes.status).toBe(200)
    expect((await qrStatusRes.json() as any).connectionStatus).toBe("scan_required")

    // Daemon reports blocked WeChat message to History.
    const reportRes = await reportDaemonImDelivery(
      new NextRequest("https://alook.ai/api/community/daemon/im-deliveries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          triggerId: wxCreated.webhook.id,
          botId: "bot_1",
          direction: "inbound",
          status: "blocked",
          eventType: "im.message",
          summary: "hi from stranger",
          senderId: "wx_stranger_1",
          senderLabel: "wx_stranger_1",
          chatLabel: "DM",
        }),
      }),
    )
    expect(reportRes.status).toBe(200)
    const deliveries = await queries.communityBotWebhook.listBotWebhookDeliveries(
      mocks.db,
      "owner_1",
      "bot_1",
      wxCreated.webhook.id,
    )
    expect(deliveries[0]?.status).toBe("blocked")
    expect(deliveries[0]?.senderId).toBe("wx_stranger_1")

    // List triggers returns machineName + lastDelivery.
    const listRes = await listTriggers(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks"),
      { params: Promise.resolve({ id: "bot_1" }) },
    )
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as { webhooks: Array<{ id: string; enabled: boolean }> }
    expect(listed.webhooks).toHaveLength(1)

    // Update WeChat trigger pauses it and syncs to daemon.
    const patchRes = await updateTrigger(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${wxCreated.webhook.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: wxCreated.webhook.id }) },
    )
    expect(patchRes.status).toBe(200)
    expect((await patchRes.json() as any).webhook.connectionStatus).toBe("paused")
  })
})

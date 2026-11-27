import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import type { SQLInputValue } from "node:sqlite"
import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  BotWebhookCreateResponseSchema,
  BotWebhookDeliveriesResponseSchema,
  BotWebhookListResponseSchema,
  BotWebhookTestResponseSchema,
  BotWebhookUpdateResponseSchema,
  createDb,
  type Database,
} from "@alook/shared"

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")

const mocks = vi.hoisted(() => ({
  db: null as unknown as Database,
  userId: "owner_1",
  env: {
    DB: {},
    BETTER_AUTH_SECRET: "mgmt-webhook-master-secret-32-bytes",
  } as unknown as Env,
  pushBotEventToMachine: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  getPrimaryDb: vi.fn(() => mocks.db),
  getDb: vi.fn(() => mocks.db),
}))

vi.mock("@/lib/middleware/auth", () => ({
  humanAuthPolicy: {
    resolve: async () => ({
      context: { env: mocks.env, userId: mocks.userId },
    }),
  },
}))

vi.mock("@/lib/community/bot-push", () => ({
  pushBotEventToMachine: (...args: unknown[]) => mocks.pushBotEventToMachine(...args),
}))

import { GET as listWebhooks, POST as createWebhook } from "./route"
import { PATCH as patchWebhook, DELETE as deleteWebhook } from "./[webhookId]/route"
import { GET as listDeliveries } from "./[webhookId]/deliveries/route"
import { POST as testWebhook } from "./[webhookId]/test/route"

const migrationsDir = resolve(import.meta.dirname, "../../../../../../../migrations")

function createMigratedSqlite(): { sqlite: InstanceType<typeof DatabaseSync>; db: Database } {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec("PRAGMA foreign_keys=ON")
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
  for (const file of files) {
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

describe("bot webhooks management API", () => {
  let sqlite: InstanceType<typeof DatabaseSync>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.userId = "owner_1"
    const created = createMigratedSqlite()
    sqlite = created.sqlite
    mocks.db = created.db
    mocks.pushBotEventToMachine.mockResolvedValue({ sent: 1 })

    const nowIso = "2026-11-27T00:00:00.000Z"
    sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run("owner_1", "gus", "gus@test.local", nowIso, nowIso, 0, null, "1813")
    sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run("owner_2", "other", "other@test.local", nowIso, nowIso, 0, null, "9999")
    sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run("bot_1", "Claudette", "bot1@test.local", nowIso, nowIso, 1, "owner_1", "5211")
    sqlite.prepare(
      `INSERT INTO community_machine (id, user_id, display_name, hostname, platform, arch, available_runtimes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("mach_1", "owner_1", "MacBook", "macbook", "darwin", "arm64", "[]", "online", nowIso, nowIso)
    sqlite.prepare(
      `INSERT INTO community_bot_binding (user_id, machine_id, runtime, model_name, is_active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run("bot_1", "mach_1", "claude-code", "claude-sonnet-4-6", nowIso)
  })

  afterEach(() => sqlite.close())

  it("supports create, list with lastDelivery, test, rotateCredentials, requireSecret, cross-owner isolation, and delete", async () => {
    const createRes = await createWebhook(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Alook GitHub CI",
          provider: "github",
          instruction: "Check failed workflows",
        }),
      }),
      { params: Promise.resolve({ id: "bot_1" }) } as any,
    )
    expect(createRes.status).toBe(201)
    expect(createRes.headers.get("cache-control")).toBe("no-store")
    const created = BotWebhookCreateResponseSchema.parse(await createRes.json())
    expect(created.webhook.provider).toBe("github")
    expect(created.webhook.hasSigningSecret).toBe(true)
    expect(created.webhookUrl).toMatch(/^https:\/\/alook\.ai\/api\/webhooks\/bot\/bwh_/)
    expect(created.signingSecret).toMatch(/^whsec_/)
    expect(created.webhook.eventFilter).toBeNull()

    const testRes = await testWebhook(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${created.webhook.id}/test`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: created.webhook.id }) } as any,
    )
    expect(testRes.status).toBe(200)
    const testBody = BotWebhookTestResponseSchema.parse(await testRes.json())
    expect(testBody.delivery.status).toBe("dispatched")
    expect(testBody.delivery.eventType).toBe("test")
    expect(mocks.pushBotEventToMachine).toHaveBeenCalledTimes(1)

    const listRes = await listWebhooks(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks"),
      { params: Promise.resolve({ id: "bot_1" }) } as any,
    )
    expect(listRes.status).toBe(200)
    const listed = BotWebhookListResponseSchema.parse(await listRes.json())
    expect(listed.webhooks).toHaveLength(1)
    expect(listed.webhooks[0]?.lastDelivery?.id).toBe(testBody.delivery.id)
    expect(listed.webhooks[0]?.lastDelivery?.status).toBe("dispatched")

    const deliveriesRes = await listDeliveries(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${created.webhook.id}/deliveries`),
      { params: Promise.resolve({ id: "bot_1", webhookId: created.webhook.id }) } as any,
    )
    expect(deliveriesRes.status).toBe(200)
    const deliveriesBody = BotWebhookDeliveriesResponseSchema.parse(await deliveriesRes.json())
    expect(deliveriesBody.deliveries).toHaveLength(1)

    const rotateRes = await patchWebhook(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${created.webhook.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rotateCredentials: true, enabled: false }),
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: created.webhook.id }) } as any,
    )
    expect(rotateRes.status).toBe(200)
    expect(rotateRes.headers.get("cache-control")).toBe("no-store")
    const rotated = BotWebhookUpdateResponseSchema.parse(await rotateRes.json())
    expect(rotated.webhook.enabled).toBe(false)
    expect(rotated.webhookUrl).not.toBe(created.webhookUrl)
    expect(rotated.signingSecret).not.toBe(created.signingSecret)

    const genericRes = await createWebhook(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Generic Hook",
          provider: "generic",
          requireSecret: false,
        }),
      }),
      { params: Promise.resolve({ id: "bot_1" }) } as any,
    )
    expect(genericRes.status).toBe(201)
    const genericCreated = BotWebhookCreateResponseSchema.parse(await genericRes.json())
    expect(genericCreated.webhook.hasSigningSecret).toBe(false)
    expect(genericCreated.signingSecret).toBeNull()

    const enableSecretRes = await patchWebhook(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${genericCreated.webhook.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requireSecret: true }),
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: genericCreated.webhook.id }) } as any,
    )
    expect(enableSecretRes.status).toBe(200)
    const enabledSecret = BotWebhookUpdateResponseSchema.parse(await enableSecretRes.json())
    expect(enabledSecret.webhook.hasSigningSecret).toBe(true)
    expect(enabledSecret.signingSecret).toMatch(/^whsec_/)

    mocks.userId = "owner_2"
    const foreignList = await listWebhooks(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks"),
      { params: Promise.resolve({ id: "bot_1" }) } as any,
    )
    expect(foreignList.status).toBe(404)

    const foreignDelete = await deleteWebhook(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${created.webhook.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: created.webhook.id }) } as any,
    )
    expect(foreignDelete.status).toBe(404)

    mocks.userId = "owner_1"
    const delRes = await deleteWebhook(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${created.webhook.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: created.webhook.id }) } as any,
    )
    expect(delRes.status).toBe(200)
    expect(await delRes.json()).toEqual({ deleted: true })
  })

  it("supports external-secret providers (create URL first, paste signingSecret via PATCH, rotate URL without wiping secret)", async () => {
    const createRes = await createWebhook(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Stripe Billing",
          provider: "stripe",
        }),
      }),
      { params: Promise.resolve({ id: "bot_1" }) } as any,
    )
    expect(createRes.status).toBe(201)
    const created = BotWebhookCreateResponseSchema.parse(await createRes.json())
    expect(created.webhook.provider).toBe("stripe")
    expect(created.webhook.hasSigningSecret).toBe(false)
    expect(created.signingSecret).toBeNull()

    const saveSecretRes = await patchWebhook(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${created.webhook.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signingSecret: "whsec_stripe_live_1234567890" }),
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: created.webhook.id }) } as any,
    )
    expect(saveSecretRes.status).toBe(200)
    const saved = BotWebhookUpdateResponseSchema.parse(await saveSecretRes.json())
    expect(saved.webhook.hasSigningSecret).toBe(true)
    expect(saved.signingSecret).toBeUndefined()

    const rotateUrlRes = await patchWebhook(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${created.webhook.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rotateCredentials: true }),
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: created.webhook.id }) } as any,
    )
    expect(rotateUrlRes.status).toBe(200)
    const rotated = BotWebhookUpdateResponseSchema.parse(await rotateUrlRes.json())
    expect(rotated.webhookUrl).not.toBe(created.webhookUrl)
    expect(rotated.webhook.hasSigningSecret).toBe(true)
    expect(rotated.signingSecret).toBeNull()

    // Enforce secret-mode policy boundaries
    const rejectNoSecretStripe = await createWebhook(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bad Stripe", provider: "stripe", requireSecret: false }),
      }),
      { params: Promise.resolve({ id: "bot_1" }) } as any,
    )
    expect(rejectNoSecretStripe.status).toBe(400)

    const rejectCustomSecretGitHub = await createWebhook(
      new NextRequest("https://alook.ai/api/community/bots/bot_1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bad GitHub", provider: "github", signingSecret: "custom_secret_12345" }),
      }),
      { params: Promise.resolve({ id: "bot_1" }) } as any,
    )
    expect(rejectCustomSecretGitHub.status).toBe(400)

    const rejectDisableSecretStripe = await patchWebhook(
      new NextRequest(`https://alook.ai/api/community/bots/bot_1/webhooks/${created.webhook.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requireSecret: false }),
      }),
      { params: Promise.resolve({ id: "bot_1", webhookId: created.webhook.id }) } as any,
    )
    expect(rejectDisableSecretStripe.status).toBe(400)
  })
})

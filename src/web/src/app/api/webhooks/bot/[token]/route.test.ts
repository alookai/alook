import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import type { SQLInputValue } from "node:sqlite"
import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  BOT_WEBHOOK_MAX_BODY_BYTES,
  createDb,
  queries,
  type Database,
} from "@alook/shared"

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")

const mocks = vi.hoisted(() => ({
  db: null as unknown as Database,
  env: {
    DB: {},
    BETTER_AUTH_SECRET: "test-webhook-master-secret-32-bytes",
  } as unknown as Env,
  pushBotEventToMachine: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: mocks.env })),
}))

vi.mock("@/lib/db", () => ({
  getPrimaryDb: vi.fn(() => mocks.db),
  getDb: vi.fn(() => mocks.db),
}))

vi.mock("@/lib/community/bot-push", () => ({
  pushBotEventToMachine: (...args: unknown[]) => mocks.pushBotEventToMachine(...args),
}))

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
}))

import { POST } from "./route"
import {
  encryptBotWebhookSecret,
  hashBotWebhookToken,
  newBotWebhookSigningSecret,
  newBotWebhookToken,
  resyncSystemPrivateInboxForBots,
} from "@/lib/community/bot-webhook.server"

const migrationsDir = resolve(import.meta.dirname, "../../../../../../migrations")

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

async function signGitHub(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
  return `sha256=${Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

describe("POST /api/webhooks/bot/[token]", () => {
  let sqlite: InstanceType<typeof DatabaseSync>

  beforeEach(() => {
    vi.clearAllMocks()
    const created = createMigratedSqlite()
    sqlite = created.sqlite
    mocks.db = created.db
    mocks.checkRateLimit.mockResolvedValue({ allowed: true })
    mocks.pushBotEventToMachine.mockResolvedValue({ sent: 1 })

    const nowIso = "2026-11-27T00:00:00.000Z"
    sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run("owner_1", "gus", "gus@test.local", nowIso, nowIso, 0, null, "1813")
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

  it("verifies GitHub HMAC, ignores ping/filtered events, deduplicates deliveries, and wakes only the bound bot", async () => {
    const token = newBotWebhookToken()
    const secret = newBotWebhookSigningSecret()
    const created = await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Alook CI",
      provider: "github",
      tokenHash: await hashBotWebhookToken(token),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, secret),
      eventFilter: ["workflow_run", "pull_request"],
      instruction: "Fix CI failures on our PR",
    })
    expect(created.ok).toBe(true)

    const workflowPayload = JSON.stringify({
      action: "completed",
      repository: { full_name: "alookai/alook" },
      sender: { login: "gus" },
      workflow_run: {
        id: 555,
        run_attempt: 1,
        name: "CI Gate",
        status: "completed",
        conclusion: "failure",
        head_branch: "feat/bot-webhooks",
        head_sha: "abcdef1234567890",
        html_url: "https://github.com/alookai/alook/actions/runs/555",
        pull_requests: [{ number: 1495 }],
      },
    })

    const badSigRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "workflow_run",
          "x-github-delivery": "deliv-1",
          "x-hub-signature-256": "sha256=" + "00".repeat(32),
        },
        body: workflowPayload,
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(badSigRes.status).toBe(401)
    expect(mocks.pushBotEventToMachine).not.toHaveBeenCalled()

    const pingBody = JSON.stringify({ zen: "Keep it logically awesome.", repository: { full_name: "alookai/alook" } })
    const pingRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "ping",
          "x-github-delivery": "deliv-ping",
          "x-hub-signature-256": await signGitHub(pingBody, secret),
        },
        body: pingBody,
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(pingRes.status).toBe(200)
    expect(await pingRes.json()).toEqual({ ok: true, event: "ping" })
    expect(mocks.pushBotEventToMachine).not.toHaveBeenCalled()

    const pushBody = JSON.stringify({ ref: "refs/heads/main", commits: [] })
    const filteredRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-github-delivery": "deliv-push",
          "x-hub-signature-256": await signGitHub(pushBody, secret),
        },
        body: pushBody,
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(filteredRes.status).toBe(200)
    expect(await filteredRes.json()).toEqual({ ok: true, ignored: "event_filtered" })
    expect(mocks.pushBotEventToMachine).not.toHaveBeenCalled()

    const validSig = await signGitHub(workflowPayload, secret)
    const okRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "workflow_run",
          "x-github-delivery": "deliv-1",
          "x-hub-signature-256": validSig,
        },
        body: workflowPayload,
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(okRes.status).toBe(200)
    expect(await okRes.json()).toMatchObject({ ok: true, delivered: true })
    expect(mocks.pushBotEventToMachine).toHaveBeenCalledTimes(1)
    expect(mocks.pushBotEventToMachine).toHaveBeenCalledWith(
      mocks.env,
      "mach_1",
      expect.objectContaining({
        type: "agent:event",
        agentId: "bot_1",
        prompt: expect.stringContaining("CI Gate"),
      }),
    )

    const dupRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "workflow_run",
          "x-github-delivery": "deliv-1",
          "x-hub-signature-256": validSig,
        },
        body: workflowPayload,
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(dupRes.status).toBe(200)
    expect(await dupRes.json()).toMatchObject({ ok: true, duplicate: true })
    expect(mocks.pushBotEventToMachine).toHaveBeenCalledTimes(1)

    const formBody = `payload=${encodeURIComponent(workflowPayload)}`
    const formRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-github-event": "workflow_run",
          "x-github-delivery": "deliv-form-2",
          "x-hub-signature-256": await signGitHub(formBody, secret),
        },
        body: formBody,
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(formRes.status).toBe(200)
    expect(mocks.pushBotEventToMachine).toHaveBeenCalledTimes(2)
  })

  it("handles generic webhooks (with secret, offline queue + resync catch-up, disabled, rate-limit, and body cap)", async () => {
    const token = newBotWebhookToken()
    const secret = newBotWebhookSigningSecret()
    const created = await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Deploy Alerts",
      provider: "generic",
      tokenHash: await hashBotWebhookToken(token),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, secret),
      eventFilter: null,
      instruction: "",
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const unauth = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "deploy.failed", summary: "Prod error" }),
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(unauth.status).toBe(401)

    mocks.pushBotEventToMachine.mockResolvedValueOnce({ sent: 0 })
    const queued = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": secret,
          "idempotency-key": "gen-1",
        },
        body: JSON.stringify({ event: "deploy.failed", summary: "Prod error" }),
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(queued.status).toBe(202)
    expect(await queued.json()).toMatchObject({ ok: true, queued: true })

    mocks.pushBotEventToMachine.mockResolvedValueOnce({ sent: 1 })
    const resync = await resyncSystemPrivateInboxForBots(mocks.db, mocks.env, "owner_1", ["bot_1"])
    expect(resync.dispatched).toBe(1)

    const deliveries = await queries.communityBotWebhook.listBotWebhookDeliveries(
      mocks.db,
      "owner_1",
      "bot_1",
      created.webhook.id,
      10,
    )
    expect(deliveries[0]?.status).toBe("dispatched")

    await queries.communityBotWebhook.updateBotWebhook(mocks.db, "owner_1", "bot_1", created.webhook.id, {
      enabled: false,
    })
    const disabledRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: { "x-webhook-secret": secret },
        body: "ignored",
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(disabledRes.status).toBe(200)
    expect(await disabledRes.json()).toEqual({ ok: true, ignored: "disabled" })

    const oversized = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        headers: { "x-webhook-secret": secret },
        body: "a".repeat(BOT_WEBHOOK_MAX_BODY_BYTES + 1),
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(oversized.status).toBe(413)

    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSec: 42 })
    const limited = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${token}`, {
        method: "POST",
        body: "hi",
      }),
      { params: Promise.resolve({ token }) },
    )
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("42")

    const notFound = await POST(
      new NextRequest("https://alook.ai/api/webhooks/bot/bwh_unknown_token_1234567890", {
        method: "POST",
        body: "hi",
      }),
      { params: Promise.resolve({ token: "bwh_unknown_token_1234567890" }) },
    )
    expect(notFound.status).toBe(404)
  })
})

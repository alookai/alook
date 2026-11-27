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

  it("verifies Linear, Sentry, Stripe, Vercel, GitLab, Slack (incl. url_verification), OpenAI (Standard Webhooks), and Cloudflare adapters", async () => {
    async function hmacHex(secret: string, data: string, hash: "SHA-256" | "SHA-1" = "SHA-256"): Promise<string> {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash }, false, ["sign"])
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))
      return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")
    }

    const nowSec = Math.floor(Date.now() / 1000)

    // 1. Fail-closed when external signing secret is not configured yet
    const unconfiguredToken = newBotWebhookToken()
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Unconfigured Stripe",
      provider: "stripe",
      tokenHash: await hashBotWebhookToken(unconfiguredToken),
      signingSecretEnc: null,
      eventFilter: null,
      instruction: "",
    })
    const unconfiguredRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${unconfiguredToken}`, { method: "POST", body: "{}" }),
      { params: Promise.resolve({ token: unconfiguredToken }) },
    )
    expect(unconfiguredRes.status).toBe(503)

    // 2. Stripe
    const stripeToken = newBotWebhookToken()
    const stripeSecret = "whsec_stripe_test_secret"
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Stripe",
      provider: "stripe",
      tokenHash: await hashBotWebhookToken(stripeToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, stripeSecret),
      eventFilter: null,
      instruction: "",
    })
    const stripeBody = JSON.stringify({
      id: "evt_stripe_1",
      type: "invoice.payment_failed",
      data: { object: { id: "in_1", amount_due: 2500, currency: "usd", status: "open" } },
    })
    const stripeSig = await hmacHex(stripeSecret, `${nowSec}.${stripeBody}`)
    const stripeRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${stripeToken}`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": `t=${nowSec},v1=${stripeSig}` },
        body: stripeBody,
      }),
      { params: Promise.resolve({ token: stripeToken }) },
    )
    expect(stripeRes.status).toBe(200)

    // 3. Linear
    const linearToken = newBotWebhookToken()
    const linearSecret = "lin_wh_secret_123456"
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Linear",
      provider: "linear",
      tokenHash: await hashBotWebhookToken(linearToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, linearSecret),
      eventFilter: null,
      instruction: "",
    })
    const linearBody = JSON.stringify({ type: "Issue", action: "create", data: { identifier: "ENG-9", title: "Bug" } })
    const linearRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${linearToken}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": await hmacHex(linearSecret, linearBody),
          "linear-delivery": "lin-deliv-1",
        },
        body: linearBody,
      }),
      { params: Promise.resolve({ token: linearToken }) },
    )
    expect(linearRes.status).toBe(200)

    // 4. Sentry
    const sentryToken = newBotWebhookToken()
    const sentrySecret = "sentry_client_secret_123"
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Sentry",
      provider: "sentry",
      tokenHash: await hashBotWebhookToken(sentryToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, sentrySecret),
      eventFilter: null,
      instruction: "",
    })
    const sentryBody = JSON.stringify({ action: "created", data: { issue: { title: "ReferenceError" } } })
    const sentryRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${sentryToken}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sentry-hook-resource": "issue",
          "sentry-hook-signature": await hmacHex(sentrySecret, sentryBody),
          "request-id": "sentry-req-1",
        },
        body: sentryBody,
      }),
      { params: Promise.resolve({ token: sentryToken }) },
    )
    expect(sentryRes.status).toBe(200)

    // 5. Vercel (HMAC-SHA1)
    const vercelToken = newBotWebhookToken()
    const vercelSecret = "vercel_secret_123456"
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Vercel",
      provider: "vercel",
      tokenHash: await hashBotWebhookToken(vercelToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, vercelSecret),
      eventFilter: null,
      instruction: "",
    })
    const vercelBody = JSON.stringify({ id: "uev_1", type: "deployment.error", payload: { deployment: { name: "web" } } })
    const vercelRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${vercelToken}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vercel-signature": await hmacHex(vercelSecret, vercelBody, "SHA-1") },
        body: vercelBody,
      }),
      { params: Promise.resolve({ token: vercelToken }) },
    )
    expect(vercelRes.status).toBe(200)

    // 6. GitLab
    const gitlabToken = newBotWebhookToken()
    const gitlabSecret = "whsec_gitlab_secret_123"
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "GitLab",
      provider: "gitlab",
      tokenHash: await hashBotWebhookToken(gitlabToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, gitlabSecret),
      eventFilter: null,
      instruction: "",
    })
    const gitlabRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${gitlabToken}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gitlab-token": gitlabSecret, "x-gitlab-event-uuid": "gl-1" },
        body: JSON.stringify({ object_kind: "pipeline", object_attributes: { status: "failed", ref: "main" } }),
      }),
      { params: Promise.resolve({ token: gitlabToken }) },
    )
    expect(gitlabRes.status).toBe(200)

    // 7. Slack (url_verification + event_callback)
    const slackToken = newBotWebhookToken()
    const slackSecret = "slack_signing_secret_123"
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Slack",
      provider: "slack",
      tokenHash: await hashBotWebhookToken(slackToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, slackSecret),
      eventFilter: null,
      instruction: "",
    })
    const slackChallengeBody = JSON.stringify({ type: "url_verification", challenge: "chal_abc123" })
    const slackChallengeRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${slackToken}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": String(nowSec),
          "x-slack-signature": `v0=${await hmacHex(slackSecret, `v0:${nowSec}:${slackChallengeBody}`)}`,
        },
        body: slackChallengeBody,
      }),
      { params: Promise.resolve({ token: slackToken }) },
    )
    expect(slackChallengeRes.status).toBe(200)
    expect(await slackChallengeRes.json()).toEqual({ challenge: "chal_abc123" })

    const slackEventBody = JSON.stringify({
      type: "event_callback",
      event_id: "Ev_123",
      event: { type: "app_mention", channel: "C1", user: "U1", text: "hi bot" },
    })
    const slackEventRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${slackToken}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": String(nowSec),
          "x-slack-signature": `v0=${await hmacHex(slackSecret, `v0:${nowSec}:${slackEventBody}`)}`,
        },
        body: slackEventBody,
      }),
      { params: Promise.resolve({ token: slackToken }) },
    )
    expect(slackEventRes.status).toBe(200)

    // 8. OpenAI (Standard Webhooks protocol)
    const openaiToken = newBotWebhookToken()
    const rawKeyBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    const openaiSecret = `whsec_${Buffer.from(rawKeyBytes).toString("base64")}`
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "OpenAI",
      provider: "openai",
      tokenHash: await hashBotWebhookToken(openaiToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, openaiSecret),
      eventFilter: null,
      instruction: "",
    })
    const openaiBody = JSON.stringify({ type: "batch.completed", data: { id: "batch_9", status: "completed" } })
    const stdKey = await crypto.subtle.importKey("raw", rawKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    const stdSigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", stdKey, new TextEncoder().encode(`msg_1.${nowSec}.${openaiBody}`)))
    const openaiRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${openaiToken}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": "msg_1",
          "webhook-timestamp": String(nowSec),
          "webhook-signature": `v1,${Buffer.from(stdSigBytes).toString("base64")}`,
        },
        body: openaiBody,
      }),
      { params: Promise.resolve({ token: openaiToken }) },
    )
    expect(openaiRes.status).toBe(200)

    // 9. Cloudflare (cf-webhook-auth)
    const cfToken = newBotWebhookToken()
    const cfSecret = "cf_secret_123456"
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Cloudflare",
      provider: "cloudflare",
      tokenHash: await hashBotWebhookToken(cfToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, cfSecret),
      eventFilter: null,
      instruction: "",
    })
    const cfRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${cfToken}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-webhook-auth": cfSecret },
        body: JSON.stringify({ alert_type: "worker_error", text: "Worker error spike" }),
      }),
      { params: Promise.resolve({ token: cfToken }) },
    )
    expect(cfRes.status).toBe(200)

    // 7 real dispatches (Stripe, Linear, Sentry, Vercel, GitLab, Slack event, OpenAI, Cloudflare = 8; Slack challenge ignored)
    expect(mocks.pushBotEventToMachine).toHaveBeenCalledTimes(8)
  })

  it("rejects forged signatures, expired replays (>5m), unauthenticated Slack challenges, and supports rotated multi-signatures, Svix headers, and dedup", async () => {
    async function hmacHex(secret: string, data: string, hash: "SHA-256" | "SHA-1" = "SHA-256"): Promise<string> {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash }, false, ["sign"])
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))
      return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")
    }

    const nowSec = Math.floor(Date.now() / 1000)
    const staleSec = nowSec - 400

    // Stripe: stale replay (401), bad sig (401), rotated multi-v1 sig (200), duplicate evt_id (200 duplicate)
    const stripeToken = newBotWebhookToken()
    const stripeSecret = "whsec_stripe_qa_secret"
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Stripe QA",
      provider: "stripe",
      tokenHash: await hashBotWebhookToken(stripeToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, stripeSecret),
      eventFilter: null,
      instruction: "",
    })
    const stripeBody = JSON.stringify({ id: "evt_qa_1", type: "charge.succeeded", data: { object: { id: "ch_1" } } })
    const staleStripeSig = await hmacHex(stripeSecret, `${staleSec}.${stripeBody}`)
    expect(
      (
        await POST(
          new NextRequest(`https://alook.ai/api/webhooks/bot/${stripeToken}`, {
            method: "POST",
            headers: { "content-type": "application/json", "stripe-signature": `t=${staleSec},v1=${staleStripeSig}` },
            body: stripeBody,
          }),
          { params: Promise.resolve({ token: stripeToken }) },
        )
      ).status,
    ).toBe(401)

    const goodStripeSig = await hmacHex(stripeSecret, `${nowSec}.${stripeBody}`)
    const multiSigRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${stripeToken}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": `t=${nowSec},v1=${"aa".repeat(32)},v1=${goodStripeSig}`,
        },
        body: stripeBody,
      }),
      { params: Promise.resolve({ token: stripeToken }) },
    )
    expect(multiSigRes.status).toBe(200)
    expect(await multiSigRes.json()).toMatchObject({ ok: true, delivered: true })

    const dupStripeRes = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${stripeToken}`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": `t=${nowSec},v1=${goodStripeSig}` },
        body: stripeBody,
      }),
      { params: Promise.resolve({ token: stripeToken }) },
    )
    expect(dupStripeRes.status).toBe(200)
    expect(await dupStripeRes.json()).toMatchObject({ ok: true, duplicate: true })

    // Slack: unauthenticated url_verification MUST return 401 (never echo challenge); stale timestamp MUST return 401
    const slackToken = newBotWebhookToken()
    const slackSecret = "slack_qa_secret_123456"
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Slack QA",
      provider: "slack",
      tokenHash: await hashBotWebhookToken(slackToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, slackSecret),
      eventFilter: null,
      instruction: "",
    })
    const chalBody = JSON.stringify({ type: "url_verification", challenge: "should_not_echo" })
    const unauthSlack = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${slackToken}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": String(nowSec),
          "x-slack-signature": `v0=${"00".repeat(32)}`,
        },
        body: chalBody,
      }),
      { params: Promise.resolve({ token: slackToken }) },
    )
    expect(unauthSlack.status).toBe(401)

    const staleSlack = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${slackToken}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": String(staleSec),
          "x-slack-signature": `v0=${await hmacHex(slackSecret, `v0:${staleSec}:${chalBody}`)}`,
        },
        body: chalBody,
      }),
      { params: Promise.resolve({ token: slackToken }) },
    )
    expect(staleSlack.status).toBe(401)

    // Clerk (Standard Webhooks via svix-* headers): stale replay (401), rotated multi-v1 sig (200), duplicate svix-id (200 duplicate)
    const clerkToken = newBotWebhookToken()
    const keyBytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13, 14, 15, 16])
    const clerkSecret = `whsec_${Buffer.from(keyBytes).toString("base64")}`
    await queries.communityBotWebhook.createBotWebhook(mocks.db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Clerk QA",
      provider: "clerk",
      tokenHash: await hashBotWebhookToken(clerkToken),
      signingSecretEnc: await encryptBotWebhookSecret(mocks.env, clerkSecret),
      eventFilter: null,
      instruction: "",
    })
    const clerkBody = JSON.stringify({ type: "user.created", data: { id: "user_1", email: "a@b.com" } })
    const svixKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    const staleSvixSig = Buffer.from(
      await crypto.subtle.sign("HMAC", svixKey, new TextEncoder().encode(`svix_1.${staleSec}.${clerkBody}`)),
    ).toString("base64")
    expect(
      (
        await POST(
          new NextRequest(`https://alook.ai/api/webhooks/bot/${clerkToken}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "svix-id": "svix_1",
              "svix-timestamp": String(staleSec),
              "svix-signature": `v1,${staleSvixSig}`,
            },
            body: clerkBody,
          }),
          { params: Promise.resolve({ token: clerkToken }) },
        )
      ).status,
    ).toBe(401)

    const goodSvixSig = Buffer.from(
      await crypto.subtle.sign("HMAC", svixKey, new TextEncoder().encode(`svix_1.${nowSec}.${clerkBody}`)),
    ).toString("base64")
    const badSvixSig = Buffer.from(new Uint8Array(32)).toString("base64")
    const clerkOk = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${clerkToken}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "svix_1",
          "svix-timestamp": String(nowSec),
          "svix-signature": `v1,${badSvixSig} v1,${goodSvixSig}`,
        },
        body: clerkBody,
      }),
      { params: Promise.resolve({ token: clerkToken }) },
    )
    expect(clerkOk.status).toBe(200)

    const clerkDup = await POST(
      new NextRequest(`https://alook.ai/api/webhooks/bot/${clerkToken}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "svix_1",
          "svix-timestamp": String(nowSec),
          "svix-signature": `v1,${goodSvixSig}`,
        },
        body: clerkBody,
      }),
      { params: Promise.resolve({ token: clerkToken }) },
    )
    expect(clerkDup.status).toBe(200)
    expect(await clerkDup.json()).toMatchObject({ ok: true, duplicate: true })

    // Linear / Sentry / Vercel / GitLab / Cloudflare bad signatures MUST all return 401
    for (const [provider, headerName, badHeader] of [
      ["linear", "linear-signature", "00".repeat(32)],
      ["sentry", "sentry-hook-signature", "00".repeat(32)],
      ["vercel", "x-vercel-signature", "00".repeat(20)],
      ["gitlab", "x-gitlab-token", "wrong-token"],
      ["cloudflare", "cf-webhook-auth", "wrong-secret"],
    ] as const) {
      const tok = newBotWebhookToken()
      await queries.communityBotWebhook.createBotWebhook(mocks.db, {
        ownerUserId: "owner_1",
        botUserId: "bot_1",
        name: `${provider} QA`,
        provider,
        tokenHash: await hashBotWebhookToken(tok),
        signingSecretEnc: await encryptBotWebhookSecret(mocks.env, "qa_secret_12345678"),
        eventFilter: null,
        instruction: "",
      })
      const badRes = await POST(
        new NextRequest(`https://alook.ai/api/webhooks/bot/${tok}`, {
          method: "POST",
          headers: { "content-type": "application/json", [headerName]: badHeader },
          body: "{}",
        }),
        { params: Promise.resolve({ token: tok }) },
      )
      expect(badRes.status).toBe(401)
    }

    // Only the 2 valid non-duplicate deliveries (Stripe + Clerk) woke the bot
    expect(mocks.pushBotEventToMachine).toHaveBeenCalledTimes(2)
  })
})

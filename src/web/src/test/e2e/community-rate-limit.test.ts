/**
 * End-to-end verification of the community message rate limiter.
 *
 * The limiter lives in a Durable Object (`RateLimitDurableObject` in
 * `src/ws-do/`) and is reached from the web worker via the `WS_DO_WORKER`
 * service binding. Since `wsDoFetch` falls open on transport failure, a
 * successful rejection at request 31 also proves the DO round-trip is
 * actually happening — a broken transport would let every request through.
 *
 * Requires both dev servers running (web on :3000, ws-do on :8789).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { DEV_WS_DO_URL, RATE_LIMITS, type RateLimitResult } from "@alook/shared"
import {
  seedTestData,
  cleanupTestData,
  sessionRequest,
  signIn,
  sqlRun,
  type TestSeed,
} from "@alook/test-utils"

let seed: TestSeed
let cookie: string
let serverId: string
let channelId: string

function nanoid() {
  return randomUUID().replace(/-/g, "").slice(0, 21)
}

beforeAll(async () => {
  seed = seedTestData()
  cookie = await signIn(seed.authEmail, seed.authPassword)

  const now = new Date().toISOString()
  serverId = `srv_${nanoid()}`
  channelId = `chn_${nanoid()}`

  sqlRun(
    `INSERT INTO community_server (id, name, description, owner_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    serverId,
    "Rate Limit Test Server",
    "",
    seed.userId,
    now,
  )
  sqlRun(
    `INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)`,
    `mem_${nanoid()}`,
    serverId,
    seed.userId,
    "owner",
    now,
  )
  sqlRun(
    `INSERT INTO community_channel (id, server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    channelId,
    serverId,
    "general",
    "text",
    0,
    now,
  )
})

afterAll(() => {
  try {
    sqlRun(`DELETE FROM community_message WHERE channel_id = ?`, channelId)
    sqlRun(`DELETE FROM community_channel WHERE id = ?`, channelId)
    sqlRun(`DELETE FROM community_server_member WHERE server_id = ?`, serverId)
    sqlRun(`DELETE FROM community_server WHERE id = ?`, serverId)
  } catch { /* ignore */ }
  cleanupTestData(seed)
})

describe("community message rate limit — DO-backed", () => {
  it("accepts up to the per-window max, then returns 429 with Retry-After", async () => {
    const name = "community:msgSend" as const
    const policy = RATE_LIMITS[name]
    const sendMessage = (content: string) => sessionRequest(
      `/api/community/channels/${channelId}/messages`,
      cookie,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      },
    )

    // Keep the two assertions that matter on the real community route, but
    // avoid making a cold CI runner perform 31 full auth + D1 message writes.
    // The first write creates the exact (name, userId) DO window used by the
    // route. Lightweight calls to the real ws-do service then fill that same
    // strongly-consistent counter before the overflow request exercises the
    // route's 429 response.
    const accepted = await sendMessage("rate-limit-e2e accepted")
    expect(accepted.status).toBe(201)

    const primed = await Promise.all(
      Array.from({ length: policy.max - 1 }, async () => {
        const response = await fetch(`${DEV_WS_DO_URL}/rate-limit/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, key: seed.userId, ...policy }),
        })
        expect(response.status).toBe(200)
        return (await response.json()) as RateLimitResult
      }),
    )
    expect(primed).toEqual(Array.from({ length: policy.max - 1 }, () => ({ allowed: true })))

    const rejected = await sendMessage("rate-limit-e2e rejected")
    expect(rejected.status).toBe(429)
    const retryAfter = rejected.headers.get("retry-after")
    expect(retryAfter).toBeTruthy()
    expect(Number(retryAfter)).toBeGreaterThan(0)
  }, 30_000)
})

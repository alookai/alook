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
  it("allows the first 30 sends inside one window, then returns 429 with Retry-After", async () => {
    const results: number[] = []
    for (let i = 0; i < 31; i++) {
      const res = await sessionRequest(
        `/api/community/channels/${channelId}/messages`,
        cookie,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `rate-limit-e2e ${i}` }),
        },
      )
      results.push(res.status)
      if (i === 30) {
        // The 31st request must be blocked, not fail-open. The Retry-After
        // header is set by writeError() when the DO returns { allowed: false }.
        const retryAfter = res.headers.get("retry-after")
        expect(retryAfter).toBeTruthy()
        expect(Number(retryAfter)).toBeGreaterThan(0)
      }
    }
    // First 30 accepted (201). If any of them 429, the counter started with
    // stale state from a previous run — reset with `pnpm db:reset`.
    const accepted = results.slice(0, 30).filter((s) => s === 201).length
    expect(accepted).toBe(30)
    expect(results[30]).toBe(429)
  }, 30_000)
})

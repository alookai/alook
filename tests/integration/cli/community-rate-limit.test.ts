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
  it("accepts up to the per-window max, then returns 429 with Retry-After", async () => {
    // Policy: community:msgSend = 30 sends / 10s fixed window (see
    // `RATE_LIMITS` in src/shared/src/lib/rate-limits.ts). Fire the whole
    // burst CONCURRENTLY so every request provably lands inside one window —
    // a sequential loop can take >10s on a slow runner, letting the fixed
    // window reset mid-loop so the counter never reaches the ceiling and no
    // 429 is ever emitted (the old flake). The DO counter is
    // strongly-consistent, so concurrency still yields a deterministic split.
    const MAX = 30
    const responses = await Promise.all(
      Array.from({ length: MAX + 1 }, (_, i) =>
        sessionRequest(
          `/api/community/channels/${channelId}/messages`,
          cookie,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: `rate-limit-e2e ${i}` }),
          },
        ),
      ),
    )

    const accepted = responses.filter((r) => r.status === 201).length
    const rejected = responses.filter((r) => r.status === 429)

    // Exactly the ceiling is accepted; the overflow is blocked (not fail-open).
    // If `accepted` < 30, the counter started with stale state from a previous
    // run — reset with `pnpm db:reset`.
    expect(accepted).toBe(MAX)
    expect(rejected).toHaveLength(1)

    // Every 429 carries a positive Retry-After (set by writeError() when the
    // DO returns { allowed: false }). Asserted per-response so a fail-open
    // (429 without the header) is caught regardless of ordering.
    for (const res of rejected) {
      const retryAfter = res.headers.get("retry-after")
      expect(retryAfter).toBeTruthy()
      expect(Number(retryAfter)).toBeGreaterThan(0)
    }
  }, 30_000)
})

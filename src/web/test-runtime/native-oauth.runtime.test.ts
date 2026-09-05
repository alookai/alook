/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers"
import { createDb, queries } from "@alook/shared"
import { describe, expect, it } from "vitest"

const runtimeEnv = env as unknown as CloudflareEnv

function registration(id: string, instanceKeyHash: string) {
  return {
    id,
    instanceKeyHash,
    stateHash: "a".repeat(64),
    pkceChallenge: "c".repeat(43),
    provider: "github" as const,
    platform: "ios" as const,
    redirectPath: "/c/me",
  }
}

describe("native OAuth CAS in real workerd D1", () => {
  it("atomically replaces, rejects a wrong code, and lets cancellation win", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
    const firstId = `native_old_${suffix}`
    const secondId = `native_new_${suffix}`
    const instanceKeyHash = suffix.padEnd(64, "a")
    const codeHash = "d".repeat(64)
    const now = 1_788_531_200_000
    const db = createDb(runtimeEnv.DB.withSession("first-primary"))

    try {
      await queries.nativeOauth.registerAttempt(
        db,
        registration(firstId, instanceKeyHash),
        now,
      )
      await queries.nativeOauth.registerAttempt(
        db,
        registration(secondId, instanceKeyHash),
        now + 1,
      )
      const rows = await runtimeEnv.DB.prepare(
        `SELECT id, status FROM native_oauth_attempt
          WHERE instance_key_hash = ? ORDER BY created_at`,
      ).bind(instanceKeyHash).all<{ id: string; status: string }>()
      expect(rows.results).toEqual([
        { id: firstId, status: "replaced" },
        { id: secondId, status: "pending" },
      ])

      await queries.nativeOauth.claimStart(db, secondId, now + 2)
      await queries.nativeOauth.attachHandoff(db, {
        attemptId: secondId,
        handoffCodeHash: codeHash,
        authKind: "signin",
      }, now + 3)
      await expect(queries.nativeOauth.claimExchange(db, {
        attemptId: secondId,
        stateHash: "a".repeat(64),
        pkceChallenge: "c".repeat(43),
        handoffCodeHash: "e".repeat(64),
      }, now + 4)).resolves.toBeNull()
      await expect(queries.nativeOauth.getAttemptStatus(db, {
        attemptId: secondId,
        stateHash: "a".repeat(64),
        pkceChallenge: "c".repeat(43),
      })).resolves.toMatchObject({ status: "ready" })

      await queries.nativeOauth.claimExchange(db, {
        attemptId: secondId,
        stateHash: "a".repeat(64),
        pkceChallenge: "c".repeat(43),
        handoffCodeHash: codeHash,
      }, now + 5)
      await queries.nativeOauth.cancelAttempt(db, {
        attemptId: secondId,
        stateHash: "a".repeat(64),
        pkceChallenge: "c".repeat(43),
      }, now + 6)
      await expect(queries.nativeOauth.finishExchange(db, {
        attemptId: secondId,
        stateHash: "a".repeat(64),
        pkceChallenge: "c".repeat(43),
        handoffCodeHash: codeHash,
      }, now + 7)).resolves.toBeNull()
    } finally {
      await runtimeEnv.DB.prepare(
        "DELETE FROM native_oauth_attempt WHERE instance_key_hash = ?",
      ).bind(instanceKeyHash).run()
    }
  })
})

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
  it("leaves one live row after overlapping primary-session registrations", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
    const firstId = `native_parallel_a_${suffix}`
    const secondId = `native_parallel_b_${suffix}`
    const instanceKeyHash = suffix.padEnd(64, "a")
    const firstDb = createDb(runtimeEnv.DB.withSession("first-primary"))
    const secondDb = createDb(runtimeEnv.DB.withSession("first-primary"))

    try {
      const settled = await Promise.allSettled([
        queries.nativeOauth.registerAttempt(
          firstDb,
          registration(firstId, instanceKeyHash),
          1_788_531_200_000,
        ),
        queries.nativeOauth.registerAttempt(
          secondDb,
          registration(secondId, instanceKeyHash),
          1_788_531_200_001,
        ),
      ])
      expect(settled.every((result) => result.status === "fulfilled")).toBe(true)

      const rows = await runtimeEnv.DB.prepare(
        `SELECT id, status FROM native_oauth_attempt
          WHERE instance_key_hash = ? ORDER BY id`,
      ).bind(instanceKeyHash).all<{ id: string; status: string }>()
      expect(rows.results.map((row) => row.id)).toEqual([firstId, secondId])
      expect(rows.results.filter((row) =>
        ["pending", "opened", "ready", "exchanging"].includes(row.status),
      )).toHaveLength(1)
      expect(rows.results.filter((row) => row.status === "replaced")).toHaveLength(1)
    } finally {
      await runtimeEnv.DB.prepare(
        "DELETE FROM native_oauth_attempt WHERE instance_key_hash = ?",
      ).bind(instanceKeyHash).run()
    }
  })

  it("has one claim and one consume winner for overlapping primary sessions", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
    const attemptId = `native_exchange_${suffix}`
    const instanceKeyHash = suffix.padEnd(64, "b")
    const codeHash = "d".repeat(64)
    const proof = {
      attemptId,
      stateHash: "a".repeat(64),
      pkceChallenge: "c".repeat(43),
      handoffCodeHash: codeHash,
    }
    const setupDb = createDb(runtimeEnv.DB.withSession("first-primary"))
    const firstDb = createDb(runtimeEnv.DB.withSession("first-primary"))
    const secondDb = createDb(runtimeEnv.DB.withSession("first-primary"))
    const now = 1_788_531_200_000

    try {
      await queries.nativeOauth.registerAttempt(
        setupDb,
        registration(attemptId, instanceKeyHash),
        now,
      )
      await queries.nativeOauth.claimStart(setupDb, attemptId, now + 1)
      await queries.nativeOauth.attachHandoff(setupDb, {
        attemptId,
        handoffCodeHash: codeHash,
        authKind: "signin",
      }, now + 2)

      const claims = await Promise.allSettled([
        queries.nativeOauth.claimExchange(firstDb, proof, now + 3),
        queries.nativeOauth.claimExchange(secondDb, proof, now + 3),
      ])
      expect(claims.every((result) => result.status === "fulfilled")).toBe(true)
      const claimRows = claims.map((result) => {
        if (result.status === "rejected") throw result.reason
        return result.value
      })
      expect(claimRows.filter((row) => row !== null)).toHaveLength(1)

      const finishes = await Promise.allSettled([
        queries.nativeOauth.finishExchange(firstDb, proof, now + 4),
        queries.nativeOauth.finishExchange(secondDb, proof, now + 4),
      ])
      expect(finishes.every((result) => result.status === "fulfilled")).toBe(true)
      const consumedRows = finishes.map((result) => {
        if (result.status === "rejected") throw result.reason
        return result.value
      })
      expect(consumedRows.filter((row) => row !== null)).toHaveLength(1)

      const final = await runtimeEnv.DB.prepare(
        "SELECT status FROM native_oauth_attempt WHERE id = ?",
      ).bind(attemptId).first<{ status: string }>()
      expect(final).toEqual({ status: "consumed" })
    } finally {
      await runtimeEnv.DB.prepare(
        "DELETE FROM native_oauth_attempt WHERE instance_key_hash = ?",
      ).bind(instanceKeyHash).run()
    }
  })

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

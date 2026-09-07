import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  take: vi.fn(),
  restore: vi.fn(),
  deleteIfMatches: vi.fn(),
  rate: vi.fn(),
  sendEmail: vi.fn(),
}))

vi.mock("@alook/shared", () => ({
  queries: {
    accountDeletion: {
      upsertDeletionChallenge: mocks.upsert,
      takeDeletionChallenge: mocks.take,
      restoreDeletionChallenge: mocks.restore,
      deleteDeletionChallengeIfMatches: mocks.deleteIfMatches,
    },
  },
}))

vi.mock("@/lib/auth", () => ({
  getAuthOtpRateLimitPolicy: () => ({ max: 5, windowMs: 60_000 }),
  sendOtpEmail: mocks.sendEmail,
}))

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.rate }))

import {
  deletionChallengeId,
  deletionChallengeIdentifier,
  generateDeletionOtp,
  restoreVerifiedDeletionCode,
  sendDeletionCode,
  verifyDeletionCode,
} from "./challenge"

const db = {} as never
const env = {} as Env
const now = new Date("2026-09-07T15:00:00.000Z")

function row(value = "123456:0", expiresAt = "2026-09-07T15:05:00.000Z") {
  return {
    id: "account-deletion:hash",
    identifier: "account-deletion-otp:user-1:user@example.com",
    value,
    expiresAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

describe("account deletion challenge", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rate.mockResolvedValue({ allowed: true })
    mocks.upsert.mockImplementation(async (_db, value) => value)
    mocks.deleteIfMatches.mockResolvedValue(true)
    mocks.restore.mockResolvedValue(true)
    mocks.sendEmail.mockResolvedValue(undefined)
  })

  it("binds a deterministic challenge key to user and normalized email", async () => {
    const identifier = deletionChallengeIdentifier("user-1", " USER@Example.COM ")
    expect(identifier).toBe("account-deletion-otp:user-1:user@example.com")
    await expect(deletionChallengeId(identifier)).resolves.toMatch(/^account-deletion:[0-9a-f]{64}$/u)
    await expect(deletionChallengeId(identifier)).resolves.toBe(await deletionChallengeId(identifier))
  })

  it("generates an unbiased six-digit code including leading zeroes", () => {
    const fill = vi.fn((view: Uint32Array) => {
      view[0] = 42
      return view
    })
    expect(generateDeletionOtp(fill as typeof crypto.getRandomValues)).toBe("000042")
  })

  it("persists five-minute challenge before sending deletion-specific email", async () => {
    const result = await sendDeletionCode(db, env, {
      userId: "user-1",
      email: "USER@example.com",
      now,
    })

    expect(result).toEqual({ kind: "sent", expiresIn: 300, resendAfter: 60 })
    expect(mocks.upsert).toHaveBeenCalledOnce()
    const persisted = mocks.upsert.mock.calls[0][1]
    expect(persisted.identifier).toBe("account-deletion-otp:user-1:user@example.com")
    expect(persisted.value).toMatch(/^\d{6}:0$/u)
    expect(persisted.expiresAt).toBe("2026-09-07T15:05:00.000Z")
    expect(mocks.sendEmail).toHaveBeenCalledWith(env, {
      email: "user@example.com",
      otp: persisted.value.slice(0, 6),
      type: "account-deletion",
    })
  })

  it("returns rate-limit retry without persisting or sending", async () => {
    mocks.rate.mockResolvedValue({ allowed: false, retryAfterSec: 17 })

    await expect(sendDeletionCode(db, env, {
      userId: "user-1",
      email: "user@example.com",
      now,
    })).resolves.toEqual({ kind: "rate_limited", retryAfter: 17 })
    expect(mocks.upsert).not.toHaveBeenCalled()
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it("compare-deletes only its own challenge when email delivery fails", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("email down"))

    await expect(sendDeletionCode(db, env, {
      userId: "user-1",
      email: "user@example.com",
      now,
    })).resolves.toEqual({ kind: "send_failed" })
    expect(mocks.deleteIfMatches).toHaveBeenCalledWith(db, expect.objectContaining({
      identifier: "account-deletion-otp:user-1:user@example.com",
      value: expect.stringMatching(/^\d{6}:0$/u),
    }))
  })

  it("consumes a correct code and returns the exact row for retry restoration", async () => {
    const challenge = row()
    mocks.take.mockResolvedValue(challenge)

    await expect(verifyDeletionCode(db, {
      userId: "user-1",
      email: "user@example.com",
      otp: "123456",
      now,
    })).resolves.toEqual({ kind: "verified", challenge })
    expect(mocks.restore).not.toHaveBeenCalled()
  })

  it("increments wrong attempts while preserving the original expiry", async () => {
    mocks.take.mockResolvedValue(row("123456:1"))

    await expect(verifyDeletionCode(db, {
      userId: "user-1",
      email: "user@example.com",
      otp: "000000",
      now,
    })).resolves.toEqual({ kind: "invalid" })
    expect(mocks.restore).toHaveBeenCalledWith(db, expect.objectContaining({
      value: "123456:2",
      expiresAt: "2026-09-07T15:05:00.000Z",
    }))
  })

  it("exhausts on the third wrong attempt without restoring", async () => {
    mocks.take.mockResolvedValue(row("123456:2"))

    await expect(verifyDeletionCode(db, {
      userId: "user-1",
      email: "user@example.com",
      otp: "000000",
      now,
    })).resolves.toEqual({ kind: "too_many_attempts" })
    expect(mocks.restore).not.toHaveBeenCalled()
  })

  it("distinguishes expired and missing challenges", async () => {
    mocks.take.mockResolvedValueOnce(row("123456:0", now.toISOString())).mockResolvedValueOnce(null)

    await expect(verifyDeletionCode(db, {
      userId: "user-1", email: "user@example.com", otp: "123456", now,
    })).resolves.toEqual({ kind: "expired" })
    await expect(verifyDeletionCode(db, {
      userId: "user-1", email: "user@example.com", otp: "123456", now,
    })).resolves.toEqual({ kind: "invalid" })
  })

  it("restores a verified challenge insert-if-absent after retryable failure", async () => {
    const challenge = row()
    await restoreVerifiedDeletionCode(db, challenge)
    expect(mocks.restore).toHaveBeenCalledWith(db, challenge)
  })
})

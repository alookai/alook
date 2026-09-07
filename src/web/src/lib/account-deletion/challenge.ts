import { queries, type Database } from "@alook/shared"
import { getAuthOtpRateLimitPolicy, sendOtpEmail } from "@/lib/auth"
import { checkRateLimit } from "@/lib/rate-limit"

const ACCOUNT_DELETION_OTP_EXPIRES_IN_SECONDS = 300
const ACCOUNT_DELETION_OTP_MAX_ATTEMPTS = 3

type RandomValues = <T extends ArrayBufferView | null>(array: T) => T

export type VerifiedDeletionChallenge = queries.accountDeletion.DeletionChallenge

export type SendDeletionCodeResult =
  | { kind: "sent"; expiresIn: number; resendAfter: number }
  | { kind: "rate_limited"; retryAfter: number }
  | { kind: "send_failed" }

export type VerifyDeletionCodeResult =
  | { kind: "verified"; challenge: VerifiedDeletionChallenge }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "too_many_attempts" }

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function deletionChallengeIdentifier(userId: string, email: string): string {
  return `account-deletion-otp:${userId}:${normalizeEmail(email)}`
}

export async function deletionChallengeId(identifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identifier))
  return `account-deletion:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export function generateDeletionOtp(
  getRandomValues: RandomValues = crypto.getRandomValues.bind(crypto),
): string {
  const sample = new Uint32Array(1)
  const maximum = 0x1_0000_0000 - (0x1_0000_0000 % 1_000_000)
  do getRandomValues(sample)
  while (sample[0] >= maximum)
  return String(sample[0] % 1_000_000).padStart(6, "0")
}

function encodeChallengeValue(otp: string, attempts: number): string {
  return `${otp}:${attempts}`
}

function parseChallengeValue(value: string): { otp: string; attempts: number } | null {
  const match = /^(\d{6}):(\d+)$/u.exec(value)
  if (!match) return null
  const attempts = Number.parseInt(match[2], 10)
  return Number.isSafeInteger(attempts) && attempts >= 0
    ? { otp: match[1], attempts }
    : null
}

async function equalOtp(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ])
  const left = new Uint8Array(providedHash)
  const right = new Uint8Array(expectedHash)
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

async function challengeKey(userId: string, email: string) {
  const identifier = deletionChallengeIdentifier(userId, email)
  return { id: await deletionChallengeId(identifier), identifier }
}

export async function sendDeletionCode(
  db: Database,
  env: Env,
  input: { userId: string; email: string; now?: Date },
): Promise<SendDeletionCodeResult> {
  const email = normalizeEmail(input.email)
  const policy = getAuthOtpRateLimitPolicy(env)
  const rate = await checkRateLimit(env, "auth:otpSend", email, policy)
  if (!rate.allowed) return { kind: "rate_limited", retryAfter: rate.retryAfterSec }

  const otp = generateDeletionOtp()
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + ACCOUNT_DELETION_OTP_EXPIRES_IN_SECONDS * 1000)
  const key = await challengeKey(input.userId, email)
  const challenge = await queries.accountDeletion.upsertDeletionChallenge(db, {
    ...key,
    value: encodeChallengeValue(otp, 0),
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })

  try {
    await sendOtpEmail(env, { email, otp, type: "account-deletion" })
  } catch {
    await queries.accountDeletion.deleteDeletionChallengeIfMatches(db, challenge)
    return { kind: "send_failed" }
  }

  return {
    kind: "sent",
    expiresIn: ACCOUNT_DELETION_OTP_EXPIRES_IN_SECONDS,
    resendAfter: Math.round(policy.windowMs / 1000),
  }
}

export async function verifyDeletionCode(
  db: Database,
  input: { userId: string; email: string; otp: string; now?: Date },
): Promise<VerifyDeletionCodeResult> {
  const key = await challengeKey(input.userId, input.email)
  const challenge = await queries.accountDeletion.takeDeletionChallenge(db, key)
  if (!challenge) return { kind: "invalid" }

  const parsed = parseChallengeValue(challenge.value)
  if (!parsed) return { kind: "invalid" }
  const now = input.now ?? new Date()
  if (Date.parse(challenge.expiresAt) <= now.getTime()) return { kind: "expired" }
  if (parsed.attempts >= ACCOUNT_DELETION_OTP_MAX_ATTEMPTS) return { kind: "too_many_attempts" }
  if (await equalOtp(input.otp, parsed.otp)) return { kind: "verified", challenge }

  const attempts = parsed.attempts + 1
  if (attempts >= ACCOUNT_DELETION_OTP_MAX_ATTEMPTS) return { kind: "too_many_attempts" }
  await queries.accountDeletion.restoreDeletionChallenge(db, {
    ...challenge,
    value: encodeChallengeValue(parsed.otp, attempts),
    updatedAt: now.toISOString(),
  })
  return { kind: "invalid" }
}

export async function restoreVerifiedDeletionCode(
  db: Database,
  challenge: VerifiedDeletionChallenge,
): Promise<void> {
  await queries.accountDeletion.restoreDeletionChallenge(db, challenge)
}

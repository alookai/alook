import { randomUUID } from "crypto"
import { sqlRun } from "./db"

export interface TestSeed {
  userId: string
  /** Email used for better-auth sign-in */
  authEmail: string
  /** Password for better-auth sign-in */
  authPassword: string
}

function nanoid() {
  return randomUUID().replace(/-/g, "").slice(0, 21)
}

export function seedTestData(): TestSeed {
  const userId = `u_${nanoid()}`

  const now = new Date().toISOString()

  sqlRun(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`, userId, `Test User ${userId}`, `${userId}@test.local`, now, now)
  // Insert account record for better-auth credential provider (scrypt hash of "e2e-test-pass")
  const accountId = `acc_${nanoid()}`
  const hashedPassword = "42f5ab765c423b9575aa9a1ed5e9e7ff:34eb25daa674d7b35e4609a239c9f780ad8df3a149442fd956a8515f3c617f0530a9abd8b93dbf7e4b9a416fb39d88936d1d7055a98344748d1b70355c31609f"
  sqlRun(`INSERT INTO account (id, userId, accountId, providerId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`, accountId, userId, userId, 'credential', hashedPassword, now, now)

  const authEmail = `${userId}@test.local`
  const authPassword = "e2e-test-pass"

  return { userId, authEmail, authPassword }
}

export function cleanupTestData(seed: TestSeed) {
  sqlRun(`DELETE FROM "user" WHERE id = ?`, seed.userId)
}

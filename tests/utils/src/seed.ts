import { randomUUID } from "crypto"
import { sqlRun } from "./db"

export interface TestSeed {
  userId: string
  workspaceId: string
  memberId: string
  runtimeId: string
  daemonId: string
  agentId: string
  agentEmailHandle: string
  /** Raw machine token (starts with al_) */
  machineToken: string
  machineTokenId: string
  whitelistId: string
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
  const workspaceId = `sp_${nanoid()}`
  const memberId = `mb_${nanoid()}`
  const runtimeId = `rt_${nanoid()}`
  const agentId = `ag_${nanoid()}`
  const daemonId = `daemon_${nanoid()}`
  const machineTokenId = `mt_${nanoid()}`
  const rawToken = `al_${randomUUID().replace(/-/g, "")}`
  const emailHandle = `e2e-${nanoid()}`
  const whitelistId = `wl_${nanoid()}`

  const now = new Date().toISOString()
  const slug = `test-${nanoid()}`

  sqlRun(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`, userId, 'Test User', `${userId}@test.local`, now, now)
  sqlRun(`INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, workspaceId, 'Test Workspace', slug, now, now)
  sqlRun(`INSERT INTO member (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)`, memberId, workspaceId, userId, 'owner', now)
  sqlRun(`INSERT INTO machine (daemon_id, workspace_id, device_info, last_seen_at, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, daemonId, workspaceId, 'test-device', now, now, now, userId)
  sqlRun(`INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, status, device_info, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, runtimeId, workspaceId, daemonId, 'local', 'claude', 'online', 'test-device', now, now)
  sqlRun(`INSERT INTO agent (id, workspace_id, name, runtime_id, email_handle, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, agentId, workspaceId, 'Test Agent', runtimeId, emailHandle, userId, now, now)
  sqlRun(`INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, machineTokenId, userId, workspaceId, rawToken, 'test-token', 'active', now)
  sqlRun(`INSERT INTO agent_whitelist (id, agent_id, workspace_id, email, created_at) VALUES (?, ?, ?, ?, ?)`, whitelistId, agentId, workspaceId, `${userId}@test.local`, now)

  // Insert account record for better-auth credential provider (scrypt hash of "e2e-test-pass")
  const accountId = `acc_${nanoid()}`
  const hashedPassword = "42f5ab765c423b9575aa9a1ed5e9e7ff:34eb25daa674d7b35e4609a239c9f780ad8df3a149442fd956a8515f3c617f0530a9abd8b93dbf7e4b9a416fb39d88936d1d7055a98344748d1b70355c31609f"
  sqlRun(`INSERT INTO account (id, userId, accountId, providerId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`, accountId, userId, userId, 'credential', hashedPassword, now, now)

  const authEmail = `${userId}@test.local`
  const authPassword = "e2e-test-pass"

  return { userId, workspaceId, memberId, runtimeId, daemonId, agentId, agentEmailHandle: emailHandle, machineToken: rawToken, machineTokenId, whitelistId, authEmail, authPassword }
}

export function cleanupTestData(seed: TestSeed) {
  const ws = seed.workspaceId
  sqlRun(`DELETE FROM task_message WHERE task_id IN (SELECT id FROM agent_task_queue WHERE workspace_id = ?)`, ws)
  sqlRun(`DELETE FROM agent_task_queue WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM message WHERE conversation_id IN (SELECT id FROM conversation WHERE workspace_id = ?)`, ws)
  sqlRun(`DELETE FROM conversation WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM meeting_session WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM emails WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = ?)`, ws)
  sqlRun(`DELETE FROM agent_skill WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM agent_whitelist WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = ?)`, ws)
  sqlRun(`DELETE FROM agent_access WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM agent_pin WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM workspace_invite WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM agent WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM agent_runtime WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM machine WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM machine_token WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM member WHERE workspace_id = ?`, ws)
  sqlRun(`DELETE FROM "session" WHERE userId = ?`, seed.userId)
  sqlRun(`DELETE FROM account WHERE userId = ?`, seed.userId)
  sqlRun(`DELETE FROM workspace WHERE id = ?`, ws)
  sqlRun(`DELETE FROM "user" WHERE id = ?`, seed.userId)
}

export interface SecondaryUser {
  userId: string
  memberId: string
}

export function seedSecondaryUser(workspaceId: string, role = "member"): SecondaryUser {
  const userId = `u_${nanoid()}`
  const memberId = `mb_${nanoid()}`
  const now = new Date().toISOString()

  sqlRun(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`, userId, 'Secondary User', `${userId}@test.local`, now, now)
  sqlRun(`INSERT INTO member (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)`, memberId, workspaceId, userId, role, now)

  return { userId, memberId }
}

export interface TestInvite {
  inviteId: string
  token: string
}

export function seedInvite(workspaceId: string, createdBy: string): TestInvite {
  const inviteId = `inv_${nanoid()}`
  const token = `tok_${nanoid()}`
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  sqlRun(`INSERT INTO workspace_invite (id, workspace_id, token, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`, inviteId, workspaceId, token, createdBy, expiresAt, now)

  return { inviteId, token }
}

export function cleanupSecondaryUser(secondary: SecondaryUser) {
  sqlRun(`DELETE FROM agent_access WHERE user_id = ?`, secondary.userId)
  sqlRun(`DELETE FROM agent_pin WHERE user_id = ?`, secondary.userId)
  sqlRun(`DELETE FROM member WHERE id = ?`, secondary.memberId)
  sqlRun(`DELETE FROM "user" WHERE id = ?`, secondary.userId)
}

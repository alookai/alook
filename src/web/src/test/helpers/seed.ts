import { randomUUID } from "crypto"
import { sql, sqlBatch } from "./db"

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
}

function nanoid() {
  return randomUUID().replace(/-/g, "").slice(0, 21)
}

/**
 * Seed a full test environment: user, workspace, member, runtime, agent, machine token.
 * All IDs are unique per call.
 */
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

  sql(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('${userId}', 'Test User', '${userId}@test.local', 1, '${now}', '${now}')`)
  sql(`INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES ('${workspaceId}', 'Test Workspace', '${slug}', '${now}', '${now}')`)
  sql(`INSERT INTO member (id, workspace_id, user_id, role, created_at) VALUES ('${memberId}', '${workspaceId}', '${userId}', 'owner', '${now}')`)
  sql(`INSERT INTO machine (daemon_id, workspace_id, device_info, last_seen_at, created_at, updated_at) VALUES ('${daemonId}', '${workspaceId}', 'test-device', '${now}', '${now}', '${now}')`)
  sql(`INSERT INTO agent_runtime (id, workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, created_at, updated_at) VALUES ('${runtimeId}', '${workspaceId}', '${daemonId}', 'Test Runtime', 'local', 'claude', 'online', 'test-device', '${now}', '${now}')`)
  sql(`INSERT INTO agent (id, workspace_id, name, runtime_id, email_handle, owner_id, created_at, updated_at) VALUES ('${agentId}', '${workspaceId}', 'Test Agent', '${runtimeId}', '${emailHandle}', '${userId}', '${now}', '${now}')`)
  sql(`INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES ('${machineTokenId}', '${userId}', '${workspaceId}', '${rawToken}', 'test-token', 'active', '${now}')`)
  sql(`INSERT INTO agent_whitelist (id, agent_id, workspace_id, email, created_at) VALUES ('${whitelistId}', '${agentId}', '${workspaceId}', '${userId}@test.local', '${now}')`)

  return { userId, workspaceId, memberId, runtimeId, daemonId, agentId, agentEmailHandle: emailHandle, machineToken: rawToken, machineTokenId, whitelistId }
}

/**
 * Clean up all test data created by seedTestData.
 */
export function cleanupTestData(seed: TestSeed) {
  const ws = seed.workspaceId
  sqlBatch([
    `DELETE FROM task_message WHERE task_id IN (SELECT id FROM agent_task_queue WHERE workspace_id = '${ws}')`,
    `DELETE FROM agent_task_queue WHERE workspace_id = '${ws}'`,
    `DELETE FROM message WHERE conversation_id IN (SELECT id FROM conversation WHERE workspace_id = '${ws}')`,
    `DELETE FROM conversation WHERE workspace_id = '${ws}'`,
    `DELETE FROM meeting_session WHERE workspace_id = '${ws}'`,
    `DELETE FROM emails WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = '${ws}')`,
    `DELETE FROM agent_whitelist WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = '${ws}')`,
    `DELETE FROM agent_access WHERE workspace_id = '${ws}'`,
    `DELETE FROM agent_pin WHERE workspace_id = '${ws}'`,
    `DELETE FROM workspace_invite WHERE workspace_id = '${ws}'`,
    `DELETE FROM agent WHERE workspace_id = '${ws}'`,
    `DELETE FROM agent_runtime WHERE workspace_id = '${ws}'`,
    `DELETE FROM machine WHERE workspace_id = '${ws}'`,
    `DELETE FROM machine_token WHERE workspace_id = '${ws}'`,
    `DELETE FROM member WHERE workspace_id = '${ws}'`,
    `DELETE FROM workspace WHERE id = '${ws}'`,
    `DELETE FROM "user" WHERE id = '${seed.userId}'`,
  ])
}

export interface SecondaryUser {
  userId: string
  memberId: string
}

/**
 * Create a second user + member record in an existing workspace.
 */
export function seedSecondaryUser(workspaceId: string, role = "member"): SecondaryUser {
  const userId = `u_${nanoid()}`
  const memberId = `mb_${nanoid()}`
  const now = new Date().toISOString()

  sql(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('${userId}', 'Secondary User', '${userId}@test.local', 1, '${now}', '${now}')`)
  sql(`INSERT INTO member (id, workspace_id, user_id, role, created_at) VALUES ('${memberId}', '${workspaceId}', '${userId}', '${role}', '${now}')`)

  return { userId, memberId }
}

export interface TestInvite {
  inviteId: string
  token: string
}

/**
 * Create a workspace invite directly in DB for testing.
 */
export function seedInvite(workspaceId: string, createdBy: string): TestInvite {
  const inviteId = `inv_${nanoid()}`
  const token = `tok_${nanoid()}`
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  sql(`INSERT INTO workspace_invite (id, workspace_id, token, created_by, expires_at, created_at) VALUES ('${inviteId}', '${workspaceId}', '${token}', '${createdBy}', '${expiresAt}', '${now}')`)

  return { inviteId, token }
}

/**
 * Clean up secondary user (and their memberships).
 */
export function cleanupSecondaryUser(secondary: SecondaryUser) {
  sql(`DELETE FROM agent_access WHERE user_id = '${secondary.userId}'`)
  sql(`DELETE FROM agent_pin WHERE user_id = '${secondary.userId}'`)
  sql(`DELETE FROM member WHERE id = '${secondary.memberId}'`)
  sql(`DELETE FROM "user" WHERE id = '${secondary.userId}'`)
}

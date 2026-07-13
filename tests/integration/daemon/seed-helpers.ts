/**
 * Shared real-infra seeding for `control-plane.test.ts` and
 * `credential-chain.test.ts` — both need the same "one human owner, one
 * server+channel, one paired machine, one bot bound to it" fixture; this
 * factors it into one place instead of duplicating the HTTP/SQL sequence.
 */
import { randomUUID } from "crypto"
import {
  sqlRun,
  pairAndActivateMachine,
  seedCommunityBot,
  cleanupCommunityBot,
  cleanupPairedMachine,
  type TestSeed,
  type PairedMachine,
  type SeededCommunityBot,
} from "@alook/test-utils"

export function nanoid() {
  return randomUUID().replace(/-/g, "").slice(0, 21)
}

export interface DaemonItFixture {
  serverId: string
  channelId: string
  paired: PairedMachine
  bot: SeededCommunityBot
}

export async function seedPairedBot(seed: TestSeed, cookie: string): Promise<DaemonItFixture> {
  const now = new Date().toISOString()
  const serverId = `srv_${nanoid()}`
  const channelId = `chn_${nanoid()}`
  sqlRun(
    `INSERT INTO community_server (id, name, description, owner_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    serverId,
    "Daemon IT Server",
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

  const paired = await pairAndActivateMachine(cookie)
  const bot = seedCommunityBot({ ownerUserId: seed.userId, serverId, machineId: paired.machineId, runtime: "claude" })

  return { serverId, channelId, paired, bot }
}

export function cleanupPairedBot(seed: TestSeed, fixture: DaemonItFixture): void {
  try {
    sqlRun(`DELETE FROM community_message WHERE channel_id = ?`, fixture.channelId)
    sqlRun(`DELETE FROM community_channel WHERE id = ?`, fixture.channelId)
    sqlRun(`DELETE FROM community_server_member WHERE server_id = ?`, fixture.serverId)
    sqlRun(`DELETE FROM community_server WHERE id = ?`, fixture.serverId)
  } catch { /* ignore */ }
  cleanupCommunityBot(fixture.bot)
  cleanupPairedMachine(fixture.paired, seed.userId)
}

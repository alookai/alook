/**
 * Shared real-infra seeding for `control-plane.test.ts` and
 * `credential-chain.test.ts` — both need the same "one human owner, one
 * server+channel, one paired machine, one bot bound to it" fixture; this
 * factors it into one place instead of duplicating the HTTP/SQL sequence.
 */
import { randomUUID } from "crypto"
import {
  sqlQuery,
  sqlRun,
  pairAndActivateMachine,
  seedCommunityBot,
  cleanupCommunityBot,
  cleanupPairedMachine,
  type TestSeed,
  type PairedMachine,
  type SeededCommunityBot,
} from "@alook/test-utils"
import { computeDiscriminator, formatHandle } from "@alook/shared"

export function nanoid() {
  return randomUUID().replace(/-/g, "").slice(0, 21)
}

export interface DaemonItFixture {
  serverId: string
  serverHandle: string
  channelId: string
  /**
   * Top-level channel NAME — the only way agent surfaces address a channel.
   * `resolveChannelByNameForMember` is name-only (migration 0057's partial
   * unique index; agent refs never accept ids), so canonical community REST
   * agent doors receive the ref as `/serverHandle/channelName`,
   * while the `/c` UI REST routes (`/api/community/channels/:id/*`) still key
   * on `channelId`.
   */
  channelName: string
  paired: PairedMachine
  bot: SeededCommunityBot
}

export async function seedPairedBot(seed: TestSeed, cookie: string): Promise<DaemonItFixture> {
  const now = new Date().toISOString()
  const serverId = `srv_${nanoid()}`
  const serverName = `Daemon IT Server ${serverId.slice(-8)}`
  const serverDiscriminator = computeDiscriminator(serverId)
  const channelId = `chn_${nanoid()}`
  const channelName = "general"
  sqlRun(
    `INSERT INTO community_server (id, name, discriminator, description, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    serverId,
    serverName,
    serverDiscriminator,
    "",
    seed.userId,
    now,
  )
  const [server] = sqlQuery<{ name: string; discriminator: string }>(
    `SELECT name, discriminator FROM community_server WHERE id = ?`,
    serverId,
  )
  if (!server) throw new Error(`seedPairedBot: server ${serverId} was not persisted`)
  const serverHandle = formatHandle(server.name, server.discriminator)
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
    channelName,
    "text",
    0,
    now,
  )

  const paired = await pairAndActivateMachine(cookie)
  const bot = seedCommunityBot({ ownerUserId: seed.userId, serverId, machineId: paired.machineId, runtime: "claude" })

  return { serverId, serverHandle, channelId, channelName, paired, bot }
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

import { randomUUID } from "crypto"
import { sqlRun } from "./db"
import { sessionRequest } from "./auth"
import { fetchWithRetry } from "./fetch"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"

function nanoid() {
  return randomUUID().replace(/-/g, "").slice(0, 21)
}

export interface PairedMachine {
  /** Long-lived daemon credential (`cmk_...`). */
  credential: string
  machineId: string
}

/**
 * Real pair → activate flow for a signed-in human owner: mints a `cmt_`
 * pairing token over the owner's session, then exchanges it for a `cmk_`
 * daemon credential via real HTTP — exactly what a daemon does on first
 * connect. Unlike a raw `sqlRun` insert, this produces a
 * `community_machine_credential` row whose hash matches the returned
 * plaintext, so the ws-do WS upgrade (which authenticates by
 * `sha256(bearer)` lookup) actually accepts it.
 */
export async function pairAndActivateMachine(
  cookie: string,
  opts?: { hostname?: string; platform?: string; arch?: string },
): Promise<PairedMachine> {
  const pairRes = await sessionRequest("/api/community/machines/pair", cookie, { method: "POST" })
  if (!pairRes.ok) {
    throw new Error(`pairAndActivateMachine: pair failed (${pairRes.status})`)
  }
  const { tokenId } = (await pairRes.json()) as { tokenId: string; expiresAt: string }

  const activateRes = await fetchWithRetry(`${APP_URL}/api/community/daemon/activate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      hostname: opts?.hostname ?? "test-host",
      platform: opts?.platform ?? "linux",
      arch: opts?.arch ?? "x64",
    }),
  })
  if (!activateRes.ok) {
    throw new Error(`pairAndActivateMachine: activate failed (${activateRes.status})`)
  }
  const { credential, machineId } = (await activateRes.json()) as {
    credential: string
    machineId: string
    expiresAt: string | null
  }
  return { credential, machineId }
}

export interface SeededCommunityBot {
  botUserId: string
  memberId: string
}

/**
 * Seed a bot bound to an already-paired machine: the bot's own `user` row
 * (`isBot: true`), its `community_bot_binding` (machine + runtime), and a
 * `community_server_member` row so `findWakeCandidates`/fanout consider it
 * a recipient of messages posted to `opts.serverId`. Raw `sqlRun` — no HTTP
 * route creates bots directly in this flow today, so this mirrors
 * `seedTestData`'s own direct-insert style.
 */
export function seedCommunityBot(opts: {
  ownerUserId: string
  serverId: string
  machineId: string
  runtime?: string
}): SeededCommunityBot {
  const botUserId = `u_${nanoid()}`
  const memberId = `mem_${nanoid()}`
  const now = new Date().toISOString()
  const runtime = opts.runtime ?? "claude"

  sqlRun(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, isBot, ownerUserId) VALUES (?, ?, ?, 1, ?, ?, 1, ?)`,
    botUserId,
    `Test Bot ${botUserId}`,
    `${botUserId}@bot.test.local`,
    now,
    now,
    opts.ownerUserId,
  )
  sqlRun(
    `INSERT INTO community_bot_binding (user_id, machine_id, runtime, created_at) VALUES (?, ?, ?, ?)`,
    botUserId,
    opts.machineId,
    runtime,
    now,
  )
  sqlRun(
    `INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)`,
    memberId,
    opts.serverId,
    botUserId,
    "member",
    now,
  )

  return { botUserId, memberId }
}

/**
 * Cleans up everything `pairAndActivateMachine` + `seedCommunityBot` created,
 * plus the machine row itself — mirrors `cleanupTestData`'s pattern of
 * scoping every delete to the ids this helper produced.
 */
export function cleanupCommunityBot(bot: SeededCommunityBot): void {
  sqlRun(`DELETE FROM community_server_member WHERE id = ?`, bot.memberId)
  sqlRun(`DELETE FROM community_agent_runner_key WHERE agent_id = ?`, bot.botUserId)
  sqlRun(`DELETE FROM community_bot_binding WHERE user_id = ?`, bot.botUserId)
  sqlRun(`DELETE FROM "user" WHERE id = ?`, bot.botUserId)
}

/**
 * `ownerUserId` is required to clean up the `community_machine_token` row:
 * the FIRST-pair token (as opposed to a reconnect token) is minted with
 * `machine_id IS NULL` (see `createPairingToken`), so it can only be found
 * by owner, not by the machine it went on to create.
 */
export function cleanupPairedMachine(machine: PairedMachine, ownerUserId: string): void {
  sqlRun(`DELETE FROM community_machine_credential WHERE machine_id = ?`, machine.machineId)
  sqlRun(`DELETE FROM community_machine_token WHERE user_id = ?`, ownerUserId)
  sqlRun(`DELETE FROM community_machine WHERE id = ?`, machine.machineId)
}

// ── API-driven community precondition seeding ───────────────────────────────
// These drive the real HTTP routes (with a signed-in session cookie) so FK,
// permissions, default channels, and slugification all match production. Use
// them for journey *preconditions* — the operations themselves are exercised
// through the UI in the Playwright specs.

export interface SeededServer {
  serverId: string
}

export async function seedServerViaApi(cookie: string, opts: { name: string }): Promise<SeededServer> {
  const res = await sessionRequest("/api/community/servers", cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: opts.name }),
  })
  if (!res.ok) throw new Error(`seedServerViaApi failed (${res.status})`)
  const data = (await res.json()) as { server: { id: string } }
  return { serverId: data.server.id }
}

export interface SeededChannel {
  channelId: string
}

export async function seedChannelViaApi(
  cookie: string,
  opts: { serverId: string; name: string; type?: "text" | "forum"; categoryId?: string },
): Promise<SeededChannel> {
  const res = await sessionRequest(`/api/community/servers/${opts.serverId}/channels`, cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: opts.name, type: opts.type, categoryId: opts.categoryId }),
  })
  if (!res.ok) throw new Error(`seedChannelViaApi failed (${res.status})`)
  const data = (await res.json()) as { channel: { id: string } }
  return { channelId: data.channel.id }
}

export interface SeededDm {
  dmId: string
}

export async function seedDmViaApi(cookie: string, opts: { userId: string }): Promise<SeededDm> {
  const res = await sessionRequest("/api/community/dm", cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: opts.userId }),
  })
  if (!res.ok) throw new Error(`seedDmViaApi failed (${res.status})`)
  const data = (await res.json()) as { conversation: { id: string } }
  return { dmId: data.conversation.id }
}

/**
 * Full friend handshake: requester sends, addressee accepts. `accept` is
 * addressee-only (403 otherwise), so both cookies are required. Returns the
 * friendship id.
 */
export async function seedFriendshipViaApi(
  cookieRequester: string,
  cookieAddressee: string,
  opts: { targetUserId: string },
): Promise<{ friendshipId: string }> {
  const reqRes = await sessionRequest("/api/community/friends/request", cookieRequester, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: opts.targetUserId }),
  })
  if (!reqRes.ok) throw new Error(`seedFriendshipViaApi request failed (${reqRes.status})`)
  const reqData = (await reqRes.json()) as { id?: string; friendship?: { id: string } | null }
  const friendshipId = reqData.id ?? reqData.friendship?.id
  if (!friendshipId) throw new Error("seedFriendshipViaApi: no friendship id in response")

  const acceptRes = await sessionRequest(`/api/community/friends/${friendshipId}/accept`, cookieAddressee, {
    method: "POST",
  })
  if (!acceptRes.ok) throw new Error(`seedFriendshipViaApi accept failed (${acceptRes.status})`)
  return { friendshipId }
}

export async function seedBlockViaApi(cookie: string, opts: { userId: string }): Promise<void> {
  const res = await sessionRequest(`/api/community/users/${opts.userId}/block`, cookie, {
    method: "POST",
  })
  if (!res.ok) throw new Error(`seedBlockViaApi failed (${res.status})`)
}

export async function addChannelMemberViaApi(
  cookie: string,
  opts: { channelId: string; userId: string },
): Promise<void> {
  const res = await sessionRequest(`/api/community/channels/${opts.channelId}/members`, cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: opts.userId }),
  })
  if (!res.ok) throw new Error(`addChannelMemberViaApi failed (${res.status})`)
}

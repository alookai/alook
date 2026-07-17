import { WEB_URL } from "../_setup/paths"
import { sessionCookie } from "./community-fixture"
import type { UserKey } from "../_setup/users"

// API-driven precondition seeding for the Playwright specs. Deliberately does
// NOT import @alook/test-utils (that barrel pulls in better-sqlite3 +
// import.meta, which Playwright's CJS test loader can't evaluate). These call
// the same community routes over HTTP with a user's session cookie — the
// operations under test are still exercised through the UI in the specs.
async function post(key: UserKey, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${WEB_URL}${path}`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie(key),
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status})`)
  return res
}

export async function seedServer(owner: UserKey, name: string): Promise<string> {
  const res = await post(owner, "/api/community/servers", { name })
  const data = (await res.json()) as { server: { id: string } }
  return data.server.id
}

export async function seedChannel(owner: UserKey, serverId: string, name: string, type?: "text" | "forum"): Promise<string> {
  const res = await post(owner, `/api/community/servers/${serverId}/channels`, { name, type })
  const data = (await res.json()) as { channel: { id: string } }
  return data.channel.id
}

// Server membership comes from joining via invite (channels/[id]/members is
// only for private-category channels and requires prior server membership).
// Owner mints an invite, the joiner accepts it. Idempotent-ish: an
// "Already a member" 400 is treated as success.
export async function seedJoinServer(owner: UserKey, joiner: UserKey, serverId: string): Promise<void> {
  const token = await createInvite(owner, serverId)
  // Retry transient 5xx (local D1/WAL contention) a couple times; a 400 is
  // "Already a member" and counts as success.
  let lastStatus = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${WEB_URL}/api/community/invites/${token}/join`, {
      method: "POST",
      headers: { Cookie: sessionCookie(joiner), "Content-Type": "application/json", Origin: WEB_URL },
    })
    if (res.ok || res.status === 400) return
    lastStatus = res.status
    if (res.status < 500) break
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`seedJoinServer join failed (${lastStatus})`)
}

// Add a server member to a PRIVATE-category channel's roster. Requires the
// target to already be a server member (call seedJoinServer first).
export async function seedChannelMember(owner: UserKey, channelId: string, userId: string): Promise<void> {
  await post(owner, `/api/community/channels/${channelId}/members`, { userId })
}

export async function seedDm(from: UserKey, targetUserId: string): Promise<string> {
  const res = await post(from, "/api/community/dm", { userId: targetUserId })
  const data = (await res.json()) as { conversation: { id: string } }
  return data.conversation.id
}

export async function seedBlock(blocker: UserKey, targetUserId: string): Promise<void> {
  await post(blocker, `/api/community/users/${targetUserId}/block`)
}

// Full friend handshake: requester sends, addressee accepts (accept is
// addressee-only, hence two keys). Returns the friendship id.
export async function seedFriendship(requester: UserKey, addressee: UserKey, targetUserId: string): Promise<string> {
  const reqRes = await post(requester, "/api/community/friends/request", { userId: targetUserId })
  const reqData = (await reqRes.json()) as { id?: string; friendship?: { id: string } | null }
  const friendshipId = reqData.id ?? reqData.friendship?.id
  if (!friendshipId) throw new Error("seedFriendship: no friendship id in response")
  await post(addressee, `/api/community/friends/${friendshipId}/accept`)
  return friendshipId
}

// Post a message into a channel via API (persisted with a real server id).
// Use when a spec needs a pre-existing message as a precondition rather than
// exercising the send UI itself. Returns the message id.
export async function seedMessage(author: UserKey, channelId: string, content: string): Promise<string> {
  const res = await post(author, `/api/community/channels/${channelId}/messages`, { content })
  const data = (await res.json()) as { message: { id: string } }
  return data.message.id
}

export async function createInvite(owner: UserKey, serverId: string): Promise<string> {
  const res = await post(owner, `/api/community/servers/${serverId}/invites`, {})
  const data = (await res.json()) as { invite: { token: string } }
  return data.invite.token
}

import { WEB_URL } from "../_setup/paths"
import { sessionCookie } from "./community-fixture"
import type { UserKey } from "../_setup/users"

// API-driven precondition seeding for the Playwright specs. Deliberately does
// NOT import @alook/test-utils (that barrel pulls in better-sqlite3 +
// import.meta, which Playwright's CJS test loader can't evaluate). These call
// the same community routes over HTTP with a user's session cookie — the
// operations under test are still exercised through the UI in the specs.
// Statuses worth retrying: a transient auth race (401/403 before the session
// cookie is fully established on a cold worker) and D1/WAL contention (5xx).
// A 4xx that isn't auth is a real precondition failure — don't mask it.
function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status >= 500
}

async function postRaw(key: UserKey, path: string, body?: unknown): Promise<Response> {
  return fetch(`${WEB_URL}${path}`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie(key),
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function post(key: UserKey, path: string, body?: unknown): Promise<Response> {
  let lastStatus = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await postRaw(key, path, body)
    if (res.ok) return res
    lastStatus = res.status
    if (!isRetryableStatus(res.status)) break
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`POST ${path} failed (${lastStatus})`)
}

export async function seedServer(owner: UserKey, name: string): Promise<string> {
  const res = await post(owner, "/api/community/servers", { name })
  const data = (await res.json()) as { server: { id: string } }
  return data.server.id
}

export async function seedChannel(
  owner: UserKey,
  serverId: string,
  name: string,
  type?: "text" | "forum",
  categoryId?: string,
): Promise<string> {
  const res = await post(owner, `/api/community/servers/${serverId}/channels`, { name, type, categoryId })
  const data = (await res.json()) as { channel: { id: string } }
  return data.channel.id
}

// Create a category (optionally private) and return its id. A private category
// is what turns its channels' @-mention scope from server-wide to the channel
// audience — the whole point of the scope spec.
export async function seedCategory(
  owner: UserKey,
  serverId: string,
  name: string,
  opts?: { private?: boolean },
): Promise<string> {
  const res = await post(owner, `/api/community/servers/${serverId}/categories`, {
    name,
    private: opts?.private,
  })
  const data = (await res.json()) as { category: { id: string } }
  return data.category.id
}

// Server membership comes from joining via invite (channels/[id]/members is
// only for private-category channels and requires prior server membership).
// Owner mints an invite, the joiner accepts it. Idempotent-ish: an
// "Already a member" 400 is treated as success.
export async function seedJoinServer(owner: UserKey, joiner: UserKey, serverId: string): Promise<void> {
  const token = await createInvite(owner, serverId)
  // Retry a transient auth race (401/403) and D1/WAL contention (5xx); a 400 is
  // "Already a member" and counts as success (idempotent on a Playwright retry).
  let lastStatus = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${WEB_URL}/api/community/invites/${token}/join`, {
      method: "POST",
      headers: { Cookie: sessionCookie(joiner), "Content-Type": "application/json", Origin: WEB_URL },
    })
    if (res.ok || res.status === 400) return
    lastStatus = res.status
    if (!isRetryableStatus(res.status)) break
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

// Post a DM message via API so the conversation shows in both sidebars with a
// preview. Returns the message id.
export async function seedDmMessage(author: UserKey, dmId: string, content: string): Promise<string> {
  const res = await post(author, `/api/community/dm/${dmId}/messages`, { content })
  const data = (await res.json()) as { message: { id: string } }
  return data.message.id
}

export async function seedBlock(blocker: UserKey, targetUserId: string): Promise<void> {
  await post(blocker, `/api/community/users/${targetUserId}/block`)
}

// Look up an existing accepted-friendship id between the requester and a target
// user, from the requester's friends list. Used to recover idempotently when a
// re-run (Playwright retry) finds the pair already friends.
async function findFriendshipId(requester: UserKey, targetUserId: string): Promise<string | undefined> {
  const res = await fetch(`${WEB_URL}/api/community/friends`, {
    headers: { Cookie: sessionCookie(requester), Origin: WEB_URL },
  })
  if (!res.ok) return undefined
  const data = (await res.json()) as { friends: Array<{ id: string; userId: string }> }
  return data.friends.find((f) => f.userId === targetUserId)?.id
}

// Full friend handshake: requester sends, addressee accepts (accept is
// addressee-only, hence two keys). Returns the friendship id. Idempotent on a
// Playwright retry: if the pair is already friends the request 409s, so we
// recover the existing friendship id and skip the accept.
export async function seedFriendship(requester: UserKey, addressee: UserKey, targetUserId: string): Promise<string> {
  let reqRes: Response | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    reqRes = await postRaw(requester, "/api/community/friends/request", { userId: targetUserId })
    // 409 = already friends / request already sent — a valid idempotent state.
    if (reqRes.ok || reqRes.status === 409 || !isRetryableStatus(reqRes.status)) break
    await new Promise((r) => setTimeout(r, 400))
  }
  if (reqRes!.status === 409) {
    const existing = await findFriendshipId(requester, targetUserId)
    if (existing) return existing
    throw new Error("seedFriendship: 409 but no existing friendship found")
  }
  if (!reqRes!.ok) throw new Error(`seedFriendship request failed (${reqRes!.status})`)
  const reqData = (await reqRes!.json()) as { id?: string; friendship?: { id: string } | null }
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

// Create a forum post (a child channel of a `type:"forum"` channel) via API.
// Returns the post's own channel id. The creator is enrolled as a participant
// server-side. Use when a spec needs an existing post before driving the UI.
export async function seedForumPost(
  author: UserKey,
  forumChannelId: string,
  name: string,
  content: string,
): Promise<string> {
  const res = await post(author, `/api/community/channels/${forumChannelId}/posts`, { name, content })
  const data = (await res.json()) as { post: { id: string } }
  return data.post.id
}

// Create a thread rooted on an existing message. Returns the thread's own
// child-channel id. A thread has NO roster of its own — its @-mention scope is
// the PARENT channel's audience — which is exactly what the scope spec probes.
export async function seedThread(author: UserKey, messageId: string, name: string): Promise<string> {
  const res = await post(author, `/api/community/messages/${messageId}/threads`, { name })
  const data = (await res.json()) as { id: string }
  return data.id
}

export async function createInvite(owner: UserKey, serverId: string): Promise<string> {
  const res = await post(owner, `/api/community/servers/${serverId}/invites`, {})
  const data = (await res.json()) as { invite: { token: string } }
  return data.invite.token
}

// Rename a user's community display name. Used by the mention specs to force
// two members to share a name (each keeps its own auto-assigned discriminator),
// which is the whole point of the same-name-disambiguation journey.
export async function renameUser(key: UserKey, name: string): Promise<void> {
  let lastStatus = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${WEB_URL}/api/community/users/me/profile`, {
      method: "PATCH",
      headers: { Cookie: sessionCookie(key), "Content-Type": "application/json", Origin: WEB_URL },
      body: JSON.stringify({ name }),
    })
    if (res.ok) return
    lastStatus = res.status
    if (!isRetryableStatus(res.status)) break
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`renameUser failed (${lastStatus})`)
}

// A member's row id + discriminator, read from a server's member list (the
// same NOT NULL column the mention grammar depends on). The mention popup keys
// its option testid off the row `id`, and the pill/profile card shows the
// `discriminator`, so the mention specs need both. `viewer` must be a member of
// `serverId`; `targetUserId` is the member being looked up.
export async function memberInfo(
  viewer: UserKey,
  serverId: string,
  targetUserId: string,
): Promise<{ id: string; discriminator: string }> {
  const res = await fetch(`${WEB_URL}/api/community/servers/${serverId}/members`, {
    headers: { Cookie: sessionCookie(viewer), Origin: WEB_URL },
  })
  if (!res.ok) throw new Error(`memberInfo list failed (${res.status})`)
  const data = (await res.json()) as { members: Array<{ id: string; userId: string; discriminator?: string }> }
  const found = data.members.find((m) => m.userId === targetUserId)
  if (!found?.discriminator) throw new Error(`memberInfo: no discriminator for ${targetUserId}`)
  return { id: found.id, discriminator: found.discriminator }
}

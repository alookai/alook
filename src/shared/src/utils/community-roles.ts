export type CommunityRole = "owner" | "admin" | "member"
export type ChannelType = "text" | "forum"
export type StoredChannelType = "text" | "forum" | "forum_post" | "thread"

export const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
} as const

export const ASSIGNABLE_ROLES = ["admin", "member"] as const
export type AssignableRole = typeof ASSIGNABLE_ROLES[number]

export const CHANNEL_TYPES = ["text", "forum"] as const

export function canManageServer(role?: string | null): boolean {
  return role === ROLES.OWNER || role === ROLES.ADMIN
}

export function isServerOwner(role?: string | null): boolean {
  return role === ROLES.OWNER
}

/**
 * The single private-channel visibility rule, shared by both access predicates
 * (`getChannelForMember` — read/post path — and `requireChannelAccess` /
 * `resolveChannelAccessContext` — manage path) plus `canBotReadWakeScope`, so
 * the rule can never drift between them. Only the unit's creator or an explicit
 * member may see a private channel/post. Callers only invoke this once they
 * know the anchor is private. Pure.
 *
 * NOTE: a server admin/owner has NO special CONTENT access to private units —
 * they see/read/post a private channel only if they created it or were added,
 * exactly like a normal member. Admins manage servers via admin-gated routes
 * (and the future Browse Channels settings surface), not by implicitly seeing
 * every private conversation. `role` is retained in the signature for callers
 * that still pass it, but it no longer grants visibility.
 */
export function canSeePrivateChannel(input: {
  role?: string | null | undefined
  isCreator: boolean
  isChannelMember: boolean
}): boolean {
  return input.isCreator || input.isChannelMember
}

export function isAssignableRole(role: unknown): role is AssignableRole {
  return typeof role === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(role)
}

export function isChannelType(t: unknown): t is ChannelType {
  return typeof t === "string" && (CHANNEL_TYPES as readonly string[]).includes(t)
}

export function isForum(t: string | null | undefined): boolean {
  return t === "forum"
}

export function isForumPost(t: string | null | undefined): boolean {
  return t === "forum_post"
}

export function isThread(t: string | null | undefined): boolean {
  return t === "thread"
}

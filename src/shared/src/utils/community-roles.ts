export type CommunityRole = "owner" | "admin" | "member"
export type ChannelType = "text" | "forum"
// Every value the `community_channel.type` column can hold. DMs became channels
// with `type='dm'` in migration 0068 (`isDm` below has always checked for it),
// but this union previously omitted `dm` — a real type-level gap. Widened to
// the full stored set so code that switches on a channel's stored type is
// exhaustive over DM channels too.
//
// `forum_post` deleted: a post is now just an ordinary thread whose opener
// message happens to have a title-shaped `content` — no distinguishing type
// value, because a post under a forum has zero structural difference from
// any other thread. Migration 0082 type-flips every existing forum_post row
// to `thread` before this union narrows; the fold is zero-schema-difference
// by construction (see create-channels.ts's createMessageWithThread doc for
// the full shape).
export type StoredChannelType = "text" | "forum" | "thread" | "dm"

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

// Private content requires creator/access membership; server role gives no bypass.
export function canSeePrivateChannel(input: {
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

export function isThread(t: string | null | undefined): boolean {
  return t === "thread"
}

export function isDm(t: string | null | undefined): boolean {
  return t === "dm"
}

// Every stored type is message-bearing — a channel/forum/thread/DM can all
// receive a send. This IS isStoredChannelType(t); kept as its own named
// predicate so send/react/pin call sites read as "is this surface legitimate
// to write to," not a re-derived type check (phase2 forum≡thread reversed
// this from an allowlist that excluded plain `forum` — see git history on
// this function for that transition).
export function isMessageBearingSurface(t: string | null | undefined): boolean {
  return isStoredChannelType(t)
}

// Each stored channel type has one closed value on each addressing, visibility, reach and creation axis.
// Canonical addressing must not acquire a second address from a display title.
// Participant-set sends enroll the author and mentioned/replied users; recipients read that same set.
// DM visibility uses relation='access' with no server walk or parent inheritance.
// Access-miss status belongs to the caller's surface; visibility only selects the resolver.
// get-or-create returns one existing winner; reject-on-collision creates no row and returns 409.
export type AddressingTrait = "by-server-name" | "by-root-seq" | "by-peer-identity"

export type VisibilityTrait = "own-roster" | "inherit-parent" | "dm-participant"

export type ReachTrait = "server-or-roster" | "participant-set" | "dm-pair"

export type CreationTrait = "get-or-create" | "reject-on-collision"
export type MessagePropertyType = "tag" | "emoji" | "mark"

export type ChannelTraits = {
  addressing: AddressingTrait
  visibility: VisibilityTrait
  reach: ReachTrait
  creation: CreationTrait
  messageProperties: readonly MessagePropertyType[]
}

export const CHANNEL_TRAITS: Record<StoredChannelType, ChannelTraits> = {
  text: { addressing: "by-server-name", visibility: "own-roster", reach: "server-or-roster", creation: "reject-on-collision", messageProperties: ["emoji", "mark"] },
  forum: { addressing: "by-server-name", visibility: "own-roster", reach: "server-or-roster", creation: "reject-on-collision", messageProperties: ["tag", "mark"] },
  thread: { addressing: "by-root-seq", visibility: "inherit-parent", reach: "participant-set", creation: "get-or-create", messageProperties: ["emoji", "mark"] },
  dm: { addressing: "by-peer-identity", visibility: "dm-participant", reach: "dm-pair", creation: "get-or-create", messageProperties: ["emoji", "mark"] },
}

export function messagePropertyCapabilities(t: StoredChannelType): readonly MessagePropertyType[] {
  return CHANNEL_TRAITS[t].messageProperties
}

export function supportsMessageProperty(
  t: string | null | undefined,
  property: MessagePropertyType,
): boolean {
  return isStoredChannelType(t) && messagePropertyCapabilities(t).includes(property)
}

export function channelReach(t: StoredChannelType): ReachTrait {
  return CHANNEL_TRAITS[t].reach
}

export function reachIsParticipantSet(t: string | null | undefined): boolean {
  return isStoredChannelType(t) && channelReach(t) === "participant-set"
}

export function isStoredChannelType(t: string | null | undefined): t is StoredChannelType {
  return t === "text" || t === "forum" || t === "thread" || t === "dm"
}

export function channelVisibility(t: StoredChannelType): VisibilityTrait {
  return CHANNEL_TRAITS[t].visibility
}

export function visibilityIsDmParticipant(t: string | null | undefined): boolean {
  return isStoredChannelType(t) && channelVisibility(t) === "dm-participant"
}

export function channelCreation(t: StoredChannelType): CreationTrait {
  return CHANNEL_TRAITS[t].creation
}

import type { CommunityResourceProfile, CommunityMemberRelation, CommunityChannelIdentity } from "@alook/shared"

export type Presence = "online" | "offline"

export type CommunityProfile = Pick<CommunityResourceProfile, "id"> & Partial<CommunityUserCore> & {
  aboutMe?: string
  bannerColor?: string | null
  kind?: "human" | "bot"
  ownerUserId?: string | null
  ownerHandle?: string | null
  mutualServers?: number
  ownedByViewer?: boolean
  statusEmoji?: CommunityResourceProfile["statusEmoji"]
  statusText?: CommunityResourceProfile["statusText"] | null
  presence?: Presence
}

export type CommunityProfilePatch = Pick<CommunityProfile, "id"> & {
  identityAbout?: Partial<Pick<
    CommunityProfile,
    "name" | "discriminator" | "aboutMe" | "bannerColor" | "kind" | "ownerUserId"
  >>
  avatar?: Pick<CommunityUserCore, "avatar" | "avatarVersion">
  status?: Pick<CommunityProfile, "statusEmoji" | "statusText">
  card?: Pick<CommunityProfile, "ownerHandle" | "mutualServers" | "ownedByViewer">
  presence?: Presence
}

export type CommunityUserCore = {
  [Field in "name" | "discriminator" | "avatar" | "avatarVersion"]: NonNullable<CommunityResourceProfile[Field]>
}

export type Member = CommunityUserCore & Pick<CommunityProfile, "statusEmoji" | "statusText"> & Pick<CommunityMemberRelation, "userId"> & Partial<Pick<CommunityMemberRelation, "isCreator">> & {
  id: string
  status: Presence
  sub: string
  role: import("@alook/shared").CommunityRole
  source?: "explicit" | "inherited" | "admin" | import("@alook/shared").ParticipantSource
}

export type Friend = CommunityUserCore & Pick<CommunityProfile, "statusEmoji" | "statusText"> & Partial<Pick<CommunityMemberRelation, "userId">> & {
  id: string
  status: Presence
  sub: string
}

export type PendingRequest = Pick<CommunityUserCore, "name" | "avatar" | "avatarVersion"> & {
  id: string
  userId: CommunityProfile["id"]
  kind: "incoming" | "outgoing"
  // The gating owner id while a bot-touched row is pending; null once
  // unlocked. Drives whether Approve/Reject buttons render.
  needsOwnerApproval?: string | null
}

export type BlockedUser = Pick<CommunityUserCore, "name" | "avatar" | "avatarVersion"> & {
  id: string
  userId?: CommunityProfile["id"]
}

// DM summary shown in the DM sidebar. Actual conversation history is loaded
// into `ctx.messages` once the user opens the DM — DM summaries don't carry
// inline messages.
export type DM = CommunityUserCore & {
  id: CommunityChannelIdentity["id"] // DM conversation nanoid — NOT the peer's user id (that's `userId`)
  userId: CommunityProfile["id"]
  status: Presence
  preview: string
  /** Server-authoritative `lastMessageAt ?? createdAt`, used only for list order. */
  activityAt?: NonNullable<CommunityChannelIdentity["lastMessageAt"]>
  unread?: boolean
  lastUnreadSeq?: number
}

// ── Settings rows ──────────────────────────────────────────────────────────
export type InviteRow = {
  code: string
  uses: number
  maxUses: number | null // null = unlimited
  expiresAt: string | null // ISO timestamp or null = never
  by: string
  creatorId: string | null
}

export type BotActivityDay = {
  // Calendar day, "YYYY-MM-DD".
  day: string
  handledCount: number
  sentCount: number
}

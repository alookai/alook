import type { CommunityResourceProfile } from "@alook/shared"

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

export type CommunityProfilePatch = {
  id: string
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

export type Member = CommunityUserCore & {
  id: string
  userId: string
  status: Presence
  sub: string
  role: import("@alook/shared").CommunityRole
  // Custom status (emoji + short term) — see `Profile.statusEmoji`/`statusText`.
  statusEmoji?: string | null
  statusText?: string | null
  // Populated only when the drawer shows a private channel/post roster or a
  // thread participant set — drives the row's Leave/Remove right-click menu.
  //   - isCreator: this user owns the unit (row locked — never removable/leaveable).
  //   - source: for a channel/post, only "explicit" rows are removable (an
  //     admin-by-role or inherited public member isn't an explicit roster row).
  //     Thread participants are always "explicit"-equivalent (a real row).
  isCreator?: boolean
  source?: "explicit" | "inherited" | "admin" | import("@alook/shared").ParticipantSource
}

export type Friend = CommunityUserCore & {
  id: string
  // Optional here (unlike Member/DM) — some friend rows predate a resolved
  // userId; that's the one field that keeps Friend from a plain intersection.
  userId?: string
  status: Presence
  sub: string
  // Custom status (emoji + short term) — see `Profile.statusEmoji`/`statusText`.
  statusEmoji?: string | null
  statusText?: string | null
}

export type PendingRequest = Pick<CommunityUserCore, "name" | "avatar" | "avatarVersion"> & {
  id: string
  userId: string
  kind: "incoming" | "outgoing"
  // The gating owner id while a bot-touched row is pending; null once
  // unlocked. Drives whether Approve/Reject buttons render.
  needsOwnerApproval?: string | null
}

export type BlockedUser = Pick<CommunityUserCore, "name" | "avatar" | "avatarVersion"> & {
  id: string
  userId?: string
}

// DM summary shown in the DM sidebar. Actual conversation history is loaded
// into `ctx.messages` once the user opens the DM — DM summaries don't carry
// inline messages.
export type DM = CommunityUserCore & {
  id: string // DM conversation nanoid — NOT the peer's user id (that's `userId`)
  userId: string
  status: Presence
  preview: string
  /** Server-authoritative `lastMessageAt ?? createdAt`, used only for list order. */
  activityAt?: string
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

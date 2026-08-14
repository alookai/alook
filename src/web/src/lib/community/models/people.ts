export type Presence = "online" | "offline"

// ── Members / friends / DMs ──────────────────────────────────────────────────
// Identity fields shared by every community user view-model (member / friend /
// DM). All three are required `string`: `user.name`/`user.discriminator` are
// NOT NULL columns always projected on live payloads. Requiring `discriminator`
// here (in one place) moves the "a mention target always has a tag" guarantee
// to compile time — see plans/mandatory-mention-discriminator.md. `userId` is
// NOT part of the core: it's required on Member/DM but optional on Friend, so
// each type declares it. Only types whose identity fields are identically
// shaped extend this — AddableMember/ThreadParticipant (nullable projections),
// Profile/UserProfile (renamed/merged shapes) intentionally stay standalone.
export type CommunityUserCore = {
  name: string
  discriminator: string
  avatar: string
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
  source?: "explicit" | "inherited" | "admin"
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

export type PendingRequest = {
  id: string
  userId: string
  name: string
  avatar: string
  kind: "incoming" | "outgoing"
  // The gating owner id while a bot-touched row is pending; null once
  // unlocked. Drives whether Approve/Reject buttons render.
  needsOwnerApproval?: string | null
}

export type BlockedUser = { id: string; userId?: string; name: string; avatar: string }

// DM summary shown in the DM sidebar. Actual conversation history is loaded
// into `ctx.messages` once the user opens the DM — DM summaries don't carry
// inline messages.
export type DM = CommunityUserCore & {
  id: string // DM conversation nanoid — NOT the peer's user id (that's `userId`)
  userId: string
  status: Presence
  preview: string
  unread?: boolean
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

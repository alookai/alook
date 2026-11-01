import { CommunityResourceProfileSchema, type CommunityResourceProfile } from "@alook/shared"

import { canonicalUserImage } from "./storage"

// Canonical row shape the member-list queries produce. Bot columns
// (`userIsBot`/`userOwnerUserId`) are optional — `searchMembers` doesn't select
// them, so search callers pass rows without them (and `botGating: false`).
export type MemberRow = {
  id: string
  userId: string
  role: string | null
  userName: string | null
  userImage: string | null
  userAvatarVersion: number
  discriminator: string | null
  statusEmoji: string | null
  statusText: string | null
  userIsBot?: boolean
  userOwnerUserId?: string | null
}

export type MappedMember = Pick<CommunityResourceProfile, "name" | "discriminator" | "avatar" | "avatarVersion"> & Required<Pick<CommunityResourceProfile, "statusEmoji" | "statusText">> & {
  id: string
  userId: string
  status: "online" | "offline"
  sub: string
  role: string
  isCreator?: boolean
  source?: string
  isBot?: true
  ownerUserId?: string
}

// The single canonical member-DTO mapper shared by every UI member-list
// endpoint. Bot ownership is exposed only when botGating is enabled and the
// actor owns that bot. Search rows do not carry bot ownership columns.
export function mapMemberForApi(
  row: MemberRow,
  viewerUserId: string,
  opts?: { botGating?: boolean; isCreator?: boolean; source?: string },
): MappedMember {
  const display = CommunityResourceProfileSchema.shape.name.parse(row.userName)
  const isOwnBot =
    !!opts?.botGating &&
    row.userIsBot === true &&
    row.userOwnerUserId === viewerUserId
  return {
    id: row.id,
    userId: row.userId,
    name: display,
    discriminator: CommunityResourceProfileSchema.shape.discriminator.parse(row.discriminator),
    avatar: canonicalUserImage(row.userId, row.userImage, row.userAvatarVersion),
    avatarVersion: row.userAvatarVersion,
    status: row.userId === viewerUserId ? "online" : "offline",
    sub: "",
    role: row.role ?? "member",
    statusEmoji: row.statusEmoji ?? null,
    statusText: row.statusText,
    ...(opts?.isCreator !== undefined ? { isCreator: opts.isCreator } : {}),
    ...(opts?.source !== undefined ? { source: opts.source } : {}),
    ...(isOwnBot ? { isBot: true as const, ownerUserId: row.userOwnerUserId! } : {}),
  }
}

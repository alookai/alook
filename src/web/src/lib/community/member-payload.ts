import { avatarInitial } from "./avatar"

// Canonical row shape the member-list queries produce. Bot columns
// (`userIsBot`/`userOwnerUserId`) are optional — `searchMembers` doesn't select
// them, so search callers pass rows without them (and `botGating: false`).
export type MemberRow = {
  id: string
  userId: string
  role: string | null
  nickname: string | null
  userName: string | null
  userImage: string | null
  discriminator: string | null
  statusEmoji: string | null
  statusText: string | null
  userIsBot?: boolean
  userOwnerUserId?: string | null
}

export type MappedMember = {
  id: string
  userId: string
  name: string
  discriminator: string | undefined
  avatar: string
  status: "online" | "offline"
  sub: string
  role: string
  statusEmoji: string | null
  statusText: string
  isCreator?: boolean
  source?: string
  isBot?: true
  ownerUserId?: string
}

// The single canonical member-DTO mapper shared by every UI member-list
// endpoint. Centralizes the `nickname ?? userName` display fallback, the
// `avatarInitial` default, the self-→`online` status guess, the constant
// `sub: ""` (the client `Member` type requires `sub: string`), and the
// owner-scoped `isBot`/`ownerUserId` projection.
//
// `botGating` is opt-in: only the server-members LIST route applies the
// owner-scoped `isBot`/`ownerUserId` projection. The search route never emitted
// bot fields (and doesn't select the columns), so it passes `botGating: false`
// to stay byte-identical.
export function memberDisplay(
  nickname: string | null | undefined,
  userName: string | null | undefined,
): string {
  return nickname ?? userName ?? ""
}

export function mapMemberForApi(
  row: MemberRow,
  viewerUserId: string,
  opts?: { botGating?: boolean; isCreator?: boolean; source?: string },
): MappedMember {
  const display = memberDisplay(row.nickname, row.userName)
  const isOwnBot =
    !!opts?.botGating &&
    row.userIsBot === true &&
    row.userOwnerUserId === viewerUserId
  return {
    id: row.id,
    userId: row.userId,
    name: display,
    discriminator: row.discriminator ?? undefined,
    avatar: row.userImage ?? avatarInitial(display),
    status: row.userId === viewerUserId ? "online" : "offline",
    sub: "",
    role: row.role ?? "member",
    statusEmoji: row.statusEmoji ?? null,
    statusText: row.statusText ?? "",
    ...(opts?.isCreator !== undefined ? { isCreator: opts.isCreator } : {}),
    ...(opts?.source !== undefined ? { source: opts.source } : {}),
    ...(isOwnBot ? { isBot: true as const, ownerUserId: row.userOwnerUserId! } : {}),
  }
}

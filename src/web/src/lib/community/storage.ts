export const ATTACHMENT_PRIVATE_IMMUTABLE_CACHE = "private, max-age=31536000, immutable"

/**
 * Sanitize a filename component that will be embedded into an R2 key. Strips
 * `..`, replaces `/` and any C0 / DEL control character with `_`, and caps
 * total length at 255. Closes an R2-key injection hole in the media-key
 * builder: without this, a filename like `../../server-icon/foo/bar.png`
 * would be inserted verbatim, letting a caller with attachment-upload access
 * write outside its target's prefix.
 */
export function sanitizeAttachmentFilename(input: string): string {
  const cleaned = input
    .replace(/\.\./g, "_")
    .replace(/[\/\x00-\x1f\x7f]/g, "_")
  if (cleaned.length === 0) return "_"
  return cleaned.length > 255 ? cleaned.slice(0, 255) : cleaned
}

/**
 * Read/render URL for a persisted attachment, served by the canonical
 * `GET /api/community/channels/{targetId}/attachments/{attachmentId}` door.
 * Every read-side call site (`groupAttachments`, the reserve/incoming arms of
 * the message-create handler) builds display URLs through this helper so the
 * id-addressed attachment scheme lives in one place.
 *
 * The `{targetId}` path segment is a routing anchor only — the download door
 * authorizes from the attachment ROW's own channel, never from the path — so a
 * stale/forged targetId can't reach another row's bytes.
 */
export function attachmentUrl(targetId: string, attachmentId: string): string {
  return `/api/community/channels/${targetId}/attachments/${attachmentId}`
}

export function attachmentThumbnailUrl(targetId: string, attachmentId: string): string {
  return `${attachmentUrl(targetId, attachmentId)}/thumbnail`
}

export function buildAttachmentThumbnailKey(originalKey: string): string {
  return `${originalKey}.thumbnail.jpg`
}

// R2 storage key builders
export function buildMediaKey(type: "channel" | "dm" | "thread", id: string, fileId: string, filename: string): string {
  return `${type}/${id}/${fileId}/${sanitizeAttachmentFilename(filename)}`
}

export function buildServerIconKey(serverId: string, fileId: string): string {
  return `server-icon/${serverId}/${fileId}`
}

export function isOwnedServerIconKey(key: string, serverId: string): boolean {
  const prefix = `server-icon/${serverId}/`
  if (!key.startsWith(prefix)) return false
  const suffix = key.slice(prefix.length)
  return suffix.length > 0 && !suffix.includes("/")
}

// Stable aliases remain deterministic for rollback compatibility. New avatar
// publications write immutable `/objects/<uuid>` children and D1 points at
// exactly one child; the canonical read URL carries that D1 version.
export function buildUserAvatarKey(userId: string): string {
  return `user-avatar/${userId}`
}

export function buildUserAvatarObjectKey(userId: string, fileId: string): string {
  return `${buildUserAvatarKey(userId)}/objects/${fileId}`
}

export function isOwnedUserAvatarObjectKey(key: string, userId: string): boolean {
  const prefix = `${buildUserAvatarKey(userId)}/objects/`
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : ""
  return suffix.length > 0 && !suffix.includes("/")
}

export function userAvatarUrl(userId: string, avatarVersion?: number): string {
  const base = `/api/community/users/${userId}/avatar`
  return avatarVersion && avatarVersion > 0 ? `${base}?v=${avatarVersion}` : base
}

export function buildBotAvatarKey(botId: string): string {
  return `bot-avatar/${botId}`
}

export function buildBotAvatarObjectKey(botId: string, fileId: string): string {
  return `${buildBotAvatarKey(botId)}/objects/${fileId}`
}

export function isOwnedBotAvatarObjectKey(key: string, botId: string): boolean {
  const prefix = `${buildBotAvatarKey(botId)}/objects/`
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : ""
  return suffix.length > 0 && !suffix.includes("/")
}

export function botAvatarUrl(botId: string, avatarVersion?: number): string {
  const base = `/api/community/bots/${botId}/avatar`
  return avatarVersion && avatarVersion > 0 ? `${base}?v=${avatarVersion}` : base
}

export function canonicalUserImage(
  userId: string,
  image: string | null,
  avatarVersion: number,
): string | null {
  if (!image) return null
  if (image === userAvatarUrl(userId)) return userAvatarUrl(userId, avatarVersion)
  if (image === botAvatarUrl(userId)) return botAvatarUrl(userId, avatarVersion)
  return image
}

/**
 * Map a `communityServer` row to the public icon URL. The DB stores the R2
 * key; clients need a routable URL. Returns `null` when no icon is set so
 * callers can pass the value straight through to the response payload.
 */
export function serverIconUrl(server: { id: string; icon: string | null }): string | null {
  if (!server.icon) return null
  return `/api/community/servers/${server.id}/icon`
}

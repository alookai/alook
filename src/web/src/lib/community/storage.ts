export { communityUserAvatarUrl as userAvatarUrl, communityBotAvatarUrl as botAvatarUrl, canonicalCommunityUserImage as canonicalUserImage } from "@alook/shared"

export const ATTACHMENT_PRIVATE_IMMUTABLE_CACHE = "private, max-age=31536000, immutable"

export function attachmentUrl(targetId: string, attachmentId: string): string {
  return `/api/community/channels/${targetId}/attachments/${attachmentId}`
}

export function attachmentThumbnailUrl(targetId: string, attachmentId: string): string {
  return `${attachmentUrl(targetId, attachmentId)}/thumbnail`
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

export function serverIconUrl(server: { id: string; icon: string | null }): string | null {
  if (!server.icon) return null
  return `/api/community/servers/${server.id}/icon?v=${encodeURIComponent(server.icon)}`
}

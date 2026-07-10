// R2 storage key builders
export function buildMediaKey(type: "channel" | "dm" | "thread", id: string, fileId: string, filename: string): string {
  return `${type}/${id}/${fileId}/${filename}`
}

export function buildServerIconKey(serverId: string, fileId: string): string {
  return `server-icon/${serverId}/${fileId}`
}

// Deterministic keys — unlike server icons (random `fileId`, old key deleted
// on replace), user/bot avatars overwrite the same R2 object in place, so the
// routable URL stored on the DB row never changes across re-uploads.
export function buildUserAvatarKey(userId: string): string {
  return `user-avatar/${userId}`
}

export function userAvatarUrl(userId: string): string {
  return `/api/community/users/${userId}/avatar`
}

export function buildBotAvatarKey(botId: string): string {
  return `bot-avatar/${botId}`
}

export function botAvatarUrl(botId: string): string {
  return `/api/community/bots/${botId}/avatar`
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

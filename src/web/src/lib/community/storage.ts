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
    // eslint-disable-next-line no-control-regex
    .replace(/[\/\x00-\x1f\x7f]/g, "_")
  if (cleaned.length === 0) return "_"
  return cleaned.length > 255 ? cleaned.slice(0, 255) : cleaned
}

/**
 * Derive the routable media URL from a stored R2 key. Every read-side call
 * site (`groupAttachments`, `mapMessageForApi`, `mapMessageForWs`) goes
 * through this helper so the `/api/community/media/` prefix lives in one
 * place.
 */
export function mediaUrlFromKey(r2Key: string): string {
  return `/api/community/media/${r2Key}`
}

// R2 storage key builders
export function buildMediaKey(type: "channel" | "dm" | "thread", id: string, fileId: string, filename: string): string {
  return `${type}/${id}/${fileId}/${sanitizeAttachmentFilename(filename)}`
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

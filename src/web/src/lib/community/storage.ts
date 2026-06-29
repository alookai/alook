// R2 storage key builders
export function buildMediaKey(type: "channel" | "dm" | "thread", id: string, fileId: string, filename: string): string {
  return `${type}/${id}/${fileId}/${filename}`
}

export function buildServerIconKey(serverId: string, fileId: string): string {
  return `server-icon/${serverId}/${fileId}`
}

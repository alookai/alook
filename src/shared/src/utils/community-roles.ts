export type CommunityRole = "owner" | "admin" | "member"
export type ChannelType = "text" | "forum"

export function canManageServer(role?: string | null): boolean {
  return role === "owner" || role === "admin"
}

export function isServerOwner(role?: string | null): boolean {
  return role === "owner"
}

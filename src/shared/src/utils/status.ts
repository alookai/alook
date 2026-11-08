

export function isPresenceOnline(status: string | null | undefined): boolean {
  return status === "online"
}
export function isPresenceOffline(status: string | null | undefined): boolean {
  return status === "offline"
}

export type FriendshipStatus = "pending" | "accepted" | "blocked"

export const FRIENDSHIP_STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  BLOCKED: "blocked",
} as const

export function isAccepted(status: string | null | undefined): boolean {
  return status === FRIENDSHIP_STATUS.ACCEPTED
}

export function isPending(status: string | null | undefined): boolean {
  return status === FRIENDSHIP_STATUS.PENDING
}

export function isBlocked(status: string | null | undefined): boolean {
  return status === FRIENDSHIP_STATUS.BLOCKED
}

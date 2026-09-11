import type { PendingRequest } from "./models/people"

export function actionableIncomingRequests(
  pending: readonly PendingRequest[] | null | undefined,
): PendingRequest[] {
  return (pending ?? []).filter(
    (request) => request.kind === "incoming" && request.needsOwnerApproval == null,
  )
}

export function compactRequestCount(count: number): string | null {
  if (count <= 0) return null
  return count > 99 ? "99+" : String(count)
}

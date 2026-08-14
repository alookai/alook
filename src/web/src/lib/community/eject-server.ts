import type { Server } from "./models/navigation"
import { ApiError } from "@/lib/errors"

// Module-scoped marker set. The "Leave" button in the server rail marks
// the server id here BEFORE firing the mutation; the layout's eject effect
// consumes it — if present, the leave was voluntary and the button owns
// the toast, so the layout stays silent. Any other trigger (kick, server
// delete, forbidden URL) finds no marker and shows the involuntary toast.
//
// Set-backed, not a ref, because the button and the layout live in
// sibling subtrees and threading a context just for this is heavier than
// the coordination warrants. Same trick as `wsStore.hasSeenMessage`.
const voluntaryLeaves = new Set<string>()

export function markVoluntaryLeave(serverId: string): void {
  voluntaryLeaves.add(serverId)
}

// Returns true iff the id was marked; clears the marker either way.
export function consumeVoluntaryLeave(serverId: string): boolean {
  return voluntaryLeaves.delete(serverId)
}

export function isDefinitiveChildMetaFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}

// Pure destination picker for the post-eject redirect. When the viewer
// has any other servers, the first (railOrder-sorted from the API) wins.
// Otherwise the DM home is the only safe landing spot.
export function pickPostEjectDestination(
  servers: readonly Server[],
  ejectedServerId: string,
): string {
  const remaining = servers.filter((s) => s.id !== ejectedServerId)
  if (remaining.length === 0) return "/c/me"
  return `/c/channels/${remaining[0].id}`
}

export function runAuthoritativeServerEject(args: {
  serverId: string
  servers: readonly Server[]
  isSuccess: boolean
  isFetching: boolean
  consumeVoluntaryLeave: (serverId: string) => boolean
  clearLastChannel: (serverId: string) => void
  toast: (message: string) => void
  replace: (destination: string) => void
}): boolean {
  // Absence is authoritative only on a settled successful snapshot. A first
  // failure has isFetched=true in TanStack, and a failed background refetch can
  // retain last-good data; neither may become an existence/membership verdict.
  if (!args.isSuccess || args.isFetching) return false
  if (args.servers.some((server) => server.id === args.serverId)) return false

  args.clearLastChannel(args.serverId)
  const voluntary = args.consumeVoluntaryLeave(args.serverId)
  if (!voluntary) args.toast("You're no longer in this server")
  args.replace(pickPostEjectDestination(args.servers, args.serverId))
  return true
}

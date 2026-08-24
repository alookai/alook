import type { QueryClient } from "@tanstack/react-query"

export type ReadCoordinatorSnapshot = {
  readStates: Array<{ channelId: string; lastReadSeq: number }>
  forumOpenerReads?: Array<{ openerMessageId: string }>
}

type SnapshotProjector = (snapshot: ReadCoordinatorSnapshot) => void

const snapshotProjectors = new WeakMap<QueryClient, SnapshotProjector>()

export function registerReadCoordinatorSnapshotProjector(
  queryClient: QueryClient,
  projector: SnapshotProjector,
) {
  snapshotProjectors.set(queryClient, projector)
}

export function unregisterReadCoordinatorSnapshotProjector(queryClient: QueryClient) {
  snapshotProjectors.delete(queryClient)
}

export function projectReadCoordinatorSnapshot(
  queryClient: QueryClient,
  snapshot: ReadCoordinatorSnapshot,
) {
  snapshotProjectors.get(queryClient)?.(snapshot)
}

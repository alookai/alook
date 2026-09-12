"use client"

import {
  useCallback,
  useSyncExternalStore,
} from "react"
import {
  hashKey,
  useQueryClient,
  type QueryClient,
  type QueryCacheNotifyEvent,
} from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

export type FriendRequestAction = "accept" | "reject"
type FriendRequestActionStatus = "pending" | "error"
export type FriendRequestSurface = "inbox" | "friends"

type FriendRequestRow = {
  id: string
  userId?: string
}

type CapturedRow = {
  row: FriendRequestRow
  index: number
}

type ActionEntry = {
  action: FriendRequestAction
  baselineEpoch: number
  generation: number
  promise?: Promise<void>
  settled: boolean
  snapshots: Partial<Record<FriendRequestSurface, CapturedRow>>
  status: FriendRequestActionStatus
}

type TerminalFence = {
  cancellation?: Promise<void>
  epoch: number
  proofs: Set<FriendRequestSurface>
}

type UserTerminalFence = {
  epoch: number
  proofs: Set<FriendRequestSurface>
}

type FriendsEnvelope = {
  pending?: readonly FriendRequestRow[]
}

type InboxEnvelope = {
  friendRequests?: readonly FriendRequestRow[]
}

export type ActionableFriendRequest<T> = {
  row: T
  action?: FriendRequestAction
  status?: FriendRequestActionStatus
  error?: string
}

const controllers = new WeakMap<QueryClient, FriendRequestActionController>()
const friendsHash = hashKey(communityKeys.friends())
const inboxHash = hashKey(communityKeys.inboxUnreads())

function captureRow<T extends FriendRequestRow>(
  rows: readonly T[],
  id: string,
): CapturedRow | undefined {
  const index = rows.findIndex((row) => row.id === id)
  return index < 0 ? undefined : { row: rows[index]!, index }
}

function rowsFromEnvelope(
  surface: FriendRequestSurface,
  data: unknown,
): readonly FriendRequestRow[] {
  if (!data || typeof data !== "object") return []
  if (surface === "friends") {
    return (data as FriendsEnvelope).pending ?? []
  }
  return (data as InboxEnvelope).friendRequests ?? []
}

function surfaceForHash(queryHash: string): FriendRequestSurface | undefined {
  if (queryHash === friendsHash) return "friends"
  if (queryHash === inboxHash) return "inbox"
  return undefined
}

class FriendRequestActionController {
  private readonly actions = new Map<string, ActionEntry>()
  private readonly listeners = new Set<() => void>()
  private readonly readStarts = new Map<string, number>()
  private readonly terminals = new Map<string, TerminalFence>()
  private readonly userTerminals = new Map<string, UserTerminalFence>()
  private clock = 0
  private version = 0

  constructor(private readonly queryClient: QueryClient) {
    queryClient.getQueryCache().subscribe((event) => this.onQueryEvent(event))
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.version

  private publish() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  private captureCaches(id: string) {
    const friends = this.queryClient.getQueryData<FriendsEnvelope>(communityKeys.friends())
    const inbox = this.queryClient.getQueryData<InboxEnvelope>(communityKeys.inboxUnreads())
    return {
      friends: captureRow(friends?.pending ?? [], id),
      inbox: captureRow(inbox?.friendRequests ?? [], id),
    }
  }

  private refreshSnapshots(entry: ActionEntry, id: string) {
    const captured = this.captureCaches(id)
    if (captured.friends) entry.snapshots.friends = captured.friends
    if (captured.inbox) entry.snapshots.inbox = captured.inbox
  }

  claimMutation(id: string, action: FriendRequestAction) {
    const current = this.actions.get(id)
    if (current?.status === "pending") {
      this.refreshSnapshots(current, id)
      return current.generation
    }
    if (this.terminals.has(id)) return current?.generation ?? 0
    const entry: ActionEntry = {
      action,
      baselineEpoch: ++this.clock,
      generation: (current?.generation ?? 0) + 1,
      settled: false,
      snapshots: current?.snapshots ?? {},
      status: "pending",
    }
    this.refreshSnapshots(entry, id)
    this.actions.set(id, entry)
    this.publish()
    return entry.generation
  }

  isCompensatable(id: string, generation: number) {
    const entry = this.actions.get(id)
    return Boolean(
      entry
      && entry.generation === generation
      && !this.terminals.has(id),
    )
  }

  publishError(id: string, generation: number) {
    const entry = this.actions.get(id)
    if (
      !entry
      || entry.generation !== generation
      || this.terminals.has(id)
      || entry.status === "error"
    ) return false
    entry.status = "error"
    entry.promise = undefined
    this.publish()
    return true
  }

  publishTerminal(id: string, generation?: number) {
    const entry = this.actions.get(id)
    if (generation !== undefined && entry?.generation !== generation) return false
    if (this.terminals.has(id)) return true
    this.terminals.set(id, { epoch: ++this.clock, proofs: new Set() })
    this.publish()
    return true
  }

  publishTerminalForUser(userId: string) {
    const existingUserFence = this.userTerminals.get(userId)
    const epoch = existingUserFence?.epoch ?? ++this.clock
    let changed = false
    if (!existingUserFence) {
      this.userTerminals.set(userId, { epoch, proofs: new Set() })
      changed = true
    }
    const ids = new Set<string>()
    for (const [id, entry] of this.actions) {
      if (Object.values(entry.snapshots).some((snapshot) => snapshot?.row.userId === userId)) {
        ids.add(id)
      }
    }
    const caches = this.captureRowsBySurface()
    for (const row of [...caches.friends, ...caches.inbox]) {
      if (row.userId === userId) ids.add(row.id)
    }
    for (const id of ids) {
      if (this.terminals.has(id)) continue
      this.terminals.set(id, { epoch, proofs: new Set() })
      changed = true
    }
    if (changed) this.publish()
  }

  async fenceReads() {
    await Promise.all([
      this.queryClient.cancelQueries({ queryKey: communityKeys.friends(), exact: true }),
      this.queryClient.cancelQueries({ queryKey: communityKeys.inboxUnreads(), exact: true }),
    ])
  }

  async publishTerminalAndFence(id: string, generation: number) {
    if (!this.publishTerminal(id, generation)) return false
    const fence = this.terminals.get(id)!
    fence.cancellation ??= this.fenceReads()
    await fence.cancellation
    return true
  }

  settleGeneration(id: string, generation: number) {
    const entry = this.actions.get(id)
    if (!entry || entry.generation !== generation) return
    entry.settled = true
    this.collectTerminal(id)
  }

  private captureRowsBySurface() {
    const friends = this.queryClient.getQueryData<FriendsEnvelope>(communityKeys.friends())
    const inbox = this.queryClient.getQueryData<InboxEnvelope>(communityKeys.inboxUnreads())
    return {
      friends: friends?.pending ?? [],
      inbox: inbox?.friendRequests ?? [],
    }
  }

  private collectTerminal(id: string) {
    const fence = this.terminals.get(id)
    if (!fence || fence.proofs.size !== 2) return
    const entry = this.actions.get(id)
    if (entry && !entry.settled) return
    const rows = this.captureRowsBySurface()
    if (
      rows.friends.some((row) => row.id === id)
      || rows.inbox.some((row) => row.id === id)
    ) return
    this.terminals.delete(id)
    this.actions.delete(id)
    this.publish()
  }

  private collectUserTerminal(userId: string) {
    const fence = this.userTerminals.get(userId)
    if (!fence || fence.proofs.size !== 2) return
    const rows = this.captureRowsBySurface()
    if (
      rows.friends.some((row) => row.userId === userId)
      || rows.inbox.some((row) => row.userId === userId)
    ) return
    this.userTerminals.delete(userId)
    this.publish()
  }

  private onQueryEvent(event: QueryCacheNotifyEvent) {
    if (event.type !== "updated") return
    const surface = surfaceForHash(event.query.queryHash)
    if (!surface) return
    if (event.action.type === "fetch") {
      this.readStarts.set(event.query.queryHash, ++this.clock)
      return
    }
    if (event.action.type !== "success" || event.action.manual) return
    const startEpoch = this.readStarts.get(event.query.queryHash)
    if (startEpoch === undefined) return
    const rows = rowsFromEnvelope(surface, event.action.data)
    const rowsById = new Map(rows.map((row, index) => [row.id, { row, index }]))
    const knownIds = new Set([...this.actions.keys(), ...this.terminals.keys()])
    let snapshotsChanged = false

    for (const [userId, fence] of this.userTerminals) {
      if (startEpoch <= fence.epoch) continue
      if (rows.some((row) => row.userId === userId)) fence.proofs.delete(surface)
      else fence.proofs.add(surface)
      this.collectUserTerminal(userId)
    }

    for (const id of knownIds) {
      const row = rowsById.get(id)
      const fence = this.terminals.get(id)
      if (fence) {
        if (startEpoch > fence.epoch) {
          if (row) fence.proofs.delete(surface)
          else fence.proofs.add(surface)
          this.collectTerminal(id)
        }
        continue
      }
      const entry = this.actions.get(id)
      if (!entry) continue
      if (row) {
        entry.snapshots[surface] = row
        snapshotsChanged = true
      } else if (startEpoch > entry.baselineEpoch) {
        void this.publishTerminalAndFence(id, entry.generation)
      }
    }
    if (snapshotsChanged) this.publish()
  }

  project<T extends FriendRequestRow>(
    surface: FriendRequestSurface,
    rows: readonly T[],
  ): Array<ActionableFriendRequest<T>> {
    const merged: Array<ActionableFriendRequest<T>> = []
    const present = new Set<string>()
    for (const row of rows) {
      if (
        this.terminals.has(row.id)
        || (row.userId !== undefined && this.userTerminals.has(row.userId))
      ) continue
      present.add(row.id)
      const entry = this.actions.get(row.id)
      merged.push(this.toItem(row, entry))
    }
    for (const [id, entry] of this.actions) {
      if (present.has(id) || this.terminals.has(id)) continue
      const snapshot = entry.snapshots[surface]
      if (!snapshot) continue
      if (
        snapshot.row.userId !== undefined
        && this.userTerminals.has(snapshot.row.userId)
      ) continue
      merged.splice(Math.min(snapshot.index, merged.length), 0, this.toItem(
        snapshot.row as T,
        entry,
      ))
    }
    return merged
  }

  private toItem<T extends FriendRequestRow>(
    row: T,
    entry: ActionEntry | undefined,
  ): ActionableFriendRequest<T> {
    return {
      row,
      action: entry?.action,
      status: entry?.status,
      ...(entry?.status === "error"
        ? { error: `Couldn’t ${entry.action} this request. Try again.` }
        : {}),
    }
  }

  start<T extends FriendRequestRow>({
    action,
    index,
    mutation,
    retry,
    row,
    surface,
  }: {
    action: FriendRequestAction
    index: number
    mutation: (id: string) => Promise<unknown>
    retry: boolean
    row: T
    surface: FriendRequestSurface
  }) {
    if (
      this.terminals.has(row.id)
      || (row.userId !== undefined && this.userTerminals.has(row.userId))
    ) return Promise.resolve()
    const current = this.actions.get(row.id)
    if (current?.status === "pending" && current.promise) return current.promise
    if (retry && current?.status !== "error") return Promise.resolve()

    const entry: ActionEntry = {
      action,
      baselineEpoch: ++this.clock,
      generation: (current?.generation ?? 0) + 1,
      settled: false,
      snapshots: current?.snapshots ?? {},
      status: "pending",
    }
    this.refreshSnapshots(entry, row.id)
    entry.snapshots[surface] = { row, index }
    this.actions.set(row.id, entry)
    this.publish()

    const task = (async () => {
      try {
        await mutation(row.id)
        await this.publishTerminalAndFence(row.id, entry.generation)
      } catch {
        this.publishError(row.id, entry.generation)
      } finally {
        this.settleGeneration(row.id, entry.generation)
      }
    })()
    entry.promise = task
    return task
  }
}

export function getFriendRequestActionController(queryClient: QueryClient) {
  let controller = controllers.get(queryClient)
  if (!controller) {
    controller = new FriendRequestActionController(queryClient)
    controllers.set(queryClient, controller)
  }
  return controller
}

export function useFriendRequestActionState<T extends FriendRequestRow>({
  rows,
  onAccept,
  onReject,
  surface,
}: {
  rows: readonly T[]
  onAccept?: (id: string) => Promise<unknown>
  onReject?: (id: string) => Promise<unknown>
  surface: FriendRequestSurface
}) {
  const queryClient = useQueryClient()
  const controller = getFriendRequestActionController(queryClient)
  useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const items = controller.project(surface, rows)

  const run = useCallback((
    item: ActionableFriendRequest<T>,
    action: FriendRequestAction,
    retry: boolean,
  ) => {
    const mutation = action === "accept" ? onAccept : onReject
    if (!mutation) return Promise.resolve()
    const index = items.findIndex((candidate) => candidate.row.id === item.row.id)
    return controller.start({
      action,
      index: Math.max(index, 0),
      mutation,
      retry,
      row: item.row,
      surface,
    })
  }, [controller, items, onAccept, onReject, surface])

  const act = useCallback((
    item: ActionableFriendRequest<T>,
    action: FriendRequestAction,
  ) => run(item, action, false), [run])

  const retry = useCallback((item: ActionableFriendRequest<T>) => (
    item.action ? run(item, item.action, true) : Promise.resolve()
  ), [run])

  return { items, act, retry }
}

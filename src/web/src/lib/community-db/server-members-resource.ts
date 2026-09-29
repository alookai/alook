import { parseLoadSubsetOptions } from "@tanstack/query-db-collection"
import type { LoadSubsetOptions } from "@tanstack/react-db"
import type {
  InfiniteData,
  QueryClient,
  QueryFunctionContext,
} from "@tanstack/react-query"
import type { Member } from "@/lib/community/models/people"
import {
  apiFetchProfiles,
  communityUserProfilePatch,
} from "@/lib/community/profile-seed"
import { createCursorPager, type CursorPager } from "./cursor-pager"
import {
  serverMembershipKey,
  type ServerMembershipRow,
} from "./schema"
import {
  serverMembersPagesKey,
  serverMembersRowsKey,
} from "./server-members-pagination"

export type ServerMembersEnvelope = {
  members: Member[]
  hasMore: boolean
  cursor?: string
  limit: number
  total: number
}

export type ServerMembersCursorPage = {
  rows: ReadonlyArray<ServerMembershipRow>
  nextCursor: string | null
  total: number
}

export type ServerMembersState = {
  fetchStatus: "fetching" | "idle" | "paused"
  hasMore: boolean
  loadedRows: number
  status: "pending" | "error" | "success"
  total: number
}

export type ServerMembersLease = {
  release: () => Promise<void>
  update: (limit: number) => Promise<void>
}

const DEFAULT_MEMBER_WINDOW = 50

function serverIdFromSubset(options: LoadSubsetOptions) {
  const ids = parseLoadSubsetOptions(options).filters.flatMap((filter) => (
    filter.operator === "eq"
    && filter.field.at(-1) === "serverId"
    && typeof filter.value === "string"
      ? [filter.value]
      : []
  ))
  return new Set(ids).size === 1 ? ids[0] : null
}

function normalizeMemberRow(
  accountId: string,
  serverId: string,
  member: Member,
): ServerMembershipRow {
  return {
    id: serverMembershipKey(serverId, member.userId),
    serverId,
    userId: member.userId,
    memberId: member.id,
    role: member.role,
    viewer: member.userId === accountId,
  }
}

export function readServerMembersState(
  queryClient: QueryClient,
  accountId: string,
  serverId: string,
): ServerMembersState {
  const state = queryClient.getQueryState<
    InfiniteData<ServerMembersCursorPage, string | undefined>
  >(serverMembersPagesKey(accountId, serverId))
  const pages = state?.data?.pages ?? []
  return {
    fetchStatus: state?.fetchStatus ?? "idle",
    hasMore: pages.length > 0 && pages.at(-1)?.nextCursor !== null,
    loadedRows: pages.reduce((count, page) => count + page.rows.length, 0),
    status: state?.status ?? "pending",
    total: pages.at(-1)?.total ?? 0,
  }
}

type DirectChange = { deleted: boolean }

export function createServerMembersCollectionDescriptor(
  queryClient: QueryClient,
  accountId: string,
) {
  const serverByRowsKey = new Map<string, string>()
  const pagers = new Map<string, CursorPager<ServerMembershipRow>>()
  const acquisitions = new Map<string, {
    highWater: number
    leases: Map<object, number>
    refresh: Promise<void>
  }>()
  const directChanges = new Map<string, Map<string, DirectChange>>()
  let readRows = (): Iterable<ServerMembershipRow> => []

  const queryKey = (options: LoadSubsetOptions = {}) => {
    const serverId = serverIdFromSubset(options)
    if (!serverId) {
      return ["community", "db", accountId, "server-members-resource", "rows"] as const
    }
    const key = serverMembersRowsKey(accountId, serverId)
    serverByRowsKey.set(JSON.stringify(key), serverId)
    return key
  }

  const pagerFor = (serverId: string) => {
    const pageKey = serverMembersPagesKey(accountId, serverId)
    const identity = JSON.stringify(pageKey)
    let pager = pagers.get(identity)
    if (pager) return pager
    pager = createCursorPager({
      queryClient,
      queryKey: pageKey,
      staleTime: Infinity,
      fetchPage: async (cursor, signal): Promise<ServerMembersCursorPage> => {
        const params = new URLSearchParams()
        if (cursor) params.set("cursor", cursor)
        const suffix = params.size > 0 ? `?${params}` : ""
        const page = await apiFetchProfiles<ServerMembersEnvelope>(
          `/api/community/servers/${encodeURIComponent(serverId)}/members${suffix}`,
          (value) => value.members.map((member) => (
            communityUserProfilePatch(member.userId, member)
          )),
          { signal },
        )
        if (page.hasMore && !page.cursor) {
          throw new TypeError("Member page declared continuation without a cursor")
        }
        return {
          rows: page.members.map((member) => normalizeMemberRow(accountId, serverId, member)),
          nextCursor: page.hasMore ? page.cursor! : null,
          total: page.total,
        }
      },
    })
    pagers.set(identity, pager)
    return pager
  }

  const queryFn = async (context: QueryFunctionContext): Promise<ServerMembershipRow[]> => {
    const serverId = serverByRowsKey.get(JSON.stringify(context.queryKey))
    if (!serverId) return []
    const acquisition = acquisitions.get(serverId)
    const fetched = await pagerFor(serverId).read({
      offset: 0,
      limit: acquisition?.highWater ?? DEFAULT_MEMBER_WINDOW,
    }, context.signal)
    const changes = directChanges.get(serverId)
    if (!changes || changes.size === 0) return fetched

    // The pager owns transport pages while the QueryCollection owns live rows.
    // Keep exact writes as an overlay until the next explicit reconciliation,
    // so loading another cached page cannot resurrect a kicked member or erase
    // a websocket role/join update.
    const rows = new Map(fetched.map((row) => [row.id, row]))
    const current = new Map(
      [...readRows()]
        .filter((row) => row.serverId === serverId)
        .map((row) => [row.id, row]),
    )
    for (const [id, change] of changes) {
      if (change.deleted) rows.delete(id)
      else {
        const row = current.get(id)
        if (row) rows.set(id, row)
      }
    }
    return [...rows.values()]
  }

  const refreshRows = (serverId: string) => queryClient.invalidateQueries({
    queryKey: serverMembersRowsKey(accountId, serverId),
    exact: true,
    refetchType: "active",
  }).then(() => undefined)

  const acquire = (serverId: string, requestedLimit: number): ServerMembersLease => {
    const token = {}
    const limit = Math.max(0, Math.trunc(requestedLimit))
    let acquisition = acquisitions.get(serverId)
    if (!acquisition) {
      acquisition = { highWater: limit, leases: new Map(), refresh: Promise.resolve() }
      acquisitions.set(serverId, acquisition)
    } else if (limit > acquisition.highWater) {
      acquisition.highWater = limit
      acquisition.refresh = refreshRows(serverId)
    }
    acquisition.leases.set(token, limit)
    let released = false
    return {
      update: async (nextLimit) => {
        if (released) return
        const current = acquisitions.get(serverId)
        if (!current || !current.leases.has(token)) return
        const normalized = Math.max(0, Math.trunc(nextLimit))
        current.leases.set(token, normalized)
        if (normalized <= current.highWater) return current.refresh
        current.highWater = normalized
        current.refresh = refreshRows(serverId)
        await current.refresh
      },
      release: async () => {
        if (released) return
        released = true
        const current = acquisitions.get(serverId)
        if (!current) return
        current.leases.delete(token)
        if (current.leases.size > 0) return
        acquisitions.delete(serverId)
      },
    }
  }

  const reconcile = async (serverId: string) => {
    const rowsKey = serverMembersRowsKey(accountId, serverId)
    const pagesKey = serverMembersPagesKey(accountId, serverId)
    await Promise.all([
      queryClient.cancelQueries({ queryKey: rowsKey, exact: true }),
      queryClient.cancelQueries({ queryKey: pagesKey, exact: true }),
    ])
    directChanges.delete(serverId)
    pagerFor(serverId).reset()
    await queryClient.invalidateQueries(
      { queryKey: rowsKey, exact: true, refetchType: "active" },
      { throwOnError: true },
    )
  }

  const markChanged = (serverId: string, id: string, deleted = false) => {
    let changes = directChanges.get(serverId)
    if (!changes) {
      changes = new Map()
      directChanges.set(serverId, changes)
    }
    changes.set(id, { deleted })
  }

  const adjustTotal = (serverId: string, delta: number) => {
    if (delta === 0) return
    queryClient.setQueryData<
      InfiniteData<ServerMembersCursorPage, string | undefined> | undefined
    >(serverMembersPagesKey(accountId, serverId), (data) => data ? {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        total: Math.max(0, page.total + delta),
      })),
    } : data)
  }

  return {
    acquire,
    adjustTotal,
    bindRows: (reader: () => Iterable<ServerMembershipRow>) => {
      readRows = reader
    },
    markChanged,
    queryFn,
    queryKey,
    reconcile,
  }
}

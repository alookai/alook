import { parseLoadSubsetOptions } from "@tanstack/query-db-collection"
import type { LoadSubsetOptions } from "@tanstack/react-db"
import type {
  InfiniteData,
  QueryClient,
  QueryFunctionContext,
} from "@tanstack/react-query"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
import type { MessagesPage, MessagesPageParam, Msg } from "@/lib/community/models/message"
import { createCursorPager, type CursorPager } from "./cursor-pager"
import {
  buildCommunityMessagesUrl,
  isMessageResourceQueryKey,
  messagePagesQueryKey,
  messageResourceQueryKey,
  messageRowsQueryKey,
  type MessageAccessScope,
  type MessageSequence,
} from "./message-pagination"
import type { MessageRow } from "./schema"

export type MessageCollectionDemand = {
  scope: MessageAccessScope
  tag: string | null
  sequence: MessageSequence
}

type MessageCursorPage = {
  rows: ReadonlyArray<MessageRow>
  nextCursor: string | null
  latestSeq: number
  surfaceReceipt?: MessageSurfaceReceipt
}

export type MessageSurfaceReceipt = {
  channelId: string
  surfaceKind: "channel" | "thread" | "forum" | "dm"
}

type MessagesTransportPage = MessagesPage & {
  surfaceReceipt?: MessageSurfaceReceipt
}

export type MessageSequenceState = {
  fetchStatus: "fetching" | "idle" | "paused"
  hasMore: boolean
  latestSeq: number
  loadedRows: number
  rowIds: string[]
  rows: MessageRow[]
  status: "pending" | "error" | "success"
}

export type MessageWindowLease = {
  release: () => Promise<void>
  update: (limit: number) => Promise<void>
}

export type MessageWindowPublication = {
  hasMore: boolean
  rows: ReadonlyArray<MessageRow>
  surfaceReceipt?: MessageSurfaceReceipt
}

function messageCollectionBaseKey(accountId: string) {
  return ["community", "db", accountId, "message-resource", "rows"] as const
}

function channelIdFromSubset(options: LoadSubsetOptions) {
  const ids = parseLoadSubsetOptions(options).filters.flatMap((filter) => (
    filter.operator === "eq"
    && filter.field.at(-1) === "channelId"
    && typeof filter.value === "string"
      ? [filter.value]
      : []
  ))
  return new Set(ids).size === 1 ? ids[0] : null
}

function defaultWindowLimit(demand: MessageCollectionDemand) {
  return demand.sequence.base.mode === "anchor" ? 26 : 50
}

function isMessageSurfaceReceipt(value: unknown): value is MessageSurfaceReceipt {
  if (!value || typeof value !== "object") return false
  const receipt = value as Partial<MessageSurfaceReceipt>
  return typeof receipt.channelId === "string" && (
    receipt.surfaceKind === "channel"
    || receipt.surfaceKind === "thread"
    || receipt.surfaceKind === "forum"
    || receipt.surfaceKind === "dm"
  )
}

function sequenceForSubset(
  demand: MessageCollectionDemand,
  options: LoadSubsetOptions,
): MessageSequence {
  const seqSort = parseLoadSubsetOptions(options).sorts.find((sort) => (
    sort.field.at(-1) === "seq"
  ))
  return {
    ...demand.sequence,
    direction: seqSort?.direction === "asc" ? "newer" : "older",
  }
}

function normalizeMessageRow(channelId: string, message: Msg): MessageRow | null {
  if (message.id.startsWith("temp_") || message.failed === true) return null
  return {
    ...message,
    type: message.type ?? "chat",
    channelId,
    replyToId: message.replyTo?.id,
  }
}

export function readMessageSequenceState(
  queryClient: QueryClient,
  demand: MessageCollectionDemand,
): MessageSequenceState {
  const key = messagePagesQueryKey(demand.scope, demand.tag, demand.sequence)
  const state = queryClient.getQueryState<InfiniteData<MessageCursorPage, string | undefined>>(key)
  const pages = state?.data?.pages ?? []
  return {
    fetchStatus: state?.fetchStatus ?? "idle",
    hasMore: pages.at(-1)?.nextCursor !== null && pages.length > 0,
    latestSeq: pages.reduce((latest, page) => Math.max(latest, page.latestSeq), 0),
    loadedRows: pages.reduce((count, page) => count + page.rows.length, 0),
    rowIds: pages.flatMap((page) => page.rows.map((row) => row.id)),
    rows: pages.flatMap((page) => page.rows),
    status: state?.status ?? "pending",
  }
}

export function readMessageWindowPublication(
  queryClient: QueryClient,
  demand: MessageCollectionDemand,
): MessageWindowPublication | undefined {
  const data = queryClient.getQueryData<InfiniteData<MessageCursorPage, string | undefined>>(
    messagePagesQueryKey(demand.scope, demand.tag, demand.sequence),
  )
  if (!data) return undefined
  const pages = data.pages
  return {
    hasMore: pages.at(-1)?.nextCursor !== null && pages.length > 0,
    rows: pages.flatMap((page) => page.rows),
    surfaceReceipt: pages.find((page) => page.surfaceReceipt)?.surfaceReceipt,
  }
}

function pageParamForCursor(
  sequence: MessageSequence,
  cursor: string | undefined,
): MessagesPageParam {
  if (cursor !== undefined) {
    return sequence.direction === "older"
      ? { mode: "older", cursor }
      : { mode: "newer", cursor }
  }
  return sequence.base.mode === "anchor"
    ? { mode: "anchor", anchor: sequence.base.anchor }
    : { mode: "newest" }
}

function sequenceRows(
  page: MessagesPage,
  sequence: MessageSequence,
  cursor: string | undefined,
) {
  if (sequence.base.mode !== "anchor" || cursor !== undefined) {
    return sequence.direction === "older"
      ? page.messages.slice().reverse()
      : page.messages
  }
  const anchor = sequence.base.anchor
  const anchorIndex = page.messages.findIndex((message) => message.id === anchor)
  if (anchorIndex < 0) throw new Error("Message anchor page omitted its anchor")
  return sequence.direction === "older"
    ? page.messages.slice(0, anchorIndex + 1).reverse()
    : page.messages.slice(anchorIndex)
}

function continuation(page: MessagesPage, sequence: MessageSequence) {
  const hasMore = sequence.direction === "older"
    ? page.hasMoreOlder ?? page.hasMore ?? false
    : page.hasMoreNewer ?? false
  if (!hasMore) return null
  const cursor = sequence.direction === "older"
    ? page.olderCursor ?? page.cursor
    : page.newerCursor
  if (!cursor) throw new TypeError(
    `Message page declared ${sequence.direction} continuation without a cursor`,
  )
  return cursor
}

export function createMessageCollectionDescriptor(
  queryClient: QueryClient,
  accountId: string,
) {
  const demandByChannel = new Map<string, MessageCollectionDemand>()
  const demandBySubset = new WeakMap<LoadSubsetOptions, MessageCollectionDemand>()
  const demandByRowsKey = new Map<string, MessageCollectionDemand>()
  const pagers = new Map<string, CursorPager<MessageRow>>()
  let readRows = (): Iterable<MessageRow> => []
  const directChanges = new Map<string, {
    channelId: string
    deleted: boolean
    apply?: (row: MessageRow) => MessageRow
  }>()
  const acquisitions = new Map<string, {
    demand: MessageCollectionDemand
    highWater: number
    leases: Map<object, number>
    refresh: Promise<void>
  }>()

  const setDemand = (demand: MessageCollectionDemand) => {
    if (demand.scope.accountId !== accountId) {
      throw new Error("message demand account mismatch")
    }
    demandByChannel.set(demand.scope.channelId, demand)
  }

  const queryKey = (options: LoadSubsetOptions = {}) => {
    let demand = demandBySubset.get(options)
    if (!demand) {
      const channelId = channelIdFromSubset(options)
      const configuredDemand = channelId ? demandByChannel.get(channelId) : undefined
      if (!configuredDemand) return messageCollectionBaseKey(accountId)
      demand = {
        ...configuredDemand,
        sequence: sequenceForSubset(configuredDemand, options),
      }
      demandBySubset.set(options, demand)
    }
    const key = messageRowsQueryKey(demand.scope, demand.tag, demand.sequence)
    demandByRowsKey.set(JSON.stringify(key), demand)
    return key
  }

  const queryFn = async (context: QueryFunctionContext): Promise<MessageRow[]> => {
    const key = JSON.stringify(context.queryKey)
    const demand = demandByRowsKey.get(key)
    if (!demand) {
      // A collection-wide observer is a projection subscription, not an empty
      // authoritative message response. Yield once so exact included/WS rows
      // written in the same React effect flush are part of its initial base.
      await Promise.resolve()
      return [...readRows()]
    }
    const resourceKey = messageResourceQueryKey(
      demand.scope,
      demand.tag,
      demand.sequence,
    )
    const pageKey = messagePagesQueryKey(
      demand.scope,
      demand.tag,
      demand.sequence,
    )
    const pagerKey = JSON.stringify(pageKey)
    let pager = pagers.get(pagerKey)
    if (!pager) {
      pager = createCursorPager({
        queryClient,
        queryKey: pageKey,
        staleTime: Infinity,
        fetchPage: async (cursor, signal) => {
          const transport = await apiFetchProfiles<MessagesTransportPage>(
            buildCommunityMessagesUrl(
              demand.scope.channelId,
              pageParamForCursor(demand.sequence, cursor),
              demand.tag,
            ),
            (page) => messageProfilePatches(page.messages),
            { signal },
          )
          const { surfaceReceipt, ...page } = transport
          return {
            rows: sequenceRows(page, demand.sequence, cursor).flatMap((message) => {
              const row = normalizeMessageRow(demand.scope.channelId, message)
              return row ? [row] : []
            }),
            nextCursor: continuation(page, demand.sequence),
            latestSeq: page.latestSeq ?? page.messages.reduce(
              (latest, message) => Math.max(latest, message.seq ?? 0),
              0,
            ),
            ...(isMessageSurfaceReceipt(surfaceReceipt) ? { surfaceReceipt } : {}),
          }
        },
      })
      pagers.set(pagerKey, pager)
    }
    const acquisition = acquisitions.get(JSON.stringify(resourceKey))
    const fetchedRows = await pager.read({
      offset: 0,
      limit: acquisition?.highWater ?? defaultWindowLimit(demand),
    }, context.signal)
    const rowsKey = messageRowsQueryKey(demand.scope, demand.tag, demand.sequence)
    if (JSON.stringify(context.queryKey) !== JSON.stringify(rowsKey)) {
      throw new Error("message row query resource mismatch")
    }
    const rows = new Map(fetchedRows.map((row) => [row.id, row]))
    const current = new Map([...readRows()].map((row) => [row.id, row]))
    for (const [id, change] of directChanges) {
      if (change.channelId !== demand.scope.channelId) continue
      if (change.deleted) rows.delete(id)
      else {
        const currentRow = current.get(id)
        if (currentRow) rows.set(id, currentRow)
        else {
          const incomingRow = rows.get(id)
          if (incomingRow && change.apply) rows.set(id, change.apply(incomingRow))
        }
      }
    }
    return [...rows.values()]
  }

  const markChanged = (
    id: string,
    channelId: string,
    deleted = false,
    apply?: (row: MessageRow) => MessageRow,
  ) => {
    directChanges.set(id, { channelId, deleted, apply })
    void queryClient.cancelQueries({
      queryKey: messageCollectionBaseKey(accountId),
      exact: true,
    })
  }

  const refreshSequence = async (demand: MessageCollectionDemand) => {
    await queryClient.invalidateQueries({
      queryKey: messageRowsQueryKey(demand.scope, demand.tag, demand.sequence),
      exact: true,
      refetchType: "active",
    })
  }

  const cleanupSequence = async (demand: MessageCollectionDemand) => {
    const rowsKey = messageRowsQueryKey(demand.scope, demand.tag, demand.sequence)
    const pageKey = messagePagesQueryKey(
      demand.scope,
      demand.tag,
      demand.sequence,
    )
    await Promise.all([
      queryClient.cancelQueries({ queryKey: rowsKey, exact: true }),
      queryClient.cancelQueries({ queryKey: pageKey, exact: true }),
    ])
    pagers.get(JSON.stringify(pageKey))?.reset()
    pagers.delete(JSON.stringify(pageKey))
    demandByRowsKey.delete(JSON.stringify(rowsKey))
    queryClient.removeQueries({ queryKey: rowsKey, exact: true })
  }

  const acquireWindow = (
    demand: MessageCollectionDemand,
    requestedLimit: number,
  ): MessageWindowLease => {
    setDemand(demand)
    const resourceKey = messageResourceQueryKey(
      demand.scope,
      demand.tag,
      demand.sequence,
    )
    const key = JSON.stringify(resourceKey)
    const token = {}
    const limit = Math.max(0, Math.trunc(requestedLimit))
    let acquisition = acquisitions.get(key)
    if (!acquisition) {
      acquisition = {
        demand,
        highWater: limit,
        leases: new Map(),
        refresh: Promise.resolve(),
      }
      acquisitions.set(key, acquisition)
    } else if (limit > acquisition.highWater) {
      acquisition.highWater = limit
      acquisition.refresh = refreshSequence(acquisition.demand)
    }
    acquisition.leases.set(token, limit)
    let released = false

    return {
      update: async (nextLimit) => {
        if (released) return
        const current = acquisitions.get(key)
        if (!current || !current.leases.has(token)) return
        const normalized = Math.max(0, Math.trunc(nextLimit))
        current.leases.set(token, normalized)
        if (normalized <= current.highWater) return current.refresh
        current.highWater = normalized
        current.refresh = refreshSequence(current.demand)
        await current.refresh
      },
      release: async () => {
        if (released) return
        released = true
        const current = acquisitions.get(key)
        if (!current) return
        current.leases.delete(token)
        if (current.leases.size > 0) return
        acquisitions.delete(key)
        await Promise.resolve()
        if (!acquisitions.has(key)) await cleanupSequence(current.demand)
      },
    }
  }

  const resetDemand = async (demand: MessageCollectionDemand) => {
    const directions = demand.sequence.base.mode === "anchor"
      ? ["older", "newer"] as const
      : ["older"] as const
    for (const direction of directions) {
      const sequence = { ...demand.sequence, direction }
      const rowsKey = messageRowsQueryKey(demand.scope, demand.tag, sequence)
      const pageKey = messagePagesQueryKey(demand.scope, demand.tag, sequence)
      await Promise.all([
        queryClient.cancelQueries({ queryKey: rowsKey, exact: true }),
        queryClient.cancelQueries({ queryKey: pageKey, exact: true }),
      ])
      pagers.get(JSON.stringify(pageKey))?.reset()
      await queryClient.invalidateQueries({
        queryKey: rowsKey,
        exact: true,
        refetchType: "active",
      })
    }
  }

  const demandsForScope = (
    kind: MessageAccessScope["kind"],
    channelId: string,
  ) => [...new Map(
    [...acquisitions.values()]
      .filter(({ demand }) => (
        demand.scope.kind === kind && demand.scope.channelId === channelId
      ))
      .map(({ demand }) => [
        JSON.stringify(messageResourceQueryKey(
          demand.scope,
          demand.tag,
          demand.sequence,
        )),
        demand,
      ]),
  ).values()]

  const reconcileScope = async (
    kind: MessageAccessScope["kind"],
    channelId: string,
  ) => {
    for (const [id, change] of directChanges) {
      if (change.channelId === channelId) directChanges.delete(id)
    }
    await Promise.all(demandsForScope(kind, channelId).map(async (demand) => {
      const rowsKey = messageRowsQueryKey(demand.scope, demand.tag, demand.sequence)
      const pageKey = messagePagesQueryKey(
        demand.scope,
        demand.tag,
        demand.sequence,
      )
      await Promise.all([
        queryClient.cancelQueries({ queryKey: rowsKey, exact: true }),
        queryClient.cancelQueries({ queryKey: pageKey, exact: true }),
      ])
      pagers.get(JSON.stringify(pageKey))?.reset()
      await queryClient.invalidateQueries(
        {
          queryKey: rowsKey,
          exact: true,
          refetchType: "active",
        },
        { throwOnError: true },
      )
    }))
  }

  const purgeScope = async (channelId: string) => {
    for (const [id, change] of directChanges) {
      if (change.channelId === channelId) directChanges.delete(id)
    }
    for (const [key, { demand }] of acquisitions) {
      if (demand.scope.channelId !== channelId) continue
      acquisitions.delete(key)
      const pageKey = messagePagesQueryKey(
        demand.scope,
        demand.tag,
        demand.sequence,
      )
      pagers.get(JSON.stringify(pageKey))?.reset()
      pagers.delete(JSON.stringify(pageKey))
      demandByRowsKey.delete(JSON.stringify(
        messageRowsQueryKey(demand.scope, demand.tag, demand.sequence),
      ))
    }
    demandByChannel.delete(channelId)
    const predicate = ({ queryKey }: { queryKey: readonly unknown[] }) => (
      isMessageResourceQueryKey(queryKey, { accountId, channelId })
    )
    await queryClient.cancelQueries({ predicate })
    queryClient.removeQueries({ predicate })
  }

  return {
    acquireWindow,
    bindRows: (reader: () => Iterable<MessageRow>) => {
      readRows = reader
    },
    markChanged,
    purgeScope,
    queryFn,
    queryKey,
    reconcileScope,
    resetDemand,
    setDemand,
  }
}

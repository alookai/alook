import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { describe, expect, it, vi } from "vitest"
import {
  getFriendRequestActionController,
  useFriendRequestActionState,
} from "./use-friend-request-action-state"
import { communityKeys } from "@/lib/query-keys"

type Row = { id: string; name: string }
const rows: Row[] = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
]

function createQueryWrapper() {
  const queryClient = new QueryClient()
  return function QueryWrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe("useFriendRequestActionState", () => {
  it("keeps an optimistically removed row visible and locks only that id", async () => {
    let resolve!: () => void
    const onAccept = vi.fn(() => new Promise<void>((next) => { resolve = next }))
    const rendered = renderHook(
      ({ currentRows }) => useFriendRequestActionState({
        rows: currentRows,
        onAccept,
        surface: "friends",
      }),
      { initialProps: { currentRows: rows }, wrapper: createQueryWrapper() },
    )
    let pending!: Promise<void>
    act(() => {
      pending = rendered.result.current.act(rendered.result.current.items[0]!, "accept")
    })
    rendered.rerender({ currentRows: [rows[1]!] })

    expect(rendered.result.current.items.map((item) => item.row.id)).toEqual(["a", "b"])
    expect(rendered.result.current.items[0]?.status).toBe("pending")
    expect(rendered.result.current.items[1]?.status).toBeUndefined()

    resolve()
    await act(async () => { await pending })
    expect(rendered.result.current.items.map((item) => item.row.id)).toEqual(["b"])
  })

  it("keeps a keyed live error and retries the same action independently", async () => {
    const onReject = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined)
    const rendered = renderHook(
      ({ currentRows }) => useFriendRequestActionState({
        rows: currentRows,
        onReject,
        surface: "friends",
      }),
      { initialProps: { currentRows: rows }, wrapper: createQueryWrapper() },
    )

    await act(async () => {
      await rendered.result.current.act(rendered.result.current.items[0]!, "reject")
    })
    rendered.rerender({ currentRows: [rows[1]!] })
    expect(rendered.result.current.items[0]).toMatchObject({
      row: rows[0],
      action: "reject",
      status: "error",
    })
    expect(rendered.result.current.items[0]?.error).toContain("Try again")
    expect(rendered.result.current.items[1]?.status).toBeUndefined()

    await act(async () => {
      await rendered.result.current.retry(rendered.result.current.items[0]!)
    })
    await waitFor(() => {
      expect(rendered.result.current.items.map((item) => item.row.id)).toEqual(["b"])
    })
    expect(onReject).toHaveBeenCalledTimes(2)
  })

  it("tracks two pending ids without sharing action state", async () => {
    const resolvers = new Map<string, () => void>()
    const onAccept = vi.fn((id: string) => new Promise<void>((resolve) => {
      resolvers.set(id, resolve)
    }))
    const rendered = renderHook(
      () => useFriendRequestActionState({ rows, onAccept, surface: "friends" }),
      { wrapper: createQueryWrapper() },
    )
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = rendered.result.current.act(rendered.result.current.items[0]!, "accept")
      second = rendered.result.current.act(rendered.result.current.items[1]!, "accept")
    })
    expect(rendered.result.current.items.map((item) => item.status)).toEqual(["pending", "pending"])

    resolvers.get("b")?.()
    await act(async () => { await second })
    expect(rendered.result.current.items[0]?.status).toBe("pending")
    expect(rendered.result.current.items[1]?.status).toBeUndefined()
    resolvers.get("a")?.()
    await act(async () => { await first })
  })

  it("fans a user terminal out across snapshots and caches", async () => {
    const queryClient = new QueryClient()
    const snapshot = { id: "snapshot", userId: "u1" }
    const cached = { id: "cached", userId: "u1" }
    const alreadyTerminal = { id: "terminal", userId: "u1" }
    queryClient.setQueryData(communityKeys.friends(), { pending: [snapshot] })
    queryClient.setQueryData(communityKeys.inboxUnreads(), {
      friendRequests: [cached, alreadyTerminal],
    })
    const controller = getFriendRequestActionController(queryClient)
    controller.claimMutation(snapshot.id, "accept")
    controller.publishTerminal(alreadyTerminal.id)

    controller.publishTerminalForUser("u1")

    expect(controller.project("friends", [snapshot])).toEqual([])
    expect(controller.project("inbox", [cached, alreadyTerminal])).toEqual([])

    const late = { id: "late", userId: "u1" }
    queryClient.setQueryData(communityKeys.inboxUnreads(), { friendRequests: [late] })
    controller.claimMutation(late.id, "reject")
    expect(controller.project("inbox", [])).toEqual([])
    const mutation = vi.fn()
    await controller.start({
      action: "reject",
      index: 0,
      mutation,
      retry: false,
      row: late,
      surface: "inbox",
    })
    expect(mutation).not.toHaveBeenCalled()
  })

  it("collects a settled terminal only after two absent authority proofs", async () => {
    const queryClient = new QueryClient()
    const row = { id: "a", userId: "u1" }
    queryClient.setQueryData(communityKeys.friends(), { pending: [row] })
    queryClient.setQueryData(communityKeys.inboxUnreads(), { friendRequests: [row] })
    const controller = getFriendRequestActionController(queryClient)
    const generation = controller.claimMutation(row.id, "accept")
    await controller.publishTerminalAndFence(row.id, generation)

    let friendRows = [row]
    await queryClient.fetchQuery({
      queryKey: communityKeys.friends(),
      queryFn: async () => ({ pending: friendRows }),
    })
    friendRows = []
    await queryClient.refetchQueries({ queryKey: communityKeys.friends(), exact: true })
    await queryClient.fetchQuery({
      queryKey: communityKeys.inboxUnreads(),
      queryFn: async () => ({ friendRequests: [] }),
    })

    queryClient.setQueryData(communityKeys.friends(), { pending: [row] })
    controller.settleGeneration(row.id, generation)
    expect(controller.project("friends", [row])).toEqual([])

    queryClient.setQueryData(communityKeys.friends(), { pending: [] })
    queryClient.setQueryData(communityKeys.inboxUnreads(), { friendRequests: [row] })
    controller.settleGeneration(row.id, generation)
    expect(controller.project("friends", [row])).toEqual([])

    queryClient.setQueryData(communityKeys.inboxUnreads(), { friendRequests: [] })
    controller.settleGeneration(row.id, generation)
    expect(controller.project("friends", [row])).toEqual([{ row }])
  })

  it("keeps a user fence until both surfaces prove absence with no cached row", async () => {
    const queryClient = new QueryClient()
    const controller = getFriendRequestActionController(queryClient)
    queryClient.setQueryData(["unrelated"], {})
    controller.publishTerminalForUser("ghost")

    await queryClient.fetchQuery({
      queryKey: communityKeys.inboxUnreads(),
      queryFn: async () => ({ friendRequests: [] }),
    })
    const row = { id: "late", userId: "ghost" }
    queryClient.setQueryData(communityKeys.inboxUnreads(), { friendRequests: [row] })
    await queryClient.fetchQuery({
      queryKey: communityKeys.friends(),
      queryFn: async () => ({ pending: [] }),
    })
    expect(controller.project("friends", [row])).toEqual([])

    queryClient.setQueryData(communityKeys.inboxUnreads(), { friendRequests: [] })
    queryClient.setQueryData(communityKeys.friends(), { pending: [row] })
    await queryClient.refetchQueries({ queryKey: communityKeys.inboxUnreads(), exact: true })
    expect(controller.project("friends", [row])).toEqual([])

    queryClient.setQueryData(communityKeys.friends(), { pending: [] })
    await queryClient.refetchQueries({ queryKey: communityKeys.inboxUnreads(), exact: true })
    expect(controller.project("friends", [row])).toEqual([{ row }])
  })
})

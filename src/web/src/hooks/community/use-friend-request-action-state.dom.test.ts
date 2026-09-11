import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { describe, expect, it, vi } from "vitest"
import { useFriendRequestActionState } from "./use-friend-request-action-state"

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
})

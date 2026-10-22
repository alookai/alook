import { createElement, type PropsWithChildren } from "react"
import { useQuery } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { useCreateOrGetDm } from "./dm"

const api = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => api(...args), toastApiError: vi.fn() }))

beforeEach(() => { api.mockReset() })

describe("DM open completion", () => {
  it("returns the authorized target while its active sidebar refresh is held", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client, registry }, children)
    const initial = { conversations: [] }
    client.setQueryData(communityKeys.dms(), initial)
    let release!: (value: typeof initial) => void
    const refresh = vi.fn(() => new Promise<typeof initial>(resolve => { release = resolve }))
    api.mockResolvedValue({ conversation: { id: "dm-a" } })
    const view = renderHook(() => {
      const sidebar = useQuery({ queryKey: communityKeys.dms(), queryFn: refresh, staleTime: Infinity })
      return { sidebar, open: useCreateOrGetDm() }
    }, { wrapper })
    try {
      let target: unknown
      await act(async () => { target = await view.result.current.open.mutateAsync({ userId: "peer-a" }) })
      expect(target).toEqual({ conversation: { id: "dm-a" } })
      expect(refresh).toHaveBeenCalledOnce()
      expect(client.getQueryState(communityKeys.dms())?.fetchStatus).toBe("fetching")
      expect(view.result.current.sidebar.data).toBe(initial)
      await act(async () => { release(initial) })
      await waitFor(() => expect(view.result.current.sidebar.isFetching).toBe(false))
    } finally { release?.(initial); view.unmount() }
  })

  it("keeps a failed command from reporting a target or refreshing the sidebar", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client, registry }, children)
    const invalidate = vi.spyOn(client, "invalidateQueries")
    api.mockRejectedValue(new Error("not allowed"))
    const view = renderHook(() => useCreateOrGetDm(), { wrapper })
    await act(async () => { await expect(view.result.current.mutateAsync({ userId: "peer-a" })).rejects.toThrow("not allowed") })
    expect(invalidate).not.toHaveBeenCalled()
    view.unmount()
  })
})

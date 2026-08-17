import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

type MutationConfig = {
  onSuccess?: (data: unknown, args: any) => void
}
let config: MutationConfig | null = null
let queryClient: QueryClient

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => queryClient,
    useMutation: (next: MutationConfig) => {
      config = next
      return {}
    },
  }
})

beforeEach(() => {
  vi.resetModules()
  config = null
  queryClient = new QueryClient()
})

describe("notification mutation cache refresh", () => {
  it("refreshes settings, inbox, and all read-state snapshots after a server change", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { useSetServerNotifLevel } = await import("./notifications")
    useSetServerNotifLevel()
    config!.onSuccess?.(undefined, { serverId: "server_1", level: "Nothing" })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.notificationSettings() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.inbox() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.servers() })
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ predicate: expect.any(Function) }))
  })

  it("refreshes every read-state snapshot after a parent channel change", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { useSetChannelNotif } = await import("./notifications")
    useSetChannelNotif()
    config!.onSuccess?.(undefined, { channelId: "parent_1", level: "Nothing" })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.inbox() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.servers() })
    const predicateCall = invalidate.mock.calls.find(
      ([filters]) => typeof filters?.predicate === "function",
    )
    const predicate = predicateCall?.[0].predicate
    expect(predicate).toBeTypeOf("function")
    expect(predicate!({ queryKey: communityKeys.channelReadStateSnapshot("parent_1") } as any)).toBe(true)
    expect(predicate!({ queryKey: communityKeys.channelReadStateSnapshot("child_1") } as any)).toBe(true)
    expect(predicate!({ queryKey: communityKeys.dmReadStateSnapshot("dm_1") } as any)).toBe(true)
    expect(predicate!({ queryKey: communityKeys.inbox() } as any)).toBe(false)
  })
})

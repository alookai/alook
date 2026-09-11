/**
 * Friend-mutation tests. Same shim pattern as messages.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

vi.mock("react", () => ({
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useState: (initial: unknown) => [initial, () => {}],
}))

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type MutConfig<Args, Ctx> = {
  mutationFn?: (args: Args) => unknown
  onMutate?: (args: Args) => Promise<Ctx> | Ctx
  onSuccess?: (data: unknown, args: Args, ctx: Ctx) => unknown
  onError?: (err: unknown, args: Args, ctx: Ctx) => unknown
  onSettled?: (data: unknown, err: unknown, args: Args, ctx: Ctx) => unknown
}
let capturedConfig: MutConfig<unknown, unknown> | null = null
let capturedQc: QueryClient
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQc,
    useMutation: (config: MutConfig<unknown, unknown>) => {
      capturedConfig = config
      return {}
    },
  }
})

async function runMutation<Args>(args: Args) {
  const cfg = capturedConfig as MutConfig<Args, unknown>
  const ctx = cfg.onMutate ? await cfg.onMutate(args) : undefined
  try {
    const data = cfg.mutationFn ? await cfg.mutationFn(args) : undefined
    await cfg.onSuccess?.(data, args, ctx)
    await cfg.onSettled?.(data, null, args, ctx)
    return { data, ctx }
  } catch (err) {
    await cfg.onError?.(err, args, ctx)
    await cfg.onSettled?.(undefined, err, args, ctx)
    throw err
  }
}

async function load() {
  vi.resetModules()
  return await import("./friends")
}

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
})

describe("useSendFriendRequest — invalidates friends on success", () => {
  it("triggers invalidateQueries(friends)", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useSendFriendRequest()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ username: "alice" })
    expect(
      spy.mock.calls.some((c) => {
        const k = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(k) && k.includes("friends")
      }),
    ).toBe(true)
  })

  it("posts both userId and the name#discriminator handle when given both", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useSendFriendRequest()
    await runMutation({ userId: "u_1", username: "alice#0042" })
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body).toEqual({ userId: "u_1", username: "alice#0042" })
  })
})

describe("useAcceptFriendRequest — rollback", () => {
  it("restores the pending row when the server rejects", async () => {
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [],
      blocked: [],
      pending: [{ id: "f_1", userId: "u_1", name: "n", avatar: "N", kind: "incoming" }],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useAcceptFriendRequest()
    await runMutation({ friendshipId: "f_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pending: { id: string }[] }>(communityKeys.friends())
    expect(cache?.pending).toHaveLength(1)
  })

  it("optimistically removes and compensates the same id in both cache grains", async () => {
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [],
      blocked: [],
      pending: [
        { id: "f_1", userId: "u_1", name: "One", avatar: "1", avatarVersion: 1, kind: "incoming" },
        { id: "f_2", userId: "u_2", name: "Two", avatar: "2", avatarVersion: 2, kind: "incoming" },
      ],
    })
    capturedQc.setQueryData(communityKeys.inboxUnreads(), {
      friendRequests: [
        { id: "f_1", userId: "u_1", name: "One", avatar: "1", avatarVersion: 1, createdAt: "2" },
        { id: "f_2", userId: "u_2", name: "Two", avatar: "2", avatarVersion: 2, createdAt: "1" },
      ],
      servers: [],
      dms: [],
    })
    const mod = await load()
    mod.useAcceptFriendRequest()
    const cfg = capturedConfig as MutConfig<{ friendshipId: string }, unknown>
    const cancelSpy = vi.spyOn(capturedQc, "cancelQueries")
    const context = await cfg.onMutate?.({ friendshipId: "f_1" })

    expect(cancelSpy.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: communityKeys.friends(), exact: true },
      { queryKey: communityKeys.inboxUnreads(), exact: true },
    ])
    expect(capturedQc.getQueryData<{ pending: { id: string }[] }>(communityKeys.friends())?.pending)
      .toEqual([expect.objectContaining({ id: "f_2" })])
    expect(capturedQc.getQueryData<{ friendRequests: { id: string }[] }>(communityKeys.inboxUnreads())?.friendRequests)
      .toEqual([expect.objectContaining({ id: "f_2" })])

    await cfg.onError?.(new Error("boom"), { friendshipId: "f_1" }, context)
    expect(capturedQc.getQueryData<{ pending: { id: string }[] }>(communityKeys.friends())?.pending.map((row) => row.id))
      .toEqual(["f_1", "f_2"])
    expect(capturedQc.getQueryData<{ friendRequests: { id: string }[] }>(communityKeys.inboxUnreads())?.friendRequests.map((row) => row.id))
      .toEqual(["f_1", "f_2"])
  })

  it.each([
    { successfulId: "a", failedId: "b", order: "failed-first" },
    { successfulId: "a", failedId: "b", order: "success-first" },
    { successfulId: "b", failedId: "a", order: "failed-first" },
    { successfulId: "b", failedId: "a", order: "success-first" },
  ])(
    "does not resurrect $successfulId when $failedId compensates $order",
    async ({ successfulId, failedId, order }) => {
      capturedQc.setQueryData(communityKeys.friends(), {
        friends: [],
        blocked: [],
        pending: [
          { id: "a", userId: "ua", name: "A", avatar: "A", avatarVersion: 1, kind: "incoming" },
          { id: "b", userId: "ub", name: "B", avatar: "B", avatarVersion: 1, kind: "incoming" },
        ],
      })
      capturedQc.setQueryData(communityKeys.inboxUnreads(), {
        friendRequests: [
          { id: "a", userId: "ua", name: "A", avatar: "A", avatarVersion: 1, createdAt: "2" },
          { id: "b", userId: "ub", name: "B", avatar: "B", avatarVersion: 1, createdAt: "1" },
        ],
        servers: [],
        dms: [],
      })
      const mod = await load()
      mod.useRejectFriendRequest()
      const cfg = capturedConfig as MutConfig<{ friendshipId: string }, unknown>
      const contextA = await cfg.onMutate?.({ friendshipId: "a" })
      const contextB = await cfg.onMutate?.({ friendshipId: "b" })
      const contexts = { a: contextA, b: contextB }
      const fail = () => cfg.onError?.(
        new Error(`${failedId} failed`),
        { friendshipId: failedId },
        contexts[failedId as "a" | "b"],
      )
      const settle = () => cfg.onSettled?.(
        undefined,
        null,
        { friendshipId: successfulId },
        contexts[successfulId as "a" | "b"],
      )
      if (order === "failed-first") {
        await fail()
        await settle()
      } else {
        await settle()
        await fail()
      }

      expect(capturedQc.getQueryData<{ pending: { id: string }[] }>(communityKeys.friends())?.pending.map((row) => row.id))
        .toEqual([failedId])
      expect(capturedQc.getQueryData<{ friendRequests: { id: string }[] }>(communityKeys.inboxUnreads())?.friendRequests.map((row) => row.id))
        .toEqual([failedId])
    },
  )

  it("preserves unrelated current-cache changes and never reconstructs an absent envelope", async () => {
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [],
      blocked: [],
      pending: [{ id: "a", userId: "ua", name: "A", avatar: "A", avatarVersion: 1, kind: "incoming" }],
    })
    const mod = await load()
    mod.useAcceptFriendRequest()
    const cfg = capturedConfig as MutConfig<{ friendshipId: string }, unknown>
    const context = await cfg.onMutate?.({ friendshipId: "a" })
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [],
      blocked: [],
      pending: [{ id: "c", userId: "uc", name: "C", avatar: "C", avatarVersion: 1, kind: "incoming" }],
    })
    await cfg.onError?.(new Error("failed"), { friendshipId: "a" }, context)

    expect(capturedQc.getQueryData<{ pending: { id: string }[] }>(communityKeys.friends())?.pending.map((row) => row.id))
      .toEqual(["a", "c"])
    expect(capturedQc.getQueryData(communityKeys.inboxUnreads())).toBeUndefined()
  })

  it("never reconstructs an absent Friends envelope while compensating Inbox", async () => {
    capturedQc.setQueryData(communityKeys.inboxUnreads(), {
      friendRequests: [{
        id: "a",
        userId: "ua",
        name: "A",
        avatar: "A",
        avatarVersion: 1,
        createdAt: "2026-09-12T01:00:00Z",
      }],
      servers: [],
      dms: [],
    })
    const mod = await load()
    mod.useAcceptFriendRequest()
    const cfg = capturedConfig as MutConfig<{ friendshipId: string }, unknown>
    const context = await cfg.onMutate?.({ friendshipId: "a" })
    await cfg.onError?.(new Error("failed"), { friendshipId: "a" }, context)

    expect(capturedQc.getQueryData(communityKeys.friends())).toBeUndefined()
    expect(capturedQc.getQueryData<{ friendRequests: { id: string }[] }>(
      communityKeys.inboxUnreads(),
    )?.friendRequests.map((row) => row.id)).toEqual(["a"])
  })

  it("awaits settled invalidation of Friends and exact Inbox unreads", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useAcceptFriendRequest()
    const gates: Array<() => void> = []
    const spy = vi.spyOn(capturedQc, "invalidateQueries").mockImplementation(() => (
      new Promise<void>((resolve) => gates.push(resolve))
    ))
    let settled = false
    const mutation = runMutation({ friendshipId: "f_1" }).then(() => { settled = true })
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    expect(settled).toBe(false)
    gates.splice(0).forEach((resolve) => resolve())
    await mutation
    expect(spy.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: communityKeys.friends(), exact: true },
      { queryKey: communityKeys.inboxUnreads(), exact: true },
    ])
  })
})

describe("useCancelBotFriendRequest — optimistic + rollback", () => {
  it("DELETEs the friendship row and optimistically drops the outgoing row", async () => {
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [],
      blocked: [],
      pending: [{ id: "fr_1", userId: "u_bot", name: "Bot", avatar: "B", kind: "outgoing" }],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useCancelBotFriendRequest()
    await runMutation({ requestId: "fr_1" })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/friends/fr_1",
      { method: "DELETE" },
    )
    const cache = capturedQc.getQueryData<{ pending: { id: string }[] }>(communityKeys.friends())
    expect(cache?.pending).toHaveLength(0)
  })

  it("restores the outgoing row when the server rejects", async () => {
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [],
      blocked: [],
      pending: [{ id: "fr_1", userId: "u_bot", name: "Bot", avatar: "B", kind: "outgoing" }],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useCancelBotFriendRequest()
    await runMutation({ requestId: "fr_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pending: { id: string }[] }>(communityKeys.friends())
    expect(cache?.pending).toHaveLength(1)
  })
})

describe("useRemoveFriend — optimistic + rollback", () => {
  it("optimistically drops the friend and restores on failure", async () => {
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [{ id: "f_1", name: "n", discriminator: "0000", avatar: "N", status: "offline", sub: "" }],
      blocked: [],
      pending: [],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useRemoveFriend()
    await runMutation({ friendshipId: "f_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ friends: { id: string }[] }>(communityKeys.friends())
    expect(cache?.friends).toHaveLength(1)
  })

  it("keeps an absent cache absent and invalidates Friends on success", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useRemoveFriend()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")

    await runMutation({ friendshipId: "missing" })

    expect(capturedQc.getQueryData(communityKeys.friends())).toBeUndefined()
    expect(spy).toHaveBeenCalledWith({ queryKey: communityKeys.friends() })
  })
})

describe("useBlockUser — invalidates friends", () => {
  it("triggers invalidateQueries(friends) on success", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useBlockUser()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ userId: "u_bad" })
    expect(
      spy.mock.calls.some((c) => {
        const k = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(k) && k.includes("friends")
      }),
    ).toBe(true)
  })
})

describe("useUnblockUser — rollback", () => {
  it("restores blocked entry on failure", async () => {
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [],
      blocked: [{ id: "b_1", userId: "u_bad", name: "b", avatar: "B" }],
      pending: [],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useUnblockUser()
    await runMutation({ userId: "u_bad" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ blocked: { id: string }[] }>(communityKeys.friends())
    expect(cache?.blocked).toHaveLength(1)
  })
})

import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"

const apiFetchProfiles = vi.fn()
const communityUserProfilePatch = vi.fn((userId: string, profile: unknown) => ({ userId, profile }))
vi.mock("@/lib/community/profile-seed", () => ({
  apiFetchProfiles: (...args: unknown[]) => apiFetchProfiles(...args),
  communityUserProfilePatch: (userId: string, profile: unknown) =>
    communityUserProfilePatch(userId, profile),
}))

import { useReactionDetails, type ReactionDetailsEnvelope } from "./use-reaction-details"
import { communityKeys } from "@/lib/query-keys"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function envelope(actorIds: string[]): ReactionDetailsEnvelope {
  return {
    messageId: "message_1",
    scope: { kind: "server", serverId: "server_1", channelId: "channel_1" },
    actors: actorIds.map((userId) => ({
      userId,
      profile: {
        id: userId,
        name: userId,
        discriminator: "0001",
        avatar: userId.slice(0, 1).toUpperCase(),
        avatarVersion: 0,
      },
    })),
  }
}

function wrapperFor(queryClient: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

type ReactionProps = { open: boolean; userIds: string[] }

function renderReactionHook(queryClient: QueryClient, initialProps: ReactionProps) {
  return renderHook(
    ({ open, userIds }: ReactionProps) => useReactionDetails({
      messageId: "message_1",
      open,
      userIds,
    }),
    { initialProps, wrapper: wrapperFor(queryClient) },
  )
}

describe("useReactionDetails", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("loads only while open and bounds burst, in-flight, missing, and reappearing actor refreshes", async () => {
    vi.useFakeTimers()
    const first = deferred<ReactionDetailsEnvelope>()
    const second = deferred<ReactionDetailsEnvelope>()
    const third = deferred<ReactionDetailsEnvelope>()
    const fourth = deferred<ReactionDetailsEnvelope>()
    apiFetchProfiles
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
      .mockReturnValueOnce(fourth.promise)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rendered = renderReactionHook(queryClient, { open: false, userIds: ["user_1"] })
    expect(apiFetchProfiles).not.toHaveBeenCalled()

    rendered.rerender({ open: true, userIds: ["user_1"] })
    expect(apiFetchProfiles).toHaveBeenCalledTimes(1)
    await act(async () => {
      first.resolve(envelope(["user_1"]))
      await first.promise
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(rendered.result.current.data?.actors).toHaveLength(1)

    rendered.rerender({ open: true, userIds: ["user_1", "user_2", "user_3"] })
    await act(async () => vi.advanceTimersByTime(99))
    expect(apiFetchProfiles).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(1))
    expect(apiFetchProfiles).toHaveBeenCalledTimes(2)

    rendered.rerender({ open: true, userIds: ["user_1", "user_2", "user_3", "user_4"] })
    expect(apiFetchProfiles).toHaveBeenCalledTimes(2)
    await act(async () => {
      second.resolve(envelope(["user_1", "user_2", "user_3"]))
      await second.promise
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => vi.advanceTimersByTime(100))
    expect(apiFetchProfiles).toHaveBeenCalledTimes(3)
    await act(async () => {
      third.resolve(envelope(["user_1", "user_2", "user_3"]))
      await third.promise
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => vi.advanceTimersByTime(500))
    expect(apiFetchProfiles).toHaveBeenCalledTimes(3)

    rendered.rerender({ open: true, userIds: ["user_1", "user_2", "user_3"] })
    rendered.rerender({ open: true, userIds: ["user_1", "user_2", "user_3", "user_4"] })
    await act(async () => vi.advanceTimersByTime(100))
    expect(apiFetchProfiles).toHaveBeenCalledTimes(4)
    await act(async () => {
      fourth.resolve(envelope(["user_1", "user_2", "user_3", "user_4"]))
      await fourth.promise
      await vi.advanceTimersByTimeAsync(0)
    })
  })

  it("seeds only authorized non-null profiles from the initial envelope", async () => {
    const data = envelope(["user_1"])
    data.actors.push({ userId: "departed", profile: null })
    apiFetchProfiles.mockImplementationOnce(async (_url, selectProfiles) => {
      expect(selectProfiles(data)).toEqual([{
        userId: "user_1",
        profile: data.actors[0].profile,
      }])
      return data
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderReactionHook(queryClient, { open: true, userIds: ["user_1"] })

    await waitFor(() => expect(communityUserProfilePatch).toHaveBeenCalledOnce())
    expect(communityUserProfilePatch).toHaveBeenCalledWith("user_1", data.actors[0].profile)
  })

  it("cancels a scheduled unknown-actor refresh when the dialog closes", async () => {
    vi.useFakeTimers()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.reactionDetails("message_1"), envelope(["user_1"]))
    const rendered = renderReactionHook(queryClient, {
      open: true,
      userIds: ["user_1", "user_2"],
    })
    expect(apiFetchProfiles).not.toHaveBeenCalled()

    rendered.rerender({ open: false, userIds: ["user_1", "user_2"] })
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(apiFetchProfiles).not.toHaveBeenCalled()
  })
})

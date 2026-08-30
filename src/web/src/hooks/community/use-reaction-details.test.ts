import { afterEach, describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

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

describe("useReactionDetails", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it("loads only while open and bounds burst, in-flight, missing, and reappearing actor refreshes", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    const first = deferred<ReactionDetailsEnvelope>()
    const second = deferred<ReactionDetailsEnvelope>()
    const third = deferred<ReactionDetailsEnvelope>()
    const fourth = deferred<ReactionDetailsEnvelope>()
    apiFetchProfiles
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
      .mockReturnValueOnce(fourth.promise)

    let props = { open: false, userIds: ["user_1"] as string[] }
    let latest: ReturnType<typeof useReactionDetails> | undefined
    function Probe() {
      latest = useReactionDetails({ messageId: "message_1", ...props })
      return null
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)),
      )
    })
    expect(apiFetchProfiles).not.toHaveBeenCalled()

    props = { open: true, userIds: ["user_1"] }
    await act(async () => renderer!.update(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)),
    ))
    expect(apiFetchProfiles).toHaveBeenCalledTimes(1)
    await act(async () => {
      first.resolve(envelope(["user_1"]))
      await first.promise
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(latest?.data?.actors).toHaveLength(1)

    props = { open: true, userIds: ["user_1", "user_2", "user_3"] }
    await act(async () => renderer!.update(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)),
    ))
    await act(async () => vi.advanceTimersByTime(99))
    expect(apiFetchProfiles).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(1))
    expect(apiFetchProfiles).toHaveBeenCalledTimes(2)

    props = { open: true, userIds: ["user_1", "user_2", "user_3", "user_4"] }
    await act(async () => renderer!.update(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)),
    ))
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

    props = { open: true, userIds: ["user_1", "user_2", "user_3"] }
    await act(async () => renderer!.update(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)),
    ))
    props = { open: true, userIds: ["user_1", "user_2", "user_3", "user_4"] }
    await act(async () => renderer!.update(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)),
    ))
    await act(async () => vi.advanceTimersByTime(100))
    expect(apiFetchProfiles).toHaveBeenCalledTimes(4)
    await act(async () => {
      fourth.resolve(envelope(["user_1", "user_2", "user_3", "user_4"]))
      await fourth.promise
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => renderer!.unmount())
  })

  it("seeds only authorized non-null profiles from the initial envelope", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    const data = envelope(["user_1"])
    data.actors.push({ userId: "departed", profile: null })
    apiFetchProfiles.mockImplementationOnce(async (_url, selectProfiles) => {
      expect(selectProfiles(data)).toEqual([{
        userId: "user_1",
        profile: data.actors[0].profile,
      }])
      return data
    })

    function Probe() {
      useReactionDetails({ messageId: "message_1", open: true, userIds: ["user_1"] })
      return null
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)),
      )
    })
    expect(communityUserProfilePatch).toHaveBeenCalledOnce()
    expect(communityUserProfilePatch).toHaveBeenCalledWith("user_1", data.actors[0].profile)
    act(() => renderer!.unmount())
  })

  it("cancels a scheduled unknown-actor refresh when the dialog closes", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    let props = { open: true, userIds: ["user_1", "user_2"] as string[] }
    function Probe() {
      useReactionDetails({ messageId: "message_1", ...props })
      return null
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.reactionDetails("message_1"), envelope(["user_1"]))
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)),
      )
    })
    expect(apiFetchProfiles).not.toHaveBeenCalled()

    props = { open: false, userIds: ["user_1", "user_2"] }
    await act(async () => renderer!.update(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)),
    ))
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(apiFetchProfiles).not.toHaveBeenCalled()
    act(() => renderer!.unmount())
  })
})

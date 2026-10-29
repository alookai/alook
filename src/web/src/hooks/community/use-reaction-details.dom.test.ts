import { channelResourceFixture, messageResourceFixture } from "@/test/community-resource-fixtures"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { communityUserProfilePatch, writeCommunityProfilePatches } from "@/lib/community/profile-seed"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"

const apiFetchProfiles = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: apiFetchProfiles }))

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
    return createElement(CommunityTestProvider, { client: queryClient, registry: getCommunityDbRegistry(queryClient)!, retainOwner: true }, children)
  }
}

type ReactionProps = { open: boolean; userIds: string[] }

function renderReactionHook(queryClient: QueryClient, initialProps: ReactionProps) {
  const registry = getCommunityDbRegistry(queryClient)!
  registry.collections.channels.utils.writeUpsert({ ...channelResourceFixture({ id: "channel_1", serverId: "server_1" }), muted: false, pending: false, tags: [] })
  registry.collections.messages.utils.writeUpsert(messageResourceFixture({ id: "message_1", channelId: "channel_1" }))
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
  beforeEach(() => { apiFetchProfiles.mockReset() })
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

    const { client: queryClient } = await createCommunityQueryOwner()
    const rendered = renderReactionHook(queryClient, { open: false, userIds: ["user_1"] })
    expect(apiFetchProfiles).not.toHaveBeenCalled()

    rendered.rerender({ open: true, userIds: ["user_1"] })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
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
    apiFetchProfiles.mockResolvedValueOnce(data)

    const { client: queryClient, registry } = await createCommunityQueryOwner()
    const rendered = renderReactionHook(queryClient, { open: true, userIds: ["user_1"] })

    await waitFor(() => expect(rendered.result.current.data?.actors).toEqual(data.actors))
    expect(registry.collections.profiles.get("user_1")?.name).toBe("user_1")
    expect(registry.collections.profiles.has("departed")).toBe(false)
    expect(apiFetchProfiles).toHaveBeenCalledWith("/api/community/messages/message_1/reactions", expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
  })

  it("cancels a scheduled unknown-actor refresh when the dialog closes", async () => {
    vi.useFakeTimers()
    const { client: queryClient, registry } = await createCommunityQueryOwner()
    const cached = envelope(["user_1"])
    writeCommunityProfilePatches(cached.actors.flatMap((actor) => actor.profile ? [communityUserProfilePatch(actor.userId, actor.profile)] : []), registry)
    queryClient.setQueryData(communityKeys.reactionDetails("message_1"), { ...cached, actors: [{ userId: "user_1", profilePresent: true }] })
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

it.each(["missing-later-core", "wrong-actor", "wrong-message", "wrong-scope"])("refuses a malformed named reaction identity subset %s before patching", async defect => {
  const { communityRegistrySnapshot } = await import("@/test/community-registry-snapshot")
  const { client, registry } = await createCommunityQueryOwner()
  const initial = envelope(["first", "second"])
  apiFetchProfiles.mockResolvedValueOnce(initial)
  const hook = renderReactionHook(client, { open: true, userIds: ["first", "second"] })
  await waitFor(() => expect(hook.result.current.data?.actors).toHaveLength(2))
  const before = communityRegistrySnapshot(registry)
  const malformed = structuredClone(initial)
  malformed.actors[0]!.profile!.name = "Must not publish"
  if (defect === "missing-later-core") delete (malformed.actors[1]!.profile as Partial<NonNullable<ReactionDetailsEnvelope["actors"][number]["profile"]>>).avatarVersion
  if (defect === "wrong-actor") malformed.actors[1]!.profile!.id = "foreign"
  if (defect === "wrong-message") malformed.messageId = "foreign"
  if (defect === "wrong-scope") malformed.scope.channelId = "foreign"
  apiFetchProfiles.mockResolvedValueOnce(malformed)
  await act(async () => { await expect(hook.result.current.refetch({ throwOnError: true })).rejects.toThrow() })
  expect(communityRegistrySnapshot(registry)).toEqual(before)
  hook.unmount()
})

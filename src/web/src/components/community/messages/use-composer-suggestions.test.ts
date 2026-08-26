import { createElement, useEffect } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  buildMention: vi.fn(),
  buildChannel: vi.fn(),
  rankMention: vi.fn(),
  rankChannel: vi.fn(),
}))

vi.mock("@/lib/community/mention-extension", () => ({
  EMPTY_MENTION_STATE: {
    items: [],
    query: "",
    selectedIndex: 0,
    command: null,
    getRect: null,
  },
  buildCommunityMentionExtension: (...args: unknown[]) =>
    mocks.buildMention(...args),
  rankMentionItems: (...args: unknown[]) => mocks.rankMention(...args),
}))

vi.mock("@/lib/community/channel-ref-extension", () => ({
  EMPTY_CHANNEL_REF_STATE: {
    items: [],
    selectedIndex: 0,
    command: null,
    getRect: null,
  },
  buildCommunityChannelRefExtension: (...args: unknown[]) =>
    mocks.buildChannel(...args),
  rankChannelRefItems: (...args: unknown[]) => mocks.rankChannel(...args),
}))

import { useComposerSuggestions } from "./use-composer-suggestions"
import type { ChannelRefCandidate } from "@/lib/community/channel-ref-extension"
import type { Member } from "@/lib/community/models/people"

type Options = Parameters<typeof useComposerSuggestions>[0]
type Result = ReturnType<typeof useComposerSuggestions>

function Harness({
  resultRef,
  ...options
}: Options & { resultRef: { current: Result | null } }) {
  const result = useComposerSuggestions(options)
  useEffect(() => {
    resultRef.current = result
  }, [result, resultRef])
  return createElement("suggestions-probe")
}

const member = (overrides: Partial<Member> = {}): Member =>
  ({
    id: "member-1",
    userId: "user-1",
    name: "Ada",
    discriminator: "0001",
    avatar: "A",
    status: "online",
    ...overrides,
  }) as Member

const channel = (
  overrides: Partial<ChannelRefCandidate> = {},
): ChannelRefCandidate => ({
  id: "channel-1",
  name: "general",
  serverId: "server-1",
  serverName: "One",
  serverDiscriminator: "0001",
  ...overrides,
})

const candidateSource = (
  search: (query: string) => void,
  overrides: Partial<NonNullable<Options["mentionCandidates"]>> = {},
) => ({
  loading: false,
  loadingMore: false,
  hasMore: false,
  failed: false,
  searchQuery: "",
  searchStatus: "idle" as const,
  loadMore: vi.fn(),
  search,
  ...overrides,
})

describe("useComposerSuggestions", () => {
  beforeEach(() => {
    mocks.buildMention.mockReset()
    mocks.buildChannel.mockReset()
    mocks.rankMention.mockReset()
    mocks.rankChannel.mockReset()
    mocks.buildMention.mockImplementation((options) => ({
      name: "mention-extension",
      runQuery: (query: string) => {
        options.queryRef.current = query
        options.onSearchMembersRef.current?.(query)
        return mocks.rankMention(
          options.membersRef.current,
          options.contextRef.current,
          query,
        )
      },
    }))
    mocks.buildChannel.mockImplementation((options) => ({
      name: "channel-extension",
      runQuery: (query: string) => {
        options.queryRef.current = query
        options.onIntentRef.current?.()
        return mocks.rankChannel(options.candidatesRef.current, query)
      },
    }))
    mocks.rankMention.mockReturnValue([])
    mocks.rankChannel.mockReturnValue([])
  })

  it("builds only the two custom extensions once and refreshes live refs", async () => {
    const resultRef: { current: Result | null } = { current: null }
    const firstMembers = [member()]
    const firstChannels = [channel()]
    const firstSearch = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, {
          members: firstMembers,
          context: "channel",
          mentionCandidates: candidateSource(firstSearch, {
            searchQuery: "ad",
            searchStatus: "ready",
          }),
          channelRefCandidates: firstChannels,
          onChannelRefIntent: vi.fn(),
          resultRef,
        }),
      )
    })
    const firstMentionExtension = resultRef.current!.mentionExtension
    const firstChannelExtension = resultRef.current!.channelRefExtension
    const mentionOptions = mocks.buildMention.mock.calls[0][0]
    const channelOptions = mocks.buildChannel.mock.calls[0][0]

    const nextMembers = [member({ avatar: "B", status: "offline" })]
    const nextChannels = [channel({ serverName: "Two" })]
    const nextSearch = vi.fn()
    const nextIntent = vi.fn()
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          members: nextMembers,
          context: "thread",
          mentionCandidates: candidateSource(nextSearch, {
            searchQuery: "ad",
            searchStatus: "ready",
          }),
          channelRefCandidates: nextChannels,
          onChannelRefIntent: nextIntent,
          resultRef,
        }),
      )
    })

    expect(mocks.buildMention).toHaveBeenCalledOnce()
    expect(mocks.buildChannel).toHaveBeenCalledOnce()
    expect(resultRef.current!.mentionExtension).toBe(firstMentionExtension)
    expect(resultRef.current!.channelRefExtension).toBe(firstChannelExtension)
    expect(mentionOptions.membersRef.current).toBe(nextMembers)
    expect(mentionOptions.contextRef.current).toBe("thread")
    expect(mentionOptions.onSearchMembersRef.current).toBe(nextSearch)
    expect(channelOptions.candidatesRef.current).toBe(nextChannels)
    expect(channelOptions.onIntentRef.current).toBe(nextIntent)

    await act(async () => {
      mentionOptions.setPopup({
        items: [],
        query: "",
        selectedIndex: 0,
        command: vi.fn(),
        getRect: null,
      })
      channelOptions.setPopup({
        items: [],
        selectedIndex: 0,
        command: vi.fn(),
        getRect: null,
      })
    })

    mocks.rankMention.mockReturnValue([{ id: "latest-member" }])
    const mentionResult = (
      resultRef.current!.mentionExtension as unknown as {
        runQuery: (query: string) => unknown
      }
    ).runQuery("ad")
    expect(mentionResult).toEqual([{ id: "latest-member" }])
    expect(nextSearch).toHaveBeenCalledWith("ad")
    expect(mocks.rankMention).toHaveBeenLastCalledWith(
      nextMembers,
      "thread",
      "ad",
    )

    mocks.rankChannel.mockReturnValue([{ id: "latest-channel" }])
    const channelResult = (
      resultRef.current!.channelRefExtension as unknown as {
        runQuery: (query: string) => unknown
      }
    ).runQuery("gen")
    expect(channelResult).toEqual([{ id: "latest-channel" }])
    expect(nextIntent).toHaveBeenCalledOnce()
    expect(mocks.rankChannel).toHaveBeenLastCalledWith(nextChannels, "gen")

    const thirdMembers = [member({ name: "Ada Latest" })]
    const thirdChannels = [channel({ name: "general-latest" })]
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          members: thirdMembers,
          context: "thread",
          mentionCandidates: candidateSource(nextSearch, {
            searchQuery: "ad",
            searchStatus: "ready",
          }),
          channelRefCandidates: thirdChannels,
          onChannelRefIntent: nextIntent,
          resultRef,
        }),
      )
    })
    expect(mocks.rankMention).toHaveBeenLastCalledWith(
      thirdMembers,
      "thread",
      "ad",
    )
    expect(mocks.rankChannel).toHaveBeenLastCalledWith(thirdChannels, "gen")
  })

  it("reranks open mentions, preserves valid selection, and detects visual changes", async () => {
    const resultRef: { current: Result | null } = { current: null }
    const initialItem = {
      kind: "member" as const,
      id: "member-1",
      userId: "user-1",
      label: "Ada#0001",
      name: "Ada",
      discriminator: "0001",
      avatar: "A",
      status: "online" as const,
    }
    const secondItem = { ...initialItem, id: "member-2", userId: "user-2" }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, {
          members: [member()],
          context: "channel",
          channelRefCandidates: [],
          resultRef,
        }),
      )
    })
    const options = mocks.buildMention.mock.calls[0][0]
    await act(async () => {
      options.setPopup({
        items: [initialItem, secondItem],
        query: "",
        selectedIndex: 1,
        command: vi.fn(),
        getRect: null,
      })
    })

    const unchangedState = resultRef.current!.mentionPopup
    mocks.rankMention.mockReturnValue([initialItem, secondItem])
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          members: [member({ name: "Ada Lovelace" })],
          context: "channel",
          channelRefCandidates: [],
          resultRef,
        }),
      )
    })
    expect(resultRef.current!.mentionPopup).toBe(unchangedState)

    mocks.rankMention.mockReturnValue([
      { ...initialItem, status: "offline" },
      secondItem,
    ])
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          members: [member({ status: "offline" })],
          context: "channel",
          channelRefCandidates: [],
          resultRef,
        }),
      )
    })
    expect(resultRef.current!.mentionPopup.items[0]).toMatchObject({
      status: "offline",
    })
    expect(resultRef.current!.mentionPopup.selectedIndex).toBe(1)

    mocks.rankMention.mockReturnValue([{ ...initialItem, avatar: "C" }])
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          members: [member({ avatar: "C" })],
          context: "thread",
          channelRefCandidates: [],
          resultRef,
        }),
      )
    })
    expect(resultRef.current!.mentionPopup.selectedIndex).toBe(0)
  })

  it("loads bare-@ pages serially and exposes first search pages while loading more", async () => {
    const resultRef: { current: Result | null } = { current: null }
    const search = vi.fn()
    const loadMore = vi.fn()
    let source = candidateSource(search, { hasMore: true, loadMore })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, {
        members: [member()],
        context: "channel",
        mentionCandidates: source,
        channelRefCandidates: [],
        resultRef,
      }))
    })
    const options = mocks.buildMention.mock.calls[0][0]
    await act(async () => {
      options.setPopup({
        items: [{ kind: "everyone", id: "everyone", label: "everyone" }],
        query: "",
        selectedIndex: 0,
        command: vi.fn(),
        getRect: null,
      })
    })
    expect(loadMore).toHaveBeenCalledOnce()
    expect(resultRef.current!.mentionPresentation.status).toBe("loading-more")

    const firstSearchItem = {
      kind: "member" as const,
      id: "member-1",
      userId: "user-1",
      label: "Ada#0001",
      name: "Ada",
      discriminator: "0001",
      avatar: "A",
      status: "online" as const,
    }
    await act(async () => {
      options.setPopup({
        items: [],
        query: "ad",
        selectedIndex: 0,
        command: vi.fn(),
        getRect: null,
      })
    })
    expect(resultRef.current!.mentionPresentation.status).toBe("loading")

    mocks.rankMention.mockReturnValue([firstSearchItem])
    source = candidateSource(search, {
      searchQuery: "ad",
      searchStatus: "loading-more",
      loadMore,
    })
    await act(async () => {
      renderer.update(createElement(Harness, {
        members: [member()],
        context: "channel",
        mentionCandidates: source,
        channelRefCandidates: [],
        resultRef,
      }))
    })
    expect(resultRef.current!.mentionPopup.items).toEqual([firstSearchItem])
    expect(resultRef.current!.mentionPresentation.status).toBe("loading-more")

    await act(async () => {
      options.setPopup({
        items: [],
        query: "bob",
        selectedIndex: 0,
        command: vi.fn(),
        getRect: null,
      })
    })
    expect(resultRef.current!.mentionPresentation.status).toBe("loading")
  })

  it("maps matching search loading, loading-more, ready, and empty states to presentation", async () => {
    const resultRef: { current: Result | null } = { current: null }
    const search = vi.fn()
    const item = {
      kind: "member" as const,
      id: "member-1",
      userId: "user-1",
      label: "Ada#0001",
      name: "Ada",
      discriminator: "0001",
      avatar: "A",
      status: "online" as const,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    const renderWith = async (
      searchStatus: NonNullable<Options["mentionCandidates"]>["searchStatus"],
      items: typeof item[],
    ) => {
      mocks.rankMention.mockReturnValue(items)
      await act(async () => {
        renderer.update(createElement(Harness, {
          members: [member()],
          context: "channel",
          mentionCandidates: candidateSource(search, {
            searchQuery: "ad",
            searchStatus,
          }),
          channelRefCandidates: [],
          resultRef,
        }))
      })
    }

    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, {
        members: [member()],
        context: "channel",
        mentionCandidates: candidateSource(search, {
          searchQuery: "ad",
          searchStatus: "loading",
        }),
        channelRefCandidates: [],
        resultRef,
      }))
    })
    const options = mocks.buildMention.mock.calls[0][0]
    const runQuery = (
      resultRef.current!.mentionExtension as unknown as {
        runQuery: (query: string) => unknown
      }
    ).runQuery
    expect(runQuery("ad")).toEqual([])
    expect(search).toHaveBeenCalledWith("ad")
    expect(mocks.rankMention).toHaveBeenLastCalledWith(
      [member()],
      "channel",
      "ad",
    )
    await act(async () => {
      options.setPopup({
        items: [],
        query: "ad",
        selectedIndex: 0,
        command: vi.fn(),
        getRect: null,
      })
    })
    expect(resultRef.current!.mentionPresentation.status).toBe("loading")

    await renderWith("idle", [])
    expect(resultRef.current!.mentionPresentation.status).toBe("loading")

    await renderWith("loading-more", [item])
    expect(resultRef.current!.mentionPopup.items).toEqual([item])
    expect(resultRef.current!.mentionPresentation.status).toBe("loading-more")
    expect(mocks.rankMention).toHaveBeenLastCalledWith(
      [member()],
      "channel",
      "ad",
    )

    await renderWith("ready", [item])
    expect(resultRef.current!.mentionPresentation.status).toBe("ready")

    await renderWith("ready", [])
    expect(resultRef.current!.mentionPopup.items).toEqual([])
    expect(resultRef.current!.mentionPresentation.status).toBe("empty")

    await renderWith("empty", [])
    expect(mocks.rankMention).toHaveBeenLastCalledWith(
      [member()],
      "channel",
      "ad",
    )
    expect(resultRef.current!.mentionPopup.items).toEqual([])
    expect(resultRef.current!.mentionPresentation.status).toBe("empty")
  })

  it("keeps channel state when only serverName changes and resets both popups", async () => {
    const resultRef: { current: Result | null } = { current: null }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, {
          members: [],
          context: "dm",
          channelRefCandidates: [channel()],
          resultRef,
        }),
      )
    })
    const mentionOptions = mocks.buildMention.mock.calls[0][0]
    const channelOptions = mocks.buildChannel.mock.calls[0][0]
    await act(async () => {
      mentionOptions.setPopup({
        items: [{ kind: "everyone", id: "everyone", label: "everyone" }],
        query: "",
        selectedIndex: 0,
        command: vi.fn(),
        getRect: null,
      })
      channelOptions.setPopup({
        items: [channel()],
        selectedIndex: 0,
        command: vi.fn(),
        getRect: null,
      })
    })
    const previousState = resultRef.current!.channelRefPopup
    mocks.rankChannel.mockReturnValue([channel({ serverName: "Two" })])
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          members: [],
          context: "dm",
          channelRefCandidates: [channel({ serverName: "Two" })],
          resultRef,
        }),
      )
    })
    expect(resultRef.current!.channelRefPopup).not.toBe(previousState)
    expect(resultRef.current!.channelRefPopup.items[0].serverName).toBe("Two")

    mocks.rankChannel.mockReturnValue([channel({
      serverName: "Two",
      serverDiscriminator: "0002",
    })])
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          members: [],
          context: "dm",
          channelRefCandidates: [channel({
            serverName: "Two",
            serverDiscriminator: "0002",
          })],
          resultRef,
        }),
      )
    })
    expect(resultRef.current!.channelRefPopup.items[0].serverDiscriminator).toBe("0002")

    const second = channel({ id: "channel-2", name: "random" })
    await act(async () => {
      channelOptions.setPopup({
        items: [channel(), second],
        selectedIndex: 1,
        command: vi.fn(),
        getRect: null,
      })
    })
    mocks.rankChannel.mockReturnValue([
      channel({ name: "general-updated" }),
      second,
    ])
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          members: [],
          context: "dm",
          channelRefCandidates: [channel({ name: "general-updated" }), second],
          resultRef,
        }),
      )
    })
    expect(resultRef.current!.channelRefPopup.selectedIndex).toBe(1)

    mocks.rankChannel.mockReturnValue([channel({ name: "final" })])
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          members: [],
          context: "dm",
          channelRefCandidates: [channel({ name: "final" })],
          resultRef,
        }),
      )
    })
    expect(resultRef.current!.channelRefPopup.selectedIndex).toBe(0)

    await act(async () => resultRef.current!.resetPopups())
    expect(resultRef.current!.mentionPopup.command).toBeNull()
    expect(resultRef.current!.channelRefPopup.command).toBeNull()
  })
})

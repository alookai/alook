import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { createElement, useLayoutEffect } from "react"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import { useCommunityStore } from "@/stores/community"
import { communityKeys } from "@/lib/query-keys"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { beginConversationNavigationProof } from "@/lib/community/conversation-navigation-proof"
import { useBotListController } from "../bots/bot-list-controller"
import type { BotSummary } from "@/hooks/community/use-bots"
import { CommunityInviteCard } from "../social/community-invite-card"
import { useCommunityNavigationController } from "./use-community-navigation-controller"
import MeFriendsPage from "@/app/c/me/friends/page"

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  createDm: vi.fn(),
  join: vi.fn(),
  alreadyMember: false,
  onboarding: null as { status: string; stage: string; botId?: string } | null,
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/c/me/bots",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), prefetch: vi.fn() }),
}))
vi.mock("@/hooks/community/use-bots", () => ({
  useBots: () => ({ bots: [], isLoading: false }),
  useDeleteBot: () => ({}),
  useResetBotSession: () => ({}),
  useResetMachineAgents: () => ({}),
  useSetBotActive: () => ({}),
}))
vi.mock("@/hooks/community/use-machines", () => ({
  useMachines: () => ({ machines: [{ id: "machine", status: "online" }], isLoading: false }),
}))
vi.mock("@/lib/community-db/projections", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/community-db/projections")>(), useCanonicalProfilesByUserId: () => new Map() }))
vi.mock("@/hooks/community/mutations", () => ({
  useCreateOrGetDm: () => ({ mutateAsync: mocks.createDm }),
  useSendFriendRequest: () => ({}),
  useAcceptFriendRequest: () => ({}),
  useRejectFriendRequest: () => ({}),
  useCancelBotFriendRequest: () => ({}),
  useRemoveFriend: () => ({}),
  useBlockUser: () => ({}),
  useUnblockUser: () => ({}),
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/hooks/community/use-friends", () => ({
  useFriends: () => ({ friends: [], pending: [], blocked: [], isLoading: false }),
}))
vi.mock("@/components/community/social/friends-page", () => ({
  FriendsPage: ({ onDm }: { onDm: (id: string) => Promise<void> }) => createElement("button", {
    onClick: () => { void onDm("friend") },
  }, "Friends DM"),
}))
vi.mock("@/lib/community-onboarding", () => ({
  useCommunityOnboarding: () => mocks.onboarding,
  readCommunityOnboardingState: () => mocks.onboarding,
  advanceCommunityOnboarding: vi.fn(),
  updateCommunityOnboardingResources: vi.fn(),
  recoverCommunityOnboardingMachine: vi.fn(),
}))
vi.mock("@/hooks/community/use-servers", () => ({
  useServers: () => ({ servers: mocks.alreadyMember ? [{ id: "server" }] : [] }),
}))
vi.mock("@/hooks/community/mutations/servers", () => ({
  useJoinServer: () => ({ mutateAsync: mocks.join, isPending: false }),
}))
vi.mock("../server-icon", () => ({ ServerIcon: () => null }))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function renderEntries() {
  const queryClient = new QueryClient()
  queryClient.setQueryData(communityKeys.inviteInfo("invite"), {
    serverId: "server", serverName: "Server", serverIcon: null, memberCount: 1,
  })
  let navigation!: ReturnType<typeof useCommunityNavigationController>
  let bots!: ReturnType<typeof useBotListController>
  function Capture() {
    const currentNavigation = useCommunityNavigationController({ ...normalizeCommunityHref("/c/me/bots"), revision: 0 })
    navigation = currentNavigation
    bots = useBotListController()
    useLayoutEffect(() => {
      createCommunityDbRegistry(queryClient, "viewer").runtime.ui.actions.registerUiHandlers({
        cancelPendingNavigation: currentNavigation.cancelPendingNavigation,
        navigatePath: currentNavigation.push,
      })
    }, [currentNavigation.cancelPendingNavigation, currentNavigation.push])
    return createElement("div", null,
      createElement(CommunityInviteCard, { token: "invite", perspective: "recipient" }),
      createElement(MeFriendsPage),
    )
  }
  render(createElement(QueryClientProvider, { client: queryClient }, createElement(Capture)))
  return { queryClient, get navigation() { return navigation }, get bots() { return bots } }
}

const bot = { id: "bot" } as BotSummary
beforeEach(() => {
  vi.clearAllMocks()
  mocks.alreadyMember = false
  mocks.onboarding = null

})


describe("real navigation entry actions", () => {
  it.each(["bot DM", "guided DM", "created bot DM", "invite Join", "Friends DM"])(
    "%s supersedes the old resolver before its own mutation completes",
    async (entry) => {
      const mutation = deferred<{ conversation: { id: string }; serverId: string }>()
      mocks.createDm.mockReturnValue(mutation.promise)
      mocks.join.mockReturnValue(mutation.promise)
      if (entry.includes("guided") || entry.includes("created")) {
        mocks.onboarding = { status: "active", stage: "bot", botId: "bot" }
      }
      const view = renderEntries()
      const old = deferred<string>()
      let oldResult!: Promise<boolean>
      act(() => { oldResult = view.navigation.resolveAndPush(() => old.promise) })
      const proof = beginConversationNavigationProof(view.queryClient, {
        href: "/c/me/old", viewerId: "viewer", channelId: "old", scopeKind: "dm",
      }, 0)
      act(() => {
        if (entry === "bot DM") void view.bots.chatWithBot(bot)
        else if (entry === "guided DM") view.bots.openGuidedCreate()
        else if (entry === "created bot DM") void view.bots.onBotCreated(bot)
        else fireEvent.click(screen.getByRole("button", { name: entry === "invite Join" ? "Join" : "Friends DM" }))
      })
      expect(proof.signal.aborted).toBe(true)
      expect(mocks.push).not.toHaveBeenCalled()
      await act(async () => {
        old.resolve("/c/me/old")
        expect(await oldResult).toBe(false)
      })
      expect(mocks.push).not.toHaveBeenCalled()
      await act(async () => mutation.resolve({ conversation: { id: "new" }, serverId: "server" }))
      expect(mocks.push.mock.calls).toEqual([[entry === "invite Join" ? "/c/channels/server" : "/c/me/new"]])
    },
  )

  it.each(["Go to Server", "Machines", "Reconnect", "Bot audit"])(
    "%s supersedes an older unresolved destination",
    async (entry) => {
      mocks.alreadyMember = true
      const view = renderEntries()
      const old = deferred<string>()
      let result!: Promise<boolean>
      act(() => { result = view.navigation.resolveAndPush(() => old.promise) })
      act(() => {
        if (entry === "Go to Server") fireEvent.click(screen.getByRole("button", { name: entry }))
        else if (entry === "Machines") view.bots.openMachines()
        else if (entry === "Reconnect") view.bots.bringMachineOnline("machine")
        else view.bots.openActivity(bot)
      })
      await act(async () => { old.resolve("/c/me/old"); expect(await result).toBe(false) })
      expect(mocks.push).toHaveBeenCalledOnce()
      expect(mocks.push).not.toHaveBeenCalledWith("/c/me/old")
    },
  )

  it("opening the bot creation dialog preserves the pending intent and proof", () => {
    const view = renderEntries()
    act(() => view.navigation.push("/c/me/old"))
    const proof = beginConversationNavigationProof(view.queryClient, {
      href: "/c/me/old", viewerId: "viewer", channelId: "old", scopeKind: "dm",
    }, 0)
    act(() => view.bots.openGuidedCreate())
    expect(view.bots.createOpen).toBe(true)
    expect(view.navigation.pendingHref).toBe("/c/me/old")
    expect(proof.signal.aborted).toBe(false)
    expect(mocks.push).toHaveBeenCalledOnce()
  })
})

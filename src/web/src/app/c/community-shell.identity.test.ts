import { beforeEach, describe, expect, it, vi } from "vitest"
import React, { useState } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { useCommunityWsStore } from "@/stores/community/ws"

type TestUser = {
  id: string
  name: string
  email: string
  avatar: string
}

let activeUser: TestUser = { id: "user-a", name: "A", email: "a@example.com", avatar: "A" }
let providerInstance = 0
const renderedProviders: Array<{ userId: string | null; instance: number }> = []
const apiFetchProfiles = vi.hoisted(() => vi.fn(() => Promise.resolve({})))

vi.mock("./QueryProvider", () => ({
  QueryProvider: ({ children, userId }: { children: React.ReactNode; userId: string | null }) => {
    const [instance] = useState(() => ++providerInstance)
    renderedProviders.push({ userId, instance })
    return children
  },
}))
vi.mock("@/contexts/community/current-user", () => ({
  CurrentUserProvider: ({ children }: { children: React.ReactNode }) => children,
  useCurrentUser: () => activeUser,
}))
vi.mock("@/hooks/community/use-community-ws", () => ({ useCommunityWs: vi.fn() }))
vi.mock("@/lib/community/profile-seed", () => ({
  apiFetchProfiles: (...args: unknown[]) => apiFetchProfiles(...args),
}))
vi.mock("@/components/perf/perf-trace-bootstrap", () => ({ PerfTraceBootstrap: () => null }))
vi.mock("@/components/daemon-update-notice", () => ({
  CommunityDaemonUpdateNotice: () => null,
}))
vi.mock("@/components/community/onboarding/community-onboarding-guide", () => ({
  CommunityOnboardingGuide: () => null,
}))
vi.mock("@/components/community/shell/community-ws-reconnect-overlay", () => ({
  CommunityWsReconnectBoundary: ({ children }: { children: React.ReactNode }) => children,
}))

import { CommunityShell } from "./community-shell"

beforeEach(() => {
  useCommunityWsStore.getState().reset()
  activeUser = { id: "user-a", name: "A", email: "a@example.com", avatar: "A" }
  providerInstance = 0
  renderedProviders.length = 0
  apiFetchProfiles.mockReset()
  apiFetchProfiles.mockResolvedValue({})
})

describe("CommunityShell identity boundary", () => {
  it("remounts the in-memory query boundary when the signed-in user changes", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(
        CommunityShell,
        { currentUser: activeUser },
        React.createElement("span", null, "content"),
      ))
    })
    expect(renderedProviders.at(-1)).toEqual({ userId: "user-a", instance: 1 })

    activeUser = { id: "user-b", name: "B", email: "b@example.com", avatar: "B" }
    act(() => {
      renderer.update(React.createElement(
        CommunityShell,
        { currentUser: activeUser },
        React.createElement("span", null, "content"),
      ))
    })
    expect(renderedProviders.at(-1)).toEqual({ userId: "user-b", instance: 2 })
    renderer.unmount()
  })

  it("does not mount a new account subtree against the previous account profile state", () => {
    const renderedProfileStates: Array<{ viewerId: string | null; profileNames: string[] }> = []
    function ProfileStateProbe() {
      const viewerId = useCommunityWsStore((state) => state.profileViewerId)
      const profiles = useCommunityWsStore((state) => state.profilesByUserId)
      renderedProfileStates.push({
        viewerId,
        profileNames: [...profiles.values()].map((profile) => profile.name),
      })
      return null
    }

    const profiles = useCommunityWsStore.getState()
    profiles.activateProfileAccount("user-a")
    profiles.patchProfiles(profiles.beginProfileSnapshot(), [{
      id: "user-a",
      identityAbout: { name: "Previous account" },
    }])
    const accountAEpoch = useCommunityWsStore.getState().profileAccountEpoch

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(
        CommunityShell,
        { currentUser: activeUser },
        React.createElement(ProfileStateProbe),
      ))
    })
    renderedProfileStates.length = 0

    activeUser = { id: "user-b", name: "B", email: "b@example.com", avatar: "B" }
    act(() => {
      renderer.update(React.createElement(
        CommunityShell,
        { currentUser: activeUser },
        React.createElement(ProfileStateProbe),
      ))
    })

    expect(renderedProfileStates.length).toBeGreaterThan(0)
    expect(renderedProfileStates).toEqual(
      renderedProfileStates.map(() => ({ viewerId: "user-b", profileNames: [] })),
    )
    expect(useCommunityWsStore.getState()).toMatchObject({
      profileViewerId: "user-b",
      profileAccountEpoch: accountAEpoch + 1,
    })
    act(() => renderer.unmount())
  })

  it("reactivates a cleared account without a render-phase update in StrictMode", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          CommunityShell,
          { currentUser: activeUser },
          React.createElement("span", null, "content"),
        ),
      ))
    })
    expect(useCommunityWsStore.getState().profileViewerId).toBe("user-a")

    act(() => {
      useCommunityWsStore.getState().activateProfileAccount(null)
    })
    expect(useCommunityWsStore.getState().profileViewerId).toBe("user-a")
    const consoleOutput = consoleError.mock.calls.flat().join("\n")
    expect(consoleOutput).not.toContain("Cannot update a component")
    expect(consoleOutput).not.toContain("while rendering a different component")

    act(() => renderer.unmount())
    consoleError.mockRestore()
  })

  it("loads the canonical self profile through the typed seeding boundary", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        CommunityShell,
        { currentUser: activeUser },
        React.createElement("span", null, "content"),
      ))
      await Promise.resolve()
    })

    expect(apiFetchProfiles).toHaveBeenCalledWith(
      "/api/community/users/me/profile",
      expect.any(Function),
    )
    const mapProfile = apiFetchProfiles.mock.calls[0]![1] as (profile: Record<string, unknown>) => unknown
    expect(mapProfile({
      id: "user-a",
      name: "Jane Roe",
      discriminator: "4242",
      aboutMe: "hello",
      avatar: "new-avatar",
      avatarVersion: 3,
      statusEmoji: null,
      statusText: "",
    })).toEqual([{
      id: "user-a",
      identityAbout: {
        name: "Jane Roe",
        discriminator: "4242",
        aboutMe: "hello",
      },
      avatar: { avatar: "new-avatar", avatarVersion: 3 },
      status: { statusEmoji: null, statusText: "" },
    }])
    renderer.unmount()
  })
})

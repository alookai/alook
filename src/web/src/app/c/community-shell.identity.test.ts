import { beforeEach, describe, expect, it, vi } from "vitest"
import React, { useState } from "react"
import TestRenderer, { act } from "react-test-renderer"

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

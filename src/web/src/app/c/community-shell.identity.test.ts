import { beforeEach, describe, expect, it, vi } from "vitest"
import React, { useState } from "react"
import TestRenderer, { act } from "react-test-renderer"

type TestUser = {
  id: string
  name: string
  email: string
  avatar: string
  aboutMe?: string
  discriminator?: string
  statusEmoji?: string | null
  statusText?: string | null
}

type ProfileResponse = {
  aboutMe: string
  avatar: string
  discriminator: string
  name: string
  statusEmoji: string | null
  statusText: string
}

let activeUser: TestUser = { id: "user-a", name: "A", email: "a@example.com", avatar: "A" }
let providerInstance = 0
const renderedProviders: Array<{ userId: string | null; instance: number }> = []
const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<() => Promise<ProfileResponse>>(),
}))
const setCurrentUser = vi.fn((updater: (user: TestUser) => TestUser) => {
  activeUser = updater(activeUser)
})

vi.mock("./QueryProvider", () => ({
  QueryProvider: ({ children, userId }: { children: React.ReactNode; userId: string | null }) => {
    const [instance] = useState(() => {
      providerInstance += 1
      return providerInstance
    })
    renderedProviders.push({ userId, instance })
    return children
  },
}))
vi.mock("@/contexts/community/current-user", () => ({
  CurrentUserProvider: ({ children }: { children: React.ReactNode }) => children,
  useCurrentUser: () => activeUser,
  useSetCurrentUser: () => setCurrentUser,
}))
vi.mock("@/hooks/community/use-community-ws", () => ({ useCommunityWs: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch }))
vi.mock("@/components/perf/perf-trace-bootstrap", () => ({ PerfTraceBootstrap: () => null }))
vi.mock("@/components/community/onboarding/community-onboarding-guide", () => ({
  CommunityOnboardingGuide: () => null,
}))

import { CommunityShell } from "./community-shell"

beforeEach(() => {
  activeUser = { id: "user-a", name: "A", email: "a@example.com", avatar: "A" }
  providerInstance = 0
  renderedProviders.length = 0
  apiFetch.mockReset()
  apiFetch.mockImplementation(() => new Promise(() => undefined))
  setCurrentUser.mockClear()
})

describe("CommunityShell identity boundary", () => {
  it("remounts the in-memory query client boundary when the signed-in user changes", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(
        CommunityShell,
        { currentUser: activeUser },
        React.createElement("span", null, "content"),
      ))
    })
    const userAInstance = renderedProviders.at(-1)?.instance

    activeUser = { id: "user-b", name: "B", email: "b@example.com", avatar: "B" }
    act(() => {
      renderer.update(React.createElement(
        CommunityShell,
        { currentUser: activeUser },
        React.createElement("span", null, "content"),
      ))
    })

    expect(renderedProviders.at(-1)).toEqual({ userId: "user-b", instance: 2 })
    expect(userAInstance).toBe(1)
    renderer.unmount()
  })

  it("hydrates a stale session name from the canonical self profile", async () => {
    activeUser = { id: "user-a", name: "Alice", email: "a@example.com", avatar: "old-avatar" }
    apiFetch.mockResolvedValueOnce({
      aboutMe: "hello",
      avatar: "new-avatar",
      discriminator: "4242",
      name: "Jane Roe",
      statusEmoji: "🌱",
      statusText: "Growing",
    })

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        CommunityShell,
        { currentUser: activeUser },
        React.createElement("span", null, "content"),
      ))
      await Promise.resolve()
    })

    expect(apiFetch).toHaveBeenCalledWith("/api/community/users/me/profile")
    expect(setCurrentUser).toHaveBeenCalledOnce()
    expect(activeUser).toMatchObject({
      name: "Jane Roe",
      aboutMe: "hello",
      avatar: "new-avatar",
      discriminator: "4242",
      statusEmoji: "🌱",
      statusText: "Growing",
    })
    renderer.unmount()
  })

  it("preserves the session name when the self profile has no canonical name", async () => {
    activeUser = { id: "user-a", name: "Alice", email: "a@example.com", avatar: "old-avatar" }
    apiFetch.mockResolvedValueOnce({
      aboutMe: "hello",
      avatar: "",
      discriminator: "4242",
      name: "",
      statusEmoji: null,
      statusText: "",
    })

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        CommunityShell,
        { currentUser: activeUser },
        React.createElement("span", null, "content"),
      ))
      await Promise.resolve()
    })

    expect(activeUser).toMatchObject({
      name: "Alice",
      aboutMe: "hello",
      avatar: "old-avatar",
      discriminator: "4242",
      statusEmoji: null,
      statusText: "",
    })
    renderer.unmount()
  })
})

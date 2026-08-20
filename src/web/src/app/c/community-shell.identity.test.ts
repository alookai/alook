import { beforeEach, describe, expect, it, vi } from "vitest"
import React, { useState } from "react"
import TestRenderer, { act } from "react-test-renderer"

let activeUser = { id: "user-a", name: "A", email: "a@example.com", avatar: "A" }
let providerInstance = 0
const renderedProviders: Array<{ userId: string | null; instance: number }> = []

vi.mock("@/modules/community/client", () => ({
  CommunityQueryProvider: ({ children, userId }: { children: React.ReactNode; userId: string | null }) => {
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
  useSetCurrentUser: () => vi.fn(),
}))
vi.mock("@/hooks/community/use-community-ws", () => ({ useCommunityWs: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }))
vi.mock("@/components/perf/perf-trace-bootstrap", () => ({ PerfTraceBootstrap: () => null }))
vi.mock("@/components/community/onboarding/community-onboarding-guide", () => ({
  CommunityOnboardingGuide: () => null,
}))

import { CommunityShell } from "./community-shell"

beforeEach(() => {
  activeUser = { id: "user-a", name: "A", email: "a@example.com", avatar: "A" }
  providerInstance = 0
  renderedProviders.length = 0
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
})

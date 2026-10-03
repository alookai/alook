import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { describe, expect, it, vi } from "vitest"
import { render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"

vi.mock("./settings-shell.module.css", () => ({ default: { shell: "settings-shell" } }))
const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: apiFetchMock, toastApiError: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/hooks/community/use-server-panels", () => ({ useInvites: () => ({ invites: [], isLoading: false }) }))
vi.mock("@/hooks/community/use-bots", () => ({ useBots: () => ({ bots: [] }) }))
vi.mock("@/hooks/community/use-notification-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/community/use-notification-settings")>(),
  useBotNotificationSetting: () => ({ data: undefined, isError: false, isLoading: false }),
  useSetBotNotificationSetting: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { ServerSettings } from "./server-settings"

const props = { section: "overview" as const, setSection: vi.fn(), onClose: vi.fn(), serverId: "server-1", serverName: "Server", members: [] }

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children)
  return { client, wrapper }
}

describe("Channels tab access", () => {
  it("lets an administrator select Channels", async () => {
    const { client, wrapper } = setup()
    const setSection = vi.fn()
    const user = setupUser()
    const rendered = render(createElement(ServerSettings, { ...props, isAdmin: true, setSection }), { wrapper })
    await user.click(screen.getByTestId(tid.settingsTab("channels")))
    expect(setSection).toHaveBeenCalledWith("channels")
    rendered.unmount()
    client.clear()
  })

  it("hides the entry and rejects a stale Channels selection after role loss", () => {
    const { client, wrapper } = setup()
    const rendered = render(createElement(ServerSettings, { ...props, isAdmin: false, section: "channels" }), { wrapper })
    expect(screen.queryByTestId(tid.settingsTab("channels"))).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "overview" })).toBeVisible()
    expect(screen.queryByTestId(tid.settingsChannels)).not.toBeInTheDocument()
    rendered.unmount()
    client.clear()
  })

  it("requests only when Channels opens, and removes the list when the role is lost", async () => {
    apiFetchMock.mockReset().mockResolvedValue({ channels: [{ id: "private-1", name: "private-1", category: null, creator: null, createdAt: "2026-10-01T00:00:00.000Z" }] })
    const { client, wrapper } = setup()
    const rendered = render(createElement(ServerSettings, { ...props, isAdmin: true }), { wrapper })
    expect(apiFetchMock).not.toHaveBeenCalled()
    rendered.rerender(createElement(ServerSettings, { ...props, isAdmin: true, section: "members" }))
    expect(apiFetchMock).not.toHaveBeenCalled()
    rendered.rerender(createElement(ServerSettings, { ...props, isAdmin: true, section: "channels" }))
    await waitFor(() => expect(screen.getByTestId(tid.settingsChannel("private-1"))).toBeVisible())
    expect(apiFetchMock).toHaveBeenCalledOnce()
    rendered.rerender(createElement(ServerSettings, { ...props, isAdmin: false, section: "channels" }))
    expect(screen.queryByTestId(tid.settingsChannels)).not.toBeInTheDocument()
    expect(screen.queryByText("private-1")).not.toBeInTheDocument()
    expect(apiFetchMock).toHaveBeenCalledOnce()
    rendered.unmount()
    client.clear()
  })
})

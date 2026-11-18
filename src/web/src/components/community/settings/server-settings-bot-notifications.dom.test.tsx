import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { act, render, setupUser, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { ApiError } from "@/lib/errors"

const api = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: toast }))
vi.mock("@/hooks/community/use-bots", () => ({ useBots: () => ({ bots: [{ id: "bot-a", name: "Bot A" }, { id: "bot-b", name: "Bot B" }] }) }))
vi.mock("./settings-shell.module.css", () => ({ default: { shell: "settings-shell" } }))

import { SettingsNotifications } from "./server-settings"

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client }, children)
  return { client, wrapper }
}

beforeEach(() => { api.mockReset(); toast.mockReset() })

describe("Bot notification display and actual mutation admission", () => {
  it("shows a restored value and blocks interaction until the exact real GET completes", async () => {
    const user = setupUser(), { client, wrapper } = setup()
    client.setQueryData(communityKeys.botNotificationSetting("bot-a", "server", "server"), { level: "mentions", serverId: "server", observed: false })
    let release!: (data: unknown) => void
    const held = new Promise(resolve => { release = resolve })
    let updated = false
    api.mockImplementation((_path: string, options: { method?: string } = {}) => {
      if (options.method === "PUT") { updated = true; return Promise.resolve({}) }
      return updated ? Promise.resolve({ level: "all" }) : held
    })
    const view = render(<SettingsNotifications serverId="server" />, { wrapper })
    await user.click(view.getByRole("button", { name: "Bot A" }))
    const all = view.getByRole("radio", { name: /Every message/ }), mentions = view.getByRole("radio", { name: /Mentions only/ })
    expect(mentions).toHaveAttribute("aria-checked", "true")
    expect(all).toHaveAttribute("aria-disabled", "true")
    await user.click(all)
    expect(api.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(0)
    await act(async () => { release({ level: "mentions" }) })
    await waitFor(() => expect(all).not.toHaveAttribute("aria-disabled", "true"))
    await user.click(all)
    await waitFor(() => expect(api.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(1))
    expect(api).toHaveBeenCalledWith("/api/community/bots/bot-a/notifications/server/server", expect.objectContaining({ method: "PUT", body: JSON.stringify({ level: "all" }), authenticationAccount: "viewer" }))
    await waitFor(() => expect(all).toHaveAttribute("aria-checked", "true"))
  })

  it("retains an old selection on an ordinary failure and uses the existing Retry", async () => {
    const user = setupUser(), { client, wrapper } = setup()
    client.setQueryData(communityKeys.botNotificationSetting("bot-a", "server", "server"), { level: "mentions", serverId: "server", observed: false })
    api.mockRejectedValueOnce(new ApiError("offline", 503)).mockResolvedValue({ level: "mentions" })
    const view = render(<SettingsNotifications serverId="server" />, { wrapper })
    await user.click(view.getByRole("button", { name: "Bot A" }))
    await waitFor(() => expect(view.getByText("Could not refresh bot notifications.")).toBeTruthy())
    expect(view.queryByText("This bot cannot access this server.")).toBeNull()
    const mentions = view.getByRole("radio", { name: /Mentions only/ })
    expect(mentions).toHaveAttribute("aria-checked", "true")
    expect(mentions).toHaveAttribute("aria-disabled", "true")
    await user.click(view.getByRole("radio", { name: /Every message/ }))
    expect(api.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(0)
    await user.click(view.getByRole("button", { name: /Retry/ }))
    await waitFor(() => expect(mentions).not.toHaveAttribute("aria-disabled", "true"))
    expect(api.mock.calls.filter(([, options]) => options?.method)).toHaveLength(0)
  })

  it("keeps an issued write with its original Bot when the selected actor changes", async () => {
    const user = setupUser(), { wrapper } = setup()
    let release!: (data: unknown) => void
    const held = new Promise(resolve => { release = resolve })
    api.mockImplementation((path: string, options: { method?: string } = {}) => options.method === "PUT" ? held
      : Promise.resolve({ level: path.includes("bot-a") ? "mentions" : "nothing" }))
    const view = render(<SettingsNotifications serverId="server" />, { wrapper })
    await user.click(view.getByRole("button", { name: "Bot A" }))
    const all = view.getByRole("radio", { name: /Every message/ })
    await waitFor(() => expect(all).not.toHaveAttribute("aria-disabled", "true"))
    await user.click(all)
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true))
    const request = api.mock.calls.find(([, options]) => options?.method === "PUT")!
    await user.click(view.getByRole("button", { name: "Bot B" }))
    expect(request[1].signal.aborted).toBe(true)
    await act(async () => { release({}) })
    const nothing = view.getByRole("radio", { name: /Mute/ })
    await waitFor(() => expect(nothing).toHaveAttribute("aria-checked", "true"))
    expect(api.mock.calls.filter(([, options]) => options?.method === "PUT").map(([path]) => path)).toEqual(["/api/community/bots/bot-a/notifications/server/server"])
    expect(toast).not.toHaveBeenCalled()
  })
})

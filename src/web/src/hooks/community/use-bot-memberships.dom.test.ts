import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { useBotMemberships } from "./use-bot-memberships"

const apiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

function setup(botId = "bot_1", open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client }, children)
  return { ...renderHook((props: { botId: string; open: boolean }) => useBotMemberships(props.botId, props.open), { initialProps: { botId, open }, wrapper }), client }
}

describe("owned bot memberships", () => {
  beforeEach(() => apiFetch.mockReset())

  it("loads only the selected bot while open", async () => {
    apiFetch.mockResolvedValue({ servers: [], groups: [] })
    const view = setup("bot_1", false)
    expect(apiFetch).not.toHaveBeenCalled()
    view.rerender({ botId: "bot_1", open: true })
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    expect(apiFetch).toHaveBeenCalledWith("/api/community/servers/channels", expect.objectContaining({ authenticationAccount: "viewer", headers: { "X-Alook-Bot-Id": "bot_1" } }))
  })

  it("flattens categories into their server and keeps empty servers and public restrictions", async () => {
    apiFetch.mockResolvedValue({ servers: [{ id: "s1", handle: "studio#0042", name: "studio", canLeave: true, icon: null }, { id: "s2", handle: "empty#0043", name: "empty", canLeave: false, icon: null }], groups: [{ category: { name: "hidden grouping", private: true }, channels: [{ ref: "/studio#0042/work", name: "work", type: "forum", visibility: "private" }] }, { category: null, channels: [{ ref: "/studio#0042/all", name: "all", type: "text", visibility: "public" }] }] })
    const view = setup()
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    expect(view.result.current.data?.servers[0].channels).toEqual([{ id: "/studio#0042/work", name: "work", type: "forum", canLeave: true }, { id: "/studio#0042/all", name: "all", type: "text", canLeave: false }])
    expect(view.result.current.data?.servers[1]).toMatchObject({ canLeave: false, channels: [] })
  })

  it("preserves membership data when leave fails and allows a retry", async () => {
    apiFetch.mockImplementation((_path: string, options: RequestInit = {}) => options.method === "DELETE" ? Promise.reject(new Error("try again")) : Promise.resolve({ servers: [], groups: [] }))
    const view = setup()
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    await act(async () => { await expect(view.result.current.leave({ kind: "channel", id: "c1", ref: "/studio#0042/work", name: "work" })).rejects.toThrow("try again") })
    await waitFor(() => expect(view.result.current.pending).toBe(false))
    expect(view.result.current.data).toEqual({ servers: [] })
  })

  it("blocks duplicate exits and refreshes only the selected bot after success", async () => {
    let finish!: () => void
    apiFetch.mockImplementation((_path: string, options: RequestInit = {}) => options.method === "DELETE" ? new Promise<void>((resolve) => { finish = resolve }) : Promise.resolve({ servers: [], groups: [] }))
    const view = setup()
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    const target = { kind: "channel" as const, id: "channel_1", ref: "/studio#0042/work", name: "work" }
    let first!: Promise<boolean>
    act(() => { first = view.result.current.leave(target) })
    await waitFor(() => expect(view.result.current.pending).toBe(true))
    expect(await view.result.current.leave(target)).toBe(false)
    await act(async () => { finish(); expect(await first).toBe(true) })
    expect(apiFetch.mock.calls.filter(([, opts]) => opts?.method === "DELETE")).toHaveLength(1)
    expect(apiFetch).toHaveBeenCalledWith("/api/community/channels/resolve/members/self?ref=%2Fstudio%230042%2Fwork", expect.objectContaining({ method: "DELETE" }))
  })

  it("keeps a late exit bound to its original bot and rejects closed-view completion", async () => {
    let finish!: () => void
    apiFetch.mockImplementation((_path: string, options: RequestInit = {}) => options.method === "POST" ? new Promise<void>((resolve) => { finish = resolve }) : Promise.resolve({ servers: [], groups: [] }))
    const view = setup()
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    let outcome!: Promise<unknown>
    act(() => { outcome = view.result.current.leave({ kind: "server", id: "server_1", ref: "studio#0042", name: "work" }).catch((error) => error) })
    await waitFor(() => expect(view.result.current.pending).toBe(true))
    view.rerender({ botId: "bot_2", open: true })
    await act(async () => { finish(); expect(await outcome).toMatchObject({ name: "AbortError" }) })
    expect(apiFetch).toHaveBeenCalledWith("/api/community/servers/resolve/leave?server=studio%230042", expect.objectContaining({ method: "POST" }))
    await waitFor(() => expect(view.result.current.data).toEqual({ servers: [] }))
  })
})

import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, setupUser, within } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { ServerSettingsChannels } from "./server-settings-channels"

const query = vi.hoisted(() => ({ channels: undefined as unknown, isError: false, isFetching: false, forbidden: false, refetch: vi.fn() }))
vi.mock("@/hooks/community/use-server-admin-channels", () => ({ useServerAdminChannels: () => query }))

beforeEach(() => {
  Object.assign(query, { channels: undefined, isError: false, isFetching: false, forbidden: false })
  query.refetch.mockReset()
})

describe("read-only channel metadata", () => {
  it("shows groups, channel names, creator handles and exact dates without navigation", () => {
    query.channels = [
      { id: "public", name: "general", category: null, creator: null, createdAt: "2026-10-01T00:00:00.000Z" },
      { id: "private", name: "long-private-name", category: { id: "cat", name: "PRIVATE GROUP", private: true }, creator: { name: "Alice", handle: "alice#0001" }, createdAt: "2026-10-01T01:00:00.000Z" },
    ]
    render(createElement(ServerSettingsChannels, { serverId: "server-1" }))
    const group = screen.getByRole("region", { name: "Group: PRIVATE GROUP" })
    expect(within(group).getByText("long-private-name")).toBeVisible()
    expect(within(group).getByText("@alice#0001")).toHaveAttribute("title", "@alice#0001")
    expect(within(group).getByText(/2026/).closest("time")).toHaveAttribute("datetime", "2026-10-01T01:00:00.000Z")
    expect(screen.getByRole("region", { name: "Group: Uncategorized" })).toBeVisible()
    expect(screen.getByText("Deleted user")).toBeVisible()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Private group")).toBeVisible()
    expect(screen.queryByLabelText("Public group")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Group: PRIVATE GROUP" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
  })

  it("collapses and expands the settings group without navigating or fetching again", async () => {
    query.channels = [{ id: "private", name: "private-forum", type: "forum", category: { id: "cat", name: "PRIVATE GROUP", private: true }, creator: null, createdAt: "2026-10-01T00:00:00.000Z" }]
    const user = setupUser()
    render(createElement(ServerSettingsChannels, { serverId: "server-1" }))
    const toggle = screen.getByRole("button", { name: "Group: PRIVATE GROUP" })
    await user.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId(tid.settingsChannel("private"))).not.toBeInTheDocument()
    await user.keyboard("{Enter}")
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId(tid.settingsChannel("private"))).toBeVisible()
    await user.keyboard(" ")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId(tid.settingsChannel("private"))).not.toBeInTheDocument()
    expect(query.refetch).not.toHaveBeenCalled()
  })

  it("distinguishes an unresolved request from an empty list", () => {
    const rendered = render(createElement(ServerSettingsChannels, { serverId: "server-1" }))
    expect(screen.getByRole("status")).toHaveTextContent("Loading channels…")
    query.channels = []
    rendered.rerender(createElement(ServerSettingsChannels, { serverId: "server-1" }))
    expect(screen.getByText("No channels yet.")).toBeVisible()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("offers retry on failure, disables it during retry and retains loaded rows", async () => {
    query.isError = true
    const user = setupUser()
    const rendered = render(createElement(ServerSettingsChannels, { serverId: "server-1" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t load channels.")
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(query.refetch).toHaveBeenCalledOnce()
    query.isFetching = true
    query.channels = [{ id: "public", name: "general", category: null, creator: null, createdAt: "2026-10-01T00:00:00.000Z" }]
    rendered.rerender(createElement(ServerSettingsChannels, { serverId: "server-1" }))
    expect(screen.getByTestId(tid.settingsChannel("public"))).toBeVisible()
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t refresh channels.")
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled()
  })

  it("renders no cached metadata after an authorization failure", () => {
    query.forbidden = true
    query.channels = [{ id: "private", name: "secret-name", category: null, creator: null, createdAt: "2026-10-01T00:00:00.000Z" }]
    render(createElement(ServerSettingsChannels, { serverId: "server-1" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Only server administrators")
    expect(screen.queryByText("secret-name")).not.toBeInTheDocument()
  })
})

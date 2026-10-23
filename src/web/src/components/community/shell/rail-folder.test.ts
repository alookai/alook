import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RailFolder, railFolderPropsEqual } from "./rail-folder"

const base = {
  folderId: "folder",
  name: "Group",
  open: false,
  active: false,
  unread: false,
  onToggle: vi.fn(),
  folderServers: [{ id: "server", name: "Server", initial: "S", icon: null }],
}

describe("RailFolder memo boundary", () => {
  it("retracts the expanded folder bar and restores aggregate state only when collapsed", () => {
    const expanded = renderToStaticMarkup(createElement(RailFolder, { ...base, open: true, active: true, unread: true }))
    expect(expanded).toContain("h-0 opacity-0")
    expect(expanded).not.toContain("group-hover:h-5")
    const collapsed = renderToStaticMarkup(createElement(RailFolder, { ...base, active: true, unread: true }))
    expect(collapsed).toContain("h-8")
    expect(collapsed).not.toContain("opacity-0")
  })
  it("rerenders for aggregate unread/open/active but ignores callback identity", () => {
    expect(railFolderPropsEqual(base, { ...base, onToggle: vi.fn() })).toBe(true)
    expect(railFolderPropsEqual(base, { ...base, unread: true })).toBe(false)
    expect(railFolderPropsEqual(base, { ...base, open: true })).toBe(false)
    expect(railFolderPropsEqual(base, { ...base, active: true })).toBe(false)
    expect(railFolderPropsEqual(base, { ...base, name: "Team" })).toBe(false)
  })

  it("rerenders only when thumbnail presentation changes", () => {
    expect(railFolderPropsEqual(base, {
      ...base,
      folderServers: base.folderServers.map((server) => ({ ...server })),
    })).toBe(true)
    expect(railFolderPropsEqual(base, {
      ...base,
      folderServers: [{ ...base.folderServers[0]!, icon: "/new.png" }],
    })).toBe(false)
  })


  it("rerenders when the shared drag description changes", () => {
    expect(railFolderPropsEqual(base, { ...base, dragDescriptionId: "rail-help" })).toBe(false)
  })
})

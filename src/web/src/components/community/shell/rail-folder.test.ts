import { describe, expect, it, vi } from "vitest"
import { railFolderPropsEqual } from "./rail-folder"

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

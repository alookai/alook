import React, { useLayoutEffect } from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { ApplicationOwnerProvider, createApplicationOwner, retireApplicationOwner, type ApplicationOwner } from "@/lib/application-owner"
import { useAgentFolders } from "./use-agent-folders"

type Folders = ReturnType<typeof useAgentFolders>
let owner: ApplicationOwner
const readers = new Map<string, Folders>()
function Probe({ name, workspace = "first" }: { name: string; workspace?: string }) {
  const folders = useAgentFolders(workspace)
  useLayoutEffect(() => { readers.set(name, folders) })
  return <output data-testid={name}>{folders.folders.flatMap((folder) => folder.agentIds).join(",")}</output>
}
function App({ current = owner, children }: { current?: ApplicationOwner; children: React.ReactNode }) {
  return <ApplicationOwnerProvider owner={current}>{children}</ApplicationOwnerProvider>
}
beforeEach(() => {
  localStorage.clear()
  readers.clear()
  owner = createApplicationOwner("folders-A", new QueryClient())
  return () => { retireApplicationOwner(owner); owner.queryClient.clear() }
})

describe("actual folder preferences and native local expansion", () => {
  it("shares persisted topology between readers while expansion stays with its consumer", () => {
    const view = render(<App><Probe name="left" /><Probe name="right" /><Probe name="other" workspace="second" /></App>)
    act(() => readers.get("left")!.createFolder(["a", "b"]))
    const folder = readers.get("right")!.folders[0]!
    expect(view.getByTestId("left").textContent).toBe("a,b")
    expect(view.getByTestId("right").textContent).toBe("a,b")
    expect(view.getByTestId("other").textContent).toBe("")
    expect(readers.get("left")!.expandedFolderId).toBe(folder.id)
    expect(readers.get("right")!.expandedFolderId).toBeNull()
    expect(JSON.parse(localStorage.getItem("alook:folders-A:ui:agent-sidebar-folders:first")!)).toEqual({ folders: [folder] })
    act(() => readers.get("right")!.addToFolder(folder.id, "c"))
    act(() => readers.get("left")!.addToFolder(folder.id, "c"))
    expect(readers.get("left")!.folders[0]!.agentIds).toEqual(["a", "b", "c"])
    act(() => readers.get("right")!.reorderInFolder(folder.id, ["c", "b", "a"]))
    expect(readers.get("left")!.getTopLevelItems(["z", "a", "c", "b"])).toEqual([
      { type: "agent", id: "z" }, { type: "folder", folder: { id: folder.id, agentIds: ["c", "b", "a"] } },
    ])
    expect(readers.get("right")!.getFolderForAgent("b")?.id).toBe(folder.id)
    expect(readers.get("right")!.getFolderForAgent("z")).toBeNull()
  })

  it("merges, removes stale members and dissolves undersized folders without losing ungrouped agents", () => {
    render(<App><Probe name="left" /></App>)
    act(() => readers.get("left")!.createFolder(["a"]))
    expect(readers.get("left")!.folders).toEqual([])
    act(() => readers.get("left")!.createFolder(["a", "b"]))
    act(() => readers.get("left")!.createFolder(["a", "b"]))
    expect(readers.get("left")!.folders).toHaveLength(1)
    act(() => readers.get("left")!.createFolder(["c", "d"]))
    const [first, second] = readers.get("left")!.folders
    act(() => readers.get("left")!.mergeFolders(second!.id, first!.id))
    expect(readers.get("left")!.folders[0]!.agentIds).toEqual(["a", "b", "c", "d"])
    act(() => readers.get("left")!.cleanupStaleAgents(["a", "b", "c"]))
    act(() => readers.get("left")!.removeFromFolder(first!.id, "c"))
    act(() => readers.get("left")!.removeAgentFromAnyFolder("a"))
    expect(readers.get("left")!.folders).toEqual([])
    expect(readers.get("left")!.getTopLevelItems(["a", "b", "c"])).toEqual(["a", "b", "c"].map((id) => ({ type: "agent", id })))
    act(() => readers.get("left")!.createFolder(["a", "b"]))
    const last = readers.get("left")!.folders[0]!
    act(() => readers.get("left")!.dissolveFolder(last.id))
    expect(readers.get("left")!.expandedFolderId).toBeNull()
  })

  it("restores only the selected account/workspace and rejects a retired account's late writer", () => {
    localStorage.setItem("agent-sidebar-folders:first", JSON.stringify({ folders: [{ id: "legacy", agentIds: ["wrong", "device"] }] }))
    localStorage.setItem("alook:folders-B:ui:agent-sidebar-folders:first", JSON.stringify({ folders: [{ id: "B-folder", agentIds: ["B1", "B2"] }] }))
    const view = render(<App><Probe name="left" /></App>)
    expect(readers.get("left")!.folders).toEqual([])
    act(() => readers.get("left")!.createFolder(["A1", "A2"]))
    const old = readers.get("left")!
    const before = localStorage.getItem("alook:folders-A:ui:agent-sidebar-folders:first")
    const next = createApplicationOwner("folders-B", new QueryClient())
    act(() => { retireApplicationOwner(owner); view.rerender(<App current={next}><Probe name="left" /></App>) })
    expect(readers.get("left")!.folders[0]!.id).toBe("B-folder")
    act(() => old.addToFolder(old.folders[0]!.id, "late-A"))
    expect(localStorage.getItem("alook:folders-A:ui:agent-sidebar-folders:first")).toBe(before)
    expect(readers.get("left")!.folders[0]!.agentIds).toEqual(["B1", "B2"])
    act(() => view.rerender(<App current={next}><Probe name="left" workspace="second" /></App>))
    expect(readers.get("left")!.folders).toEqual([])
    view.unmount()
    retireApplicationOwner(next)
    next.queryClient.clear()
  })
})

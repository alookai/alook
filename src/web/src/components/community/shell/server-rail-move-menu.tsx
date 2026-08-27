"use client"

import { useEffect, useMemo, useState } from "react"
import { MAX_SERVER_RAIL_FOLDERS } from "@alook/shared"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  folderForServer,
  visibleTopLevelServers,
  type RailEntity,
  type RailInstruction,
  type RailState,
} from "@/lib/community/server-rail-model"

type Destination = "rail" | "new" | `folder:${string}` | "folders"

export function ServerRailMoveMenu({
  source,
  state,
  serverNames,
  folderNames,
  onClose,
  onMove,
}: {
  source: RailEntity | null
  state: RailState
  serverNames: ReadonlyMap<string, string>
  folderNames: ReadonlyMap<string, string>
  onClose: () => void
  onMove: (instruction: RailInstruction) => void
}) {
  const sourceFolder = source?.kind === "server" ? folderForServer(state, source.id) : null
  const [destination, setDestination] = useState<Destination>("rail")
  const [targetId, setTargetId] = useState("")
  const [placement, setPlacement] = useState<"before" | "after" | "inside">("after")

  const targets = useMemo(() => {
    if (!source) return []
    if (source.kind === "folder") {
      return state.folderOrder.filter((folderId) => folderId !== source.id)
    }
    if (destination === "rail" || destination === "new") {
      return visibleTopLevelServers(state).filter((serverId) => serverId !== source.id)
    }
    if (destination.startsWith("folder:")) {
      return (state.folders[destination.slice("folder:".length)] ?? [])
        .filter((serverId) => serverId !== source.id)
    }
    return []
  }, [destination, source, state])

  useEffect(() => {
    if (!source) return
    const initialDestination: Destination = source.kind === "folder"
      ? "folders"
      : sourceFolder
        ? `folder:${sourceFolder}`
        : "rail"
    setDestination(initialDestination)
    setPlacement("after")
  }, [source, sourceFolder])

  useEffect(() => {
    setTargetId(targets[0] ?? "")
  }, [targets])

  const submit = () => {
    if (!source || !targetId) return
    const target: RailEntity = source.kind === "folder"
      ? { kind: "folder", id: targetId }
      : destination.startsWith("folder:") && placement === "inside"
        ? { kind: "folder", id: destination.slice("folder:".length) }
        : { kind: "server", id: targetId }
    const operation = destination === "new" || placement === "inside"
      ? "combine"
      : placement === "before"
        ? "reorder-before"
        : "reorder-after"
    onMove({
      operation,
      source,
      target,
      ...(destination === "new" ? { newFolderId: `temp_${crypto.randomUUID()}` } : {}),
    })
  }

  return (
    <Sheet open={!!source} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="bottom" className="max-h-[min(32rem,80dvh)] rounded-t-2xl" showCloseButton>
        <SheetHeader>
          <SheetTitle>Move {source?.kind === "folder" ? "group" : "server"}</SheetTitle>
          <SheetDescription>Choose a destination, then its exact position.</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <label className="grid gap-1.5 text-sm font-medium">
            <span>Destination</span>
            <select
              data-testid={tid.serverRailMoveDestination}
              value={destination}
              onChange={(event) => {
                setDestination(event.target.value as Destination)
                setPlacement("after")
              }}
              className="h-10 rounded-lg border border-input bg-card px-3 text-card-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              {source?.kind === "folder" ? (
                <option value="folders">Group order</option>
              ) : (
                <>
                  <option value="rail">Server rail</option>
                  {state.folderOrder.map((folderId) => (
                    <option key={folderId} value={`folder:${folderId}`}>
                      {folderNames.get(folderId) ?? "Group"}
                    </option>
                  ))}
                  {!sourceFolder && state.folderOrder.length < MAX_SERVER_RAIL_FOLDERS && (
                    <option value="new">New group</option>
                  )}
                </>
              )}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            <span>Position</span>
            <select
              data-testid={tid.serverRailMoveTarget}
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              className="h-10 rounded-lg border border-input bg-card px-3 text-card-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              {targets.map((id) => (
                <option key={id} value={id}>
                  {source?.kind === "folder"
                    ? folderNames.get(id) ?? "Group"
                    : serverNames.get(id) ?? "Server"}
                </option>
              ))}
            </select>
          </label>
          {destination !== "new" && targets.length > 0 && (
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Placement">
              <Button
                type="button"
                variant={placement === "before" ? "default" : "outline"}
                onClick={() => setPlacement("before")}
              >
                Before
              </Button>
              <Button
                type="button"
                variant={placement === "after" ? "default" : "outline"}
                onClick={() => setPlacement("after")}
              >
                After
              </Button>
              {source?.kind === "server" && destination.startsWith("folder:") && (
                <Button
                  type="button"
                  variant={placement === "inside" ? "default" : "outline"}
                  className="col-span-2"
                  onClick={() => setPlacement("inside")}
                >
                  Inside group
                </Button>
              )}
            </div>
          )}
        </SheetBody>
        <SheetFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            data-testid={tid.serverRailMoveConfirm}
            disabled={!targetId}
            onClick={submit}
          >
            Move
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Plus } from "lucide-react"
import { MAX_SERVER_RAIL_FOLDERS } from "@alook/shared"
import { announce, cleanup as cleanupLiveRegion } from "@atlaskit/pragmatic-drag-and-drop-live-region"
import { RailIcon } from "./rail-icon"
import { AnimatedAlookLogo } from "./animated-alook-logo"
import { tid } from "@/lib/community/testids"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { SortableServer } from "./sortable-server"
import { RailFolder } from "./rail-folder"
import { CreateServerDialog } from "../settings/create-server-dialog"
import { ServerRailMoveMenu } from "./server-rail-move-menu"
import {
  cloneRailState,
  commitRailInstruction,
  planRailPersistence,
  railMoveAnnouncement,
  railStateFromData,
  visibleTopLevelServers,
  type RailEntity,
  type RailInstruction,
  type RailState,
} from "@/lib/community/server-rail-model"
import { useServerRailPdd } from "./use-server-rail-pdd"
import { useServerRailCommit } from "@/hooks/community/mutations"
import type { Server, CommunityFolder, FolderServer } from "@/lib/community/models/navigation"
import type { View } from "@/components/community/shell/shell-types"
import {
  completeCommunityOnboarding,
  isCommunityOnboardingStage,
} from "@/lib/community-onboarding"

type MoveSheetState = { source: RailEntity; focusTarget: HTMLElement } | null

function reconcileCreatedFolders(
  state: RailState,
  createdFolderIds: Record<string, string>,
): RailState {
  if (Object.keys(createdFolderIds).length === 0) return state
  return {
    ...state,
    folderOrder: state.folderOrder.map((id) => createdFolderIds[id] ?? id),
    folders: Object.fromEntries(Object.entries(state.folders).map(([id, serverIds]) => [
      createdFolderIds[id] ?? id,
      serverIds,
    ])),
    expanded: [...new Set([
      ...state.expanded.map((id) => createdFolderIds[id] ?? id),
      ...Object.values(createdFolderIds),
    ])],
  }
}

export const ServerRail = memo(function ServerRail({
  servers,
  folders,
  activeServerId: activeServerIdProp,
  serversLoading,
  view,
  bottomInset,
  onHome,
  onHomePrefetch,
  onServer,
  onServerNavigate,
  onServerPrefetch,
  onCreateServer,
  onLeaveServer,
  onOpenSettings,
  onOpenInvitePopover,
}: {
  servers: Server[]
  folders: CommunityFolder[]
  activeServerId?: string
  serversLoading?: boolean
  view: View
  bottomInset?: number
  onHome: () => void
  onHomePrefetch?: () => void
  onServer?: () => void
  onServerNavigate?: (id: string) => void
  onServerPrefetch?: (id: string) => void
  onCreateServer?: (name: string, icon?: File) => void
  onLeaveServer?: (id: string) => void
  onOpenSettings?: (serverId: string) => void
  onOpenInvitePopover?: (serverId: string) => void
}) {
  const [state, setState] = useState<RailState>(() =>
    railStateFromData(servers.map((server) => server.id), folders, []),
  )
  const [preview, setPreview] = useState<RailInstruction | null>(null)
  const [dragSource, setDragSource] = useState<RailEntity | null>(null)
  const [moveSheet, setMoveSheet] = useState<MoveSheetState>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragSnapshotRef = useRef<RailState | null>(null)
  const stateRef = useRef(state)
  const mutationPendingRef = useRef(false)
  const railMutation = useServerRailCommit()

  const claimMutation = useCallback(() => {
    if (mutationPendingRef.current) {
      announce("A server rail move is already being saved")
      return false
    }
    mutationPendingRef.current = true
    return true
  }, [])
  const releaseMutation = useCallback(() => {
    mutationPendingRef.current = false
  }, [])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("rail-open-folders")
      if (!saved) return
      const expanded = JSON.parse(saved) as string[]
      setState((current) => ({
        ...current,
        expanded: expanded.filter((folderId) => current.folderOrder.includes(folderId)),
      }))
    } catch {}
  }, [])

  useEffect(() => {
    setState((current) => railStateFromData(
      servers.map((server) => server.id),
      folders,
      current.expanded,
    ))
  }, [folders, servers])

  useEffect(() => {
    sessionStorage.setItem("rail-open-folders", JSON.stringify(state.expanded))
  }, [state.expanded])

  useEffect(() => () => cleanupLiveRegion(), [])

  const activeFromProps = activeServerIdProp ?? servers.find((server) => server.active)?.id ?? ""
  const [localActiveId, setLocalActiveId] = useState(activeFromProps)
  const activeId = activeFromProps || localActiveId
  useEffect(() => { if (activeFromProps) setLocalActiveId(activeFromProps) }, [activeFromProps])
  const pickServer = (id: string) => {
    setLocalActiveId(id)
    onServer?.()
    onServerNavigate?.(id)
  }

  const serverById = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers])
  const serverNames = useMemo(
    () => new Map(servers.map((server) => [server.id, server.name])),
    [servers],
  )
  const folderNames = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  )

  const focusEntity = useCallback((
    entity: RailEntity,
    options?: { preferred?: HTMLElement; afterReconcile?: boolean },
  ) => {
    const focusCurrentEntity = () => {
      const testId = entity.kind === "server"
        ? tid.serverIcon(entity.id)
        : tid.serverRailFolder(entity.id)
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus()
    }
    requestAnimationFrame(() => {
      if (options?.afterReconcile) {
        requestAnimationFrame(focusCurrentEntity)
        return
      }
      if (options?.preferred?.isConnected) options.preferred.focus()
      else focusCurrentEntity()
    })
  }, [])

  const applyInstruction = useCallback((
    rawInstruction: RailInstruction,
    before: RailState,
    focusTarget?: HTMLElement,
  ) => {
    let instruction = rawInstruction
    if (
      instruction.operation === "combine"
      && instruction.source.kind === "server"
      && instruction.target.kind === "server"
      && !instruction.newFolderId
    ) {
      instruction = { ...instruction, newFolderId: `temp_${crypto.randomUUID()}` }
    }
    const result = commitRailInstruction(before, instruction)
    if (!result.applied) {
      announce(result.reason)
      focusEntity(instruction.source, { preferred: focusTarget })
      return
    }
    if (!claimMutation()) return
    const label = railMoveAnnouncement(instruction, { servers: serverNames, folders: folderNames })
    setState(result.state)
    railMutation.mutate(
      { before, after: result.state, commands: result.commands },
      {
        onSuccess: (response) => {
          setState((current) => reconcileCreatedFolders(current, response.createdFolderIds))
          announce(label)
        },
        onError: () => {
          setState(before)
          announce(`${label} failed and was rolled back`)
        },
        onSettled: () => {
          releaseMutation()
          focusEntity(instruction.source, { afterReconcile: true })
        },
      },
    )
  }, [claimMutation, focusEntity, folderNames, railMutation, releaseMutation, serverNames])

  const ungroupFolder = useCallback((folderId: string) => {
    const before = cloneRailState(stateRef.current)
    const after = cloneRailState(stateRef.current)
    const firstServerId = before.folders[folderId]?.[0]
    delete after.folders[folderId]
    after.folderOrder = after.folderOrder.filter((id) => id !== folderId)
    after.expanded = after.expanded.filter((id) => id !== folderId)
    const commands = planRailPersistence(before, after)
    if (commands.length !== 1) return
    if (!claimMutation()) return
    setState(after)
    railMutation.mutate(
      { before, after, commands },
      {
        onSuccess: () => announce("Group removed"),
        onError: () => {
          setState(before)
          announce("Removing group failed and was rolled back")
        },
        onSettled: (_data, error) => {
          releaseMutation()
          focusEntity(error || !firstServerId
            ? { kind: "folder", id: folderId }
            : { kind: "server", id: firstServerId }, { afterReconcile: true })
        },
      },
    )
  }, [claimMutation, focusEntity, railMutation, releaseMutation])

  const createSingleServerFolder = useCallback((serverId: string) => {
    const before = cloneRailState(stateRef.current)
    if (before.folderOrder.length >= MAX_SERVER_RAIL_FOLDERS) return
    const after = cloneRailState(before)
    const clientId = `temp_${crypto.randomUUID()}`
    after.folderOrder.push(clientId)
    after.folders[clientId] = [serverId]
    after.expanded.push(clientId)
    const commands = planRailPersistence(before, after)
    if (!claimMutation()) return
    setState(after)
    railMutation.mutate(
      { before, after, commands },
      {
        onSuccess: (response) => {
          setState((current) => reconcileCreatedFolders(current, response.createdFolderIds))
          announce("Group created")
        },
        onError: () => {
          setState(before)
          announce("Creating group failed and was rolled back")
        },
        onSettled: () => {
          releaseMutation()
          focusEntity({ kind: "server", id: serverId }, { afterReconcile: true })
        },
      },
    )
  }, [claimMutation, focusEntity, railMutation, releaseMutation])

  const { registerItem } = useServerRailPdd({
    scrollRef,
    onDragStart: (source) => {
      dragSnapshotRef.current = cloneRailState(state)
      setDragSource(source)
    },
    onPreview: setPreview,
    onDrop: (instruction) => {
      const before = dragSnapshotRef.current ?? cloneRailState(state)
      dragSnapshotRef.current = null
      setDragSource(null)
      applyInstruction(instruction, before)
    },
    onCancel: () => {
      dragSnapshotRef.current = null
      setDragSource(null)
    },
    onHoverExpand: (folderId) => {
      setState((current) => current.expanded.includes(folderId)
        ? current
        : { ...current, expanded: [...current.expanded, folderId] })
    },
  })

  const previewFor = (entity: RailEntity) => preview?.target.kind === entity.kind
    && preview.target.id === entity.id
    ? preview.operation
    : null
  const dragging = (entity: RailEntity) => dragSource?.kind === entity.kind
    && dragSource.id === entity.id
  const folderServers = (folderId: string): FolderServer[] => (state.folders[folderId] ?? [])
    .map((serverId) => serverById.get(serverId))
    .filter((server): server is Server => !!server)
    .map((server) => ({
      id: server.id,
      name: server.name,
      initial: server.initial,
      icon: server.icon ?? null,
    }))

  return (
    <nav aria-label="Server navigation" className="flex min-h-0 w-14 shrink-0 flex-col items-center overflow-hidden pt-2">
      <div className="flex w-full shrink-0 flex-col items-center gap-2">
        <Tooltip>
          <TooltipTrigger render={<div className="group relative flex w-full justify-center" />}>
            <span className={[
              "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all duration-150",
              view === "dm" ? "h-8" : "h-0 group-hover:h-5",
            ].join(" ")} />
            <button
              onClick={onHome}
              onPointerEnter={onHomePrefetch}
              onFocus={onHomePrefetch}
              aria-label="Home"
              data-testid={tid.homeButton}
              className="group/alook grid size-10 shrink-0 place-items-center rounded-[20px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <AnimatedAlookLogo className="size-10" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>Home</TooltipContent>
        </Tooltip>
        <div className="my-1 w-6 border-t border-border/50" />
      </div>

      <div
        ref={scrollRef}
        data-testid={tid.serverRailScroll}
        className="min-h-0 w-full shrink overflow-y-auto overflow-x-clip py-2 thin-scrollbar scrollbar-none"
      >
        {serversLoading && servers.length === 0 && folders.length === 0 ? (
          <ServerRailSkeleton />
        ) : (
          <div className="flex w-full flex-col items-center gap-2">
            {visibleTopLevelServers(state).map((serverId) => {
              const server = serverById.get(serverId)
              if (!server) return null
              return (
                <SortableServer
                  key={serverId}
                  server={server}
                  active={view !== "dm" && activeId === serverId}
                  onClick={() => pickServer(serverId)}
                  onPrefetch={() => onServerPrefetch?.(serverId)}
                  onLeave={() => onLeaveServer?.(serverId)}
                  onOpenSettings={() => onOpenSettings?.(serverId)}
                  onOpenInvitePopover={onOpenInvitePopover ? () => onOpenInvitePopover(serverId) : undefined}
                  onCreateFolder={state.folderOrder.length < MAX_SERVER_RAIL_FOLDERS ? () => createSingleServerFolder(serverId) : undefined}
                  dragging={dragging({ kind: "server", id: serverId })}
                  preview={previewFor({ kind: "server", id: serverId })}
                  registerItem={registerItem}
                  onMove={(source, focusTarget) => setMoveSheet({ source, focusTarget })}
                />
              )
            })}
            {state.folderOrder.map((folderId) => {
              const serversInFolder = folderServers(folderId)
              const open = state.expanded.includes(folderId)
                && !(dragSource?.kind === "folder" && dragSource.id === folderId)
              return (
                <div key={folderId} className="flex w-full flex-col items-center gap-2">
                  <RailFolder
                    folderId={folderId}
                    open={open}
                    onToggle={() => setState((current) => ({
                      ...current,
                      expanded: current.expanded.includes(folderId)
                        ? current.expanded.filter((id) => id !== folderId)
                        : [...current.expanded, folderId],
                    }))}
                    activeId={activeId}
                    folderServers={serversInFolder}
                    onUngroup={() => ungroupFolder(folderId)}
                    dragging={dragging({ kind: "folder", id: folderId })}
                    preview={previewFor({ kind: "folder", id: folderId })}
                    registerItem={registerItem}
                    onMove={(source, focusTarget) => setMoveSheet({ source, focusTarget })}
                  />
                  {open && serversInFolder.length > 0 && (
                    <div className="relative flex w-full flex-col items-center gap-2 py-1">
                      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-12 -translate-x-1/2 rounded-[20px] bg-primary/10" />
                      {serversInFolder.map((server) => (
                        <SortableServer
                          key={server.id}
                          server={{ ...server, active: false, mentions: serverById.get(server.id)?.mentions ?? 0, isOwner: serverById.get(server.id)?.isOwner }}
                          active={view !== "dm" && activeId === server.id}
                          onClick={() => pickServer(server.id)}
                          onPrefetch={() => onServerPrefetch?.(server.id)}
                          onOpenSettings={() => onOpenSettings?.(server.id)}
                          onOpenInvitePopover={onOpenInvitePopover ? () => onOpenInvitePopover(server.id) : undefined}
                          inFolder
                          dragging={dragging({ kind: "server", id: server.id })}
                          preview={previewFor({ kind: "server", id: server.id })}
                          registerItem={registerItem}
                          onMove={(source, focusTarget) => setMoveSheet({ source, focusTarget })}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex w-full shrink-0 justify-center" style={{ paddingBottom: bottomInset ?? 8 }}>
        <RailIcon
          label={<Plus className="size-6" />}
          round
          accent
          tooltip="Add a Server"
          testId={tid.serverAdd}
          onboardingTarget="add-server"
          onClick={() => {
            const guided = isCommunityOnboardingStage("server")
            setCreateOpen(true)
            if (guided) completeCommunityOnboarding()
          }}
        />
      </div>

      <ServerRailMoveMenu
        source={moveSheet?.source ?? null}
        state={state}
        serverNames={serverNames}
        folderNames={folderNames}
        onClose={() => setMoveSheet(null)}
        onMove={(instruction) => {
          const focusTarget = moveSheet?.focusTarget
          setMoveSheet(null)
          applyInstruction(instruction, cloneRailState(state), focusTarget)
        }}
      />

      {createOpen && (
        <CreateServerDialog
          onClose={() => setCreateOpen(false)}
          onCreateServer={(name, icon) => { onCreateServer?.(name, icon) }}
        />
      )}
    </nav>
  )
})

function ServerRailSkeleton() {
  return (
    <div className="flex w-full flex-col items-center gap-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="size-10 rounded-[20px]" />
      ))}
    </div>
  )
}

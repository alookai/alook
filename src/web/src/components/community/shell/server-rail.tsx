"use client"

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react"
import { Plus } from "lucide-react"
import { announce, cleanup as cleanupLiveRegion } from "@atlaskit/pragmatic-drag-and-drop-live-region"
import { RailIcon } from "./rail-icon"
import { AnimatedAlookLogo } from "./animated-alook-logo"
import { tid } from "@/lib/community/testids"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { SortableServer } from "./sortable-server"
import { RailFolder } from "./rail-folder"
import { CreateServerDialog } from "../settings/create-server-dialog"
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
import type { Server, CommunityFolder } from "@/lib/community/models/navigation"
import type { View } from "@/components/community/shell/shell-types"
import {
  completeCommunityOnboarding,
  isCommunityOnboardingStage,
} from "@/lib/community-onboarding"

const DRAG_INSTRUCTIONS_ID = "server-rail-drag-instructions"

function ServerRailFrame({
  home,
  items,
  add,
  bottomInset,
  scrollRef,
  ariaLabel,
  ariaHidden,
  children,
}: {
  home: ReactNode
  items: ReactNode
  add: ReactNode
  bottomInset?: number
  scrollRef?: Ref<HTMLDivElement>
  ariaLabel?: string
  ariaHidden?: boolean
  children?: ReactNode
}) {
  return (
    <nav
      aria-label={ariaLabel}
      aria-hidden={ariaHidden || undefined}
      className="flex min-h-0 w-14 shrink-0 flex-col items-center overflow-hidden pt-2"
    >
      <div className="flex w-full shrink-0 flex-col items-center gap-2">
        {home}
        <div className="my-1 w-6 border-t border-border/50" />
      </div>

      <div
        ref={scrollRef}
        data-testid={tid.serverRailScroll}
        className="min-h-0 w-full shrink overflow-y-auto overflow-x-clip py-2 thin-scrollbar scrollbar-none"
      >
        {items}
      </div>

      <div
        data-slot="community-server-rail-add"
        className="flex w-full shrink-0 justify-center pb-[calc(var(--community-rail-bottom-inset)+var(--app-safe-area-bottom))] sm:pb-(--community-rail-bottom-inset)"
        style={{
          "--community-rail-bottom-inset": `${bottomInset ?? 8}px`,
        } as CSSProperties}
      >
        {add}
      </div>
      {children}
    </nav>
  )
}

function reconcileCreatedFolders(
  state: RailState,
  createdFolderIds: Record<string, string>,
  explicitlyCollapsed: ReadonlySet<string>,
): RailState {
  if (Object.keys(createdFolderIds).length === 0) return state
  const expanded = new Set(state.expanded.map((id) => createdFolderIds[id] ?? id))
  for (const [clientId, folderId] of Object.entries(createdFolderIds)) {
    if (!explicitlyCollapsed.has(clientId) && !explicitlyCollapsed.has(folderId)) {
      expanded.add(folderId)
    }
  }
  return {
    ...state,
    folderOrder: state.folderOrder.map((id) => createdFolderIds[id] ?? id),
    folders: Object.fromEntries(Object.entries(state.folders).map(([id, serverIds]) => [
      createdFolderIds[id] ?? id,
      serverIds,
    ])),
    expanded: [...expanded],
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
  const [createOpen, setCreateOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragSnapshotRef = useRef<RailState | null>(null)
  const stateRef = useRef(state)
  const mutationPendingRef = useRef(false)
  const collapsedPendingFolderIdsRef = useRef(new Set<string>())
  const railMutation = useServerRailCommit()
  const serverIdentityOrder = servers.map((server) => server.id).join("\0")
  const serverIds = useMemo(
    () => serverIdentityOrder ? serverIdentityOrder.split("\0") : [],
    [serverIdentityOrder],
  )
  const railDataIdentity = useMemo(
    () => JSON.stringify([
      serverIds,
      folders.map((folder) => [
        folder.id,
        folder.position,
        folder.servers.map((server) => server.id),
      ]),
    ]),
    [folders, serverIds],
  )
  const [stateDataIdentity, setStateDataIdentity] = useState(railDataIdentity)
  const renderState = stateDataIdentity === railDataIdentity
    ? state
    : railStateFromData(serverIds, folders, state.expanded)

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
    collapsedPendingFolderIdsRef.current.clear()
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

  useLayoutEffect(() => {
    setState((current) => railStateFromData(serverIds, folders, current.expanded))
    setStateDataIdentity(railDataIdentity)
  }, [folders, railDataIdentity, serverIds])

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
          setState((current) => reconcileCreatedFolders(
            current,
            response.createdFolderIds,
            collapsedPendingFolderIdsRef.current,
          ))
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

  const { registerItem } = useServerRailPdd({
    scrollRef,
    getState: () => stateRef.current,
    canStart: () => !mutationPendingRef.current,
    getEntityLabel: (entity) => entity.kind === "server"
      ? serverNames.get(entity.id) ?? "Server"
      : folderNames.get(entity.id) ?? "Group",
    onDragStart: (source) => {
      dragSnapshotRef.current = cloneRailState(stateRef.current)
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
    onAnnounce: announce,
  })

  const previewFor = (entity: RailEntity) => preview?.target.kind === entity.kind
    && preview.target.id === entity.id
    ? preview.operation
    : null
  const dragging = (entity: RailEntity) => dragSource?.kind === entity.kind
    && dragSource.id === entity.id
  const folderServers = (folderId: string): Server[] => (renderState.folders[folderId] ?? [])
    .map((serverId) => serverById.get(serverId))
    .filter((server): server is Server => !!server)

  const home = (
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
  )
  const items = serversLoading && servers.length === 0 && folders.length === 0 ? (
    <ServerRailSkeleton />
  ) : (
    <div className="flex w-full flex-col items-center gap-2">
      {visibleTopLevelServers(renderState).map((serverId) => {
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
            dragging={dragging({ kind: "server", id: serverId })}
            preview={previewFor({ kind: "server", id: serverId })}
            registerItem={registerItem}
            dragDescriptionId={DRAG_INSTRUCTIONS_ID}
          />
        )
      })}
      {renderState.folderOrder.map((folderId) => {
        const serversInFolder = folderServers(folderId)
        const open = renderState.expanded.includes(folderId)
          && !(dragSource?.kind === "folder" && dragSource.id === folderId)
        return (
          <div key={folderId} className="flex w-full flex-col items-center gap-2">
            <RailFolder
              folderId={folderId}
              name={folderNames.get(folderId) ?? "Group"}
              open={open}
              active={!open && serversInFolder.some((server) => server.id === activeId)}
              unread={!open && serversInFolder.some((server) => server.unread)}
              onToggle={() => setState((current) => {
                const collapsing = current.expanded.includes(folderId)
                if (mutationPendingRef.current) {
                  if (collapsing) collapsedPendingFolderIdsRef.current.add(folderId)
                  else collapsedPendingFolderIdsRef.current.delete(folderId)
                }
                return {
                  ...current,
                  expanded: collapsing
                    ? current.expanded.filter((id) => id !== folderId)
                    : [...current.expanded, folderId],
                }
              })}
              folderServers={serversInFolder}
              onUngroup={() => ungroupFolder(folderId)}
              dragging={dragging({ kind: "folder", id: folderId })}
              preview={previewFor({ kind: "folder", id: folderId })}
              registerItem={registerItem}
              dragDescriptionId={DRAG_INSTRUCTIONS_ID}
            />
            {open && serversInFolder.length > 0 && (
              <div className="relative flex w-full flex-col items-center gap-2 py-1">
                <span className="pointer-events-none absolute inset-y-0 left-1/2 w-12 -translate-x-1/2 rounded-[20px] bg-primary/10" />
                {serversInFolder.map((server) => (
                  <SortableServer
                    key={server.id}
                    server={server}
                    active={view !== "dm" && activeId === server.id}
                    onClick={() => pickServer(server.id)}
                    onPrefetch={() => onServerPrefetch?.(server.id)}
                    onOpenSettings={() => onOpenSettings?.(server.id)}
                    onOpenInvitePopover={onOpenInvitePopover ? () => onOpenInvitePopover(server.id) : undefined}
                    inFolder
                    dragging={dragging({ kind: "server", id: server.id })}
                    preview={previewFor({ kind: "server", id: server.id })}
                    registerItem={registerItem}
                    dragDescriptionId={DRAG_INSTRUCTIONS_ID}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

  return (
    <ServerRailFrame
      ariaLabel="Server navigation"
      home={home}
      items={items}
      bottomInset={bottomInset}
      scrollRef={scrollRef}
      add={(
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
      )}
    >
      <span id={DRAG_INSTRUCTIONS_ID} className="sr-only">
        Press Space to pick up a server or group. Use the arrow keys to choose a position,
        Space or Enter to drop, and Escape to cancel.
      </span>
      {createOpen && (
        <CreateServerDialog
          onClose={() => setCreateOpen(false)}
          onCreateServer={(name, icon) => { onCreateServer?.(name, icon) }}
        />
      )}
    </ServerRailFrame>
  )
})

export function ServerRailPending({ bottomInset }: { bottomInset?: number }) {
  return (
    <ServerRailFrame
      ariaHidden
      bottomInset={bottomInset}
      home={<Skeleton className="size-10 shrink-0 rounded-[20px]" />}
      items={<ServerRailSkeleton />}
      add={<Skeleton className="size-10 shrink-0 rounded-[20px]" />}
    />
  )
}

export function ServerRailSkeleton() {
  return (
    <div
      data-testid={tid.initialRailPending}
      aria-hidden
      className="flex w-full flex-col items-center gap-2"
    >
      {Array.from({ length: 1 }).map((_, index) => (
        <Skeleton key={index} className="size-10 rounded-[20px]" />
      ))}
    </div>
  )
}

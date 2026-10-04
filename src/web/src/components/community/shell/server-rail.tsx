"use client"
import { useCommunityRuntime } from "@/stores/community/runtime"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
import { RailIndicator } from "./rail-indicator"
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
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
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
  add?: ReactNode
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
        data-slot="community-server-rail-viewport"
        className="flex min-h-0 w-full flex-1 flex-col items-center"
      >
        <div
          ref={scrollRef}
          data-testid={tid.serverRailScroll}
          className="min-h-0 w-full shrink overflow-y-auto overflow-x-clip py-2 thin-scrollbar scrollbar-none"
        >
          {items}
        </div>

        {add && (
          <div
            data-slot="community-server-rail-add"
            className="flex w-full shrink-0 justify-center pb-[calc(var(--community-rail-bottom-inset)+var(--app-safe-area-bottom))] sm:pb-(--community-rail-bottom-inset)"
            style={{
              "--community-rail-bottom-inset": `${bottomInset ?? 8}px`,
            } as CSSProperties}
          >
            {add}
          </div>
        )}
      </div>
      {children}
    </nav>
  )
}

export const ServerRail = memo(function ServerRail({
  servers,
  folders,
  activeServerId: activeServerIdProp,
  serversLoading,
  view,
  bottomInset,
  onHome,
  onServer,
  onServerNavigate,
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
  onServer?: () => void
  onServerNavigate?: (id: string) => void
  onCreateServer?: (name: string, icon?: File) => void
  onLeaveServer?: (id: string) => void
  onOpenSettings?: (serverId: string) => void
  onOpenInvitePopover?: (serverId: string) => void
}) {
  const expandedAtom = useCreateAtom<string[]>([])
  const [expanded, setExpanded] = useAtom(expandedAtom)
  const collapsedAtom = useCreateAtom(new Set<string>())
  const dragSnapshotAtom = useCreateAtom<RailState | null>(null)
  const [preview, setPreview] = useAtom(useCreateAtom<RailInstruction | null>(null))
  const [dragSource, setDragSource] = useAtom(useCreateAtom<RailEntity | null>(null))
  const [createOpen, setCreateOpen] = useAtom(useCreateAtom(false))
  const scrollRef = useRef<HTMLDivElement>(null)
  const serverActivationRef = useRef({ onServer, onServerNavigate, onOpenSettings, onOpenInvitePopover })
  const railMutation = useServerRailCommit()
  const communityRuntime = useCommunityRuntime()
  const registry = useOptionalCommunityDbRegistry()
  const viewLifecycle = useCreateAtom({ active: true, generation: 0 })
  useLayoutEffect(() => {
    viewLifecycle.set((state) => ({ ...state, active: true }))
    return () => viewLifecycle.set((state) => ({ active: false, generation: state.generation + 1 }))
  }, [viewLifecycle])
  const captureUI = useCallback(() => {
    const generation = viewLifecycle.get().generation
    const ownerGeneration = registry?.runtime.lifecycle.get().generation
    return () => {
      const view = viewLifecycle.get(), owner = registry?.runtime.lifecycle.get()
      if (!view.active || view.generation !== generation || (owner && (!owner.active || owner.generation !== ownerGeneration))) throw new DOMException("Retired server rail view", "AbortError")
    }
  }, [registry, viewLifecycle])
  const storageKey = `alook:community:${registry?.accountId ?? "anon"}:rail-open-folders`
  const renderState = useMemo(() => railStateFromData(servers.map((server) => server.id), folders, expanded), [servers, folders, expanded])
  const claimMutation = useCallback(() => {
    if (railMutation.isCommandPending()) {
      announce("A server rail move is already being saved")
      return false
    }
    return true
  }, [railMutation])
  const releaseMutation = useCallback(() => collapsedAtom.set(() => new Set()), [collapsedAtom])
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]") as unknown
      if (Array.isArray(saved)) setExpanded(saved.filter((id): id is string => typeof id === "string"))
    } catch {}
  }, [storageKey, setExpanded])
  useLayoutEffect(() => {
    serverActivationRef.current = { onServer, onServerNavigate, onOpenSettings, onOpenInvitePopover }
  }, [onServer, onServerNavigate, onOpenSettings, onOpenInvitePopover])

  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(expanded))
  }, [expanded, storageKey])

  useEffect(() => () => cleanupLiveRegion(), [])

  const activeFromProps = activeServerIdProp ?? servers.find((server) => server.active)?.id ?? ""
  const [localActiveId, setLocalActiveId] = useAtom(useCreateAtom(activeFromProps))
  const activeId = activeFromProps || localActiveId
  useEffect(() => { if (activeFromProps) setLocalActiveId(activeFromProps) }, [activeFromProps, setLocalActiveId])
  // SortableServer deliberately ignores callback identity to keep rail-wide
  // presence/roster ticks cheap. Keep the dispatcher stable while reading the
  // latest committed navigation semantics through a layout-synchronized ref.
  const pickServer = useCallback((id: string) => {
    setLocalActiveId(id)
    serverActivationRef.current.onServer?.()
    serverActivationRef.current.onServerNavigate?.(id)
  }, [setLocalActiveId])

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
    assertUI = captureUI(),
  ) => {
    const current = () => { try { assertUI(); return true } catch { return false } }
    const focusCurrentEntity = () => {
      if (!current()) return
      const testId = entity.kind === "server"
        ? tid.serverIcon(entity.id)
        : tid.serverRailFolder(entity.id)
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus()
    }
    requestAnimationFrame(() => {
      if (!current()) return
      if (options?.afterReconcile) {
        requestAnimationFrame(focusCurrentEntity)
        return
      }
      if (options?.preferred?.isConnected) options.preferred.focus()
      else focusCurrentEntity()
    })
  }, [captureUI])

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
    const assertUI = captureUI()
    setExpanded(result.state.expanded)
    railMutation.mutate(
      { before, after: result.state, commands: result.commands, assertUI },
      {
        onSuccess: (response) => {
          try { assertUI() } catch { return }
          setExpanded((current) => {
            const next = new Set(current.map((id) => response.createdFolderIds[id] ?? id))
            for (const [clientId, id] of Object.entries(response.createdFolderIds)) if (!collapsedAtom.get().has(clientId) && !collapsedAtom.get().has(id)) next.add(id)
            return [...next]
          })
          announce(label)
        },
        onError: () => {
          try { assertUI() } catch { return }
          const created = new Set(result.commands.flatMap((command) => command.kind === "create-folder" ? [command.clientId] : []))
          setExpanded((current) => current.filter((id) => !created.has(id)))
          announce(`${label} failed and was rolled back`)
        },
        onSettled: () => {
          try { assertUI() } catch { return }
          releaseMutation()
          focusEntity(instruction.source, { afterReconcile: true }, assertUI)
        },
      },
    )
  }, [captureUI, claimMutation, collapsedAtom, focusEntity, folderNames, railMutation, releaseMutation, serverNames, setExpanded])

  const ungroupFolder = useCallback((folderId: string) => {
    const before = cloneRailState(renderState)
    const after = cloneRailState(renderState)
    const firstServerId = before.folders[folderId]?.[0]
    delete after.folders[folderId]
    after.folderOrder = after.folderOrder.filter((id) => id !== folderId)
    after.expanded = after.expanded.filter((id) => id !== folderId)
    const commands = planRailPersistence(before, after)
    if (commands.length !== 1) return
    if (!claimMutation()) return
    const assertUI = captureUI()
    setExpanded(after.expanded)
    railMutation.mutate(
      { before, after, commands, assertUI },
      {
        onSuccess: () => { try { assertUI() } catch { return }; announce("Group removed") },
        onError: () => {
          try { assertUI() } catch { return }
          if (before.expanded.includes(folderId)) setExpanded((current) => [...new Set([...current, folderId])])
          announce("Removing group failed and was rolled back")
        },
        onSettled: (_data, error) => {
          try { assertUI() } catch { return }
          releaseMutation()
          focusEntity(error || !firstServerId
            ? { kind: "folder", id: folderId }
            : { kind: "server", id: firstServerId }, { afterReconcile: true }, assertUI)
        },
      },
    )
  }, [captureUI, claimMutation, focusEntity, railMutation, releaseMutation, renderState, setExpanded])

  const { registerItem } = useServerRailPdd({
    scrollRef,
    getState: () => renderState,
    canStart: () => !railMutation.isCommandPending(),
    getEntityLabel: (entity) => entity.kind === "server"
      ? serverNames.get(entity.id) ?? "Server"
      : folderNames.get(entity.id) ?? "Group",
    onDragStart: (source) => {
      dragSnapshotAtom.set(() => cloneRailState(renderState))
      setDragSource(source)
    },
    onPreview: setPreview,
    onDrop: (instruction) => {
      const before = dragSnapshotAtom.get() ?? cloneRailState(renderState)
      dragSnapshotAtom.set(() => null)
      setDragSource(null)
      applyInstruction(instruction, before)
    },
    onCancel: () => {
      dragSnapshotAtom.set(() => null)
      setDragSource(null)
    },
    onHoverExpand: (folderId) => {
      setExpanded((current) => current.includes(folderId) ? current : [...current, folderId])
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
        <RailIndicator active={view === "dm"} />
        <button
          onClick={onHome}
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
  const serverListPending = serversLoading && servers.length === 0 && folders.length === 0
  const items = serverListPending ? (
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
            onLeave={() => onLeaveServer?.(serverId)}
            onOpenSettings={() => serverActivationRef.current.onOpenSettings?.(serverId)}
            onOpenInvitePopover={onOpenInvitePopover ? () => serverActivationRef.current.onOpenInvitePopover?.(serverId) : undefined}
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
              onToggle={() => setExpanded((current) => {
                const collapsing = current.includes(folderId)
                if (railMutation.isCommandPending()) collapsedAtom.set((values) => {
                  const next = new Set(values)
                  if (collapsing) next.add(folderId)
                  else next.delete(folderId)
                  return next
                })
                return collapsing ? current.filter((id) => id !== folderId) : [...current, folderId]
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
                    onOpenSettings={() => serverActivationRef.current.onOpenSettings?.(server.id)}
                    onOpenInvitePopover={onOpenInvitePopover ? () => serverActivationRef.current.onOpenInvitePopover?.(server.id) : undefined}
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
      add={serverListPending ? undefined : (
        <RailIcon
          label={<Plus className="size-6" />}
          round
          accent
          tooltip="Add a Server"
          testId={tid.serverAdd}
          onboardingTarget="add-server"
          onClick={() => {
            const guided = isCommunityOnboardingStage(communityRuntime, "server")
            setCreateOpen(true)
            if (guided) completeCommunityOnboarding(communityRuntime)
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
      home={(
        <Skeleton
          data-slot="community-home-logo-pending"
          className="size-10 shrink-0 rounded-[9px]"
        />
      )}
      items={<ServerRailSkeleton />}
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

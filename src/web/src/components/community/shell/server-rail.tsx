"use client"
import { useCommunityPreviewNavigation } from "./community-preview-navigation"
import { useCommunityRuntime } from "@/stores/community/runtime"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react"
import type { ServerRailEntry } from "@alook/shared"
import { Plus } from "lucide-react"
import { CommunityDndProvider, useCommunityDndScrolling } from "../community-dnd"
import { RailIcon } from "./rail-icon"
import { AnimatedAlookLogo } from "./animated-alook-logo"
import { tid } from "@/lib/community/testids"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { CommunityNavigationLink } from "./community-navigation-link"
import { serverRootHref } from "@/lib/community/community-route"
import { SortableServer } from "./sortable-server"
import { RailFolder } from "./rail-folder"
import { ServerRailDragPreview } from "./server-rail-drag-preview"
import { RailIndicator } from "./rail-indicator"
import { CreateServerDialog } from "../settings/create-server-dialog"
import {
  cloneRailState,
  commitRailInstruction,
  railMoveAnnouncement,
  railStateFromData,
  railTopLevel,
  type RailEntity,
  type RailInstruction,
  type RailState,
} from "@/lib/community/server-rail-model"
import { RailEndDropTarget, RailFolderGapDropTarget, useServerRailDnd } from "./use-server-rail-dnd"
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
          className="min-h-0 w-full shrink overflow-y-auto overflow-x-clip pt-2 pb-1 thin-scrollbar scrollbar-none"
        >
          {items}
        </div>

        {add && (
          <div
            data-slot="community-server-rail-add"
            className="flex w-full shrink-0 justify-center pt-2 pb-[calc(var(--community-rail-bottom-inset)+var(--app-safe-area-bottom)+0.5rem)] sm:pb-[calc(var(--community-rail-bottom-inset)+0.5rem)]"
            style={{
              "--community-rail-bottom-inset": `${bottomInset ?? 0}px`,
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

function ServerRailContent({
  servers,
  homeHref = "/c/me",
  serverHrefs = {},
  folders,
  topOrder,
  navigationKey,
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
  homeHref?: string
  serverHrefs?: Readonly<Record<string, string>>
  folders: CommunityFolder[]
  topOrder?: ServerRailEntry[]
  navigationKey?: string
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
  const [announcement, announce] = useAtom(useCreateAtom(""))
  const isPreview = useCommunityPreviewNavigation()
  const expandedAtom = useCreateAtom<string[]>([])
  const [expanded, setExpanded] = useAtom(expandedAtom)
  const expansionOverrides = useCreateAtom(new Map<string, boolean>())
  const dragSnapshotAtom = useCreateAtom<RailState | null>(null)
  const [preview, setPreview] = useAtom(useCreateAtom<RailInstruction | null>(null))
  const [dragSource, setDragSource] = useAtom(useCreateAtom<RailEntity | null>(null))
  const [createOpen, setCreateOpen] = useAtom(useCreateAtom(false))
  const scrollRef = useRef<HTMLDivElement>(null)
  useCommunityDndScrolling(scrollRef, "community/server-rail")
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
  const renderState = useMemo(() => railStateFromData(servers.map((server) => server.id), folders, expanded, topOrder), [servers, folders, expanded, topOrder])
  const claimMutation = useCallback(() => {
    if (railMutation.isCommandPending()) {
      announce("A server rail move is already being saved")
      return false
    }
    return true
  }, [announce, railMutation])
  const releaseMutation = useCallback(() => expansionOverrides.set(() => new Map()), [expansionOverrides])
  useEffect(() => {
    try {
      if (isPreview) return
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]") as unknown
      if (Array.isArray(saved)) setExpanded(saved.filter((id): id is string => typeof id === "string"))
    } catch {}
  }, [isPreview, storageKey, setExpanded])
  useLayoutEffect(() => {
    serverActivationRef.current = { onServer, onServerNavigate, onOpenSettings, onOpenInvitePopover }
  }, [onServer, onServerNavigate, onOpenSettings, onOpenInvitePopover])

  useEffect(() => {
    if (isPreview) return
    sessionStorage.setItem(storageKey, JSON.stringify(expanded))
  }, [isPreview, expanded, storageKey])


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
    if (isPreview) return
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
      { commands: result.commands, assertUI },
      {
        onSuccess: (response) => {
          try { assertUI() } catch { return }
          setExpanded((current) => {
            const next = new Set(current.map((id) => response.createdFolderIds[id] ?? id))
            for (const [clientId, id] of Object.entries(response.createdFolderIds)) if (expansionOverrides.get().get(clientId) !== false && expansionOverrides.get().get(id) !== false) next.add(id)
            return [...next]
          })
          announce(label)
        },
        onError: () => {
          try { assertUI() } catch { return }
          const created = new Set(result.commands.flatMap((command) => command.kind === "create-folder" ? [command.clientId] : []))
          setExpanded(() => {
            const restored = new Set(before.expanded)
            for (const [id, open] of expansionOverrides.get()) { if (open) restored.add(id); else restored.delete(id) }
            return [...restored].filter((id) => !created.has(id))
          })
          announce(`${label} failed and was rolled back`)
        },
        onSettled: () => {
          try { assertUI() } catch { return }
          releaseMutation()
          focusEntity(instruction.source, { afterReconcile: true }, assertUI)
        },
      },
    )
  }, [announce, isPreview, captureUI, claimMutation, expansionOverrides, focusEntity, folderNames, railMutation, releaseMutation, serverNames, setExpanded])

  const dnd = useServerRailDnd({
    getState: () => renderState,
    canStart: () => !isPreview && !railMutation.isCommandPending(),
    onDragStart: (source) => {
      dragSnapshotAtom.set(() => cloneRailState(renderState))
      setDragSource(source)
    },
    onPreview: (instruction) => {
      setPreview(instruction)
    },
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
  })
  useLayoutEffect(() => { dnd.cancel() }, [dnd, navigationKey, activeFromProps, view, registry?.accountId])

  const dragging = (entity: RailEntity) => dragSource?.kind === entity.kind
    && dragSource.id === entity.id
  const folderServers = (folderId: string): Server[] => (renderState.folders[folderId] ?? [])
    .map((serverId) => serverById.get(serverId))
    .filter((server): server is Server => !!server)

  const home = (
    <Tooltip>
      <TooltipTrigger render={<div className="group relative flex w-full justify-center" />}>
        <RailIndicator active={view === "dm"} />
        <CommunityNavigationLink
          href={homeHref}
          active={view === "dm"}
          onActivate={onHome}
          navigationDisabled={dragSource !== null}
          aria-label="Home"
          data-testid={tid.homeButton}
          className="group/alook grid size-10 shrink-0 place-items-center rounded-[20px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <AnimatedAlookLogo className="size-10" />
        </CommunityNavigationLink>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>Home</TooltipContent>
    </Tooltip>
  )
  const serverListPending = serversLoading && servers.length === 0 && folders.length === 0
  const serverItem = (server: Server, inFolder = false) => (
    <SortableServer key={server.id} server={server}
      href={serverHrefs[server.id] ?? serverRootHref(server.id)}
      navigationDisabled={dragSource !== null}
      active={view !== "dm" && activeId === server.id}
      onClick={() => pickServer(server.id)}
      onLeave={inFolder ? undefined : () => onLeaveServer?.(server.id)}
      onOpenSettings={() => serverActivationRef.current.onOpenSettings?.(server.id)}
      onOpenInvitePopover={onOpenInvitePopover ? () => serverActivationRef.current.onOpenInvitePopover?.(server.id) : undefined}
      inFolder={inFolder} dragging={dragging({ kind: "server", id: server.id })}
      preview={preview?.target.kind === "server" && preview.target.id === server.id && preview.operation !== "append" ? preview.operation : null}
      combineWith={preview?.operation === "combine" && preview.target.kind === "server" && preview.target.id === server.id && preview.source.kind === "server" ? serverById.get(preview.source.id) : undefined}
      dnd={dnd} dragDescriptionId={DRAG_INSTRUCTIONS_ID}
    />
  )
  const items = serverListPending ? <ServerRailSkeleton /> : (
    <div className="flex w-full flex-col items-center gap-2">
      {railTopLevel(renderState).map((entry, index, entries) => {
        if (entry.kind === "server") {
          const server = serverById.get(entry.id)
          return server ? serverItem(server) : null
        }
        const folderId = entry.id
        const children = folderServers(folderId)
        const open = renderState.expanded.includes(folderId) && !dragging(entry)
        const active = children.some((server) => server.id === activeId)
        const operation = preview?.target.kind === "folder" && preview.target.id === folderId && preview.operation !== "append" ? preview.operation : null
        return (
          <div key={`folder:${folderId}`} data-slot="community-rail-folder-surface" data-folder-id={folderId}
            data-rail-preview={operation || undefined}
            className="group/folder relative w-full py-1">
            <RailFolderGapDropTarget dnd={dnd} folderId={folderId} operation="reorder-before" testId={tid.serverRailFolderBefore(folderId)} />
            {index < entries.length - 1 && <RailFolderGapDropTarget dnd={dnd} folderId={folderId} operation="reorder-after" testId={tid.serverRailFolderAfter(folderId)} />}
            <div data-slot="community-rail-folder-backdrop" className={`pointer-events-none absolute bg-accent/50 dark:bg-accent ${open ? "inset-x-1 inset-y-0 rounded-[12px]" : `left-1/2 top-1 size-10 -translate-x-1/2 transition-[border-radius] duration-150 ${active ? "rounded-xl" : "rounded-[18px] group-hover/folder:rounded-xl"}`} ${operation === "combine" ? "ring-2 ring-primary" : ""}`} />
            {operation && operation !== "combine" && <span data-slot="community-server-rail-insert" className={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-primary ${operation === "reorder-before" ? "-top-1 -translate-y-1/2" : "-bottom-1 translate-y-1/2"}`} />}
            <RailFolder folderId={folderId} name={folderNames.get(folderId) ?? "Group"} open={open}
              active={!open && active}
              unread={!open && children.some((server) => server.unread)}
              onToggle={() => setExpanded((current) => {
                const expanding = !current.includes(folderId)
                if (railMutation.isCommandPending()) expansionOverrides.set((previous) => new Map(previous).set(folderId, expanding))
                return expanding ? [...current, folderId] : current.filter((id) => id !== folderId)
              })}
              folderServers={children} dragging={dragging(entry)} dnd={dnd} dragDescriptionId={DRAG_INSTRUCTIONS_ID}
            />
            <div className={`relative grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`} inert={!open}>
              <div className="min-h-0 overflow-hidden">
                <div className="flex w-full flex-col items-center gap-2 pt-2">
                  {children.map((server) => serverItem(server, true))}
                  <RailEndDropTarget dnd={dnd} target={{ kind: "folder-content", id: folderId }} testId={tid.serverRailFolderEnd(folderId)} active={preview?.operation === "append" && preview.target.kind === "folder-content" && preview.target.id === folderId} />
                </div>
              </div>
            </div>
          </div>
        )
      })}
      <RailEndDropTarget dnd={dnd} target={{ kind: "root", id: "root" }} testId={tid.serverRailEnd} active={preview?.operation === "append" && preview.target.kind === "root"} />
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
      <ServerRailDragPreview dnd={dnd} servers={serverById} folderNames={folderNames} state={renderState} activeServerId={view === "dm" ? "" : activeId} />
      <span id={DRAG_INSTRUCTIONS_ID} className="sr-only">
        Drag to move a server or group. On touch screens, hold before moving. Escape cancels.
      </span>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      {createOpen && (
        <CreateServerDialog
          onClose={() => setCreateOpen(false)}
          onCreateServer={(name, icon) => { onCreateServer?.(name, icon) }}
        />
      )}
    </ServerRailFrame>
  )
}

export const ServerRail = memo(function ServerRail(props: ComponentProps<typeof ServerRailContent>) {
  return <CommunityDndProvider><ServerRailContent {...props} /></CommunityDndProvider>
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

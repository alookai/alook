"use client"

import type { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"
import type { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useVirtualizer } from "@tanstack/react-virtual"
import { OfficialServerBadge } from "../official-server-badge"
import { CommunityNavigationLink } from "../shell/community-navigation-link"
import { channelHref } from "@/lib/community/community-route"
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, type ComponentProps, type MouseEvent } from "react"
import { Link2, Settings, Users, Bell, ChevronDown, UserPlus } from "@/components/icons/lucide";
import { CommunityDndProvider, useCommunityDndScrolling } from "../community-dnd"
import { ChannelDndScope, ChannelDropContainer, useChannelDragActive } from "./channel-dnd"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea, ScrollAreaContent, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area"
import { SortableCategory } from "./sortable-category"
import { SortableChannel, PendingChannelRow } from "./sortable-channel"
import { CreateChannelDialog } from "../settings/create-channel-dialog"
import { CreateCategoryDialog } from "../settings/create-category-dialog"
import { CategorySettingsDialog } from "../settings/category-settings-dialog"
import { projectChannelTreeDrop, type ChannelCategoryMove, type ChannelTree, type ChannelTreeDrop } from "./use-channel-tree"
import { InviteDialog } from "../social/invite-dialog"
import { ChannelAddMembersDialog } from "../members/channel-add-members-dialog"
import type { Channel } from "@/lib/community/models/navigation"
import type { SettingsSection } from "@/components/community/settings/settings-types"
import type { ChannelType } from "@alook/shared"
import { tid } from "@/lib/community/testids"
import type { ForumSidebarThread } from "@/hooks/community/use-forum-sidebar-threads"
import { selectUnreadPresentation } from "@/hooks/community/unread-presentation"
import { ChannelUnreadIndicator } from "./channel-unread-indicator"
import { ForumPostCountsStatus } from "./forum-post-count"
import {
  COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
  measureCommunityVirtualizerElement,
  observeCommunityVirtualizerRect,
} from "@/hooks/community/virtualizer-react-options"

const FORUM_SIDEBAR_ROW_HEIGHT = 28
const CHANNEL_SIDEBAR_VIRTUALIZE_THRESHOLD = 60

type SidebarVirtualEntry =
  | { kind: "category-header"; key: string; id: string; name: string; open: boolean; isPrivate: boolean; pending: boolean; hasChannels: boolean; canCreate: boolean }
  | { kind: "channel"; key: string; channel: Channel; categoryId: string; isPrivate: boolean }
  | { kind: "pending-channel"; key: string; channel: Channel }
  | { kind: "forum-threads"; key: string; parentId: string; threads: ForumSidebarThread[] }
  | { kind: "drop-end"; key: string; categoryId: string; before: boolean; lastRowId?: string }

type Dialog =
  | { kind: "create-channel"; categoryId: string }
  | { kind: "edit-channel"; id: string; categoryId: string; name: string; type: ChannelType }
  | { kind: "create-category" }
  | { kind: "category-settings"; categoryId: string }
  | { kind: "manage-members"; channelId: string; channelName: string }
  | { kind: "delete-channel"; channelId: string; channelName: string }
  | { kind: "delete-category"; categoryId: string; categoryName: string }
  | null

export type ChannelSidebarProps = {
  tree: ChannelTree
  serverName: string
  official?: boolean
  activeChannel: string
  setActiveChannel: (id: string) => void
  noHeader?: boolean
  onOpenSettings?: (section?: SettingsSection) => void
  isAdmin?: boolean
  reorderPending?: boolean
  currentUserId?: string
  onBlockedCreate?: () => void
  mutedChannels?: Record<string, boolean>
  onCreateChannel?: (categoryId: string, name: string, type: ChannelType) => Promise<string | null> | void
  onCreateCategory?: (name: string, opts?: { private?: boolean }) => Promise<string | null> | void
  onDeleteChannel?: (channelId: string) => void
  onDeleteCategory?: (categoryId: string) => void
  onUpdateCategory?: (categoryId: string, opts: { name?: string }) => void
  onRenameChannel?: (channelId: string, name: string) => void
  onReorderCategories?: (categoryIds: string[]) => void
  onReorderChannels?: (channelIds: string[], move?: ChannelCategoryMove) => void
  serverId?: string
  invitePopoverOpen?: boolean
  onInvitePopoverOpenChange?: (open: boolean) => void
  forumThreadsByParent?: Record<string, ForumSidebarThread[]>
  activeThreadId?: string | null
  onSelectForumThread?: (parentId: string, id: string) => void
}

function ChannelSidebarContent({
  tree, serverName, official, activeChannel, setActiveChannel, noHeader, onOpenSettings,
  isAdmin = true, reorderPending = false, currentUserId, onBlockedCreate, mutedChannels,
  onCreateChannel, onCreateCategory, onDeleteChannel, onDeleteCategory,
  onUpdateCategory, onRenameChannel, onReorderCategories, onReorderChannels,
  serverId, invitePopoverOpen, onInvitePopoverOpenChange,
  forumThreadsByParent = {}, activeThreadId, onSelectForumThread,
}: ChannelSidebarProps) {
  const { collapsed, catOrder, order, catNames, catPrivate, catPending, toggleCat } = tree
  const scrollRef = useRef<HTMLDivElement>(null)
  useCommunityDndScrolling(scrollRef, "community/channel-tree")
  const menuActionsRef = useRef<ContextMenuPrimitive.Root.Actions | null>(null)
  const headerMenuActionsRef = useRef<MenuPrimitive.Root.Actions | null>(null)
  useEffect(() => {
    if (!onOpenSettings) {
      headerMenuActionsRef.current?.close()
      headerMenuActionsRef.current?.unmount()
    }
  }, [onOpenSettings])
  useEffect(() => {
    if (!isAdmin) {
      menuActionsRef.current?.close()
      menuActionsRef.current?.unmount()
    }
  }, [isAdmin])
  const canReorder = isAdmin && !reorderPending
  const onDragEnd = useCallback((event: ChannelTreeDrop) => {
    const commit = projectChannelTreeDrop(tree, event)
    if (!commit || !canReorder) return
    if ("categoryIds" in commit) onReorderCategories?.(commit.categoryIds)
    else onReorderChannels?.(commit.channelIds, commit.move)
  }, [canReorder, onReorderCategories, onReorderChannels, tree])
  const [dialog, setDialog] = useAtom(useCreateAtom<Dialog>(null))
  const hasActiveSidebarThread = useMemo(() => (
    !!activeThreadId && Object.values(forumThreadsByParent)
      .some((threads) => threads.some((thread) => thread.id === activeThreadId))
  ), [activeThreadId, forumThreadsByParent])

  const noneCatId = useMemo(
    () => Object.keys(catNames).find((id) => catNames[id] === "") ?? "",
    [catNames],
  )
  const namedCategoryIds = useMemo(
    () => catOrder.filter((id) => catNames[id] !== ""),
    [catNames, catOrder],
  )

  // Who may create a channel where:
  //   - uncategorized (empty categoryId) / public category → admins only
  //   - private category → any member (they own the channel + its roster)
  const canCreateInCategory = useCallback(
    (categoryId: string) => Boolean(onCreateChannel) && (catPrivate[categoryId] ? true : isAdmin),
    [catPrivate, isAdmin, onCreateChannel],
  )
  const requestCreateChannel = useCallback((categoryId: string) => {
    if (!canCreateInCategory(categoryId)) { onBlockedCreate?.(); return }
    setDialog({ kind: "create-channel", categoryId })
  }, [canCreateInCategory, onBlockedCreate, setDialog])

  const createChannel = useCallback(async (categoryId: string, { name, type }: { name: string; type: ChannelType }) => {
    const id = await onCreateChannel?.(categoryId, name, type)
    if (id) setActiveChannel(id)
  }, [onCreateChannel, setActiveChannel])

  const handleEditChannel = useCallback((ch: Channel, categoryId = "") => {
    setDialog({ kind: "edit-channel", id: ch.id, categoryId, name: ch.name, type: ch.type ?? "text" })
  }, [setDialog])
  const handleRequestDeleteChannel = useCallback((ch: Channel) => {
    setDialog({ kind: "delete-channel", channelId: ch.id, channelName: ch.name })
  }, [setDialog])
  const handleManageChannelMembers = useCallback((ch: Channel) => {
    setDialog({ kind: "manage-members", channelId: ch.id, channelName: ch.name })
  }, [setDialog])
  const handleCategorySettings = useCallback((categoryId: string) => {
    setDialog({ kind: "category-settings", categoryId })
  }, [setDialog])
  const handleRequestDeleteCategory = useCallback((categoryId: string, categoryName: string) => {
    setDialog({ kind: "delete-category", categoryId, categoryName })
  }, [setDialog])

  const flatEntries = useMemo<SidebarVirtualEntry[]>(() => {
    const entries: SidebarVirtualEntry[] = []
    if (noneCatId) {
      const noneChannels = order[noneCatId] ?? []
      for (const ch of noneChannels) {
        if (ch.pending) {
          entries.push({ kind: "pending-channel", key: `pending:${ch.id}`, channel: ch })
        } else {
          entries.push({ kind: "channel", key: `ch:${ch.id}`, channel: ch, categoryId: noneCatId, isPrivate: false })
          const threads = forumThreadsByParent[ch.id]
          if (threads && threads.length > 0) {
            entries.push({ kind: "forum-threads", key: `threads:${ch.id}`, parentId: ch.id, threads })
          }
        }
      }
      entries.push({
        kind: "drop-end",
        key: `drop-end:${noneCatId}`,
        categoryId: noneCatId,
        before: noneChannels.length === 0,
        lastRowId: noneChannels.filter((channel) => !channel.pending).at(-1)?.id,
      })
    }
    for (const id of namedCategoryIds) {
      const channels = order[id] ?? []
      const open = !collapsed.has(id)
      entries.push({
        kind: "category-header",
        key: `cat:${id}`,
        id,
        name: catNames[id] ?? id,
        open,
        isPrivate: !!catPrivate[id],
        pending: !!catPending[id],
        hasChannels: channels.length > 0,
        canCreate: !catPending[id] && canCreateInCategory(id),
      })
      if (open) {
        for (const ch of channels) {
          if (ch.pending) {
            entries.push({ kind: "pending-channel", key: `pending:${ch.id}`, channel: ch })
          } else {
            entries.push({ kind: "channel", key: `ch:${ch.id}`, channel: ch, categoryId: id, isPrivate: !!catPrivate[id] })
            const threads = forumThreadsByParent[ch.id]
            if (threads && threads.length > 0) {
              entries.push({ kind: "forum-threads", key: `threads:${ch.id}`, parentId: ch.id, threads })
            }
          }
        }
        entries.push({
          kind: "drop-end",
          key: `drop-end:${id}`,
          categoryId: id,
          before: false,
          lastRowId: channels.filter((channel) => !channel.pending).at(-1)?.id,
        })
      }
    }
    return entries
  }, [canCreateInCategory, catNames, catPending, catPrivate, collapsed, forumThreadsByParent, namedCategoryIds, noneCatId, order])

  const shouldVirtualize = flatEntries.length > CHANNEL_SIDEBAR_VIRTUALIZE_THRESHOLD
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const sidebarVirtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    count: shouldVirtualize ? flatEntries.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const entry = flatEntries[index]
      if (!entry) return 36
      if (entry.kind === "category-header") return 32
      if (entry.kind === "forum-threads") return entry.threads.length * FORUM_SIDEBAR_ROW_HEIGHT
      if (entry.kind === "drop-end") return 16
      return 36
    },
    overscan: 10,
    initialRect: { width: 240, height: 600 },
    measureElement: measureCommunityVirtualizerElement,
    observeElementRect: observeCommunityVirtualizerRect,
  })
  const virtualEntries = shouldVirtualize ? sidebarVirtualizer.getVirtualItems() : []

  const renderForumThreads = (parentId: string, threads: ForumSidebarThread[]) => {
    if (threads.length === 0) return null
    const branchY = (index: number) => index * FORUM_SIDEBAR_ROW_HEIGHT + FORUM_SIDEBAR_ROW_HEIGHT / 2
    const lastY = branchY(threads.length - 1)
    const connectorPath = [
      `M 1 0 V ${lastY - 6} Q 1 ${lastY} 7 ${lastY} H 11`,
      ...threads.slice(0, -1).map((_, index) => `M 1 ${branchY(index)} H 11`),
    ].join(" ")
    return (
      <div className="relative mt-0! ml-5">
        <svg
          aria-hidden="true"
          viewBox={`0 0 16 ${threads.length * FORUM_SIDEBAR_ROW_HEIGHT}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute top-0 left-0 w-4 text-muted-foreground/45"
          style={{ height: threads.length * FORUM_SIDEBAR_ROW_HEIGHT }}
        >
          <path
            d={connectorPath}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {threads.map((thread) => (
          <ForumSidebarThreadRow
            key={thread.id}
            parentId={parentId}
            thread={thread}
            href={serverId ? channelHref(serverId, thread.id) : undefined}
            active={thread.id === activeThreadId}
            muted={!!mutedChannels?.[parentId]}
            onSelectForumThread={onSelectForumThread}
          />
        ))}
      </div>
    )
  }

  const channelTree = (
    <ChannelDndScope tree={tree} onDrop={onDragEnd} enabled={canReorder}>
      {shouldVirtualize ? (
        <div ref={sidebarVirtualizer.containerRef} className="relative w-full" style={{ height: sidebarVirtualizer.getTotalSize() }}>
          {virtualEntries.map((virtualItem) => {
            const entry = flatEntries[virtualItem.index]
            if (!entry) return null
            return (
              <div
                key={entry.key}
                data-index={virtualItem.index}
                ref={sidebarVirtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {entry.kind === "category-header" ? (
                  <SortableCategory
                    id={entry.id}
                    name={entry.name}
                    open={entry.open}
                    onToggle={toggleCat}
                    onAddChannel={entry.canCreate ? requestCreateChannel : undefined}
                    onSettings={!entry.pending && isAdmin ? handleCategorySettings : undefined}
                    onRequestDelete={!entry.pending && isAdmin ? handleRequestDeleteCategory : undefined}
                    isPrivate={entry.isPrivate}
                    canReorder={canReorder && !entry.pending}
                    pending={entry.pending}
                    hasChannels={entry.hasChannels}
                    className="mb-1 pt-2"
                  />
                ) : entry.kind === "pending-channel" ? (
                  <div className="pb-1">
                    <PendingChannelRow ch={entry.channel} />
                  </div>
                ) : entry.kind === "channel" ? (() => {
                  const ch = entry.channel
                  const canManageChannel = entry.categoryId === noneCatId
                    ? isAdmin
                    : isAdmin || (entry.isPrivate && ch.creatorId === currentUserId)
                  const resolvedMuted = mutedChannels && ch.id in mutedChannels ? mutedChannels[ch.id] : ch.muted
                  return (
                    <div className="pb-1">
                      <SortableChannel
                        ch={ch}
                        categoryId={entry.categoryId}
                        muted={resolvedMuted}
                        href={serverId ? channelHref(serverId, ch.id) : undefined}
                        active={ch.id === activeChannel && !hasActiveSidebarThread}
                        canReorder={canReorder}
                        onClick={setActiveChannel}
                        onEdit={canManageChannel ? handleEditChannel : undefined}
                        onRequestDelete={canManageChannel ? handleRequestDeleteChannel : undefined}
                        onManageMembers={(entry.isPrivate && canManageChannel) ? handleManageChannelMembers : undefined}
                      />
                    </div>
                  )
                })() : entry.kind === "forum-threads" ? (
                  renderForumThreads(entry.parentId, entry.threads)
                ) : (
                  <div className="pb-3">
                    <ChannelDropContainer id={entry.categoryId} before={entry.before} lastRowId={entry.lastRowId} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <>
          {/* uncategorized channels (empty-name category) render bare at the top — no header */}
          {noneCatId && (
            <div className={order[noneCatId].length > 0 ? "mb-4" : ""}>
              <div className="space-y-1">
                {order[noneCatId].map((ch) => {
                  if (ch.pending) return <PendingChannelRow key={ch.id} ch={ch} />
                  const resolvedMuted = mutedChannels && ch.id in mutedChannels ? mutedChannels[ch.id] : ch.muted
                  const threads = forumThreadsByParent[ch.id]
                  return (
                    <Fragment key={ch.id}>
                      <SortableChannel
                        ch={ch}
                        categoryId={noneCatId}
                        muted={resolvedMuted}
                        href={serverId ? channelHref(serverId, ch.id) : undefined}
                        active={ch.id === activeChannel && !hasActiveSidebarThread}
                        canReorder={canReorder}
                        onClick={setActiveChannel}
                        onEdit={isAdmin ? handleEditChannel : undefined}
                        onRequestDelete={isAdmin ? handleRequestDeleteChannel : undefined}
                      />
                      {threads && threads.length > 0 ? renderForumThreads(ch.id, threads) : null}
                    </Fragment>
                  )
                })}
              </div>
              <ChannelDropContainer id={noneCatId} before={order[noneCatId].length === 0} lastRowId={order[noneCatId].filter((channel) => !channel.pending).at(-1)?.id} />
            </div>
          )}

          {namedCategoryIds.map((id) => (
            <SortableCategory
              key={id}
              id={id}
              name={catNames[id] ?? id}
              open={!collapsed.has(id)}
              onToggle={toggleCat}
              onAddChannel={!catPending[id] && canCreateInCategory(id) ? requestCreateChannel : undefined}
              onSettings={!catPending[id] && isAdmin ? handleCategorySettings : undefined}
              onRequestDelete={!catPending[id] && isAdmin ? handleRequestDeleteCategory : undefined}
              isPrivate={catPrivate[id]}
              canReorder={canReorder && !catPending[id]}
              pending={catPending[id]}
              hasChannels={(order[id]?.length ?? 0) > 0}
            >
              <div className={(order[id]?.length ?? 0) > 0 ? "mt-1" : ""}>
                <div className="space-y-1">
                {(order[id] ?? []).map((ch) => {
                  if (ch.pending) return <PendingChannelRow key={ch.id} ch={ch} />
                  // Manage/edit rights:
                  //   - admins everywhere
                  //   - private category: the channel creator too
                  // Public-category channels are admin-managed only.
                  const canManageChannel = isAdmin || (!!catPrivate[id] && ch.creatorId === currentUserId)
                  const resolvedMuted = mutedChannels && ch.id in mutedChannels ? mutedChannels[ch.id] : ch.muted
                  const threads = forumThreadsByParent[ch.id]
                  return (
                    <Fragment key={ch.id}>
                      <SortableChannel
                        ch={ch}
                        categoryId={id}
                        muted={resolvedMuted}
                        href={serverId ? channelHref(serverId, ch.id) : undefined}
                        active={ch.id === activeChannel && !hasActiveSidebarThread}
                        canReorder={canReorder}
                        onClick={setActiveChannel}
                        onEdit={canManageChannel ? handleEditChannel : undefined}
                        onRequestDelete={canManageChannel ? handleRequestDeleteChannel : undefined}
                        onManageMembers={(catPrivate[id] && canManageChannel) ? handleManageChannelMembers : undefined}
                      />
                      {threads && threads.length > 0 ? renderForumThreads(ch.id, threads) : null}
                    </Fragment>
                  )
                })}
                </div>
                <ChannelDropContainer id={id} lastRowId={order[id]?.filter((channel) => !channel.pending).at(-1)?.id} />
              </div>
            </SortableCategory>
          ))}
        </>
      )}
    </ChannelDndScope>
  )

  return (
    <aside className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!noHeader && (
        <header className="relative flex h-12 items-center gap-1 border-b border-border/40 px-2">
          <OfficialServerBadge official={official} className="absolute left-1 top-0.5 z-1" />
          <DropdownMenu disabled={!onOpenSettings} actionsRef={headerMenuActionsRef}>
            <DropdownMenuTrigger disabled={!onOpenSettings} className="flex h-11 min-w-0 max-w-full items-center gap-2 rounded-md px-2 enabled:hover:bg-accent disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:h-auto sm:py-1">
              <span data-slot="community-sidebar-server-name" className="min-w-0 truncate pr-1 font-brand text-[1.75rem] leading-none font-bold">{serverName || "\u00a0"}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            {onOpenSettings && (
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={() => onOpenSettings("overview")} data-testid={tid.serverSettingsOpen}><Settings className="size-4" /> Overview</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings("members")}><Users className="size-4" /> Members</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings("invites")}><Link2 className="size-4" /> Invites</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings("notifications")}><Bell className="size-4" /> Notifications</DropdownMenuItem>
              </DropdownMenuContent>
            )}
          </DropdownMenu>
          {serverId && (
            <>
              <Button variant="ghost" size="icon"
                onClick={() => onInvitePopoverOpenChange?.(true)}
                disabled={!onInvitePopoverOpenChange}
                className="ml-auto grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground sm:size-7 enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label="Invite to server"
                title="Invite to server"
              >
                <UserPlus className="size-4" />
              </Button>
              {onInvitePopoverOpenChange && (
                <InviteDialog
                  open={!!invitePopoverOpen}
                  onOpenChange={onInvitePopoverOpenChange}
                  serverId={serverId}
                  serverName={serverName}
                />
              )}
            </>
          )}
        </header>
      )}
      <ForumPostCountsStatus />
      <ScrollAreaRoot className="flex min-h-0 flex-1 flex-col">
        <ContextMenu disabled={!isAdmin} actionsRef={menuActionsRef}>
          <ContextMenuTrigger
            onTouchStart={(event) => { if (isAdmin) event.preventBaseUIHandler() }}
            render={(
              <ScrollAreaViewport
                ref={scrollRef}
                data-testid={tid.channelSidebarScroll}
                className="min-h-0 flex-1 overflow-x-clip overflow-y-auto scroll-fade-y scroll-fade-4 px-2 py-4"
              />
            )}
          >
            <ScrollAreaContent>{channelTree}</ScrollAreaContent>
          </ContextMenuTrigger>
          {isAdmin && (
            <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={() => requestCreateChannel(noneCatId)}>Create channel</ContextMenuItem>
              <ContextMenuItem onClick={() => setDialog({ kind: "create-category" })}>Create category</ContextMenuItem>
            </ContextMenuContent>
          )}
        </ContextMenu>
        <ScrollBar orientation="vertical" />
      </ScrollAreaRoot>

      {dialog?.kind === "create-channel" && (
        <CreateChannelDialog
          category={catNames[dialog.categoryId] ?? ""}
          onClose={() => setDialog(null)}
          onCreate={(ch) => createChannel(dialog.categoryId, ch)}
        />
      )}
      {dialog?.kind === "edit-channel" && (
        <CreateChannelDialog
          category={catNames[dialog.categoryId] ?? ""}
          initial={{ name: dialog.name, type: dialog.type }}
          onClose={() => setDialog(null)}
          onCreate={({ name }) => { onRenameChannel?.(dialog.id, name) }}
        />
      )}
      {dialog?.kind === "create-category" && (
        <CreateCategoryDialog
          onClose={() => setDialog(null)}
          onCreate={(name, opts) => { void onCreateCategory?.(name, opts) }}
          canTogglePrivate={isAdmin}
        />
      )}
      {dialog?.kind === "category-settings" && (
        <CategorySettingsDialog
          name={catNames[dialog.categoryId] ?? ""}
          isPrivate={!!catPrivate[dialog.categoryId]}
          onClose={() => setDialog(null)}
          onSave={(nextName) => {
            onUpdateCategory?.(dialog.categoryId, { name: nextName })
          }}
        />
      )}
      {dialog?.kind === "manage-members" && serverId && (
        <ChannelAddMembersDialog
          serverId={serverId}
          channelId={dialog.channelId}
          channelName={dialog.channelName}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete-channel" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          title={`Delete /${dialog.channelName}?`}
          description="This channel and its message history will be removed for everyone. This can't be undone."
          confirmLabel="Delete channel"
          onConfirm={() => {
            const targetId = dialog.channelId
            setDialog(null)
            onDeleteChannel?.(targetId)
          }}
        />
      )}
      {dialog?.kind === "delete-category" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          title={`Delete ${dialog.categoryName}?`}
          description="Channels inside this category will also be removed. This can't be undone."
          confirmLabel="Delete category"
          onConfirm={() => {
            const targetId = dialog.categoryId
            setDialog(null)
            onDeleteCategory?.(targetId)
          }}
        />
      )}
    </aside>
  )
}

export const ChannelSidebar = memo(function ChannelSidebar(props: ComponentProps<typeof ChannelSidebarContent>) {
  return <CommunityDndProvider><ChannelSidebarContent {...props} /></CommunityDndProvider>
})

const ForumSidebarThreadRow = memo(function ForumSidebarThreadRow({
  parentId,
  thread,
  href,
  active,
  muted,
  onSelectForumThread,
}: {
  parentId: string
  thread: ForumSidebarThread
  href?: string
  active: boolean
  muted: boolean
  onSelectForumThread?: (parentId: string, id: string) => void
}) {
  const dragActive = useChannelDragActive()
  const handleSelect = useCallback(() => onSelectForumThread?.(parentId, thread.id), [onSelectForumThread, parentId, thread.id])
  const unread = selectUnreadPresentation({
    accountUnread: thread.unread,
    active,
    muted,
  })
  const rowProps = {
    style: { height: FORUM_SIDEBAR_ROW_HEIGHT },
    "data-testid": tid.forumSidebarThread(thread.id),
    "aria-current": active ? "page" as const : undefined,
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
    },
    className: [
      "relative ml-4 flex w-[calc(100%-1rem)] min-w-0 items-center rounded-md px-2 text-left text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      active
        ? "bg-sidebar-accent text-foreground"
        : muted
          ? "text-muted-foreground/50 hover:bg-sidebar-accent/60 hover:text-muted-foreground"
          : unread.emphasize
            ? "text-foreground hover:bg-sidebar-accent/60"
            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
    ].join(" "),
  }
  const content = (<>
    <span className="truncate">{thread.title}</span>
    <ChannelUnreadIndicator visible={unread.showDot} dot />
  </>)
  return (
    <div className="relative" style={{ height: FORUM_SIDEBAR_ROW_HEIGHT }}>
      {href ? (
        <CommunityNavigationLink {...rowProps} href={href} active={active} onActivate={handleSelect}
          navigationDisabled={dragActive !== null}>
          {content}
        </CommunityNavigationLink>
      ) : (
        <button {...rowProps} type="button" onClick={handleSelect}>{content}</button>
      )}
    </div>
  )
})

export function ChannelSidebarSkeleton({
  noHeader,
  showInviteAction = false,
  targetServerId,
}: {
  noHeader?: boolean
  showInviteAction?: boolean
  targetServerId?: string
}) {
  return (
    <aside
      data-testid={targetServerId ? tid.channelSidebarPending(targetServerId) : undefined}
      data-pending-server-id={targetServerId}
      aria-label={targetServerId ? "Loading server channels" : undefined}
      aria-busy={targetServerId ? true : undefined}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {!noHeader && (
        <header className="flex h-12 items-center gap-1 border-b border-border/40 px-2">
          <Skeleton className="ml-2 h-7 w-32 rounded" />
          {showInviteAction && <Skeleton className="ml-auto size-7 shrink-0 rounded-md" />}
        </header>
      )}
      <ScrollArea className="flex min-h-0 flex-1 flex-col" viewportClassName="min-h-0 flex-1 scroll-fade-y scroll-fade-4 px-2 py-4">
        <div className="mb-4 space-y-1">
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-7 w-11/12 rounded-md" />
        </div>
        {[40, 32].map((w, i) => (
          <div key={i} className="mb-4">
            <div className="mb-2 flex items-center gap-1 px-1">
              <Skeleton className="h-3 rounded" style={{ width: w }} />
            </div>
            <div className="space-y-1">
              <Skeleton className="h-7 w-full rounded-md" />
              <Skeleton className="h-7 w-10/12 rounded-md" />
              <Skeleton className="h-7 w-11/12 rounded-md" />
              <Skeleton className="h-7 w-9/12 rounded-md" />
            </div>
          </div>
        ))}
      </ScrollArea>
    </aside>
  )
}

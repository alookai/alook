"use client"

import type { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { OfficialServerBadge } from "../official-server-badge"
import { CommunityNavigationLink } from "../shell/community-navigation-link"
import { channelHref } from "@/lib/community/community-route"
import { Fragment, memo, useEffect, useRef, type ComponentProps, type MouseEvent } from "react"
import { Settings, Users, Link2, Bell, ChevronDown, UserPlus } from "lucide-react"
import { CommunityDndProvider, useCommunityDndScrolling } from "../community-dnd"
import { ChannelDndScope, ChannelDropContainer, useChannelDragActive } from "./channel-dnd"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
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


type Dialog =
  | { kind: "create-channel"; categoryId: string }
  | { kind: "edit-channel"; id: string; categoryId: string; name: string; type: ChannelType }
  | { kind: "create-category" }
  | { kind: "category-settings"; categoryId: string }
  | { kind: "manage-members"; channelId: string; channelName: string }
  | null

export type ChannelSidebarProps = {
  tree: ChannelTree
  serverName: string
  official?: boolean
  serverIcon?: string | null
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
  useEffect(() => {
    if (!isAdmin) {
      menuActionsRef.current?.close()
      menuActionsRef.current?.unmount()
    }
  }, [isAdmin])
  const canReorder = isAdmin && !reorderPending
  const onDragEnd = (event: ChannelTreeDrop) => {
    const commit = projectChannelTreeDrop(tree, event)
    if (!commit || !canReorder) return
    if ("categoryIds" in commit) onReorderCategories?.(commit.categoryIds)
    else onReorderChannels?.(commit.channelIds, commit.move)
  }
  const [dialog, setDialog] = useAtom(useCreateAtom<Dialog>(null))
  const withMute = (ch: Channel): Channel => mutedChannels && ch.id in mutedChannels ? { ...ch, muted: mutedChannels[ch.id] } : ch
  const hasActiveSidebarThread = !!activeThreadId && Object.values(forumThreadsByParent)
    .some((threads) => threads.some((thread) => thread.id === activeThreadId))
  const childRows = (parentId: string) => {
    const threads = forumThreadsByParent[parentId] ?? []
    if (threads.length === 0) return null
    const rowHeight = 28
    const branchY = (index: number) => index * rowHeight + rowHeight / 2
    const lastY = branchY(threads.length - 1)
    const connectorPath = [
      `M 1 0 V ${lastY - 6} Q 1 ${lastY} 7 ${lastY} H 11`,
      ...threads.slice(0, -1).map((_, index) => `M 1 ${branchY(index)} H 11`),
    ].join(" ")
    return (
      <div className="relative mt-0! ml-5">
        <svg
          aria-hidden="true"
          viewBox={`0 0 16 ${threads.length * rowHeight}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute top-0 left-0 w-4 text-muted-foreground/45"
          style={{ height: threads.length * rowHeight }}
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
            thread={thread}
            href={serverId ? channelHref(serverId, thread.id) : undefined}
            active={thread.id === activeThreadId}
            muted={!!mutedChannels?.[parentId]}
            onClick={() => onSelectForumThread?.(parentId, thread.id)}
          />
        ))}
      </div>
    )
  }

  // Find the "none" category ID (empty name) — only if one explicitly exists
  const noneCatId = Object.keys(catNames).find((id) => catNames[id] === "") ?? ""

  // Who may create a channel where:
  //   - uncategorized (empty categoryId) / public category → admins only
  //   - private category → any member (they own the channel + its roster)
  const canCreateInCategory = (categoryId: string) =>
    Boolean(onCreateChannel) && (catPrivate[categoryId] ? true : isAdmin)
  const requestCreateChannel = (categoryId: string) => {
    if (!canCreateInCategory(categoryId)) { onBlockedCreate?.(); return }
    setDialog({ kind: "create-channel", categoryId })
  }

  const createChannel = async (categoryId: string, { name, type }: { name: string; type: ChannelType }) => {
    const id = await onCreateChannel?.(categoryId, name, type)
    if (id) setActiveChannel(id)
  }

  const channelTree = (
    <ChannelDndScope tree={tree} onDrop={onDragEnd} enabled={canReorder}>
      {/* uncategorized channels (empty-name category) render bare at the top — no header */}
      {noneCatId && (
        <div className={order[noneCatId].length > 0 ? "mb-4" : ""}>
          <div className="space-y-1">
            {order[noneCatId].map((ch) => ch.pending ? (
              <PendingChannelRow key={ch.id} ch={ch} />
            ) : (
              <Fragment key={ch.id}>
                <SortableChannel
                  ch={withMute(ch)}
                  href={serverId ? channelHref(serverId, ch.id) : undefined}
                  active={ch.id === activeChannel && !hasActiveSidebarThread}
                  canReorder={canReorder}
                  onClick={() => setActiveChannel(ch.id)}
                  onEdit={isAdmin ? () => setDialog({ kind: "edit-channel", id: ch.id, categoryId: noneCatId, name: ch.name, type: ch.type ?? "text" }) : undefined}
                  onDelete={isAdmin ? () => onDeleteChannel?.(ch.id) : undefined}
                />
                {childRows(ch.id)}
              </Fragment>
            ))}
          </div>
          <ChannelDropContainer id={noneCatId} before={order[noneCatId].length === 0} lastRowId={order[noneCatId].filter((channel) => !channel.pending).at(-1)?.id} />
        </div>
      )}

        {catOrder.filter((id) => catNames[id] !== "").map((id) => (
          <SortableCategory
            key={id}
            id={id}
            name={catNames[id] ?? id}
            open={!collapsed.has(id)}
            onToggle={() => toggleCat(id)}
            onAddChannel={!catPending[id] && canCreateInCategory(id) ? () => requestCreateChannel(id) : undefined}
            onSettings={!catPending[id] && isAdmin ? () => setDialog({ kind: "category-settings", categoryId: id }) : undefined}
            onDelete={!catPending[id] && isAdmin ? () => onDeleteCategory?.(id) : undefined}
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
                  return (
                    <Fragment key={ch.id}>
                      <SortableChannel
                        ch={withMute(ch)}
                        href={serverId ? channelHref(serverId, ch.id) : undefined}
                        active={ch.id === activeChannel && !hasActiveSidebarThread}
                        canReorder={canReorder}
                        onClick={() => setActiveChannel(ch.id)}
                        onEdit={canManageChannel ? () => setDialog({ kind: "edit-channel", id: ch.id, categoryId: id, name: ch.name, type: ch.type ?? "text" }) : undefined}
                        onDelete={canManageChannel ? () => onDeleteChannel?.(ch.id) : undefined}
                        onManageMembers={(catPrivate[id] && canManageChannel) ? () => setDialog({ kind: "manage-members", channelId: ch.id, channelName: ch.name }) : undefined}
                      />
                      {childRows(ch.id)}
                    </Fragment>
                  )
                })}
                </div>
                <ChannelDropContainer id={id} lastRowId={order[id]?.filter((channel) => !channel.pending).at(-1)?.id} />
              </div>
          </SortableCategory>
        ))}
    </ChannelDndScope>
  )

  return (
    <aside className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!noHeader && (
        <header className="relative flex h-12 items-center gap-1 border-b border-border/40 px-2">
          <OfficialServerBadge official={official} className="absolute left-1 top-0.5 z-1" />
          {serverName && onOpenSettings ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex h-11 min-w-0 max-w-full items-center gap-2 rounded-md px-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:h-auto sm:py-1">
                <span className="min-w-0 truncate pr-1 font-brand text-[1.75rem] leading-none font-bold">{serverName}</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={() => onOpenSettings("overview")} data-testid={tid.serverSettingsOpen}><Settings className="size-4" /> Overview</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings("members")}><Users className="size-4" /> Members</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings("invites")}><Link2 className="size-4" /> Invites</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings("notifications")}><Bell className="size-4" /> Notifications</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="flex min-w-0 max-w-full items-center gap-2 px-2">
              <span className="min-w-0 truncate pr-1 font-brand text-[1.75rem] leading-none font-bold">{serverName || "\u00a0"}</span>
            </span>
          )}
          {serverId && onInvitePopoverOpenChange && (
            <>
              <button
                onClick={() => onInvitePopoverOpenChange(true)}
                className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label="Invite to server"
                title="Invite to server"
              >
                <UserPlus className="size-4" />
              </button>
              <InviteDialog
                open={!!invitePopoverOpen}
                onOpenChange={onInvitePopoverOpenChange}
                serverId={serverId}
                serverName={serverName}
              />
            </>
          )}
        </header>
      )}
      <ContextMenu disabled={!isAdmin} actionsRef={menuActionsRef}>
        <ContextMenuTrigger
          onTouchStart={(event) => { if (isAdmin) event.preventBaseUIHandler() }}
          render={(
            <div
              ref={scrollRef}
              data-testid={tid.channelSidebarScroll}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-4 thin-scrollbar scrollbar-none"
            />
          )}
        >
          {channelTree}
        </ContextMenuTrigger>
        {isAdmin && (
          <ContextMenuContent className="w-48">
            <ContextMenuItem onClick={() => requestCreateChannel(noneCatId)}>Create channel</ContextMenuItem>
            <ContextMenuItem onClick={() => setDialog({ kind: "create-category" })}>Create category</ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>

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
          onCreate={(name, opts) => { onCreateCategory?.(name, opts) }}
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
    </aside>
  )
}

export const ChannelSidebar = memo(function ChannelSidebar(props: ComponentProps<typeof ChannelSidebarContent>) {
  return <CommunityDndProvider><ChannelSidebarContent {...props} /></CommunityDndProvider>
})

function ForumSidebarThreadRow({
  thread,
  href,
  active,
  muted,
  onClick,
}: {
  thread: ForumSidebarThread
  href?: string
  active: boolean
  muted: boolean
  onClick: () => void
}) {
  const dragActive = useChannelDragActive()
  const unread = selectUnreadPresentation({
    accountUnread: thread.unread,
    active,
    muted,
  })
  const rowProps = {
    "data-testid": tid.forumSidebarThread(thread.id),
    "aria-current": active ? "page" as const : undefined,
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
    },
    className: [
      "relative ml-4 flex h-7 w-[calc(100%-1rem)] min-w-0 items-center rounded-md px-2 text-left text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
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
    <div className="relative h-7">
      {href ? (
        <CommunityNavigationLink {...rowProps} href={href} active={active} onActivate={onClick}
          navigationDisabled={dragActive !== null}>
          {content}
        </CommunityNavigationLink>
      ) : (
        <button {...rowProps} type="button" onClick={onClick}>{content}</button>
      )}
    </div>
  )
}

// Loading placeholder for the channel sidebar. Kept colocated so changes to
// row density or header height stay in sync with the live sidebar above.
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
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-4 thin-scrollbar scrollbar-none">
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
      </div>
    </aside>
  )
}

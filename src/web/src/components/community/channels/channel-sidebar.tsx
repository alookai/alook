"use client"

import { Fragment, memo, useRef, useState } from "react"
import { Settings, Users, Link2, Bell, ChevronDown, UserPlus } from "lucide-react"
import {
  DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors,
  type CollisionDetection,
} from "@dnd-kit/core"
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { SortableCategory } from "./sortable-category"
import { SortableChannel, PendingChannelRow } from "./sortable-channel"
import { CreateChannelDialog } from "../settings/create-channel-dialog"
import { CreateCategoryDialog } from "../settings/create-category-dialog"
import { CategorySettingsDialog } from "../settings/category-settings-dialog"
import { catId, catOf, reorderChannelsWithin, type ChannelTree } from "./use-channel-tree"
import { InviteDialog } from "../social/invite-dialog"
import { ChannelAddMembersDialog } from "../members/channel-add-members-dialog"
import type { Channel } from "@/lib/community/models/navigation"
import type { SettingsSection } from "@/components/community/settings/settings-types"
import { UNCATEGORIZED_CATEGORY_ID, type ChannelType } from "@alook/shared"
import { tid } from "@/lib/community/testids"
import type { ForumSidebarThread } from "@/hooks/community/use-forum-sidebar-threads"


type Dialog =
  | { kind: "create-channel"; categoryId: string }
  | { kind: "edit-channel"; id: string; categoryId: string; name: string; type: ChannelType }
  | { kind: "create-category" }
  | { kind: "category-settings"; categoryId: string }
  | { kind: "manage-members"; channelId: string; channelName: string }
  | null

type SortableData = { kind?: "category" | "channel"; sortable?: { containerId?: string } }

const channelSidebarCollisionDetection: CollisionDetection = (args) => {
  const activeData = args.active.data.current as SortableData | undefined
  if (args.pointerCoordinates && activeData?.kind !== "category") return closestCenter(args)

  const containerId = activeData?.sortable?.containerId
  if (!containerId) return closestCenter(args)

  const sameContainer = args.droppableContainers.filter((container) =>
    (container.data.current as SortableData | undefined)?.sortable?.containerId === containerId)
  return closestCenter({ ...args, droppableContainers: sameContainer })
}

// The channel sidebar (server view). Category/channel reorder + add/remove/rename live in
// useChannelTree. The category gear/right-click opens settings; "+" (or empty-space
// right-click) creates; channels right-click to edit/delete. A private category only
// lets admins create channels — non-admins are blocked via onBlockedCreate.
export const ChannelSidebar = memo(function ChannelSidebar({
  tree, serverName, activeChannel, setActiveChannel, prefetchChannel, noHeader, onOpenSettings,
  isAdmin = true, currentUserId, onBlockedCreate, mutedChannels, loading,
  onCreateChannel, onCreateCategory, onDeleteChannel, onDeleteCategory,
  onUpdateCategory, onRenameChannel, onReorderCategories, onReorderChannels,
  onMoveChannel, onBlockedMove,
  serverId, invitePopoverOpen, onInvitePopoverOpenChange,
  forumThreadsByParent = {}, activeThreadId, onSelectForumThread,
}: {
  tree: ChannelTree
  serverName: string
  serverIcon?: string | null
  activeChannel: string
  setActiveChannel: (id: string) => void
  prefetchChannel?: (id: string, parentId?: string) => void
  noHeader?: boolean
  onOpenSettings?: (section?: SettingsSection) => void
  isAdmin?: boolean
  currentUserId?: string
  onBlockedCreate?: () => void
  mutedChannels?: Record<string, boolean>
  loading?: boolean
  onCreateChannel?: (categoryId: string, name: string, type: ChannelType) => Promise<string | null> | void
  onCreateCategory?: (name: string, opts?: { private?: boolean }) => Promise<string | null> | void
  onDeleteChannel?: (channelId: string) => void
  onDeleteCategory?: (categoryId: string) => void
  onUpdateCategory?: (categoryId: string, opts: { name?: string }) => void
  onRenameChannel?: (channelId: string, name: string) => void
  onReorderCategories?: (categoryIds: string[]) => void
  onReorderChannels?: (channelIds: string[]) => void
  onMoveChannel?: (channelId: string, categoryId: string | null) => void
  onBlockedMove?: () => void
  serverId?: string
  invitePopoverOpen?: boolean
  onInvitePopoverOpenChange?: (open: boolean) => void
  forumThreadsByParent?: Record<string, ForumSidebarThread[]>
  activeThreadId?: string | null
  onSelectForumThread?: (parentId: string, id: string) => void
}) {
  const { collapsed, catOrder, order, catNames, catPrivate, catPending, toggleCat, removeChannel, renameChannel, renameCategory, onDragOver, onDragEnd: treeDragEnd } = tree
  // Category the dragged channel started in — captured at drag start, because
  // `onDragOver` mutates `order` mid-drag so by drop time it already reflects
  // the destination.
  const dragOriginCat = useRef<string | undefined>(undefined)
  const onDragStart = (e: { active: { id: string | number } }) => {
    const activeStr = String(e.active.id)
    dragOriginCat.current = catOrder.includes(activeStr) ? undefined : catOf(activeStr, order)
  }
  const onDragEnd = (e: Parameters<typeof treeDragEnd>[0]) => {
    const originCat = dragOriginCat.current
    dragOriginCat.current = undefined
    treeDragEnd(e)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const activeStr = String(active.id)
    const overStr = String(over.id)
    const activeIsCategory = catOrder.includes(activeStr)
    const overIsCategory = catOrder.includes(overStr)
    if (activeIsCategory && overIsCategory) {
      const reordered = catOrder.indexOf(activeStr) !== -1 ? (() => {
        const from = catOrder.indexOf(activeStr)
        const to = catOrder.indexOf(overStr)
        if (from === -1 || to === -1) return null
        const next = [...catOrder]
        const [item] = next.splice(from, 1)
        next.splice(to, 0, item)
        return next
      })() : null
      // Never send an optimistic (pending) category id to the reorder endpoint.
      if (reordered) onReorderCategories?.(reordered.filter((cid) => !catPending[cid]))
    } else if (!activeIsCategory) {
      // The channel's category AFTER onDragOver settled the optimistic move.
      const destCat = catOf(activeStr, order)
      // A blocked public↔private move: the cursor landed in a different-privacy
      // category, so onDragOver refused to move it and destCat === originCat.
      // Detect the attempt from the drop target and warn.
      const dropTargetCat = overIsCategory ? overStr : catOf(overStr, order)
      if (
        originCat && dropTargetCat && dropTargetCat !== originCat &&
        destCat === originCat &&
        !!catPrivate[originCat] !== !!catPrivate[dropTargetCat]
      ) {
        onBlockedMove?.()
        return
      }
      // Persist a same-privacy cross-category move: write the new categoryId
      // (translating the synthetic uncategorized bucket to null), then reorder.
      //
      // `treeDragEnd(e)` above settles the drop via `setOrder(...)`, which only
      // applies on the NEXT render — so the `order` closure here is still the
      // PRE-drop order for a same-category reorder (`onDragOver` never touched
      // it in that case). Reading it directly would PATCH the old sequence and
      // the reorder wouldn't persist. Recompute the settled order synchronously
      // from the same pure helper `treeDragEnd` uses. Cross-category is already
      // settled by `onDragOver`, and re-settling within the destination is
      // idempotent — so this is correct for both paths.
      const settledOrder = reorderChannelsWithin(order, activeStr, overStr)
      const allChannelIds = catOrder.flatMap((cat) => (settledOrder[cat] ?? []).filter((c) => !c.pending).map((c) => c.id))
      if (destCat && originCat && destCat !== originCat) {
        // The uncategorized bucket (empty name, synthetic id) maps back to a
        // real `categoryId: null` for the PATCH.
        const isUncategorized = catNames[destCat] === "" || destCat === UNCATEGORIZED_CATEGORY_ID
        onMoveChannel?.(activeStr, isUncategorized ? null : destCat)
      }
      onReorderChannels?.(allChannelIds)
    }
  }
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [dialog, setDialog] = useState<Dialog>(null)
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
            active={thread.id === activeThreadId}
            muted={!!mutedChannels?.[parentId]}
            onClick={() => onSelectForumThread?.(parentId, thread.id)}
            onPrefetch={() => prefetchChannel?.(thread.id, parentId)}
          />
        ))}
      </div>
    )
  }

  // Find the "none" category ID (empty name) — only if one explicitly exists
  const noneCatId = Object.keys(catNames).find((id) => catNames[id] === "") ?? ""

  // Initial load / server switch — render skeleton so the sidebar holds its
  // width and rhythm instead of collapsing to an empty column. Do NOT gate on
  // `catOrder.length === 0`: the tree is derived from `categories` inside a
  // useEffect (use-channel-tree.ts), so on a server switch it still holds the
  // PREVIOUS server's categories for one commit while `loading` has already
  // flipped true. Gating on catOrder would flash the old server's channel list
  // for a frame before collapsing to skeleton.
  if (loading) {
    return (
      <ChannelSidebarSkeleton
        noHeader={noHeader}
        showInviteAction={Boolean(serverId && onInvitePopoverOpenChange)}
      />
    )
  }


  // Who may create a channel where:
  //   - uncategorized (empty categoryId) / public category → admins only
  //   - private category → any member (they own the channel + its roster)
  const canCreateInCategory = (categoryId: string) =>
    catPrivate[categoryId] ? true : isAdmin
  const requestCreateChannel = (categoryId: string) => {
    if (!canCreateInCategory(categoryId)) { onBlockedCreate?.(); return }
    setDialog({ kind: "create-channel", categoryId })
  }

  const createChannel = async (categoryId: string, { name, type }: { name: string; type: ChannelType }) => {
    const id = await onCreateChannel?.(categoryId, name, type)
    if (id) setActiveChannel(id)
  }

  // one DndContext spans everything: categories sort among themselves, channels across categories
  const channelTree = (
    <DndContext id="d-channels" sensors={sensors} collisionDetection={channelSidebarCollisionDetection} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
      {/* uncategorized channels (empty-name category) render bare at the top — no header */}
      {noneCatId && order[noneCatId]?.length > 0 && (
        <SortableContext items={order[noneCatId].filter((c) => !c.pending).map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="mb-4 space-y-1">
            {order[noneCatId].map((ch) => ch.pending ? (
              <PendingChannelRow key={ch.id} ch={ch} />
            ) : (
              <Fragment key={ch.id}>
                <SortableChannel
                  ch={withMute(ch)}
                  active={ch.id === activeChannel && !hasActiveSidebarThread}
                  canReorder={isAdmin}
                  onClick={() => setActiveChannel(ch.id)}
                  onPrefetch={() => prefetchChannel?.(ch.id)}
                  onEdit={isAdmin ? () => setDialog({ kind: "edit-channel", id: ch.id, categoryId: noneCatId, name: ch.name, type: ch.type ?? "text" }) : undefined}
                  onDelete={isAdmin ? () => { removeChannel(ch.id); onDeleteChannel?.(ch.id) } : undefined}
                />
                {childRows(ch.id)}
              </Fragment>
            ))}
          </div>
        </SortableContext>
      )}
      <SortableContext items={catOrder.filter((id) => catNames[id] !== "" && !catPending[id]).map((id) => catId(id))} strategy={verticalListSortingStrategy}>
        {catOrder.filter((id) => catNames[id] !== "").map((id) => (
          <SortableCategory
            key={id}
            id={catId(id)}
            name={catNames[id] ?? id}
            open={!collapsed.has(id)}
            onToggle={() => toggleCat(id)}
            onAddChannel={!catPending[id] && canCreateInCategory(id) ? () => requestCreateChannel(id) : undefined}
            onSettings={!catPending[id] && isAdmin ? () => setDialog({ kind: "category-settings", categoryId: id }) : undefined}
            onDelete={!catPending[id] && isAdmin ? () => onDeleteCategory?.(id) : undefined}
            isPrivate={catPrivate[id]}
            canReorder={isAdmin && !catPending[id]}
            pending={catPending[id]}
          >
            <SortableContext items={(order[id] ?? []).filter((c) => !c.pending).map((c) => c.id)} strategy={verticalListSortingStrategy}>
              <div className="mt-1 min-h-2 space-y-1">
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
                        active={ch.id === activeChannel && !hasActiveSidebarThread}
                        canReorder={isAdmin}
                        onClick={() => setActiveChannel(ch.id)}
                        onPrefetch={() => prefetchChannel?.(ch.id)}
                        onEdit={canManageChannel ? () => setDialog({ kind: "edit-channel", id: ch.id, categoryId: id, name: ch.name, type: ch.type ?? "text" }) : undefined}
                        onDelete={canManageChannel ? () => { removeChannel(ch.id); onDeleteChannel?.(ch.id) } : undefined}
                        onManageMembers={(catPrivate[id] && canManageChannel) ? () => setDialog({ kind: "manage-members", channelId: ch.id, channelName: ch.name }) : undefined}
                      />
                      {childRows(ch.id)}
                    </Fragment>
                  )
                })}
              </div>
            </SortableContext>
          </SortableCategory>
        ))}
      </SortableContext>
    </DndContext>
  )

  return (
    <aside className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!noHeader && (
        <header className="flex h-12 items-center gap-1 border-b border-border/40 px-2">
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
      {/* right-click anywhere in the list (incl. empty space) → create channel / category.
          Non-admins have no actions, so the menu is skipped entirely (no empty popover). */}
      {isAdmin ? (
      <ContextMenu>
        <ContextMenuTrigger
          render={(
            <div
              data-testid={tid.channelSidebarScroll}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-4 thin-scrollbar scrollbar-none"
            />
          )}
        >
          {channelTree}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={() => requestCreateChannel(noneCatId)}>Create channel</ContextMenuItem>
          <ContextMenuItem onClick={() => setDialog({ kind: "create-category" })}>Create category</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      ) : (
        <div
          data-testid={tid.channelSidebarScroll}
          className="min-h-0 flex-1 overflow-y-auto px-2 py-4 thin-scrollbar scrollbar-none"
        >
          {channelTree}
        </div>
      )}

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
          onCreate={({ name }) => { renameChannel(dialog.id, name); onRenameChannel?.(dialog.id, name) }}
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
            renameCategory(dialog.categoryId, nextName)
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
})

function ForumSidebarThreadRow({
  thread,
  active,
  muted,
  onClick,
  onPrefetch,
}: {
  thread: ForumSidebarThread
  active: boolean
  muted: boolean
  onClick: () => void
  onPrefetch?: () => void
}) {
  return (
    <div className="relative h-7">
      <button
        type="button"
        data-testid={tid.forumSidebarThread(thread.id)}
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        onPointerEnter={onPrefetch}
        onFocus={onPrefetch}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        className={[
          "ml-4 flex h-7 w-[calc(100%-1rem)] min-w-0 items-center rounded-md px-2 text-left text-xs font-medium",
          active
            ? "bg-sidebar-accent text-foreground"
            : muted
              ? "text-muted-foreground/50 hover:bg-sidebar-accent/60 hover:text-muted-foreground"
              : thread.unread
                ? "text-foreground hover:bg-sidebar-accent/60"
            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
        ].join(" ")}
      >
        <span className="truncate">{thread.title}</span>
        {!muted && thread.unread && !active ? (
          <span className="ml-auto size-2 shrink-0 rounded-full bg-primary" />
        ) : null}
      </button>
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

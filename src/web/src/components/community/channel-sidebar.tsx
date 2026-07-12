"use client"

import { memo, useRef, useState } from "react"
import { Settings, Users, Link2, Bell, ScrollText, ChevronDown, UserPlus } from "lucide-react"
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { SortableCategory } from "./sortable-category"
import { SortableChannel } from "./sortable-channel"
import { CreateChannelDialog } from "./create-channel-dialog"
import { CreateCategoryDialog } from "./create-category-dialog"
import { CategorySettingsDialog } from "./category-settings-dialog"
import { catId, catOf, isCat, type ChannelTree } from "./use-channel-tree"
import { InviteDialog } from "./invite-dialog"
import { ChannelMembersDialog } from "./channel-members-dialog"
import type { Channel, SettingsSection } from "./_types"
import type { ChannelType } from "@alook/shared"


type Dialog =
  | { kind: "create-channel"; categoryId: string }
  | { kind: "edit-channel"; id: string; categoryId: string; name: string; type: ChannelType }
  | { kind: "create-category" }
  | { kind: "category-settings"; categoryId: string }
  | { kind: "manage-members"; channelId: string; channelName: string }
  | null

// The channel sidebar (server view). Category/channel reorder + add/remove/rename live in
// useChannelTree. The category gear/right-click opens settings; "+" (or empty-space
// right-click) creates; channels right-click to edit/delete. A private category only
// lets admins create channels — non-admins are blocked via onBlockedCreate.
export const ChannelSidebar = memo(function ChannelSidebar({
  tree, serverName, activeChannel, setActiveChannel, noHeader, onOpenSettings,
  isAdmin = true, currentUserId, onBlockedCreate, mutedChannels, loading,
  onCreateChannel, onCreateCategory, onDeleteChannel, onDeleteCategory,
  onUpdateCategory, onRenameChannel, onReorderCategories, onReorderChannels,
  onMoveChannel, onBlockedMove,
  serverId, invitePopoverOpen, onInvitePopoverOpenChange,
}: {
  tree: ChannelTree
  serverName: string
  activeChannel: string
  setActiveChannel: (id: string) => void
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
}) {
  const { collapsed, catOrder, order, catNames, catPrivate, toggleCat, removeChannel, renameChannel, removeCategory, renameCategory, onDragOver, onDragEnd: treeDragEnd } = tree
  // Category the dragged channel started in — captured at drag start, because
  // `onDragOver` mutates `order` mid-drag so by drop time it already reflects
  // the destination.
  const dragOriginCat = useRef<string | undefined>(undefined)
  const onDragStart = (e: { active: { id: string | number } }) => {
    const activeStr = String(e.active.id)
    dragOriginCat.current = isCat(activeStr) ? undefined : catOf(activeStr, order)
  }
  const onDragEnd = (e: Parameters<typeof treeDragEnd>[0]) => {
    const originCat = dragOriginCat.current
    dragOriginCat.current = undefined
    treeDragEnd(e)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const activeStr = String(active.id)
    const overStr = String(over.id)
    if (activeStr.startsWith("cat_") && overStr.startsWith("cat_")) {
      const reordered = catOrder.indexOf(activeStr) !== -1 ? (() => {
        const from = catOrder.indexOf(activeStr)
        const to = catOrder.indexOf(overStr)
        if (from === -1 || to === -1) return null
        const next = [...catOrder]
        const [item] = next.splice(from, 1)
        next.splice(to, 0, item)
        return next
      })() : null
      if (reordered) onReorderCategories?.(reordered)
    } else if (!activeStr.startsWith("cat_")) {
      // The channel's category AFTER onDragOver settled the optimistic move.
      const destCat = catOf(activeStr, order)
      // A blocked public↔private move: the cursor landed in a different-privacy
      // category, so onDragOver refused to move it and destCat === originCat.
      // Detect the attempt from the drop target and warn.
      const dropTargetCat = isCat(overStr) ? overStr : catOf(overStr, order)
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
      const allChannelIds = catOrder.flatMap((cat) => (order[cat] ?? []).map((c) => c.id))
      if (destCat && originCat && destCat !== originCat) {
        // The uncategorized bucket (empty name, synthetic id) maps back to a
        // real `categoryId: null` for the PATCH.
        const isUncategorized = catNames[destCat] === "" || destCat === "__uncategorized__"
        onMoveChannel?.(activeStr, isUncategorized ? null : destCat)
      }
      onReorderChannels?.(allChannelIds)
    }
  }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const [dialog, setDialog] = useState<Dialog>(null)
  const withMute = (ch: Channel): Channel => mutedChannels && ch.id in mutedChannels ? { ...ch, muted: mutedChannels[ch.id] } : ch

  // Find the "none" category ID (empty name) — only if one explicitly exists
  const noneCatId = Object.keys(catNames).find((id) => catNames[id] === "") ?? ""

  // Initial load / server switch — render skeleton so the sidebar holds its
  // width and rhythm instead of collapsing to an empty column. Do NOT gate on
  // `catOrder.length === 0`: the tree is derived from `categories` inside a
  // useEffect (use-channel-tree.ts), so on a server switch it still holds the
  // PREVIOUS server's categories for one commit while `loading` has already
  // flipped true. Gating on catOrder would flash the old server's channel list
  // for a frame before collapsing to skeleton.
  if (loading) return <ChannelSidebarSkeleton noHeader={noHeader} />


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

  return (
    <aside className="flex min-w-0 flex-1 flex-col">
      {!noHeader && (
        <header className="flex h-12 items-center gap-1 border-b border-border/40 px-2">
          {serverName && onOpenSettings ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                <span className="truncate text-lg font-semibold">{serverName}</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={() => onOpenSettings("overview")}><Settings className="size-4" /> Overview</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings("members")}><Users className="size-4" /> Members</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings("invites")}><Link2 className="size-4" /> Invites</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings("notifications")}><Bell className="size-4" /> Notifications</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings("audit")}><ScrollText className="size-4" /> Audit Log</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="min-w-0 flex-1 truncate px-2 text-lg font-semibold">{serverName || "\u00a0"}</span>
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
      {/* right-click anywhere in the list (incl. empty space) → create channel / category */}
      <ContextMenu>
        <ContextMenuTrigger
          render={<div className="flex-1 overflow-y-auto thin-scrollbar px-2 py-4" />}
        >
          {/* one DndContext spans everything: categories sort among themselves, channels across categories */}
          <DndContext id="d-channels" sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
            {/* uncategorized channels (empty-name category) render bare at the top — no header */}
            {noneCatId && order[noneCatId]?.length > 0 && (
              <SortableContext items={order[noneCatId].map((c) => c.id)} strategy={verticalListSortingStrategy}>
                <div className="mb-4 space-y-1">
                  {order[noneCatId].map((ch) => (
                    <SortableChannel
                      key={ch.id}
                      ch={withMute(ch)}
                      active={ch.id === activeChannel}
                      canReorder={isAdmin}
                      onClick={() => setActiveChannel(ch.id)}
                      onEdit={isAdmin ? () => setDialog({ kind: "edit-channel", id: ch.id, categoryId: noneCatId, name: ch.name, type: ch.type ?? "text" }) : undefined}
                      onDelete={isAdmin ? () => { removeChannel(ch.id); onDeleteChannel?.(ch.id) } : undefined}
                    />
                  ))}
                </div>
              </SortableContext>
            )}
            <SortableContext items={catOrder.filter((id) => catNames[id] !== "").map((id) => catId(id))} strategy={verticalListSortingStrategy}>
              {catOrder.filter((id) => catNames[id] !== "").map((id) => (
                <SortableCategory
                  key={id}
                  id={catId(id)}
                  name={catNames[id] ?? id}
                  open={!collapsed.has(id)}
                  onToggle={() => toggleCat(id)}
                  onAddChannel={canCreateInCategory(id) ? () => requestCreateChannel(id) : undefined}
                  onSettings={isAdmin ? () => setDialog({ kind: "category-settings", categoryId: id }) : undefined}
                  onDelete={isAdmin ? () => { removeCategory(id); onDeleteCategory?.(id) } : undefined}
                  isPrivate={catPrivate[id]}
                  canReorder={isAdmin}
                >
                  <SortableContext items={(order[id] ?? []).map((c) => c.id)} strategy={verticalListSortingStrategy}>
                    <div className="mt-1 min-h-2 space-y-1">
                      {(order[id] ?? []).map((ch) => {
                        // Manage/edit rights:
                        //   - admins everywhere
                        //   - private category: the channel creator too
                        // Public-category channels are admin-managed only.
                        const canManageChannel = isAdmin || (!!catPrivate[id] && ch.creatorId === currentUserId)
                        return (
                          <SortableChannel
                            key={ch.id}
                            ch={withMute(ch)}
                            active={ch.id === activeChannel}
                            canReorder={isAdmin}
                            onClick={() => setActiveChannel(ch.id)}
                            onEdit={canManageChannel ? () => setDialog({ kind: "edit-channel", id: ch.id, categoryId: id, name: ch.name, type: ch.type ?? "text" }) : undefined}
                            onDelete={canManageChannel ? () => { removeChannel(ch.id); onDeleteChannel?.(ch.id) } : undefined}
                            onManageMembers={(catPrivate[id] && canManageChannel) ? () => setDialog({ kind: "manage-members", channelId: ch.id, channelName: ch.name }) : undefined}
                          />
                        )
                      })}
                    </div>
                  </SortableContext>
                </SortableCategory>
              ))}
            </SortableContext>
          </DndContext>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {isAdmin && (
            <>
              <ContextMenuItem onClick={() => requestCreateChannel(noneCatId)}>Create channel</ContextMenuItem>
              <ContextMenuItem onClick={() => setDialog({ kind: "create-category" })}>Create category</ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
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
        <ChannelMembersDialog
          channelId={dialog.channelId}
          channelName={dialog.channelName}
          serverId={serverId}
          onClose={() => setDialog(null)}
        />
      )}
    </aside>
  )
})

// Loading placeholder for the channel sidebar. Kept colocated so changes to
// row density or header height stay in sync with the live sidebar above.
function ChannelSidebarSkeleton({ noHeader }: { noHeader?: boolean }) {
  return (
    <aside className="flex min-w-0 flex-1 flex-col">
      {!noHeader && (
        <header className="flex h-12 items-center border-b border-border/40 px-2">
          <Skeleton className="h-5 w-32 rounded" />
        </header>
      )}
      <div className="flex-1 overflow-hidden px-2 py-4">
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

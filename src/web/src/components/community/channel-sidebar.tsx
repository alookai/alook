"use client"

import { useState } from "react"
import { Settings } from "lucide-react"
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { SortableCategory } from "./sortable-category"
import { SortableChannel } from "./sortable-channel"
import { CreateChannelDialog } from "./create-channel-dialog"
import { CreateCategoryDialog } from "./create-category-dialog"
import { CategorySettingsDialog } from "./category-settings-dialog"
import { catId, type ChannelTree } from "./use-channel-tree"
import type { Channel } from "./_types"

let channelSeq = 0

type Dialog =
  | { kind: "create-channel"; categoryId: string }
  | { kind: "edit-channel"; id: string; categoryId: string; name: string; type: "text" | "forum" }
  | { kind: "create-category" }
  | { kind: "category-settings"; categoryId: string }
  | null

// The channel sidebar (server view). Category/channel reorder + add/remove/rename live in
// useChannelTree. The category gear/right-click opens settings; "+" (or empty-space
// right-click) creates; channels right-click to edit/delete. A private category only
// lets admins create channels — non-admins are blocked via onBlockedCreate.
export function ChannelSidebar({
  tree, serverName, activeChannel, setActiveChannel, bordered, noHeader, onOpenSettings,
  isAdmin = true, onBlockedCreate, mutedChannels,
  onCreateChannel, onCreateCategory, onDeleteChannel, onDeleteCategory,
}: {
  tree: ChannelTree
  serverName: string
  activeChannel: string
  setActiveChannel: (id: string) => void
  bordered?: boolean
  noHeader?: boolean
  onOpenSettings?: () => void
  isAdmin?: boolean
  onBlockedCreate?: () => void
  mutedChannels?: Record<string, boolean>
  onCreateChannel?: (categoryId: string, name: string, type: "text" | "forum") => void
  onCreateCategory?: (name: string, opts?: { private?: boolean }) => void
  onDeleteChannel?: (channelId: string) => void
  onDeleteCategory?: (categoryId: string) => void
}) {
  const { collapsed, catOrder, order, catNames, catPrivate, toggleCat, addChannel, removeChannel, renameChannel, addCategory, removeCategory, setCategoryPrivate, onDragOver, onDragEnd } = tree
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const [dialog, setDialog] = useState<Dialog>(null)
  const withMute = (ch: Channel): Channel => mutedChannels && ch.id in mutedChannels ? { ...ch, muted: mutedChannels[ch.id] } : ch

  // Find the "none" category ID (empty name) — only if one explicitly exists
  const noneCatId = Object.keys(catNames).find((id) => catNames[id] === "") ?? ""

  // open the create-channel dialog, unless the category is private and the user isn't admin
  const requestCreateChannel = (categoryId: string) => {
    if (catPrivate[categoryId] && !isAdmin) { onBlockedCreate?.(); return }
    setDialog({ kind: "create-channel", categoryId })
  }

  const createChannel = (categoryId: string, { name, type }: { name: string; type: "text" | "forum" }) => {
    const ch: Channel = { id: `ch_local_${++channelSeq}`, name, active: false, unread: false, type }
    addChannel(categoryId, ch)
    setActiveChannel(ch.id)
    onCreateChannel?.(categoryId, name, type)
  }

  return (
    <aside className={`flex min-w-0 flex-1 flex-col ${bordered ? "rounded-tl-xl border-l border-t border-border" : ""}`}>
      {!noHeader && (
        <header className="flex h-12 items-center justify-between gap-2 border-b border-border px-4">
          <span className="truncate text-base font-semibold">{serverName || "\u00a0"}</span>
          {serverName && (
            <button onClick={onOpenSettings} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Server settings">
              <Settings className="size-4" />
            </button>
          )}
        </header>
      )}
      {/* right-click anywhere in the list (incl. empty space) → create channel / category */}
      <ContextMenu>
        <ContextMenuTrigger
          render={<div className="flex-1 overflow-y-auto thin-scrollbar px-2 py-3" />}
        >
          {/* one DndContext spans everything: categories sort among themselves, channels across categories */}
          <DndContext id="d-channels" sensors={sensors} collisionDetection={closestCenter} onDragOver={onDragOver} onDragEnd={onDragEnd}>
            {/* uncategorized channels (empty-name category) render bare at the top — no header */}
            {noneCatId && order[noneCatId]?.length > 0 && (
              <SortableContext items={order[noneCatId].map((c) => c.id)} strategy={verticalListSortingStrategy}>
                <div className="mb-4 space-y-0.5">
                  {order[noneCatId].map((ch) => (
                    <SortableChannel
                      key={ch.id}
                      ch={withMute(ch)}
                      active={ch.id === activeChannel}
                      onClick={() => setActiveChannel(ch.id)}
                      onEdit={() => setDialog({ kind: "edit-channel", id: ch.id, categoryId: noneCatId, name: ch.name, type: ch.type ?? "text" })}
                      onDelete={() => { removeChannel(ch.id); onDeleteChannel?.(ch.id) }}
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
                  onAddChannel={() => requestCreateChannel(id)}
                  onSettings={() => setDialog({ kind: "category-settings", categoryId: id })}
                  onDelete={() => { removeCategory(id); onDeleteCategory?.(id) }}
                  isPrivate={catPrivate[id]}
                >
                  <SortableContext items={(order[id] ?? []).map((c) => c.id)} strategy={verticalListSortingStrategy}>
                    <div className="mt-0.5 min-h-2 space-y-0.5">
                      {(order[id] ?? []).map((ch) => (
                        <SortableChannel
                          key={ch.id}
                          ch={withMute(ch)}
                          active={ch.id === activeChannel}
                          onClick={() => setActiveChannel(ch.id)}
                          onEdit={() => setDialog({ kind: "edit-channel", id: ch.id, categoryId: id, name: ch.name, type: ch.type ?? "text" })}
                          onDelete={() => { removeChannel(ch.id); onDeleteChannel?.(ch.id) }}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </SortableCategory>
              ))}
            </SortableContext>
          </DndContext>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={() => requestCreateChannel(noneCatId)}>Create Channel</ContextMenuItem>
          <ContextMenuItem onClick={() => setDialog({ kind: "create-category" })}>Create Category</ContextMenuItem>
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
          onCreate={({ name }) => renameChannel(dialog.id, name)}
        />
      )}
      {dialog?.kind === "create-category" && (
        <CreateCategoryDialog
          onClose={() => setDialog(null)}
          onCreate={(name, opts) => { addCategory(name, opts); onCreateCategory?.(name, opts) }}
        />
      )}
      {dialog?.kind === "category-settings" && (
        <CategorySettingsDialog
          name={catNames[dialog.categoryId] ?? ""}
          isPrivate={!!catPrivate[dialog.categoryId]}
          onClose={() => setDialog(null)}
          onSave={(priv) => setCategoryPrivate(dialog.categoryId, priv)}
        />
      )}
    </aside>
  )
}

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { arrayMove } from "@dnd-kit/sortable"
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core"
import type { CommunityFolder } from "./_types"

export const FOLDER_PREFIX = "folder:"
export function folderId(id: string) { return `${FOLDER_PREFIX}${id}` }
export function isFolderKey(key: string) { return key.startsWith(FOLDER_PREFIX) }
export function extractFolderId(key: string) { return key.slice(FOLDER_PREFIX.length) }

type Callbacks = {
  onReorderRail?: (serverIds: string[]) => void
  onReorderFolders?: (folderIds: string[]) => void
  onFolderItemsChange?: (folderId: string, serverIds: string[]) => void
  onCreateFolder?: (serverIdA: string, serverIdB: string) => void
}

const GROUP_DELAY = 300

/**
 * Multi-folder rail order hook.
 *
 * Rail order is a flat list of server ids and folder keys (folder:{id}).
 * Each folder can be open/closed independently.
 * When open, folder's servers are rendered inline after the folder key.
 */
export function useRailOrder(
  railServerIds: string[],
  folders: CommunityFolder[],
  callbacks?: Callbacks,
) {
  // Build initial rail order: servers not in any folder + folder keys sorted by position
  const folderServerSet = useRef(new Set<string>())
  const buildRailOrder = useCallback(() => {
    const inFolder = new Set(folders.flatMap((f) => f.servers.map((s) => s.id)))
    folderServerSet.current = inFolder
    const serverItems = railServerIds.filter((id) => !inFolder.has(id))
    // Copy before sort — `folders` may be a frozen fallback while the query
    // is loading; mutating it in place would throw.
    const folderItems = [...folders].sort((a, b) => a.position - b.position).map((f) => folderId(f.id))
    return [...serverItems, ...folderItems]
  }, [railServerIds, folders])

  const [railOrder, setRailOrder] = useState<string[]>(buildRailOrder)
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const [groupTarget, setGroupTarget] = useState<string | null>(null)

  // Restore open state from sessionStorage after hydration, then persist changes
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true
      try {
        const saved = sessionStorage.getItem("rail-open-folders")
        if (saved) {
          const ids = JSON.parse(saved) as string[]
          if (ids.length > 0) setOpenFolders(new Set(ids))
        }
      } catch { /* ignore */ }
      return
    }
    sessionStorage.setItem("rail-open-folders", JSON.stringify([...openFolders]))
  }, [openFolders])

  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null)
  const hoverTargetRef = useRef<string | null>(null)
  const groupTargetRef = useRef<string | null>(null)
  useEffect(() => { groupTargetRef.current = groupTarget }, [groupTarget])

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
    hoverTargetRef.current = null
  }, [])

  // Folder internal orders (folderId → serverId[])
  const [folderOrders, setFolderOrders] = useState<Map<string, string[]>>(() => {
    const m = new Map<string, string[]>()
    for (const f of folders) m.set(f.id, f.servers.map((s) => s.id))
    return m
  })

  // Refs for sync reads during drag
  const railOrderRef = useRef(railOrder)
  useEffect(() => { railOrderRef.current = railOrder }, [railOrder])
  const folderOrdersRef = useRef(folderOrders)
  useEffect(() => { folderOrdersRef.current = folderOrders }, [folderOrders])

  // Sync from props
  const prevRailRef = useRef(railServerIds)
  const prevFoldersRef = useRef(folders)
  useEffect(() => {
    const pr = prevRailRef.current
    const pf = prevFoldersRef.current
    prevRailRef.current = railServerIds
    prevFoldersRef.current = folders

    const inFolder = new Set(folders.flatMap((f) => f.servers.map((s) => s.id)))
    folderServerSet.current = inFolder

    // Sync rail order: keep existing order, remove deleted, add new
    const prJoin = pr.join(",")
    const curJoin = railServerIds.join(",")
    const pfIds = pf.map((f) => f.id).join(",")
    const curFIds = folders.map((f) => f.id).join(",")

    if (prJoin !== curJoin || pfIds !== curFIds) {
      setRailOrder((current) => {
        const validServers = new Set(railServerIds.filter((id) => !inFolder.has(id)))
        const validFolderKeys = new Set(folders.map((f) => folderId(f.id)))
        const validSet = new Set([...validServers, ...validFolderKeys])

        // Keep existing items that are still valid
        const kept = current.filter((id) => validSet.has(id))
        const keptSet = new Set(kept)

        // Add new servers/folders not in current order
        const added = [...validSet].filter((id) => !keptSet.has(id))
        return [...kept, ...added]
      })
    }

    // Sync folder internal orders
    if (pfIds !== curFIds || pf.some((f, i) => {
      const cur = folders[i]
      return !cur || f.servers.map((s) => s.id).join(",") !== cur.servers.map((s) => s.id).join(",")
    })) {
      setFolderOrders((current) => {
        const next = new Map(current)
        for (const f of folders) {
          const propIds = f.servers.map((s) => s.id)
          const existing = next.get(f.id)
          if (!existing) {
            next.set(f.id, propIds)
          } else {
            // Keep order of existing, remove deleted, add new
            const propSet = new Set(propIds)
            const kept = existing.filter((id) => propSet.has(id))
            const keptSet = new Set(kept)
            const added = propIds.filter((id) => !keptSet.has(id))
            next.set(f.id, [...kept, ...added])
          }
        }
        // Remove folders no longer in props
        const validIds = new Set(folders.map((f) => f.id))
        for (const key of next.keys()) {
          if (!validIds.has(key)) next.delete(key)
        }
        return next
      })
    }
  }, [railServerIds, folders])

  // Which folder does a server id belong to?
  const getServerFolder = useCallback((serverId: string): string | null => {
    for (const [fId, ids] of folderOrdersRef.current) {
      if (ids.includes(serverId)) return fId
    }
    return null
  }, [])

  // --- Drag handlers ---

  const [reopenAfterDrag, setReopenAfterDrag] = useState<string | null>(null)

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id)
    // If dragging an open folder, close it temporarily
    if (isFolderKey(id) && openFolders.has(extractFolderId(id))) {
      setReopenAfterDrag(extractFolderId(id))
      setOpenFolders((s) => { const n = new Set(s); n.delete(extractFolderId(id)); return n })
    }
  }

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e
    if (!over) { clearHoverTimer(); setGroupTarget(null); return }
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) { clearHoverTimer(); setGroupTarget(null); return }

    const activeInRail = railOrderRef.current.includes(activeId)
    const overInRail = railOrderRef.current.includes(overId)
    const activeFolder = getServerFolder(activeId)
    const overFolder = getServerFolder(overId)

    // Rail server dragged over a folder server → move into that folder
    if (activeInRail && !isFolderKey(activeId) && overFolder) {
      const newRail = railOrderRef.current.filter((id) => id !== activeId)
      railOrderRef.current = newRail
      setRailOrder(newRail)
      setFolderOrders((m) => {
        const next = new Map(m)
        const arr = [...(next.get(overFolder) ?? [])]
        if (!arr.includes(activeId)) {
          const idx = arr.indexOf(overId)
          arr.splice(idx >= 0 ? idx : arr.length, 0, activeId)
        }
        next.set(overFolder, arr)
        return next
      })
      folderOrdersRef.current = new Map(folderOrdersRef.current).set(overFolder, [...(folderOrdersRef.current.get(overFolder) ?? []), activeId])
      clearHoverTimer(); setGroupTarget(null)
      return
    }

    // Folder server dragged over a rail item → move out of folder
    if (activeFolder && overInRail && !isFolderKey(overId)) {
      setFolderOrders((m) => {
        const next = new Map(m)
        next.set(activeFolder, (next.get(activeFolder) ?? []).filter((id) => id !== activeId))
        return next
      })
      const newRail = [...railOrderRef.current]
      if (!newRail.includes(activeId)) {
        const idx = newRail.indexOf(overId)
        newRail.splice(idx >= 0 ? idx : newRail.length, 0, activeId)
      }
      railOrderRef.current = newRail
      setRailOrder(newRail)
      clearHoverTimer(); setGroupTarget(null)
      return
    }

    // Rail server dragged over a folder key → move into that folder
    if (activeInRail && !isFolderKey(activeId) && isFolderKey(overId)) {
      const targetFId = extractFolderId(overId)
      const newRail = railOrderRef.current.filter((id) => id !== activeId)
      railOrderRef.current = newRail
      setRailOrder(newRail)
      setFolderOrders((m) => {
        const next = new Map(m)
        const arr = [...(next.get(targetFId) ?? [])]
        if (!arr.includes(activeId)) arr.push(activeId)
        next.set(targetFId, arr)
        return next
      })
      clearHoverTimer(); setGroupTarget(null)
      return
    }

    // Group-create hover: rail server onto another rail server (both not in folders, no folder keys)
    if (activeInRail && overInRail && !isFolderKey(activeId) && !isFolderKey(overId)) {
      if (hoverTargetRef.current === overId) return
      clearHoverTimer()
      setGroupTarget(null)
      hoverTargetRef.current = overId
      hoverTimerRef.current = setTimeout(() => {
        setGroupTarget(overId)
        groupTargetRef.current = overId
      }, GROUP_DELAY)
      return
    }

    clearHoverTimer()
    if (groupTarget) setGroupTarget(null)
  }

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    clearHoverTimer()
    const pendingGroup = groupTargetRef.current
    setGroupTarget(null)

    if (reopenAfterDrag) {
      setOpenFolders((s) => new Set(s).add(reopenAfterDrag))
      setReopenAfterDrag(null)
    }

    if (!over || active.id === over.id) {
      persistState()
      return
    }

    const activeId = String(active.id)
    const overId = String(over.id)

    // Folder group creation
    if (pendingGroup && pendingGroup === overId && callbacks?.onCreateFolder) {
      callbacks.onCreateFolder(activeId, overId)
      return
    }

    // Within-rail reorder
    const endActiveInRail = railOrderRef.current.includes(activeId)
    const endOverInRail = railOrderRef.current.includes(overId)
    if (endActiveInRail && endOverInRail) {
      const from = railOrderRef.current.indexOf(activeId)
      const to = railOrderRef.current.indexOf(overId)
      if (from !== -1 && to !== -1) {
        const newRail = arrayMove(railOrderRef.current, from, to)
        railOrderRef.current = newRail
        setRailOrder(newRail)
      }
    }

    // Within same folder reorder
    const activeFolder = getServerFolder(activeId)
    const overFolder = getServerFolder(overId)
    if (activeFolder && activeFolder === overFolder) {
      setFolderOrders((m) => {
        const next = new Map(m)
        const arr = [...(next.get(activeFolder) ?? [])]
        const from = arr.indexOf(activeId)
        const to = arr.indexOf(overId)
        if (from !== -1 && to !== -1) {
          next.set(activeFolder, arrayMove(arr, from, to))
        }
        return next
      })
    }

    persistState()
  }

  // Persist to callbacks
  const prevPersistedRailRef = useRef<string[]>([])
  const prevPersistedFoldersRef = useRef<Map<string, string[]>>(new Map())

  const persistState = useCallback(() => {
    const rail = railOrderRef.current
    const serverIds = rail.filter((id) => !isFolderKey(id))
    const folderKeys = rail.filter((id) => isFolderKey(id)).map(extractFolderId)

    // Persist rail server order
    if (serverIds.join(",") !== prevPersistedRailRef.current.join(",")) {
      prevPersistedRailRef.current = serverIds
      callbacks?.onReorderRail?.(serverIds)
    }

    // Persist folder order in rail
    if (folderKeys.length > 0) {
      callbacks?.onReorderFolders?.(folderKeys)
    }

    // Persist each folder's internal order
    for (const [fId, order] of folderOrdersRef.current) {
      const prev = prevPersistedFoldersRef.current.get(fId)
      if (!prev || prev.join(",") !== order.join(",")) {
        prevPersistedFoldersRef.current.set(fId, order)
        callbacks?.onFolderItemsChange?.(fId, order)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Build visible items
  const visibleItems: string[] = []
  const seen = new Set<string>()
  for (const id of railOrder) {
    if (seen.has(id)) continue
    seen.add(id)
    visibleItems.push(id)
    if (isFolderKey(id) && openFolders.has(extractFolderId(id))) {
      const fId = extractFolderId(id)
      const order = folderOrders.get(fId) ?? []
      for (const sid of order) {
        if (seen.has(sid)) continue
        seen.add(sid)
        visibleItems.push(sid)
      }
    }
  }

  const toggleFolder = useCallback((fId: string) => {
    setOpenFolders((s) => {
      const next = new Set(s)
      if (next.has(fId)) next.delete(fId)
      else next.add(fId)
      return next
    })
  }, [])

  return {
    visibleItems,
    sortableIds: visibleItems,
    openFolders,
    toggleFolder,
    folderOrders,
    onDragStart,
    onDragOver,
    onDragEnd,
    groupTarget,
  }
}

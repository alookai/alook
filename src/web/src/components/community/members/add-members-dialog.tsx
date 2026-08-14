"use client"

import type React from "react"
import { useMemo, useState } from "react"
import { Search, Loader2 } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Avatar } from "../avatar"
import { displayName } from "@/lib/community/display-name"
import { toastApiError } from "@/lib/api/client"

export type AddableCandidate = {
  userId: string
  name: string | null
  avatar: string
}

/**
 * A single candidate row with its own in-flight state. Exported so the
 * spinner-vs-"Add" + disabled behaviour is unit-testable without mounting the
 * Portal-rendered Dialog (the node test env's `renderToStaticMarkup` doesn't
 * render portal children).
 */
export function AddMemberRow({
  candidate,
  adding,
  onAdd,
}: {
  candidate: AddableCandidate
  adding: boolean
  onAdd: (userId: string) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40">
      <Avatar label={candidate.avatar || candidate.name || ""} seed={candidate.userId} size={32} />
      <div className="min-w-0 flex-1 truncate text-sm font-medium">{displayName(candidate)}</div>
      <Button size="sm" disabled={adding} onClick={() => onAdd(candidate.userId)}>
        {adding ? <Loader2 className="size-4 animate-spin" /> : "Add"}
      </Button>
    </div>
  )
}

/**
 * Drive one add through its in-flight lifecycle: mark the id in flight, await
 * the caller's `onAdd`, and toast on failure. Exported for unit-testing the
 * reject path without React.
 *
 * On SUCCESS the id is intentionally kept in flight: `onAdd`'s mutation resolves
 * before its candidate-pool refetch lands, so clearing here would flash the
 * button back to "Add" for a frame before the row unmounts. Keeping the spinner
 * until the row leaves the list is seamless. On FAILURE the id is cleared so the
 * row reverts to a clickable "Add" for retry.
 */
export async function runAdd(
  userId: string,
  onAdd: (userId: string) => Promise<unknown> | void,
  setAddingIds: React.Dispatch<React.SetStateAction<Set<string>>>,
): Promise<void> {
  setAddingIds((s) => new Set(s).add(userId))
  try {
    await onAdd(userId)
  } catch (err) {
    toastApiError(err, "Couldn't add member")
    setAddingIds((s) => {
      const next = new Set(s)
      next.delete(userId)
      return next
    })
  }
}

/**
 * Shared "add members" picker for every private unit — a channel/post roster or
 * a thread participant set. Pure add: the current-member list and its
 * leave/remove controls live in the Members drawer's row right-click menu
 * (`MemberList` `manageContext`), not here.
 *
 * The caller resolves the candidate pool (server members not in a channel, or
 * parent-channel members not yet participating) and supplies `onAdd`.
 */
export function AddMembersDialog({
  title,
  subtitle,
  candidates,
  onAdd,
  onClose,
}: {
  title: string
  subtitle: string
  candidates: AddableCandidate[]
  onAdd: (userId: string) => Promise<unknown> | void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  // In-flight adds, keyed by userId — each row spins independently, so adding
  // multiple people in a row doesn't disable the others.
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((m) => (m.name ?? "").toLowerCase().includes(q))
  }, [candidates, query])

  const add = (userId: string) => void runAdd(userId, onAdd, setAddingIds)

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[80vh] w-full flex-col gap-0 p-0 sm:max-w-md">
        <header className="border-b border-border/50 px-4 py-3">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar px-2 py-2">
          <label className="relative mx-2 mb-2 block">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members"
              className="pl-9"
            />
          </label>
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {query ? "No matches." : "Everyone is already here."}
            </p>
          ) : (
            filtered.map((m) => (
              <AddMemberRow
                key={m.userId}
                candidate={m}
                adding={addingIds.has(m.userId)}
                onAdd={add}
              />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

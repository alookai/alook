"use client"

import { useMemo, useState } from "react"
import { Search } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Avatar } from "./avatar"
import { displayName } from "@/lib/community/display-name"

export type AddableCandidate = {
  userId: string
  name: string | null
  avatar: string
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
  addPending,
  onAdd,
  onClose,
}: {
  title: string
  subtitle: string
  candidates: AddableCandidate[]
  addPending: boolean
  onAdd: (userId: string) => Promise<void> | void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((m) => (m.name ?? "").toLowerCase().includes(q))
  }, [candidates, query])

  const add = async (userId: string) => {
    try {
      await onAdd(userId)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't add member")
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[80vh] w-full flex-col gap-0 p-0 sm:max-w-md">
        <header className="border-b border-border px-4 py-3">
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
              <div key={m.userId} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40">
                <Avatar label={m.avatar || m.name || ""} seed={m.userId} size={32} />
                <div className="min-w-0 flex-1 truncate text-sm font-medium">{displayName(m)}</div>
                <Button size="sm" disabled={addPending} onClick={() => add(m.userId)}>
                  Add
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

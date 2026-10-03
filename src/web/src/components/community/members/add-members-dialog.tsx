"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import type { MemberOriginalView } from "./member-management-types"
import type React from "react"
import { useMemo } from "react"
import { Search, Loader2 } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Avatar } from "../avatar"
import {
  PeoplePickerBody,
  PeoplePickerHeader,
  PeoplePickerRowsSkeleton,
  resolvePeoplePickerViewState,
  type PeoplePickerAsyncState,
} from "../people-picker"
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
  scopeId = "members",
  title,
  subtitle,
  candidates,
  queryState,
  onAdd,
  onClose,
}: {
  scopeId?: string
  title: string
  subtitle: string
  candidates: AddableCandidate[]
  queryState: PeoplePickerAsyncState
  onAdd: (userId: string, assert?: MemberOriginalView) => Promise<unknown> | void
  onClose: () => void
}) {
  const client = useQueryClient()
  const source = useCommunityViewSource("add-members:" + scopeId)
  const key = ["community", "member-picker", scopeId]
  type Intent = { userId: string; candidate: AddableCandidate; assert: ReturnType<typeof source.capture> }
  const command = useMutation({
    mutationKey: key,
    gcTime: 0,
    mutationFn: async ({ userId, assert }: Intent) => { assert(); await onAdd(userId, assert); assert() },
    onError: (error, intent) => toastApiError(error, "Couldn't add member", intent.assert),
  })
  const [query, setQuery] = useAtom(useCreateAtom(""))
  // In-flight adds, keyed by userId — each row spins independently, so adding
  // multiple people in a row doesn't disable the others.
  const attempts = useMutationState({ filters: { mutationKey: key }, select: (mutation) => ({ intent: mutation.state.variables as Intent | undefined, status: mutation.state.status }) })
  const addingIds = new Set(attempts.filter((attempt) => attempt.intent?.assert.signal === source.signal && (attempt.status === "pending" || attempt.status === "success")).map((attempt) => attempt.intent!.userId))
  const visibleCandidates = useMemo(() => {
    const rows = new Map(candidates.map((candidate) => [candidate.userId, candidate]))
    for (const { intent, status } of attempts) {
      if (status === "pending" && intent?.assert.signal === source.signal && intent.candidate && !rows.has(intent.userId)) {
        rows.set(intent.userId, intent.candidate)
      }
    }
    return [...rows.values()]
  }, [candidates, attempts, source.signal])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return visibleCandidates
    return visibleCandidates.filter((m) => (m.name ?? "").toLowerCase().includes(q))
  }, [visibleCandidates, query])

  const pickerState = resolvePeoplePickerViewState({
    resolved: queryState.resolved,
    loading: queryState.loading,
    error: queryState.error,
    sourceCount: visibleCandidates.length,
    visibleCount: filtered.length,
    query,
  })

  const add = (userId: string) => {
    const candidate = candidates.find((row) => row.userId === userId)
    if (!candidate) return
    const assert = source.capture()
    const attempts = client.getMutationCache().findAll({ mutationKey: key })
    if (attempts.some((mutation) => { const intent = mutation.state.variables as Intent | undefined; return intent?.userId === userId && intent.assert.signal === assert.signal && (mutation.state.status === "pending" || mutation.state.status === "success") })) return
    command.mutate({ userId, candidate: { ...candidate }, assert })
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) { source.retire(); onClose() } }}>
      <DialogContent className="flex max-h-[80vh] w-full flex-col gap-0 p-0 sm:max-w-md">
        <PeoplePickerHeader title={title} subtitle={subtitle} />

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
          <PeoplePickerBody
            state={pickerState}
            loading={<PeoplePickerRowsSkeleton actionClassName="w-14" />}
            errorMessage="Couldn't load people."
            emptyMessage="Everyone is already here."
            retrying={queryState.retrying}
            onRetry={() => { source.capture()(); queryState.retry?.() }}
          >
            {filtered.map((m) => (
              <AddMemberRow
                key={m.userId}
                candidate={m}
                adding={addingIds.has(m.userId)}
                onAdd={add}
              />
            ))}
          </PeoplePickerBody>
        </div>
      </DialogContent>
    </Dialog>
  )
}

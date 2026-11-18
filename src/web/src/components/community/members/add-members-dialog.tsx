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
  disabled = false,
  onAdd,
}: {
  candidate: AddableCandidate
  adding: boolean
  disabled?: boolean
  onAdd: (userId: string) => void
}) {
  return (
    <div
      data-slot="people-picker-row"
      className="flex items-center gap-3.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-accent/40"
    >
      <Avatar
        label={candidate.avatar || candidate.name || ""}
        seed={candidate.userId}
        size={38}
        ringColor="var(--tn-sticker-face, var(--popover))"
      />
      <div className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em]">
        {displayName(candidate)}
      </div>
      <Button size="sm" disabled={adding || disabled} onClick={() => onAdd(candidate.userId)}>
        {adding ? <Loader2 className="size-4 animate-spin" /> : "Add"}
      </Button>
    </div>
  )
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
  const command = useMutation({ meta: { observabilityAction: "channel.members.add" },
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
    error: queryState.error,
    sourceCount: visibleCandidates.length,
    visibleCount: filtered.length,
    query,
  })

  const add = (userId: string) => {
    if (queryState.actionable === false) return
    const candidate = candidates.find((row) => row.userId === userId)
    if (!candidate) return
    const assert = source.capture()
    const attempts = client.getMutationCache().findAll({ mutationKey: key })
    if (attempts.some((mutation) => { const intent = mutation.state.variables as Intent | undefined; return intent?.userId === userId && intent.assert.signal === assert.signal && (mutation.state.status === "pending" || mutation.state.status === "success") })) return
    command.mutate({ userId, candidate: { ...candidate }, assert })
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) { source.retire(); onClose() } }}>
      <DialogContent
        data-own-padding=""
        className="flex h-[max(75%,min(32rem,calc(100%-2rem)))] max-h-[calc(100%-2rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-120"
      >
        <PeoplePickerHeader title={title} subtitle={subtitle} />

        <div className="px-5 pt-3 pb-2">
          <label className="relative block">
            <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members"
              className="h-10 rounded-xl pl-9.5 text-sm"
            />
          </label>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto thin-scrollbar px-2 pt-1.5 pb-4">
          <PeoplePickerBody
            state={pickerState}
            loading={<PeoplePickerRowsSkeleton actionClassName="w-14" />}
            errorMessage="Couldn't load people."
            emptyMessage="Everyone is already here."
            retrying={queryState.retrying}
            refreshFailed={queryState.resolved && queryState.error}
            onRetry={() => { source.capture()(); queryState.retry?.() }}
          >
            <div className="flex flex-col gap-0.5">
              {filtered.map((m) => (
                <AddMemberRow
                  key={m.userId}
                  candidate={m}
                  adding={addingIds.has(m.userId)}
                  disabled={queryState.actionable === false}
                  onAdd={add}
                />
              ))}
            </div>
          </PeoplePickerBody>
        </div>
      </DialogContent>
    </Dialog>
  )
}

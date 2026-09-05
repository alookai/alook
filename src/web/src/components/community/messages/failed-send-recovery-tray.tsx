"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Check, Copy, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  COMMUNITY_REPLICA_INTENTS_CHANGED_EVENT,
  dismissCommunityReplicaIntent,
  listCommunityReplicaIntents,
  type ReplicaIntentRow,
} from "@/lib/community/replica/store"

type RecoveryRow = ReplicaIntentRow & {
  outcome: Extract<NonNullable<ReplicaIntentRow["outcome"]>, { status: "rejected" }>
}

function isPermissionRecovery(row: ReplicaIntentRow): row is RecoveryRow {
  return row.state === "canonical-rejected"
    && row.outcome?.status === "rejected"
    && row.outcome.code === "permission-denied"
}

export function FailedSendRecoveryTray({ accountId }: { accountId: string }) {
  const [rows, setRows] = useState<RecoveryRow[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const load = useCallback(() => {
    void listCommunityReplicaIntents(accountId)
      .then((intents) => setRows(intents.filter(isPermissionRecovery)))
      .catch(() => undefined)
  }, [accountId])

  useEffect(() => {
    load()
    if (typeof window === "undefined") return
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId?: string }>).detail
      if (!detail?.accountId || detail.accountId === accountId) load()
    }
    window.addEventListener(COMMUNITY_REPLICA_INTENTS_CHANGED_EVENT, onChanged)
    window.addEventListener("pageshow", load)
    return () => {
      window.removeEventListener(COMMUNITY_REPLICA_INTENTS_CHANGED_EVENT, onChanged)
      window.removeEventListener("pageshow", load)
    }
  }, [accountId, load])

  const visible = useMemo(() => rows.slice(0, 3), [rows])
  if (visible.length === 0) return null

  return (
    <aside
      aria-label="Unsent messages"
      className="fixed inset-x-3 bottom-3 z-50 ml-auto flex max-w-md flex-col gap-2 sm:left-auto sm:w-[24rem]"
    >
      {visible.map((row) => (
        <div
          key={row.intentId}
          className="rounded-xl border bg-background/95 p-3 text-sm text-foreground shadow-lg backdrop-blur-sm"
          role="alert"
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">Message not sent</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                You lost access to the channel. Your text is still available here.
              </p>
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap wrap-break-word rounded-md bg-muted/60 px-2 py-1.5 text-xs">
                {row.intent.payload.content}
              </p>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="-mr-1 -mt-1 size-8 shrink-0"
              aria-label="Dismiss unsent message"
              onClick={() => {
                void dismissCommunityReplicaIntent(accountId, row.intentId).then(() => {
                  setRows((current) => current.filter((item) => item.intentId !== row.intentId))
                }).catch(() => toast.error("Could not dismiss message"))
              }}
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mt-2 h-8 gap-1.5"
            onClick={() => {
              void navigator.clipboard.writeText(row.intent.payload.content).then(() => {
                setCopiedId(row.intentId)
              }).catch(() => toast.error("Copy failed"))
            }}
          >
            {copiedId === row.intentId
              ? <Check aria-hidden="true" className="size-3.5" />
              : <Copy aria-hidden="true" className="size-3.5" />}
            {copiedId === row.intentId ? "Copied" : "Copy text"}
          </Button>
        </div>
      ))}
    </aside>
  )
}

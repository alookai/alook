"use client"

import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { BillingSummarySchema, BillingRedirectResponseSchema } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

export type BillingReturn = "checkout" | "cancel" | "portal" | null
type BillingAction = { kind: "checkout"; priceId: string; founderAcknowledged?: boolean } | { kind: "portal"; priceId?: string }

export function readBillingReturn(value: string | null): BillingReturn {
  return value === "checkout" || value === "cancel" || value === "portal" ? value : null
}

export function useBilling(returnFrom: BillingReturn = null, enabled = false) {
  const qc = useQueryClient()
  const [polling, setPolling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const actionLock = useRef(false)
  const [redirecting, setRedirecting] = useState(false)
  const observedPlan = useRef<string | null>(null)
  const returnStartedAt = useRef(0)
  const handledReturn = useRef<BillingReturn>(null)
  const returnPollingComplete = useRef(false)
  const query = useQuery({
    queryKey: communityKeys.billing(),
    enabled,
    queryFn: async ({ signal }) => BillingSummarySchema.parse(
      await apiFetch<unknown>("/api/community/billing", { signal }),
    ),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: polling ? 2_000 : false,
    retry: false,
  })

  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      actionLock.current = false
      setRedirecting(false)
      if (enabled) {
        void qc.invalidateQueries({ queryKey: communityKeys.billing() })
        void qc.invalidateQueries({ queryKey: communityKeys.bots() })
        void qc.invalidateQueries({ queryKey: communityKeys.machines() })
      }
    }
    window.addEventListener("pageshow", restore)
    return () => window.removeEventListener("pageshow", restore)
  }, [enabled, qc])

  useEffect(() => {
    if (!returnFrom) {
      handledReturn.current = null
      setPolling(false)
      return
    }
    if (!enabled) {
      setPolling(false)
      return
    }
    if (handledReturn.current === returnFrom) {
      if (!returnPollingComplete.current && returnFrom !== "cancel" && Date.now() - returnStartedAt.current < 30_000) setPolling(true)
      return
    }
    handledReturn.current = returnFrom
    returnPollingComplete.current = false
    returnStartedAt.current = Date.now()
    void qc.invalidateQueries({ queryKey: communityKeys.billing() })
    void qc.invalidateQueries({ queryKey: communityKeys.bots() })
    void qc.invalidateQueries({ queryKey: communityKeys.machines() })
    if (returnFrom === "cancel") return
    setPolling(true)
  }, [enabled, returnFrom, qc])

  useEffect(() => {
    if (!enabled || !polling) return
    const remaining = Math.max(0, 30_000 - (Date.now() - returnStartedAt.current))
    const timer = setTimeout(() => {
      returnPollingComplete.current = true
      setPolling(false)
    }, remaining)
    return () => clearTimeout(timer)
  }, [enabled, polling])

  useEffect(() => {
    if (!enabled || !query.data) return
    const projection = `${query.data.plan.id}:${query.data.isFounder}`
    const cachedBots = qc.getQueryData<{ plan: { id: string }; isFounder: boolean }>(communityKeys.bots())
    const previous = observedPlan.current ?? (cachedBots ? `${cachedBots.plan.id}:${cachedBots.isFounder}` : null)
    if (previous !== null && previous !== projection) {
      void qc.invalidateQueries({ queryKey: communityKeys.bots() })
      void qc.invalidateQueries({ queryKey: communityKeys.machines() })
    }
    observedPlan.current = projection
    if (
      returnFrom === "checkout" && !query.data.isFounder && query.dataUpdatedAt >= returnStartedAt.current &&
      query.data.subscription?.status === "active" &&
      query.data.subscription.plan.id === query.data.plan.id
    ) {
      returnPollingComplete.current = true
      setPolling(false)
    }
  }, [enabled, returnFrom, query.data, query.dataUpdatedAt, qc])

  const redirect = useMutation({
    mutationFn: async (action: BillingAction) => {
      const result = BillingRedirectResponseSchema.parse(await apiFetch<unknown>(
        `/api/community/billing/${action.kind}`,
        {
          method: "POST",
          ...(action.priceId ? { body: JSON.stringify({ priceId: action.priceId, ...(action.kind === "checkout" && action.founderAcknowledged ? { founderAcknowledged: true } : {}) }) } : {}),
        },
      ))
      const url = new URL(result.url)
      if (url.protocol !== "https:") throw new Error("INVALID_BILLING_URL")
      return url.href
    },
    retry: false,
  })

  const start = async (action: BillingAction) => {
    if (actionLock.current || !query.data) return
    if (query.data.isFounder && (action.kind !== "checkout" || !action.founderAcknowledged)) return
    actionLock.current = true
    setActionError(null)
    try {
      const url = await redirect.mutateAsync(action)
      setRedirecting(true)
      window.location.assign(url)
    } catch {
      actionLock.current = false
      setRedirecting(false)
      setActionError(action.kind === "checkout"
        ? "Couldn't open checkout. Try again to resume your purchase."
        : "Couldn't open billing management. Try again.")
      void query.refetch()
    }
  }

  const cancelChangeMutation = useMutation({
    mutationFn: async () => BillingSummarySchema.parse(await apiFetch<unknown>(
      "/api/community/billing/cancel-change", { method: "POST" },
    )),
    retry: false,
  })

  const cancelChange = async () => {
    if (actionLock.current || !query.data?.subscription?.scheduledChange || query.data.isFounder) return
    actionLock.current = true
    setActionError(null)
    try {
      const summary = await cancelChangeMutation.mutateAsync()
      await qc.cancelQueries({ queryKey: communityKeys.billing() })
      qc.setQueryData(communityKeys.billing(), summary)
    } catch {
      setActionError("Couldn't cancel the scheduled plan change. Refresh status and try again.")
      void query.refetch()
    } finally {
      actionLock.current = false
    }
  }

  const refresh = () => {
    void query.refetch()
    void qc.invalidateQueries({ queryKey: communityKeys.bots() })
    void qc.invalidateQueries({ queryKey: communityKeys.machines() })
  }

  return {
    ...query,
    returnFrom,
    polling,
    actionError,
    isBusy: redirect.isPending || redirecting || cancelChangeMutation.isPending,
    isCancelingChange: cancelChangeMutation.isPending,
    cancelChange,
    checkout: (priceId: string, founderAcknowledged = false) => start({ kind: "checkout", priceId, founderAcknowledged }),
    portal: (priceId?: string) => start({ kind: "portal", priceId }),
    refresh,
  }
}

export type BillingController = ReturnType<typeof useBilling>

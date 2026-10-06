"use client"

import { useObservedQueryRegion } from "@/lib/observability/query-regions"
import { emitTelemetry } from "@/lib/observability/telemetry"
import { useEffect, useLayoutEffect, useCallback, useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { BillingSummarySchema, BillingRedirectResponseSchema } from "@alook/shared"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCreateStore, useSelector } from "@tanstack/react-store"
import { applicationKey, captureApplicationOwner, assertApplicationOwner, invalidateApplicationAuthentication, type ApplicationOwner } from "@/lib/application-owner"
import { isAbortError } from "@/lib/errors"
import { apiFetch, type ApiRequestOptions } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { toAnalyticsPlanId, trackBeginCheckout, type BillingEntryPoint } from "@/lib/analytics"
import { stripeAmountToMajorUnit } from "@/lib/billing/currency"

export type BillingReturn = "checkout" | "cancel" | "portal" | null
type BillingAction = {
  kind: "checkout"
  priceId: string
  founderAcknowledged: boolean
  entryPoint: BillingEntryPoint
} | { kind: "portal"; priceId?: string }

export function readBillingReturn(value: string | null): BillingReturn {
  return value === "checkout" || value === "cancel" || value === "portal" ? value : null
}

export function useBilling(returnFrom: BillingReturn = null, enabled = false, application?: ApplicationOwner) {
  const qc = useQueryClient()
  const communityOrigin = useCommunityMutationOrigin()
  const registry = communityOrigin.registry
  const key = useMemo(() => application ? applicationKey(application, "billing") : communityKeys.billing(), [application])
  const capture = useCallback(() => {
    if (application) {
      const token = captureApplicationOwner(application)
      const assert = () => assertApplicationOwner(token)
      return { assert, request: <T,>(path: string, options?: ApiRequestOptions) => apiFetch<T>(path, {
        ...options, authenticationAccount: application.userId,
        assertActive: () => { assertApplicationOwner(token, options?.signal ?? undefined); options?.assertActive?.() },
        onUnauthorized: () => invalidateApplicationAuthentication(token, options?.signal ?? undefined),
      }) }
    }
    const token = communityOrigin.begin().token
    return { assert: () => communityOrigin.assert(token), request: <T,>(path: string, options?: ApiRequestOptions) => communityOrigin.request<T>(token, path, options) }
  }, [application, communityOrigin])
  const ui = useCreateStore({
    active: enabled, generation: 0, lock: null as symbol | null, redirecting: false,
    actionError: null as string | null, polling: false, observedPlan: null as string | null,
    handledReturn: null as BillingReturn, returnStartedAt: 0, returnComplete: false,
  })
  const state = useSelector(ui, (state) => state)
  useLayoutEffect(() => {
    ui.setState((state) => ({ ...state, active: enabled, ...(!state.active && enabled ? { lock: null, redirecting: false } : {}) }))
    return () => ui.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
  }, [ui, enabled])
  const captureView = useCallback(() => {
    const original = capture(), generation = ui.get().generation
    return { ...original, assertView: () => {
      original.assert()
      const state = ui.get()
      if (!state.active || state.generation !== generation) throw new DOMException("Retired billing view", "AbortError")
    } }
  }, [capture, ui])
  const query = useQuery({
    queryKey: key, enabled, subscribed: enabled,
    queryFn: async ({ signal }) => {
      const original = capture()
      const summary = BillingSummarySchema.parse(await original.request<unknown>("/api/community/billing", { signal }))
      original.assert()
      return summary
    },
    staleTime: 30_000, refetchOnWindowFocus: true,
    refetchInterval: state.polling ? 2_000 : false, retry: false,
  })
  useObservedQueryRegion("billing", query, undefined, enabled)
  const invalidateDependents = useCallback(() => {
    if (!registry) return
    void qc.invalidateQueries({ queryKey: communityKeys.bots() })
    void qc.invalidateQueries({ queryKey: communityKeys.machines() })
  }, [qc, registry])
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      ui.setState((state) => ({ ...state, lock: null, redirecting: false }))
      if (enabled) { capture().assert(); void qc.invalidateQueries({ queryKey: key, exact: true }); invalidateDependents() }
    }
    window.addEventListener("pageshow", restore)
    return () => window.removeEventListener("pageshow", restore)
  }, [capture, enabled, invalidateDependents, key, qc, ui])
  useEffect(() => {
    const current = ui.get()
    if (!returnFrom || !enabled) {
      ui.setState((state) => ({ ...state, polling: false, handledReturn: returnFrom ? state.handledReturn : null }))
      return
    }
    if (current.handledReturn === returnFrom) {
      if (!current.returnComplete && returnFrom !== "cancel" && Date.now() - current.returnStartedAt < 30_000) ui.setState((state) => ({ ...state, polling: true }))
      return
    }
    capture().assert()
    emitTelemetry("business.result", { action_name: "billing_return", phase: "auth", outcome: returnFrom === "cancel" ? "cancelled" : "observed", capability: "limited" })
    ui.setState((state) => ({ ...state, handledReturn: returnFrom, returnComplete: false, returnStartedAt: Date.now(), polling: returnFrom !== "cancel" }))
    void qc.invalidateQueries({ queryKey: key, exact: true })
    invalidateDependents()
  }, [enabled, returnFrom, qc, ui, capture, key, invalidateDependents])
  useEffect(() => {
    if (!enabled || !state.polling) return
    const original = captureView()
    const timer = setTimeout(() => {
      try { original.assertView() } catch { return }
      ui.setState((state) => ({ ...state, returnComplete: true, polling: false }))
    }, Math.max(0, 30_000 - (Date.now() - state.returnStartedAt)))
    return () => clearTimeout(timer)
  }, [captureView, enabled, state.polling, state.returnStartedAt, ui])
  useEffect(() => {
    if (!enabled || !query.data) return
    capture().assert()
    const projection = `${query.data.plan.id}:${query.data.isFounder}`
    const cachedBots = registry ? qc.getQueryData<{ plan: { id: string }; isFounder: boolean }>(communityKeys.bots()) : undefined
    const previous = ui.get().observedPlan ?? (cachedBots ? `${cachedBots.plan.id}:${cachedBots.isFounder}` : null)
    if (previous !== null && previous !== projection) invalidateDependents()
    const settled = returnFrom === "checkout" && !query.data.isFounder && query.dataUpdatedAt >= ui.get().returnStartedAt
      && query.data.subscription?.status === "active" && query.data.subscription.plan.id === query.data.plan.id
    if (settled && !ui.get().returnComplete) emitTelemetry("business.result", { action_name: "billing_return", outcome: "success", phase: "primary" })
    ui.setState((state) => ({ ...state, observedPlan: projection, ...(settled ? { returnComplete: true, polling: false } : {}) }))
  }, [enabled, returnFrom, query.data, query.dataUpdatedAt, qc, ui, capture, registry, invalidateDependents])
  type Original = ReturnType<typeof captureView>
  const redirect = useMutation({ meta: { observabilityAction: "billing.redirect" },
    mutationKey: [...key, "redirect"], retry: false,
    mutationFn: async ({ action, original }: { action: BillingAction; original: Original }) => {
      original.assertView()
      const result = BillingRedirectResponseSchema.parse(await original.request<unknown>(`/api/community/billing/${action.kind}`, {
        method: "POST", assertActive: original.assertView, ...(action.priceId ? { body: JSON.stringify({ priceId: action.priceId, ...(action.kind === "checkout" && action.founderAcknowledged ? { founderAcknowledged: true } : {}) }) } : {}),
      }))
      original.assertView()
      const url = new URL(result.url)
      if (url.protocol !== "https:") throw new Error("INVALID_BILLING_URL")
      return url.href
    },
  })
  const start = async (action: BillingAction) => {
    if (ui.get().lock || !query.data) return
    if (query.data.isFounder && (action.kind !== "checkout" || !action.founderAcknowledged)) return
    const original = captureView(), lock = Symbol("billing-action")
    original.assertView()
    const offer = action.kind === "checkout" ? query.data.offers.find((item) => item.priceId === action.priceId) : undefined
    ui.setState((state) => ({ ...state, lock, actionError: null }))
    try {
      const url = await redirect.mutateAsync({ action, original })
      original.assertView()
      if (ui.get().lock !== lock) return
      const planId = offer ? toAnalyticsPlanId(offer.plan.id) : null
      if (offer && planId && planId !== "free" && action.kind === "checkout") {
        const value = stripeAmountToMajorUnit(offer.unitAmount, offer.currency)
        if (value !== null) trackBeginCheckout({ plan_id: planId, currency: offer.currency, value, entry_point: action.entryPoint })
      }
      ui.setState((state) => ({ ...state, redirecting: true }))
      window.location.assign(url)
    } catch (error) {
      try { original.assertView() } catch { return }
      if (isAbortError(error) || ui.get().lock !== lock) return
      ui.setState((state) => ({ ...state, lock: null, redirecting: false, actionError: action.kind === "checkout" ? "Couldn't open checkout. Try again to resume your purchase." : "Couldn't open billing management. Try again." }))
      void query.refetch({ cancelRefetch: false })
    }
  }
  const cancelMutation = useMutation({ meta: { observabilityAction: "billing.change.cancel" },
    mutationKey: [...key, "cancel-change"], retry: false,
    mutationFn: async (original: Original) => {
      original.assertView()
      await qc.cancelQueries({ queryKey: key, exact: true })
      original.assertView()
      const resource = qc.getQueryCache().find({ queryKey: key, exact: true })
      const before = resource?.state.data
      const summary = BillingSummarySchema.parse(await original.request<unknown>("/api/community/billing/cancel-change", { method: "POST", assertActive: original.assertView }))
      original.assert()
      if (resource && qc.getQueryCache().find({ queryKey: key, exact: true }) === resource) qc.setQueryData(key, (current: unknown) => current === before ? summary : current)
      original.assert()
      await qc.invalidateQueries({ queryKey: key, exact: true })
      original.assert()
      return summary
    },
  })
  const cancelChange = async () => {
    if (ui.get().lock || !query.data?.subscription?.scheduledChange || query.data.isFounder) return
    const original = captureView(), lock = Symbol("billing-cancel")
    original.assertView()
    ui.setState((state) => ({ ...state, lock, actionError: null }))
    try { await cancelMutation.mutateAsync(original); original.assertView() }
    catch (error) {
      try { original.assertView() } catch { return }
      if (!isAbortError(error) && ui.get().lock === lock) {
        ui.setState((state) => ({ ...state, actionError: "Couldn't cancel the scheduled plan change. Refresh status and try again." }))
        void query.refetch({ cancelRefetch: false })
      }
    } finally {
      try { original.assertView(); if (ui.get().lock === lock) ui.setState((state) => ({ ...state, lock: null })) } catch {}
    }
  }
  const refresh = () => { captureView().assertView(); void query.refetch({ cancelRefetch: false }); invalidateDependents() }
  return {
    ...query, returnFrom, polling: state.polling, actionError: state.actionError,
    isBusy: redirect.isPending || state.redirecting || cancelMutation.isPending, isCancelingChange: cancelMutation.isPending,
    cancelChange, checkout: (priceId: string, founderAcknowledged: boolean, entryPoint: BillingEntryPoint) => start({ kind: "checkout", priceId, founderAcknowledged, entryPoint }),
    portal: (priceId?: string) => start({ kind: "portal", priceId }), refresh,
  }
}
export type BillingController = ReturnType<typeof useBilling>

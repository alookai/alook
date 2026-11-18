"use client"

import { useCallback, useEffect, useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useAtom, useCreateAtom, useCreateStore } from "@tanstack/react-store"
import type { AutomationAccessCodeCreate, AutomationAccessCodeUpdate, AutomationAccessCodeCreateResponse } from "@alook/shared"
import { AccessCodeDisplaySchema } from "@/lib/community/display-window-persistence"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCommunityViewSource } from "./use-community-view-source"

const path = "/api/community/automation/access-codes"
type Command = { kind: "create"; data: AutomationAccessCodeCreate } | { kind: "update"; id: string; data: AutomationAccessCodeUpdate } | { kind: "delete"; id: string }

export function useAutomation(userId: string) {
  const origin = useCommunityMutationOrigin()
  const view = useCommunityViewSource(`automation:${userId}`)
  const client = useQueryClient()
  const lock = useCreateStore({ pending: false })
  const queryKey = useMemo(() => ["community", "automation-access-codes", userId] as const, [userId])
  const list = useQuery({
    queryKey, retry: false, staleTime: 0,
    queryFn: async ({ signal }) => {
      const original = origin.begin().token, query = client.getQueryCache().find({ queryKey, exact: true })
      const assert = () => {
        origin.assert(original)
        if (signal.aborted || query && client.getQueryCache().find({ queryKey, exact: true }) !== query) throw new DOMException("Retired access-code read", "AbortError")
      }
      const auxiliaryReadEpoch = await origin.registry!.captureAuxiliaryReadEpoch()
      assert()
      const data = AccessCodeDisplaySchema.parse(await origin.request(original, path, { signal, assertActive: assert }))
      assert()
      return { ...data, observed: true, ...(auxiliaryReadEpoch ? { auxiliaryReadEpoch } : {}) }
    },
  })
  const refetch = list.refetch
  const [now, setNow] = useAtom(useCreateAtom<number | null>(null))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      clearTimeout(timer)
      const current = Date.now()
      setNow(current)
      const next = list.data?.accessCodes.reduce((next, code) => {
        const expires = code.expiresAt ? Date.parse(code.expiresAt) : Infinity
        return expires > current ? Math.min(next, expires) : next
      }, Infinity) ?? Infinity
      if (Number.isFinite(next)) timer = setTimeout(refresh, Math.min(next - current, 2_147_483_647))
    }
    refresh()
    const resume = () => {
      refresh()
      if (document.visibilityState === "visible") void refetch({ cancelRefetch: false })
    }
    window.addEventListener("focus", resume)
    document.addEventListener("visibilitychange", resume)
    return () => {
      clearTimeout(timer)
      window.removeEventListener("focus", resume)
      document.removeEventListener("visibilitychange", resume)
    }
  }, [list.data, setNow, refetch])
  const data = list.data ? { ...list.data, accessCodes: list.data.accessCodes.filter((code) => !code.expiresAt || Date.parse(code.expiresAt) > (now ?? Infinity)) } : undefined
  const isCurrentRead = useCallback((id?: string) => {
    const current = client.getQueryState<typeof list.data>(queryKey)
    return current?.status === "success" && !current.isInvalidated && current.data === list.data && current.data?.observed === true
      && (!id || current.data.accessCodes.some(code => code.id === id && (!code.expiresAt || Date.parse(code.expiresAt) > Date.now())))
  }, [client, list.data, queryKey])
  type Intent = { action: Command; assert: ReturnType<typeof view.capture>; token: ReturnType<typeof origin.begin>["token"]; onCreated?: (result: AutomationAccessCodeCreateResponse) => void }
  const mutation = useMutation({
    meta: { observabilityAction: "automation.access_code.command" },
    mutationKey: [...queryKey, "action"], retry: false, gcTime: 0,
    mutationFn: async ({ action, assert, token, onCreated }: Intent) => {
      assert()
      if (action.kind !== "create" && !isCurrentRead(action.id)) throw new DOMException("Access-code read is not confirmed", "AbortError")
      const resource = client.getQueryCache().find({ queryKey, exact: true }), baseline = resource?.state.dataUpdateCount
      const result = await origin.request<AutomationAccessCodeCreateResponse | undefined>(token,
        action.kind === "create" ? path : `${path}/${encodeURIComponent(action.id)}`, {
          method: action.kind === "create" ? "POST" : action.kind === "update" ? "PATCH" : "DELETE",
          ...(action.kind === "delete" ? {} : { body: JSON.stringify(action.data) }),
          signal: assert.signal, assertActive: assert,
        })
      assert()
      if (resource && client.getQueryCache().find({ queryKey, exact: true }) === resource) await client.cancelQueries({ queryKey, exact: true })
      assert()
      await origin.registry!.retireAuxiliaryDisk([{ kind: "access-code-list", id: userId }, ...(action.kind === "delete" ? [{ kind: "access-code" as const, id: action.id }] : [])])
        .catch(cause => console.error("Access-code cache retirement failed", cause))
      assert()
      const auxiliaryReadEpoch = await origin.registry!.captureAuxiliaryReadEpoch()
      assert()
      const before = client.getQueryState(queryKey)?.dataUpdatedAt
      const updated = action.kind !== "delete" && result ? AccessCodeDisplaySchema.parse({ accessCodes: [result.accessCode] }).accessCodes[0] : undefined
      if (resource && client.getQueryCache().find({ queryKey, exact: true }) === resource && (action.kind !== "update" || resource.state.dataUpdateCount === baseline)) client.setQueryData<typeof list.data>(queryKey, current => current ? { ...current,
        accessCodes: action.kind === "create" && updated ? [updated, ...current.accessCodes.filter(code => code.id !== updated.id)]
          : current.accessCodes.flatMap(code => action.kind === "delete" && code.id === action.id ? []
            : action.kind === "update" && code.id === action.id && updated ? [updated] : [code]),
        observed: false, ...(auxiliaryReadEpoch ? { auxiliaryReadEpoch } : {}) } : current, { updatedAt: before })
      if (action.kind === "create" && result) onCreated?.(result)
      void client.invalidateQueries({ queryKey, exact: true }).catch(() => undefined)
    },
  })
  const mutateAsync = mutation.mutateAsync
  const execute = useCallback(async (action: Command, onCreated?: Intent["onCreated"]) => {
    if (lock.get().pending) throw new DOMException("Automation request already pending", "AbortError")
    const assert = view.capture()
    assert()
    lock.setState(() => ({ pending: true }))
    try {
      await mutateAsync({ action, assert, token: origin.begin().token, onCreated })
      assert()
    } finally { lock.setState(() => ({ pending: false })) }
  }, [view, origin, mutateAsync, lock])
  return { list: { ...list, data }, isCurrentRead, execute, pending: mutation.isPending }
}

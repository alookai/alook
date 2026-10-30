"use client"

import { useCallback, useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useAtom, useCreateAtom, useCreateStore } from "@tanstack/react-store"
import type { AutomationAccessCodeCreate, AutomationAccessCodeUpdate, AutomationAccessCodeListResponse, AutomationAccessCodeCreateResponse } from "@alook/shared"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCommunityViewSource } from "./use-community-view-source"

const path = "/api/community/automation/access-codes"
type Command = { kind: "create"; data: AutomationAccessCodeCreate } | { kind: "update"; id: string; data: AutomationAccessCodeUpdate } | { kind: "delete"; id: string }

export function useAutomation(userId: string) {
  const origin = useCommunityMutationOrigin()
  const view = useCommunityViewSource(`automation:${userId}`)
  const client = useQueryClient()
  const lock = useCreateStore({ pending: false })
  const queryKey = ["community", "automation-access-codes", userId] as const
  const list = useQuery({
    queryKey, retry: false, staleTime: 0, gcTime: 0,
    queryFn: ({ signal }) => origin.fetch<AutomationAccessCodeListResponse>(path, { signal }),
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
  type Intent = { action: Command; assert: ReturnType<typeof view.capture>; token: ReturnType<typeof origin.begin>["token"]; onCreated?: (result: AutomationAccessCodeCreateResponse) => void }
  const mutation = useMutation({
    meta: { observabilityAction: "automation.access_code.command" },
    mutationKey: [...queryKey, "action"], retry: false, gcTime: 0,
    mutationFn: async ({ action, assert, token, onCreated }: Intent) => {
      assert()
      const result = await origin.request<AutomationAccessCodeCreateResponse | undefined>(token,
        action.kind === "create" ? path : `${path}/${encodeURIComponent(action.id)}`, {
          method: action.kind === "create" ? "POST" : action.kind === "update" ? "PATCH" : "DELETE",
          ...(action.kind === "delete" ? {} : { body: JSON.stringify(action.data) }),
          signal: assert.signal, assertActive: assert,
        })
      assert()
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
  return { list: { ...list, data }, execute, pending: mutation.isPending }
}

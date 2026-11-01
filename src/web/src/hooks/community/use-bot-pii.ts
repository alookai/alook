"use client"

import { useCallback, useEffect, useMemo } from "react"
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query"
import { PII_TEXT_MAX_BYTES, utf8ByteLength, type PiiOperation, type PiiSnapshot } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCommunityViewSource } from "./use-community-view-source"

export type BotPiiState = {
  requestId: string
  status: "pending" | "complete" | "error"
  snapshot?: PiiSnapshot
  error?: string
  uncertain?: boolean
  operation?: PiiOperation["action"]
  output?: string
  triggeredFilters?: { id: string; name: string }[]
}

export function useBotPii(botId: string, machineId: string, online: boolean) {
  const client = useQueryClient()
  const origin = useCommunityMutationOrigin()
  const connected = useCommunityWsStore(state => state.connectionStatus === "connected")
  const source = useCommunityViewSource(`pii:${machineId}:${botId}`, online && connected)
  const key = useMemo(() => communityKeys.botPii(machineId, botId), [machineId, botId])
  const { data } = useQuery<BotPiiState>({ queryKey: key, queryFn: skipToken, gcTime: 0 })

  const run = useCallback(async (operation: PiiOperation): Promise<boolean> => {
    if (!online || !connected || client.getQueryData<BotPiiState>(key)?.status === "pending") return false
    const assert = source.capture()
    const { token } = origin.begin()
    try { assert() } catch { return false }
    const requestId = crypto.randomUUID()
    const previous = client.getQueryData<BotPiiState>(key)
    client.setQueryData<BotPiiState>(key, { requestId, status: "pending", operation: operation.action, snapshot: previous?.snapshot })
    return new Promise<boolean>(resolve => {
      const complete = (success: boolean) => { clearTimeout(timer); unsubscribe(); assert.signal.removeEventListener("abort", cancel); resolve(success) }
      const fail = (error: string) => {
        try { assert() } catch { complete(false); return }
        const current = client.getQueryData<BotPiiState>(key)
        if (current?.requestId === requestId && current.status === "pending") {
          client.setQueryData<BotPiiState>(key, { ...current, status: "error", error, uncertain: operation.action === "setEnabled" || operation.action === "remove" })
        }
        complete(false)
      }
      const cancel = () => {
        complete(false)
        if (client.getQueryData<BotPiiState>(key)?.requestId === requestId) client.removeQueries({ queryKey: key, exact: true })
      }
      const unsubscribe = client.getQueryCache().subscribe(() => {
        const current = client.getQueryData<BotPiiState>(key)
        if (current?.requestId !== requestId) complete(false)
        else if (current.status !== "pending") complete(current.status === "complete")
      })
      const timer = setTimeout(() => fail(operation.action === "preview"
        ? "The test timed out. Run it again when your machine is available."
        : operation.action === "list"
        ? "Could not load filters. Reload to try again."
        : "Could not confirm the change. Reload filters before making another change."), 45_000)
      assert.signal.addEventListener("abort", cancel, { once: true })
      void origin.request(token, `/api/community/bots/${encodeURIComponent(botId)}/pii`, {
        method: "POST", body: JSON.stringify({ requestId, operation }), signal: assert.signal, assertActive: assert,
      }).catch((error: unknown) => {
        const code = error instanceof Error ? error.message : ""
        fail(code === "UPGRADE_REQUIRED" ? "Update this machine’s daemon to manage PII filters."
          : code === "MACHINE_OFFLINE" ? "This machine is offline. Reconnect and reload filters."
          : operation.action === "preview" ? "Could not run the test. Try again."
          : operation.action === "list" ? "Could not load filters. Reload to try again."
          : "Could not confirm the change. Reload filters before making another change.")
      })
    })
  }, [botId, client, connected, key, online, origin, source])

  useEffect(() => {
    if (online && connected) void run({ action: "list" })
  }, [run, online, connected])

  const clearPreview = useCallback(() => {
    const current = client.getQueryData<BotPiiState>(key)
    if (current?.operation === "preview") client.setQueryData<BotPiiState>(key, { requestId: "", status: "complete", snapshot: current.snapshot })
  }, [client, key])

  return {
    snapshot: data?.snapshot,
    pending: data?.status === "pending",
    error: data?.operation === "preview" ? undefined : data?.error,
    previewError: data?.operation === "preview" ? data.error : undefined,
    output: online && connected && data?.operation === "preview" ? data.output : undefined,
    triggeredFilters: online && connected && data?.operation === "preview" ? data.triggeredFilters : undefined,
    previewPending: data?.operation === "preview" && data.status === "pending",
    clearPreview,
    preview: (text: string) => data?.snapshot && !data.uncertain && text.trim() && utf8ByteLength(text) <= PII_TEXT_MAX_BYTES
      ? run({ action: "preview", text, expectedRevision: data.snapshot.revision }) : Promise.resolve(false),
    unavailable: !online ? "This machine is offline. Reconnect to manage filters."
      : !connected ? "Connection lost. Reconnect to manage filters."
      : data?.uncertain ? "Reload filters to check the current state." : undefined,
    reload: () => run({ action: "list" }),
    setEnabled: (pluginId: string, enabled: boolean) => data?.snapshot && !data.uncertain
      ? run({ action: "setEnabled", pluginId, enabled, expectedRevision: data.snapshot.revision }) : Promise.resolve(false),
    remove: (pluginId: string) => data?.snapshot && !data.uncertain
      ? run({ action: "remove", pluginId, expectedRevision: data.snapshot.revision }) : Promise.resolve(false),
  }
}

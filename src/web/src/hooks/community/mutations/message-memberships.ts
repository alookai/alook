"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"
import { useMutation, useQueryClient, type Query } from "@tanstack/react-query"
import { toast } from "sonner"
import { useCommunityMutationOrigin } from "../community-origin"
import { communityKeys } from "@/lib/query-keys"
import { isAbortError } from "@/lib/errors"
import { toastApiError } from "@/lib/api/client"
import type { MarkMessageArgs, PinMessageArgs, UnmarkMessageArgs } from "./message-command-inputs"

type OriginalView = (() => void) & { signal: AbortSignal }
function current(assert?: OriginalView) { try { assert?.(); return true } catch { return false } }

function usePinCommand(action: "pin" | "unpin") {
  const origin = useCommunityMutationOrigin(), client = useQueryClient()
  type Intent = PinMessageArgs & { original: ReturnType<typeof origin.begin>["token"]; resource: Query | undefined }
  const native = useMutation<void, Error, Intent>({ meta: { observabilityAction: action === "pin" ? "message.pin" : "message.unpin" },
    mutationKey: ["community", "pin-command", action], scope: { id: "community-pin-commands" }, gcTime: 0,
    mutationFn: async ({ channelId, messageId, original, resource, assertActive }) => {
      const assert = () => { origin.assert(original); assertActive?.() }
      assert()
      const key = communityKeys.pins(channelId)
      if (resource && client.getQueryCache().find({ queryKey: key, exact: true }) === resource) await client.cancelQueries({ queryKey: key, exact: true })
      assert()
      const baseline = resource?.state.dataUpdateCount
      await origin.request(original, action === "pin" ? `/api/community/channels/${channelId}/pins` : `/api/community/channels/${channelId}/pins/${messageId}`, { method: action === "pin" ? "POST" : "DELETE", signal: assertActive?.signal, assertActive, ...(action === "pin" ? { body: JSON.stringify({ messageId }) } : {}) })
      assert()
      if (resource && client.getQueryCache().find({ queryKey: key, exact: true }) === resource) {
        if (resource.state.dataUpdateCount === baseline) client.setQueryData<{ pins: Array<{ id: string }> }>(key, (data) => data ? { pins: action === "pin" ? [...data.pins.filter((row) => row.id !== messageId), { id: messageId }] : data.pins.filter((row) => row.id !== messageId) } : data)
        void client.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false }).catch(() => undefined)
      }
    },
  })
  const capture = useCallback((input: PinMessageArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token, resource: client.getQueryCache().find({ queryKey: communityKeys.pins(input.channelId), exact: true }) } }, [origin, client])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}
export function usePinMessage() { return usePinCommand("pin") }
export function useUnpinMessage() { return usePinCommand("unpin") }

function useMarkCommand<T extends { messageId: string; channelId?: string; assertActive?: OriginalView }>(marked: boolean) {
  const origin = useCommunityMutationOrigin(), client = useQueryClient()
  type Intent = T & { original: ReturnType<typeof origin.begin>["token"]; resources: Array<Query> }
  const native = useMutation<void, Error, Intent>({ meta: { observabilityAction: marked ? "message.mark" : "message.unmark" },
    mutationKey: ["community", "mark-command", marked], scope: { id: "community-mark-commands" }, gcTime: 0,
    mutationFn: async ({ messageId, channelId, original, resources, assertActive }) => {
      const assert = () => { origin.assert(original); assertActive?.() }
      assert()
      const key = communityKeys.messageMarked(messageId)
      const resource = resources.find((query) => query.queryKey.length === key.length && key.every((part, index) => Object.is(part, query.queryKey[index])))
      if (resource && client.getQueryCache().find({ queryKey: key, exact: true }) === resource) await client.cancelQueries({ queryKey: key, exact: true })
      assert()
      const baseline = resource?.state.dataUpdateCount
      await origin.request(original, `/api/community/messages/${messageId}/marks`, { method: marked ? "PUT" : "DELETE", signal: assertActive?.signal, assertActive, ...(marked ? { body: JSON.stringify({ channelId }) } : {}) })
      assert()
      if (resource && client.getQueryCache().find({ queryKey: key, exact: true }) === resource && resource.state.dataUpdateCount === baseline) client.setQueryData(key, { marked })
      for (const query of resources) if (client.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query) void client.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false }).catch(() => undefined)
    },
    onError: (error, args) => {
      if (isAbortError(error)) return
      try { origin.assert(args.original); args.assertActive?.() } catch { return }
      toastApiError(error, marked ? "Failed to mark message" : "Failed to unmark message", () => { origin.assert(args.original); args.assertActive?.() })
    },
  })
  const capture = useCallback((input: T): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token, resources: [communityKeys.messageMarked(input.messageId), communityKeys.inboxMarked()].flatMap((key) => { const query = client.getQueryCache().find({ queryKey: key, exact: true }); return query ? [query] : [] }) } }, [origin, client])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}
export function useMarkMessage() { return useMarkCommand<MarkMessageArgs>(true) }
export function useUnmarkMessage() { return useMarkCommand<UnmarkMessageArgs>(false) }
export function useToggleMark() {
  const client = useQueryClient(), mark = useMarkMessage(), unmark = useUnmarkMessage()
  return useCallback((channelId: string, messageId: string, assertActive?: OriginalView) => {
    assertActive?.()
    const pending = client.getMutationCache().findAll({ mutationKey: ["community", "mark-command"], status: "pending", predicate: (mutation) => (mutation.state.variables as { messageId: string }).messageId === messageId }).at(-1)
    const marked = pending ? pending.options.mutationKey?.[2] === true : client.getQueryData<{ marked: boolean }>(communityKeys.messageMarked(messageId))?.marked ?? false
    if (marked) unmark.mutate({ messageId, assertActive }, { onSuccess: () => { if (current(assertActive)) toast("Removed from marked") } })
    else mark.mutate({ channelId, messageId, assertActive }, { onSuccess: () => { if (current(assertActive)) toast("Message marked") } })
  }, [client, mark, unmark])
}

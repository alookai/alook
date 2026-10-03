"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useWorkspaceViewSource } from "./use-workspace-view-source"

import { useMutation, useMutationState, type Query } from "@tanstack/react-query"
import type { AgentRuntime } from "@alook/shared"
import { triggerRuntimeUpdate, triggerRuntimeRescan } from "@/lib/api"
import { captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, type WorkspaceOwner } from "@/contexts/workspace-context"

type RuntimeIntent = { kind: "update" | "rescan"; id: string; token: ReturnType<typeof captureWorkspaceOwner>; assertActive?: (() => void) & { signal: AbortSignal } }

export function useRuntimeCommand(owner: WorkspaceOwner) {
  const key = owner.key("runtime-command")
  const source = useWorkspaceViewSource(owner, "runtime-command", true)
  type NativeIntent = RuntimeIntent & { view: ReturnType<typeof source.capture>; resources: Query[] }
  const native = useMutation({ mutationKey: key, scope: { id: JSON.stringify(key) },
    mutationFn: async ({ kind, id, token, view, resources, assertActive }: NativeIntent) => {
      const assert = () => { assertWorkspaceOwner(token, assertActive?.signal ?? view.signal); view.assert(); assertActive?.() }, qc = owner.queryClient, resourceKey = owner.key("runtimes")
      assert()
      await Promise.all(resources.filter((query) => qc.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query).map((query) => qc.cancelQueries({ queryKey: query.queryKey, exact: true })))
      assert()
      const original = resources.find((query) => JSON.stringify(query.queryKey) === JSON.stringify(resourceKey))
      const baseline = (original?.state.data as AgentRuntime[] | undefined)?.find((row) => row.id === id)
      const writes = original?.state.dataUpdateCount
      try {
        const result = kind === "update" ? await triggerRuntimeUpdate(id, owner.workspaceId, workspaceRequestOptions(token, assertActive?.signal ?? view.signal, assert)) : await triggerRuntimeRescan(id, owner.workspaceId, workspaceRequestOptions(token, assertActive?.signal ?? view.signal, assert))
        assert()
        if (original && qc.getQueryCache().find({ queryKey: resourceKey, exact: true }) === original && original.state.dataUpdateCount === writes) qc.setQueryData<AgentRuntime[]>(resourceKey, (rows) => rows?.map((row) => {
          if (row.id !== id) return row
          if ("pending_update_version" in result && row.pending_update_version === baseline?.pending_update_version) return { ...row, pending_update_version: result.pending_update_version }
          if ("pending_rescan" in result && row.pending_rescan === baseline?.pending_rescan) return { ...row, pending_rescan: result.pending_rescan }
          return row
        }))
        if (original && qc.getQueryCache().find({ queryKey: resourceKey, exact: true }) === original) await qc.invalidateQueries({ queryKey: resourceKey, exact: true }, { cancelRefetch: false })
        assert()
      } catch (error) { assert(); throw error }
    },
  })
  const capture = useCallback((input: RuntimeIntent): NativeIntent => {
    const view = source.capture()
    view.assert(); assertWorkspaceOwner(input.token); input.assertActive?.()
    return { ...input, view, resources: [...new Set([owner.key("runtimes")].flatMap((queryKey) => owner.queryClient.getQueryCache().findAll({ queryKey })))] }
  }, [owner, source])
  const assertCurrent = useCallback((args: NativeIntent) => { args.view.assert(); assertWorkspaceOwner(args.token); args.assertActive?.() }, [])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

export function usePendingRuntimeCommands(owner: WorkspaceOwner) {
  return useMutationState({ filters: { mutationKey: owner.key("runtime-command"), status: "pending" }, select: (mutation) => mutation.state.variables as RuntimeIntent })
}

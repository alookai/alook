"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useWorkspaceViewSource } from "./use-workspace-view-source"

import { useMutation,useMutationState,type Query } from "@tanstack/react-query"
import type { Agent } from "@alook/shared"
import { addWhitelistEmail,removeWhitelistEmail,updateAgent,grantAgentAccess,revokeAgentAccess,type WhitelistEntry,type AgentAccessEntry } from "@/lib/api"
import { captureWorkspaceOwner,assertWorkspaceOwner,workspaceRequestOptions,type WorkspaceOwner } from "@/contexts/workspace-context"

type AgentPermissionAction =
  | { kind: "whitelist-add"; email: string }
  | { kind: "whitelist-remove"; id: string }
  | { kind: "visibility"; value: string }
  | { kind: "grant"; userId: string }
  | { kind: "revoke"; userId: string; removeWhitelist: boolean }
type Command = { action: AgentPermissionAction; token: ReturnType<typeof captureWorkspaceOwner>; assertActive?: (() => void) & { signal: AbortSignal } }

export function usePendingAgentPermissions(owner: WorkspaceOwner, agentId: string) {
  return useMutationState({ filters: { mutationKey: owner.key("agent-permission-command", agentId), status: "pending" }, select: (mutation) => (mutation.state.variables as Command).action })
}

export function useAgentPermissionCommand(owner: WorkspaceOwner, agentId: string) {
  const key = owner.key("agent-permission-command", agentId)
  const source = useWorkspaceViewSource(owner, `agent-permissions:${agentId}`, true)
  type NativeIntent = Command & { view: ReturnType<typeof source.capture>; resources: Query[] }
  const native = useMutation({ meta: { observabilityAction: "agent.permission.command" }, mutationKey: key, scope: { id: JSON.stringify(key) },
    mutationFn: async ({ action, token, view, resources, assertActive }: NativeIntent) => {
      const assert = () => { assertWorkspaceOwner(token, assertActive?.signal ?? view.signal); view.assert(); assertActive?.() }
      const qc = owner.queryClient, whitelistKey = owner.key("agent-whitelist", agentId), accessKey = owner.key("agent-access", agentId), agentsKey = owner.key("agents")
      const keys = action.kind === "visibility" ? [agentsKey] : action.kind.startsWith("whitelist") ? [whitelistKey] : [accessKey, whitelistKey]
      assert()
      await Promise.all(resources.filter((query) => keys.some((key) => JSON.stringify(key) === JSON.stringify(query.queryKey)) && qc.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query).map((query) => qc.cancelQueries({ queryKey: query.queryKey, exact: true })))
      assert()
      const sourceKey = action.kind === "visibility" ? agentsKey : action.kind.startsWith("whitelist") ? whitelistKey : accessKey
      const resource = resources.find((query) => JSON.stringify(query.queryKey) === JSON.stringify(sourceKey)), baseline = resource?.state.data
      const writes = resource?.state.dataUpdateCount
      const qualified = () => resource && qc.getQueryCache().find({ queryKey: sourceKey, exact: true }) === resource && resource.state.dataUpdateCount === writes
      const options = workspaceRequestOptions(token, assertActive?.signal ?? view.signal, assert)
      try {
        if (action.kind === "whitelist-add") {
          const row = await addWhitelistEmail(agentId, action.email, owner.workspaceId, options)
          assert()
          if (qualified()) qc.setQueryData<WhitelistEntry[]>(whitelistKey, (rows) => [...(rows ?? []).filter((entry) => entry.id !== row.id), row])
        } else if (action.kind === "whitelist-remove") {
          await removeWhitelistEmail(agentId, action.id, owner.workspaceId, options)
          assert()
          if (qualified()) qc.setQueryData<WhitelistEntry[]>(whitelistKey, (rows) => rows?.filter((entry) => entry.id !== action.id))
        } else if (action.kind === "visibility") {
          const row = await updateAgent(agentId, { visibility: action.value }, owner.workspaceId, options)
          assert()
          const old = (baseline as Agent[] | undefined)?.find((entry) => entry.id === agentId)
          if (qualified()) qc.setQueryData<Agent[]>(agentsKey, (rows) => rows?.map((entry) => entry.id === agentId && entry.visibility === old?.visibility ? { ...entry, visibility: row.visibility } : entry))
        } else if (action.kind === "grant") {
          await grantAgentAccess(owner.workspaceId, agentId, action.userId, options)
          assert()
        } else {
          await revokeAgentAccess(owner.workspaceId, agentId, action.userId, action.removeWhitelist, options)
          assert()
          if (qualified()) qc.setQueryData<AgentAccessEntry[]>(accessKey, (rows) => rows?.filter((entry) => entry.user_id !== action.userId))
        }
        assert()
        await Promise.all(resources.filter((query) => qc.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query).map((query) => qc.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false })))
        assert()
      } catch (error) { assert(); throw error }
    },
  })
  const capture = useCallback((input: Command): NativeIntent => {
    const view = source.capture()
    view.assert(); assertWorkspaceOwner(input.token); input.assertActive?.()
    return { ...input, view, resources: [...new Set([owner.key("agents"), owner.key("agent-whitelist", agentId), owner.key("agent-access", agentId)].flatMap((queryKey) => owner.queryClient.getQueryCache().findAll({ queryKey })))] }
  }, [owner, agentId, source])
  const assertCurrent = useCallback((args: NativeIntent) => { args.view.assert(); assertWorkspaceOwner(args.token); args.assertActive?.() }, [])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

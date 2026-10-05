"use client"

import { isAbortError } from "@/lib/errors"

import { useCallback, useEffect, useMemo, type ReactNode } from "react"
import { createStore, createStoreContext, useSelector } from "@tanstack/react-store"
import { useMutation, useMutationState, useQuery, type Query } from "@tanstack/react-query"
import type { Channel } from "@alook/shared"
import { listChannels, createChannelApi, renameChannelApi, deleteChannelApi, reorderChannelsApi } from "@/lib/api"
import { toast } from "sonner"
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source"
import { workspaceRequestOptions } from "./workspace-context"
import { assertWorkspaceOwner, captureWorkspaceOwner, runWorkspaceRequest, useWorkspaceOwner, type WorkspaceOwner } from "./workspace-context"

function preferenceKey(workspace: WorkspaceOwner, agentId: string | null) {
  return `alook:channel:v2:${workspace.application.userId}:${workspace.workspaceId}:${agentId ?? "workspace"}`
}
function createChannelOwner(workspace: WorkspaceOwner) {
  const ui = createStore({ activeChannel: "default", agentId: null as string | null, selection: 0 })
  return {
    workspace, ui,
    key: workspace.key("channels"),
    setActiveChannel: (name: string) => {
      if (!workspace.lifecycle.get().active || !workspace.application.lifecycle.get().active) return
      ui.setState((state) => state.activeChannel === name ? state : { ...state, activeChannel: name, selection: state.selection + 1 })
      try { localStorage.setItem(preferenceKey(workspace, ui.get().agentId), name) } catch {}
    },
    setAgentId: (agentId: string | null) => {
      if (!workspace.lifecycle.get().active || !workspace.application.lifecycle.get().active) return
      let activeChannel = "default"
      try { activeChannel = localStorage.getItem(preferenceKey(workspace, agentId)) ?? "default" } catch {}
      ui.setState((state) => state.agentId === agentId ? state : { agentId, activeChannel, selection: state.selection + 1 })
    },
  }
}
const { StoreProvider, useStoreContext } = createStoreContext<{ owner: ReturnType<typeof createChannelOwner> }>()
const EMPTY_CHANNELS: Channel[] = []
export function ChannelProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const workspace = useWorkspaceOwner()
  const handles = useMemo(() => ({ owner: createChannelOwner(workspace) }), [workspace])
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== preferenceKey(workspace, handles.owner.ui.get().agentId)) return
      handles.owner.ui.setState((state) => ({ ...state, activeChannel: event.newValue ?? "default", selection: state.selection + 1 }))
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [handles, workspace])
  if (workspace.workspaceId !== workspaceId) throw new Error("Channel workspace owner mismatch")
  return <StoreProvider value={handles}>{children}</StoreProvider>
}
export function useChannel() {
  const { owner } = useStoreContext()
  const { workspace } = owner
  const qc = workspace.queryClient
  const activeChannel = useSelector(owner.ui, (state) => state.activeChannel)
  const query = useQuery({ queryKey: owner.key, queryFn: ({ signal }) => runWorkspaceRequest(workspace, (options) => listChannels(workspace.workspaceId, options), signal) })
  const source = useWorkspaceViewSource(workspace, "workspace-channel-commands", true)
  const commandKey = [...owner.key, "command"]
  type Action = { kind: "create"; name: string } | { kind: "rename"; id: string; name: string } | { kind: "delete"; id: string } | { kind: "reorder"; ids: string[] }
  type Intent = { action: Action; token: ReturnType<typeof captureWorkspaceOwner>; view: ReturnType<typeof source.capture>; resource: Query | undefined; selection: number; targetName?: string }
  const native = useMutation({ meta: { observabilityAction: "workspace.channel.command" }, mutationKey: commandKey, scope: { id: JSON.stringify(commandKey) }, gcTime: 0,
    mutationFn: async ({ action, token, view, resource, selection, targetName }: Intent) => {
      const assert = () => { assertWorkspaceOwner(token, view.signal); view.assert() }
      const original = () => resource && qc.getQueryCache().find({ queryKey: owner.key, exact: true }) === resource
      assert()
      if (original()) await qc.cancelQueries({ queryKey: owner.key, exact: true })
      assert()
      const options = workspaceRequestOptions(token, view.signal, assert)
      try {
        let created: Awaited<ReturnType<typeof createChannelApi>> | undefined
        if (action.kind === "create") created = await createChannelApi(workspace.workspaceId, action.name, options)
        else if (action.kind === "rename") await renameChannelApi(action.id, workspace.workspaceId, action.name, options)
        else if (action.kind === "delete") await deleteChannelApi(action.id, workspace.workspaceId, options)
        else await reorderChannelsApi(workspace.workspaceId, action.ids, options)
        assert()
        if (original()) await qc.invalidateQueries({ queryKey: owner.key, exact: true }, { cancelRefetch: false })
        assert()
        const state = owner.ui.get()
        if (state.selection === selection && targetName === state.activeChannel) {
          if (action.kind === "rename") owner.setActiveChannel(action.name)
          else if (action.kind === "delete") owner.setActiveChannel("default")
        }
        return created
      } catch (error) { assert(); throw error }
    },
  })
  const pending = useMutationState({ filters: { mutationKey: commandKey, status: "pending", exact: true }, select: (mutation) => (mutation.state.variables as Intent).action })
  const order = pending.filter((action): action is Extract<Action, { kind: "reorder" }> => action.kind === "reorder").at(-1)?.ids
  const facts = query.data ?? EMPTY_CHANNELS
  const channels = useMemo(() => {
    if (!order) return facts
    const rows = new Map(facts.map((row) => [row.id, row])), wanted = new Set(order)
    return [...order.flatMap((id) => rows.get(id) ?? []), ...facts.filter((row) => !wanted.has(row.id))]
  }, [facts, order])
  const capture = (action: Action): Intent => {
    const view = source.capture(); view.assert()
    return { action, token: captureWorkspaceOwner(workspace), view, resource: qc.getQueryCache().find({ queryKey: owner.key, exact: true }), selection: owner.ui.get().selection, targetName: "id" in action ? qc.getQueryData<Channel[]>(owner.key)?.find((row) => row.id === action.id)?.name : undefined }
  }
  const execute = (action: Action) => native.mutateAsync(capture(action))
  const creating = pending.some((action) => action.kind === "create"), renaming = pending.find((action) => action.kind === "rename"), deleting = pending.find((action) => action.kind === "delete")
  const busy = (kind: Action["kind"]) => qc.getMutationCache().findAll({ mutationKey: commandKey, status: "pending", exact: true }).some((mutation) => (mutation.state.variables as Intent).action.kind === kind)
  const refresh = useCallback(() => { const token = captureWorkspaceOwner(workspace); assertWorkspaceOwner(token); return qc.invalidateQueries({ queryKey: owner.key, exact: true }) }, [qc, owner, workspace])
  return {
    channels, activeChannel, readActiveChannel: () => owner.ui.get().activeChannel, loading: query.isPending,
    creating, renaming: renaming?.kind === "rename" ? renaming.id : null, deleting: deleting?.kind === "delete" ? deleting.id : null,
    setActiveChannel: owner.setActiveChannel, setAgentId: owner.setAgentId,
    createChannel: async (name: string) => busy("create") ? undefined : execute({ kind: "create", name }),
    renameChannel: async (id: string, name: string) => { if (!busy("rename")) await execute({ kind: "rename", id, name }) },
    deleteChannel: async (id: string) => { if (!busy("delete")) await execute({ kind: "delete", id }) },
    reorderChannels: async (ids: string[]) => { const intent = capture({ kind: "reorder", ids }); try { await native.mutateAsync(intent) } catch (error) { if (!isAbortError(error)) { try { intent.view.assert(); assertWorkspaceOwner(intent.token); toast.error("Failed to reorder channels") } catch {} } } },
    refresh,
  }

}

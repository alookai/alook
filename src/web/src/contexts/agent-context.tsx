"use client"

import { deriveView, valueEvidence, withSource } from "@/lib/observability/data-source"

import { isAbortError } from "@/lib/errors"
import { publishWorkspaceChatEvent } from "@/lib/workspace-chat-events"
import { captureQueryReceipt, withQueryReceipt, reconcileQueryReceipt } from "@/lib/query-receipt"
import { publishWorkspaceIssueEvent } from "@/lib/workspace-issue-events"

import { useMemo, type ReactNode } from "react"
import { createStore, createStoreContext, useSelector } from "@tanstack/react-store"
import { queryOptions, useMutation, useQueries, useQuery } from "@tanstack/react-query"
import {
  listAgents, listRuntimes, createAgent, updateAgent, deleteAgent,
  createMachineToken, deleteMachine, listWorkspaceActiveTasks,
  listAgentActiveTaskCounts, listAgentPins, listAgentLinks, pinAgent as pinAgentApi, unpinAgent as unpinAgentApi,
  reorderAgentPins, reorderUnpinnedAgents, type WorkspaceActiveTask,
} from "@/lib/api"
import type { AgentRuntime as Runtime, Agent, AgentLink, CreateAgentRequest, UpdateAgentRequest, WsMessage } from "@alook/shared"
import { useUserWs } from "@/lib/use-user-ws"
import { toast } from "sonner"
import { assertWorkspaceOwner, captureWorkspaceOwner, workspaceRequestOptions, useWorkspaceOwner, runWorkspaceRequest, type WorkspaceOwner } from "./workspace-context"

import type { ApiRequestOptions } from "@/lib/api/client"

type WsSubscriber = (message: WsMessage) => void
interface AgentContextValue {
  workspaceId: string;
  agents: Agent[];
  agentLinks: AgentLink[];
  runtimes: Runtime[];
  loading: boolean;
  activeTaskCounts: Record<string, number>;
  pendingNewAgent: { agentId: string; parentAgentId: string } | null;
  clearPendingNewAgent: () => void;
  activeTaskDetails: WorkspaceActiveTask[];
  pins: Map<string, { created_at: string; position: number }>;
  reload: () => Promise<void>;
  subscribeWs: (fn: WsSubscriber) => () => void;
  subscribeReconnect: (fn: () => void) => () => void;
  handleCreateAgent: (req: CreateAgentRequest) => Promise<Agent | null>;
  handleUpdateAgent: (id: string, req: UpdateAgentRequest) => Promise<boolean>;
  handleDeleteAgent: (id: string) => Promise<boolean>;
  handlePinAgent: (agentId: string) => Promise<void>;
  handleUnpinAgent: (agentId: string) => Promise<void>;
  handleReorderPins: (orderedAgentIds: string[]) => Promise<void>;
  unpinnedOrder: Map<string, number>;
  handleReorderUnpinned: (orderedAgentIds: string[]) => Promise<void>;
  getFirstOnlineRuntimeId: () => string;
  handleGenerateToken: () => Promise<string | null>;
  handleDeleteMachine: (daemonId: string) => Promise<boolean>;
  patchAgent: (id: string, fields: Partial<Agent>) => void;
}


function agentQueries(workspace: WorkspaceOwner) {
  const options = <T,>(resource: string, load: (options: ApiRequestOptions) => Promise<T>, extra = {}) => queryOptions({
    queryKey: workspace.key(resource),
    structuralSharing: reconcileQueryReceipt,
    queryFn: async ({ signal }) => { const receipt = captureQueryReceipt(workspace.queryClient, workspace.key(resource)); const data = await runWorkspaceRequest(workspace, load, signal); return data && typeof data === "object" ? withQueryReceipt(data, receipt) : data },
    ...extra,
  })
  return {
    agents: options("agents", (options) => listAgents(workspace.workspaceId, options)),
    runtimes: options("runtimes", (options) => listRuntimes(workspace.workspaceId, options), {
      refetchInterval: 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: true,
    }),
    pins: options("agent-pins", (options) => listAgentPins(workspace.workspaceId, options)),
    links: options("agent-links", (options) => listAgentLinks(workspace.workspaceId, options)),
    counts: options("active-task-counts", (options) => listAgentActiveTaskCounts(workspace.workspaceId, options)),
    tasks: options("active-tasks", (options) => listWorkspaceActiveTasks(workspace.workspaceId, options), {
      refetchInterval: 15_000, refetchIntervalInBackground: false,
    }),
  }
}
function createAgentOwner(workspace: WorkspaceOwner) {
  const queries = agentQueries(workspace)
  const subscribers = new Set<WsSubscriber>()
  const reconnectSubscribers = new Set<() => void>()
  return {
    workspace, queries,
    ui: createStore({ pendingNewAgent: null as AgentContextValue["pendingNewAgent"] }),
    subscribeWs: (fn: WsSubscriber) => { subscribers.add(fn); return () => { subscribers.delete(fn) } },
    subscribeReconnect: (fn: () => void) => { reconnectSubscribers.add(fn); return () => { reconnectSubscribers.delete(fn) } },
    dispatch: (message: WsMessage) => { for (const subscriber of subscribers) subscriber(message) },
    reconnect: () => { for (const subscriber of reconnectSubscribers) subscriber() },
    reload: async () => {
      const token = captureWorkspaceOwner(workspace)
      assertWorkspaceOwner(token)
      await Promise.all([queries.agents, queries.runtimes, queries.pins, queries.links].map(({ queryKey }) =>
        workspace.queryClient.cancelQueries({ queryKey, exact: true }).then(() => {
          assertWorkspaceOwner(token)
          return workspace.queryClient.invalidateQueries({ queryKey, exact: true })
        })))
      assertWorkspaceOwner(token)
    },
  }
}
type AgentOwner = ReturnType<typeof createAgentOwner>
const { StoreProvider, useStoreContext } = createStoreContext<{ owner: AgentOwner }>()
const EMPTY_AGENTS: Agent[] = []
const EMPTY_RUNTIMES: Runtime[] = []
const EMPTY_LINKS: AgentLink[] = []
const EMPTY_TASKS: WorkspaceActiveTask[] = []

export function useAgentContext({ poll = false }: { poll?: boolean } = {}): AgentContextValue {
  const { owner } = useStoreContext()
  const results = useQueries({ queries: [
    owner.queries.agents, { ...owner.queries.runtimes, refetchInterval: poll ? 30_000 : false }, owner.queries.pins,
    owner.queries.links, { ...owner.queries.counts, refetchInterval: () => {
      if (!poll) return false
      const details = owner.workspace.queryClient.getQueryState<Awaited<ReturnType<typeof listWorkspaceActiveTasks>>>(owner.queries.tasks.queryKey)
      const counts = owner.workspace.queryClient.getQueryState(owner.queries.counts.queryKey)
      return details && details.dataUpdatedAt >= (counts?.dataUpdatedAt ?? 0) && details.data?.tasks.length ? false : 15_000
    } },
  ] })
  const cachedDetails = owner.workspace.queryClient.getQueryState<Awaited<ReturnType<typeof listWorkspaceActiveTasks>>>(owner.queries.tasks.queryKey)
  const detailsAreLatest = (cachedDetails?.dataUpdatedAt ?? 0) >= results[4].dataUpdatedAt
  const hasActiveTasks = detailsAreLatest
    ? (cachedDetails?.data?.tasks.length ?? 0) > 0
    : Object.values(results[4].data?.counts ?? {}).some((count) => count > 0)
  const detailsQuery = useQuery({ ...owner.queries.tasks, enabled: hasActiveTasks, subscribed: hasActiveTasks, refetchInterval: poll && hasActiveTasks ? 15_000 : false })
  const pendingNewAgent = useSelector(owner.ui, (state) => state.pendingNewAgent)
  const workspace = owner.workspace
  const mutation = useMutation({ meta: { observabilityAction: "agent.update" },
    mutationFn: async ({ operation, token }: { operation: (options: ApiRequestOptions) => Promise<unknown>; token: ReturnType<typeof captureWorkspaceOwner> }) => {
      assertWorkspaceOwner(token)
      try {
        const result = await operation(workspaceRequestOptions(token))
        assertWorkspaceOwner(token)
        return result
      } catch (error) { assertWorkspaceOwner(token); throw error }
    },
  })
  const pinMutationKey = [...owner.queries.pins.queryKey, "change"]
  type PinChange = { kind: "pin" | "unpin" | "reorder-pins" | "reorder-unpinned"; ids: string[]; token: ReturnType<typeof captureWorkspaceOwner> }
  const pinMutation = useMutation({ meta: { observabilityAction: "agent.rail.command" },
    mutationKey: pinMutationKey,
    scope: { id: JSON.stringify(pinMutationKey) },
    mutationFn: async (action: PinChange) => {
      assertWorkspaceOwner(action.token)
      const options = workspaceRequestOptions(action.token)
      try {
      if (action.kind === "pin") await pinAgentApi(workspace.workspaceId, action.ids[0], options)
      else if (action.kind === "unpin") await unpinAgentApi(workspace.workspaceId, action.ids[0], options)
      else if (action.kind === "reorder-pins") await reorderAgentPins(workspace.workspaceId, action.ids, options)
      else await reorderUnpinnedAgents(workspace.workspaceId, action.ids, options)
        assertWorkspaceOwner(action.token)
      } catch (error) { assertWorkspaceOwner(action.token); throw error }
    },
    onMutate: async (action) => {
      const token = action.token
      const qc = workspace.queryClient
      const key = owner.queries.pins.queryKey
      await qc.cancelQueries({ queryKey: key, exact: true })
      assertWorkspaceOwner(token)
      const previous = qc.getQueryData(key)
      qc.setQueryData(key, (data) => {
        const current = data ?? { pins: [], sidebar_order: [] }
        if (action.kind === "pin") {
          if (current.pins.some((pin) => pin.agent_id === action.ids[0])) return current
          const position = Math.max(-1, ...current.pins.map((pin) => pin.position)) + 1
          return { ...current, pins: [...current.pins, { id: `pending:${action.ids[0]}`, agent_id: action.ids[0], created_at: new Date().toISOString(), position }] }
        }
        if (action.kind === "unpin") return { ...current, pins: current.pins.filter((pin) => pin.agent_id !== action.ids[0]) }
        if (action.kind === "reorder-pins") return { ...current, pins: current.pins.map((pin) => action.ids.includes(pin.agent_id) ? { ...pin, position: action.ids.indexOf(pin.agent_id) } : pin) }
        return { ...current, sidebar_order: action.ids.map((agent_id, position) => ({ agent_id, position })) }
      })
      return { token, previous, optimistic: qc.getQueryData(key), query: qc.getQueryCache().find({ queryKey: key, exact: true }) }
    },
    onError: (error, _action, context) => {
      if (!context || isAbortError(error)) return
      try { assertWorkspaceOwner(context.token) } catch { return }
      if (context.query && workspace.queryClient.getQueryCache().find({ queryKey: owner.queries.pins.queryKey, exact: true }) === context.query && workspace.queryClient.getQueryData(owner.queries.pins.queryKey) === context.optimistic) {
        workspace.queryClient.setQueryData(owner.queries.pins.queryKey, context.previous)
      }
    },
    onSettled: (_data, _error, _action, context) => {
      if (!context) return
      try { assertWorkspaceOwner(context.token) } catch { return }
      if (workspace.queryClient.isMutating({ mutationKey: pinMutationKey, exact: true }) === 1) {
        return workspace.queryClient.invalidateQueries({ queryKey: owner.queries.pins.queryKey, exact: true })
      }
    },
  })
  const mutateOperation = mutation.mutateAsync, mutatePins = pinMutation.mutateAsync
  const operations = useMemo(() => {
    const { workspace: source, queries } = owner
    const qc = source.queryClient
    const invoke = async <T,>(operation: (options: ApiRequestOptions) => Promise<T>, fallback: string): Promise<T | null> => {
      const token = captureWorkspaceOwner(source)
      try {
        assertWorkspaceOwner(token)
        const result = await mutateOperation({ operation, token }) as T
        assertWorkspaceOwner(token)
        return result
      }
      catch (error) {
        try { assertWorkspaceOwner(token) } catch { return null }
        if (!(isAbortError(error))) {
          toast.error(error instanceof Error ? error.message : fallback)
        }
        return null
      }
    }
    const change = async (operation: (options: ApiRequestOptions) => Promise<unknown>, fallback: string) => {
      const token = captureWorkspaceOwner(source)
      const result = await invoke(operation, fallback)
      if (result === null) return false
      try {
        assertWorkspaceOwner(token)
        await owner.reload()
        assertWorkspaceOwner(token)
      } catch (error) { if (isAbortError(error)) return false; throw error }
      return true
    }
    const changePins = async (kind: PinChange["kind"], ids: string[], fallback: string) => {
      const token = captureWorkspaceOwner(source)
      try { assertWorkspaceOwner(token); await mutatePins({ kind, ids, token }); assertWorkspaceOwner(token) }
      catch (error) {
        try { assertWorkspaceOwner(token) } catch { return }
        if (!(isAbortError(error))) toast.error(fallback)
      }
    }
    return {
      clearPendingNewAgent: () => owner.ui.setState((state) => state.pendingNewAgent ? { pendingNewAgent: null } : state),
      reload: owner.reload,
      subscribeWs: owner.subscribeWs,
      subscribeReconnect: owner.subscribeReconnect,
      handleCreateAgent: async (request: CreateAgentRequest) => {
        const token = captureWorkspaceOwner(source)
        const agent = await invoke((options) => createAgent(request, source.workspaceId, options), "Failed to create agent")
        if (agent) {
          try { assertWorkspaceOwner(token); await owner.reload(); assertWorkspaceOwner(token) }
          catch (error) { if (isAbortError(error)) return null; throw error }
        }
        return agent
      },
      handleUpdateAgent: (id: string, request: UpdateAgentRequest) =>
        change((options) => updateAgent(id, request, source.workspaceId, options), "Failed to update agent"),
      handleDeleteAgent: (id: string) =>
        change(async (options) => { await deleteAgent(id, source.workspaceId, options); return true }, "Failed to remove agent"),
      handleDeleteMachine: (id: string) =>
        change(async (options) => { await deleteMachine(id, source.workspaceId, options); return true }, "Failed to remove machine"),
      handleGenerateToken: () => invoke((options) => createMachineToken("cli", source.workspaceId, options).then((data) => data.token), "Failed to generate token"),
      handlePinAgent: (id: string) => changePins("pin", [id], "Failed to pin agent"),
      handleUnpinAgent: (id: string) => changePins("unpin", [id], "Failed to unpin agent"),
      handleReorderPins: (ids: string[]) => changePins("reorder-pins", ids, "Failed to reorder pins"),
      handleReorderUnpinned: (ids: string[]) => changePins("reorder-unpinned", ids, "Failed to reorder agents"),
      getFirstOnlineRuntimeId: () => qc.getQueryData(queries.runtimes.queryKey)?.find((runtime) => runtime.status === "online")?.id ?? "",
      patchAgent: (id: string, fields: Partial<Agent>) => {
        if (!source.lifecycle.get().active || !source.application.lifecycle.get().active) return
        void qc.cancelQueries({ queryKey: queries.agents.queryKey, exact: true })
        qc.setQueryData(queries.agents.queryKey, (current) => current?.map((agent) => agent.id === id ? { ...agent, ...fields } : agent))
      },
    }
  }, [owner, mutateOperation, mutatePins])
  const agents = (results[0]?.data as Agent[] | undefined) ?? EMPTY_AGENTS
    const runtimes = (results[1]?.data as Runtime[] | undefined) ?? EMPTY_RUNTIMES
    const pinData = results[2]?.data as Awaited<ReturnType<typeof listAgentPins>> | undefined
    const agentLinks = (results[3]?.data as AgentLink[] | undefined) ?? EMPTY_LINKS
    const tasks = detailsQuery.data
    const activeTaskDetails = tasks?.tasks ?? EMPTY_TASKS
    const activeTaskCounts = useMemo(() => {
      if (results[4].dataUpdatedAt > detailsQuery.dataUpdatedAt) return results[4].data?.counts ?? {}
      const counts: Record<string, number> = {}
      for (const task of activeTaskDetails) counts[task.agent_id] = (counts[task.agent_id] ?? 0) + 1
      return counts
    }, [activeTaskDetails, detailsQuery.dataUpdatedAt, results])
    const pins = useMemo(() => new Map(pinData?.pins.map((pin) => [pin.agent_id, { created_at: pin.created_at, position: pin.position }])), [pinData])
    const unpinnedOrder = useMemo(() => new Map(pinData?.sidebar_order.map((entry) => [entry.agent_id, entry.position])), [pinData])
    const loading = results.slice(0, 4).some((result) => result.isPending)
    deriveView(agents, [valueEvidence(owner.workspace.queryClient, results[0]?.data)])
    deriveView(runtimes, [valueEvidence(owner.workspace.queryClient, results[1]?.data)])
    deriveView(agentLinks, [valueEvidence(owner.workspace.queryClient, results[3]?.data)])
    return useMemo(() => ({
      ...operations, workspaceId: owner.workspace.workspaceId, agents, runtimes,
      agentLinks, activeTaskCounts, activeTaskDetails, pendingNewAgent,
      loading, pins, unpinnedOrder,
    }), [owner, operations, agents, runtimes, agentLinks, activeTaskCounts, activeTaskDetails, pendingNewAgent, loading, pins, unpinnedOrder])
}
function AgentBootstrap({ owner }: { owner: AgentOwner }) {
  useAgentContext({ poll: true })
  useUserWs((message) => {
    const { workspace } = owner
    if (!workspace.lifecycle.get().active || !workspace.application.lifecycle.get().active) return
    if ("workspaceId" in message && message.workspaceId && message.workspaceId !== workspace.workspaceId) return
    withSource(workspace.queryClient, "ws", () => {
      publishWorkspaceChatEvent(workspace, message)
      publishWorkspaceIssueEvent(workspace, message)
      owner.dispatch(message)
    })
    switch (message.type) {
      case "runtime.registered": case "runtime.deleted": void owner.reload(); break
      case "runtime.status":
        void workspace.queryClient.cancelQueries({ queryKey: owner.queries.runtimes.queryKey, exact: true }).then(() => workspace.queryClient.invalidateQueries({ queryKey: owner.queries.runtimes.queryKey, exact: true })); break
      case "agent.created":
        owner.ui.setState(() => ({ pendingNewAgent: { agentId: message.agentId, parentAgentId: message.parentAgentId } }))
        void owner.reload(); break
      case "task.updated":
        const details = workspace.queryClient.getQueryData(owner.queries.tasks.queryKey)
        void workspace.queryClient.invalidateQueries({ queryKey: details?.tasks.length ? owner.queries.tasks.queryKey : owner.queries.counts.queryKey, exact: true }); break
    }
  }, { onReconnect: () => { void owner.reload(); owner.reconnect() } })
  return null
}
export function AgentProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const workspace = useWorkspaceOwner()
  const owner = useMemo(() => createAgentOwner(workspace), [workspace])
  const handles = useMemo(() => ({ owner }), [owner])
  if (workspace.workspaceId !== workspaceId) throw new Error("Agent workspace owner mismatch")
  return <StoreProvider value={handles}><AgentBootstrap owner={owner} />{children}</StoreProvider>
}

"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  listAgents,
  listRuntimes,
  createAgent,
  updateAgent,
  deleteAgent,
  createMachineToken,
  deleteMachine,
  listAgentActiveTaskCounts,
  listWorkspaceActiveTasks,
  listAgentPins,
  listAgentLinks,
  pinAgent as pinAgentApi,
  unpinAgent as unpinAgentApi,
  reorderAgentPins,
  reorderUnpinnedAgents,
  type WorkspaceActiveTask,
} from "@/lib/api";
import type { AgentRuntime as Runtime } from "@alook/shared";
import { toast } from "sonner";
import type {
  Agent,
  AgentLink,
  CreateAgentRequest,
  UpdateAgentRequest,
  WsMessage,
} from "@alook/shared";
import { useUserWs } from "@/lib/use-user-ws";


type WsSubscriber = (msg: WsMessage) => void;

interface AgentContextValue {
  workspaceId: string;
  agents: Agent[];
  agentLinks: AgentLink[];
  runtimes: Runtime[];
  loading: boolean;
  activeTaskCounts: Record<string, number>;
  activeTaskDetails: WorkspaceActiveTask[];
  pins: Map<string, { created_at: string; position: number }>;
  reload: () => Promise<void>;
  subscribeWs: (fn: WsSubscriber) => () => void;
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
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function useAgentContext() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgentContext must be used within AgentProvider");
  return ctx;
}

export function AgentProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTaskCounts, setActiveTaskCounts] = useState<Record<string, number>>({});
  const [activeTaskDetails, setActiveTaskDetails] = useState<WorkspaceActiveTask[]>([]);
  const hasActiveTasksRef = useRef(false);
  const [agentLinks, setAgentLinks] = useState<AgentLink[]>([]);
  const [pins, setPins] = useState<Map<string, { created_at: string; position: number }>>(new Map());
  const [unpinnedOrder, setUnpinnedOrder] = useState<Map<string, number>>(new Map());
  const loadedRef = useRef(false);
  const subscribersRef = useRef(new Set<WsSubscriber>());
  const taskCountsMountedRef = useRef(true);
  const isReloadingRuntimesRef = useRef(false);

  const subscribeWs = useCallback((fn: WsSubscriber) => {
    subscribersRef.current.add(fn);
    return () => { subscribersRef.current.delete(fn); };
  }, []);

  const isFetchingRef = useRef(false);

  const fetchTaskCounts = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      if (hasActiveTasksRef.current) {
        const res = await listWorkspaceActiveTasks(workspaceId);
        if (!taskCountsMountedRef.current) return;
        setActiveTaskDetails(res.tasks);
        const counts: Record<string, number> = {};
        for (const t of res.tasks) {
          counts[t.agent_id] = (counts[t.agent_id] ?? 0) + 1;
        }
        setActiveTaskCounts(counts);
        hasActiveTasksRef.current = res.tasks.length > 0;
      } else {
        const res = await listAgentActiveTaskCounts(workspaceId);
        if (!taskCountsMountedRef.current) return;
        setActiveTaskCounts(res.counts);
        const hasAny = Object.values(res.counts).some((n) => n > 0);
        if (hasAny) {
          hasActiveTasksRef.current = true;
          const detailed = await listWorkspaceActiveTasks(workspaceId);
          if (taskCountsMountedRef.current) setActiveTaskDetails(detailed.tasks);
        } else {
          setActiveTaskDetails([]);
        }
      }
    } catch {
      // ignore
    } finally {
      isFetchingRef.current = false;
    }
  }, [workspaceId]);

  useEffect(() => {
    taskCountsMountedRef.current = true;
    fetchTaskCounts();
    const id = setInterval(fetchTaskCounts, 15000);
    return () => {
      taskCountsMountedRef.current = false;
      clearInterval(id);
    };
  }, [fetchTaskCounts]);

  const reload = useCallback(async () => {
    try {
      const [a, r, pinsData, links] = await Promise.all([
        listAgents(workspaceId),
        listRuntimes(workspaceId),
        listAgentPins(workspaceId),
        listAgentLinks(workspaceId),
      ]);
      setAgents(a);
      setRuntimes(r);
      setAgentLinks(links);
      setPins(new Map(pinsData.pins.map((pin) => [pin.agent_id, { created_at: pin.created_at, position: pin.position }])));
      setUnpinnedOrder(new Map(pinsData.sidebar_order.map((o) => [o.agent_id, o.position])));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
      loadedRef.current = true;
    }
  }, [workspaceId]);

  const reloadRuntimes = useCallback(async () => {
    if (isReloadingRuntimesRef.current) return;
    isReloadingRuntimesRef.current = true;
    try {
      const r = await listRuntimes(workspaceId);
      setRuntimes(r);
    } catch {
      // ignore — next tick will retry
    } finally {
      isReloadingRuntimesRef.current = false;
    }
  }, [workspaceId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Periodic runtime polling (30s, visibility-aware)
  useEffect(() => {
    let jitterTimer: ReturnType<typeof setTimeout> | null = null;

    const intervalId = setInterval(() => {
      if (document.visibilityState === "visible") {
        reloadRuntimes();
      }
    }, 30_000);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        const jitter = Math.random() * 2000;
        jitterTimer = setTimeout(() => reloadRuntimes(), jitter);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(intervalId);
      if (jitterTimer) clearTimeout(jitterTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [reloadRuntimes]);


  // Listen for real-time WS events
  const handleWsMessage = useCallback(
    (msg: WsMessage) => {
      // Dispatch to all subscribers so child components can react
      for (const fn of subscribersRef.current) fn(msg);

      // AgentProvider only reloads agents/runtimes for runtime events
      switch (msg.type) {
        case "runtime.registered":
          // Filter by workspaceId — ignore registrations in other workspaces
          if (msg.workspaceId !== workspaceId) break;
          reload();
          break;
        case "runtime.deleted":
          reload();
          break;
        case "runtime.status":
          // Filter by workspaceId — ignore messages from other workspaces
          if (msg.workspaceId !== workspaceId) break;
          reloadRuntimes();
          break;
        case "task.updated":
          fetchTaskCounts();
          break;
      }
    },
    [reload, reloadRuntimes, fetchTaskCounts, workspaceId]
  );
  useUserWs(handleWsMessage, { onReconnect: reloadRuntimes });

  const handleCreateAgent = useCallback(
    async (req: CreateAgentRequest): Promise<Agent | null> => {
      try {
        const agent = await createAgent(req, workspaceId);
        await reload();
        return agent;
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to create agent"
        );
        return null;
      }
    },
    [reload, workspaceId]
  );

  const handleUpdateAgent = useCallback(
    async (id: string, req: UpdateAgentRequest): Promise<boolean> => {
      try {
        await updateAgent(id, req, workspaceId);
        await reload();
        return true;
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update agent"
        );
        return false;
      }
    },
    [reload, workspaceId]
  );

  const handleDeleteAgent = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await deleteAgent(id, workspaceId);
        await reload();
        return true;
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to remove agent"
        );
        return false;
      }
    },
    [reload, workspaceId]
  );

  const handlePinAgent = useCallback(async (agentId: string) => {
    setPins((prev) => {
      const maxPos = Math.max(-1, ...[...prev.values()].map((v) => v.position));
      return new Map(prev).set(agentId, { created_at: new Date().toISOString(), position: maxPos + 1 });
    });
    try {
      await pinAgentApi(workspaceId, agentId);
    } catch {
      setPins((prev) => { const next = new Map(prev); next.delete(agentId); return next; });
      toast.error("Failed to pin agent");
    }
  }, [workspaceId]);

  const handleUnpinAgent = useCallback(async (agentId: string) => {
    let savedValue: { created_at: string; position: number } | undefined;
    setPins((prev) => { savedValue = prev.get(agentId); const next = new Map(prev); next.delete(agentId); return next; });
    try {
      await unpinAgentApi(workspaceId, agentId);
    } catch {
      if (savedValue !== undefined) setPins((prev) => new Map(prev).set(agentId, savedValue!));
      toast.error("Failed to unpin agent");
    }
  }, [workspaceId]);

  const handleReorderPins = useCallback(async (orderedAgentIds: string[]) => {
    const prev = new Map(pins);
    setPins((current) => {
      const next = new Map(current);
      orderedAgentIds.forEach((id, i) => {
        const existing = next.get(id);
        if (existing) next.set(id, { ...existing, position: i });
      });
      return next;
    });
    try {
      await reorderAgentPins(workspaceId, orderedAgentIds);
    } catch {
      setPins(prev);
      toast.error("Failed to reorder pins");
    }
  }, [workspaceId, pins]);

  const handleReorderUnpinned = useCallback(async (orderedAgentIds: string[]) => {
    const prev = new Map(unpinnedOrder);
    setUnpinnedOrder(new Map(orderedAgentIds.map((id, i) => [id, i])));
    try {
      await reorderUnpinnedAgents(workspaceId, orderedAgentIds);
    } catch {
      setUnpinnedOrder(prev);
      toast.error("Failed to reorder agents");
    }
  }, [workspaceId, unpinnedOrder]);

  const getFirstOnlineRuntimeId = useCallback(() => {
    const first = runtimes.find((r) => r.status === "online");
    return first?.id ?? "";
  }, [runtimes]);

  const handleGenerateToken = useCallback(async (): Promise<string | null> => {
    try {
      const res = await createMachineToken("cli", workspaceId);
      return res.token;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to generate token"
      );
      return null;
    }
  }, [workspaceId]);

  const handleDeleteMachine = useCallback(
    async (daemonId: string): Promise<boolean> => {
      try {
        await deleteMachine(daemonId, workspaceId);
        await reload();
        return true;
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to remove machine"
        );
        return false;
      }
    },
    [reload, workspaceId]
  );

  return (
    <AgentContext.Provider
      value={{
        workspaceId,
        agents,
        agentLinks,
        runtimes,
        loading,
        activeTaskCounts,
        activeTaskDetails,
        pins,
        reload,
        subscribeWs,
        handleCreateAgent,
        handleUpdateAgent,
        handleDeleteAgent,
        handlePinAgent,
        handleUnpinAgent,
        handleReorderPins,
        unpinnedOrder,
        handleReorderUnpinned,
        getFirstOnlineRuntimeId,
        handleGenerateToken,
        handleDeleteMachine,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

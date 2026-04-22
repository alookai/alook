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
  listAgentPins,
  pinAgent as pinAgentApi,
  unpinAgent as unpinAgentApi,
  type AgentPin,
} from "@/lib/api";
import type { AgentRuntime as Runtime } from "@alook/shared";
import { toast } from "sonner";
import type {
  Agent,
  CreateAgentRequest,
  UpdateAgentRequest,
  WsMessage,
} from "@alook/shared";
import { useUserWs } from "@/lib/use-user-ws";

type WsSubscriber = (msg: WsMessage) => void;

interface AgentContextValue {
  workspaceId: string;
  agents: Agent[];
  runtimes: Runtime[];
  loading: boolean;
  activeTaskCounts: Record<string, number>;
  pins: Map<string, string>;
  reload: () => Promise<void>;
  subscribeWs: (fn: WsSubscriber) => () => void;
  handleCreateAgent: (req: CreateAgentRequest) => Promise<Agent | null>;
  handleUpdateAgent: (id: string, req: UpdateAgentRequest) => Promise<boolean>;
  handleDeleteAgent: (id: string) => Promise<boolean>;
  handlePinAgent: (agentId: string) => Promise<void>;
  handleUnpinAgent: (agentId: string) => Promise<void>;
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
  const [pins, setPins] = useState<Map<string, string>>(new Map());
  const loadedRef = useRef(false);
  const subscribersRef = useRef(new Set<WsSubscriber>());
  const taskCountsMountedRef = useRef(true);

  const subscribeWs = useCallback((fn: WsSubscriber) => {
    subscribersRef.current.add(fn);
    return () => { subscribersRef.current.delete(fn); };
  }, []);

  const fetchTaskCounts = useCallback(async () => {
    try {
      const res = await listAgentActiveTaskCounts(workspaceId);
      if (taskCountsMountedRef.current) setActiveTaskCounts(res.counts);
    } catch {
      // ignore
    }
  }, [workspaceId]);

  useEffect(() => {
    taskCountsMountedRef.current = true;
    fetchTaskCounts();
    const id = setInterval(fetchTaskCounts, 5000);
    return () => {
      taskCountsMountedRef.current = false;
      clearInterval(id);
    };
  }, [fetchTaskCounts]);

  const reload = useCallback(async () => {
    try {
      const [a, r, p] = await Promise.all([
        listAgents(workspaceId),
        listRuntimes(workspaceId),
        listAgentPins(workspaceId),
      ]);
      setAgents(a);
      setRuntimes(r);
      setPins(new Map(p.map((pin) => [pin.agent_id, pin.created_at])));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
      loadedRef.current = true;
    }
  }, [workspaceId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Debounced reload for runtime.status events
  const statusDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedReload = useCallback(() => {
    if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current);
    statusDebounceRef.current = setTimeout(() => {
      statusDebounceRef.current = null;
      reload();
    }, 300);
  }, [reload]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current);
    };
  }, []);

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
          debouncedReload();
          break;
        case "task.updated":
          fetchTaskCounts();
          break;
      }
    },
    [reload, debouncedReload, fetchTaskCounts, workspaceId]
  );
  useUserWs(handleWsMessage);

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
    setPins((prev) => new Map(prev).set(agentId, new Date().toISOString()));
    try {
      await pinAgentApi(workspaceId, agentId);
    } catch {
      setPins((prev) => { const next = new Map(prev); next.delete(agentId); return next; });
      toast.error("Failed to pin agent");
    }
  }, [workspaceId]);

  const handleUnpinAgent = useCallback(async (agentId: string) => {
    let savedValue: string | undefined;
    setPins((prev) => { savedValue = prev.get(agentId); const next = new Map(prev); next.delete(agentId); return next; });
    try {
      await unpinAgentApi(workspaceId, agentId);
    } catch {
      if (savedValue !== undefined) setPins((prev) => new Map(prev).set(agentId, savedValue!));
      toast.error("Failed to unpin agent");
    }
  }, [workspaceId]);

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
        runtimes,
        loading,
        activeTaskCounts,
        pins,
        reload,
        subscribeWs,
        handleCreateAgent,
        handleUpdateAgent,
        handleDeleteAgent,
        handlePinAgent,
        handleUnpinAgent,
        getFirstOnlineRuntimeId,
        handleGenerateToken,
        handleDeleteMachine,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

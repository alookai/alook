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
  createConversation,
  createMachineToken,
  deleteMachine,
  type Runtime,
} from "@/lib/api";
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
  agents: Agent[];
  runtimes: Runtime[];
  loading: boolean;
  reload: () => Promise<void>;
  subscribeWs: (fn: WsSubscriber) => () => void;
  handleCreateAgent: (req: CreateAgentRequest) => Promise<Agent | null>;
  handleUpdateAgent: (id: string, req: UpdateAgentRequest) => Promise<boolean>;
  handleDeleteAgent: (id: string) => Promise<boolean>;
  chatWithAgent: (agentId: string) => Promise<string | null>;
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
  const loadedRef = useRef(false);
  const subscribersRef = useRef(new Set<WsSubscriber>());

  const subscribeWs = useCallback((fn: WsSubscriber) => {
    subscribersRef.current.add(fn);
    return () => { subscribersRef.current.delete(fn); };
  }, []);

  const reload = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([
        listAgents(workspaceId),
        listRuntimes(workspaceId),
      ]);
      setAgents(a);
      setRuntimes(r);
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

  // Listen for real-time WS events
  const handleWsMessage = useCallback(
    (msg: WsMessage) => {
      // Dispatch to all subscribers so child components can react
      for (const fn of subscribersRef.current) fn(msg);

      // AgentProvider only reloads agents/runtimes for runtime events
      switch (msg.type) {
        case "runtime.registered":
        case "runtime.status":
        case "runtime.deleted":
          reload();
          break;
      }
    },
    [reload]
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

  const chatWithAgent = useCallback(
    async (agentId: string): Promise<string | null> => {
      try {
        const conversation = await createConversation(agentId, workspaceId);
        return conversation.id;
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to start conversation"
        );
        return null;
      }
    },
    [workspaceId]
  );

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
        agents,
        runtimes,
        loading,
        reload,
        subscribeWs,
        handleCreateAgent,
        handleUpdateAgent,
        handleDeleteAgent,
        chatWithAgent,
        getFirstOnlineRuntimeId,
        handleGenerateToken,
        handleDeleteMachine,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

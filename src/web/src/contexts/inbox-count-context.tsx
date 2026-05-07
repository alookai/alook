"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { getInboxCount } from "@/lib/api";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { sendTaskNotification } from "@/lib/browser-notification";
import type { WsMessage } from "@alook/shared";

interface InboxCountContextValue {
  count: number;
  refresh: () => void;
  decrement: () => void;
}

const InboxCountContext = createContext<InboxCountContextValue | null>(null);

export function useInboxCount() {
  const ctx = useContext(InboxCountContext);
  if (!ctx) throw new Error("useInboxCount must be used within InboxCountProvider");
  return ctx;
}

export function InboxCountProvider({ children }: { children: ReactNode }) {
  const { workspaceId } = useWorkspace();
  const { subscribeWs, agents } = useAgentContext();
  const [count, setCount] = useState(0);
  const prevCountRef = useRef<number | null>(null);
  const pendingAgentIdRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    getInboxCount(workspaceId).then((r) => {
      const prev = prevCountRef.current;
      prevCountRef.current = r.count;
      setCount(r.count);
      // Only notify when count increases after initial load
      if (prev !== null && r.count > prev) {
        const agent = pendingAgentIdRef.current
          ? agents.find((a) => a.id === pendingAgentIdRef.current)
          : undefined;
        sendTaskNotification("completed", agent?.name);
      }
      pendingAgentIdRef.current = null;
    }).catch(() => {});
  }, [workspaceId, agents]);

  const decrement = useCallback(() => {
    setCount((c) => {
      const next = Math.max(0, c - 1);
      prevCountRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    return subscribeWs((msg: WsMessage) => {
      if (msg.type === "task.updated" && (msg.status === "completed" || msg.status === "failed")) {
        pendingAgentIdRef.current = msg.agentId;
        refresh();
      }
    });
  }, [subscribeWs, refresh]);

  useEffect(() => {
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <InboxCountContext.Provider value={{ count, refresh, decrement }}>
      {children}
    </InboxCountContext.Provider>
  );
}

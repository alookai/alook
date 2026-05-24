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
import { getInboxFilterTypes } from "@/lib/inbox-filter";
import type { WsMessage } from "@alook/shared";

interface InboxCountContextValue {
  count: number;
  notificationToken: number;
  refresh: () => void;
  decrement: () => void;
}

const InboxCountContext = createContext<InboxCountContextValue | null>(null);

const FALLBACK_INBOX_COUNT: InboxCountContextValue = {
  count: 0,
  notificationToken: 0,
  refresh: () => {},
  decrement: () => {},
};

export function useInboxCount() {
  const ctx = useContext(InboxCountContext);
  return ctx ?? FALLBACK_INBOX_COUNT;
}

export function InboxCountProvider({ children }: { children: ReactNode }) {
  const { workspaceId } = useWorkspace();
  const { subscribeWs, agents } = useAgentContext();
  const [count, setCount] = useState(0);
  const [notificationToken, setNotificationToken] = useState(0);
  const prevCountRef = useRef<number | null>(null);
  const pendingAgentIdRef = useRef<string | null>(null);

  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; });

  const refresh = useCallback(() => {
    const types = getInboxFilterTypes();
    getInboxCount(workspaceId, { types }).then((r) => {
      const prev = prevCountRef.current;
      prevCountRef.current = r.count;
      setCount(r.count);
      if (prev !== null && r.count > prev) {
        setNotificationToken((token) => token + 1);
        const agent = pendingAgentIdRef.current
          ? agentsRef.current.find((a) => a.id === pendingAgentIdRef.current)
          : undefined;
        sendTaskNotification("completed", agent?.name);
      }
      pendingAgentIdRef.current = null;
    }).catch(() => {});
  }, [workspaceId]);

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
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <InboxCountContext.Provider value={{ count, notificationToken, refresh, decrement }}>
      {children}
    </InboxCountContext.Provider>
  );
}

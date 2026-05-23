"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { getFlaggedCount } from "@/lib/api";
import { useWorkspace } from "@/contexts/workspace-context";

interface FlagCountContextValue {
  count: number;
  refresh: () => void;
  increment: () => void;
  decrement: () => void;
}

const FlagCountContext = createContext<FlagCountContextValue | null>(null);

export function useFlagCount() {
  const ctx = useContext(FlagCountContext);
  if (!ctx) throw new Error("useFlagCount must be used within FlagCountProvider");
  return ctx;
}

export function FlagCountProvider({ children }: { children: ReactNode }) {
  const { workspaceId } = useWorkspace();
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    getFlaggedCount(workspaceId)
      .then((r) => setCount(r.count))
      .catch(() => {});
  }, [workspaceId]);

  const increment = useCallback(() => {
    setCount((c) => c + 1);
  }, []);

  const decrement = useCallback(() => {
    setCount((c) => Math.max(0, c - 1));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <FlagCountContext.Provider value={{ count, refresh, increment, decrement }}>
      {children}
    </FlagCountContext.Provider>
  );
}

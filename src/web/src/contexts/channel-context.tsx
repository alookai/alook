"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { Channel } from "@alook/shared";
import {
  listChannels,
  createChannelApi,
  renameChannelApi,
  deleteChannelApi,
  reorderChannelsApi,
} from "@/lib/api";
import { toast } from "sonner";

interface ChannelContextValue {
  channels: Channel[];
  activeChannel: string;
  loading: boolean;
  setActiveChannel: (name: string) => void;
  setAgentId: (id: string | null) => void;
  createChannel: (name: string) => Promise<Channel>;
  renameChannel: (id: string, name: string) => Promise<void>;
  deleteChannel: (id: string) => Promise<void>;
  reorderChannels: (orderedIds: string[]) => Promise<void>;
  refresh: () => Promise<void>;
}

const ChannelContext = createContext<ChannelContextValue | null>(null);

function storageKey(workspaceId: string, agentId?: string | null) {
  return agentId
    ? `alook:channel:${workspaceId}:${agentId}`
    : `alook:channel:${workspaceId}`;
}

export function ChannelProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannelState] = useState<string>("default");
  const [loading, setLoading] = useState(true);
  const [agentId, setAgentId] = useState<string | null>(null);

  const fetchChannels = useCallback(async () => {
    try {
      const list = await listChannels(workspaceId);
      setChannels(list);
    } catch {
      // fallback — at minimum show default
      setChannels([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchChannels().finally(() => setLoading(false));
  }, [workspaceId, fetchChannels]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!agentId) return;
    const stored = localStorage.getItem(storageKey(workspaceId, agentId));
    setActiveChannelState(stored ?? "default");
  }, [workspaceId, agentId]);

  const setActiveChannel = useCallback(
    (name: string) => {
      setActiveChannelState(name);
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(storageKey(workspaceId, agentId), name);
        } catch {
          // localStorage quota exceeded or unavailable
        }
      }
    },
    [workspaceId, agentId]
  );

  const createChannel = useCallback(
    async (name: string) => {
      const created = await createChannelApi(workspaceId, name);
      await fetchChannels();
      return created;
    },
    [workspaceId, fetchChannels]
  );

  const renameChannel = useCallback(
    async (id: string, name: string) => {
      const ch = channels.find((c) => c.id === id);
      await renameChannelApi(id, workspaceId, name);
      if (ch && ch.name === activeChannel) {
        setActiveChannel(name);
      }
      await fetchChannels();
    },
    [workspaceId, channels, activeChannel, setActiveChannel, fetchChannels]
  );

  const deleteChannel = useCallback(
    async (id: string) => {
      const ch = channels.find((c) => c.id === id);
      await deleteChannelApi(id, workspaceId);
      if (ch && ch.name === activeChannel) {
        setActiveChannel("default");
      }
      await fetchChannels();
    },
    [workspaceId, channels, activeChannel, setActiveChannel, fetchChannels]
  );

  const reorderChannels = useCallback(
    async (orderedIds: string[]) => {
      setChannels((current) => {
        const idToChannel = new Map(current.map((c) => [c.id, c]));
        const reordered = orderedIds
          .map((id) => idToChannel.get(id))
          .filter((c): c is Channel => c !== undefined);
        const reorderedSet = new Set(orderedIds);
        const preserved = current.filter((c) => !reorderedSet.has(c.id));
        return [...preserved, ...reordered];
      });
      try {
        await reorderChannelsApi(workspaceId, orderedIds);
      } catch {
        await fetchChannels();
        toast.error("Failed to reorder channels");
      }
    },
    [workspaceId, fetchChannels]
  );

  return (
    <ChannelContext.Provider
      value={{
        channels,
        activeChannel,
        loading,
        setActiveChannel,
        setAgentId,
        createChannel,
        renameChannel,
        deleteChannel,
        reorderChannels,
        refresh: fetchChannels,
      }}
    >
      {children}
    </ChannelContext.Provider>
  );
}

export function useChannel() {
  const ctx = useContext(ChannelContext);
  if (!ctx) {
    throw new Error("useChannel must be used within a ChannelProvider");
  }
  return ctx;
}

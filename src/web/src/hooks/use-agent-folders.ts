"use client";

import { useState, useCallback } from "react";
import { useLocalStorage } from "./use-local-storage";

export interface AgentFolder {
  id: string;
  agentIds: string[];
}

interface FolderState {
  folders: AgentFolder[];
}

export type TopLevelItem =
  | { type: "agent"; id: string }
  | { type: "folder"; folder: AgentFolder };

const EMPTY_STATE: FolderState = { folders: [] };

export function useAgentFolders(workspaceId: string) {
  const [state, setState] = useLocalStorage<FolderState>(
    `agent-sidebar-folders:${workspaceId}`,
    EMPTY_STATE
  );
  const [expandedFolderId, setExpandedFolderId] = useState<string | null>(null);

  const folders = state.folders;

  const getFolderForAgent = useCallback(
    (agentId: string): AgentFolder | null =>
      folders.find((f) => f.agentIds.includes(agentId)) ?? null,
    [folders]
  );

  const createFolder = useCallback(
    (agentIds: string[]) => {
      if (agentIds.length < 2) return;
      const id = crypto.randomUUID();
      setState((prev) => {
        const existingAgentIds = new Set(
          prev.folders.flatMap((f) => f.agentIds)
        );
        const clean = agentIds.filter((a) => !existingAgentIds.has(a));
        if (clean.length < 2) return prev;
        return { folders: [...prev.folders, { id, agentIds: clean }] };
      });
      setExpandedFolderId(id);
    },
    [setState]
  );

  const addToFolder = useCallback(
    (folderId: string, agentId: string) => {
      setState((prev) => {
        const alreadyInFolder = prev.folders.some((f) =>
          f.agentIds.includes(agentId)
        );
        if (alreadyInFolder) return prev;
        return {
          folders: prev.folders.map((f) =>
            f.id === folderId
              ? { ...f, agentIds: [...f.agentIds, agentId] }
              : f
          ),
        };
      });
    },
    [setState]
  );

  const removeFromFolder = useCallback(
    (folderId: string, agentId: string) => {
      setState((prev) => {
        const updated = prev.folders.map((f) =>
          f.id === folderId
            ? { ...f, agentIds: f.agentIds.filter((id) => id !== agentId) }
            : f
        );
        return { folders: updated.filter((f) => f.agentIds.length > 1) };
      });
    },
    [setState]
  );

  const dissolveFolder = useCallback(
    (folderId: string) => {
      setState((prev) => ({
        folders: prev.folders.filter((f) => f.id !== folderId),
      }));
      if (expandedFolderId === folderId) setExpandedFolderId(null);
    },
    [setState, expandedFolderId]
  );

  const reorderInFolder = useCallback(
    (folderId: string, orderedAgentIds: string[]) => {
      setState((prev) => ({
        folders: prev.folders.map((f) =>
          f.id === folderId ? { ...f, agentIds: orderedAgentIds } : f
        ),
      }));
    },
    [setState]
  );

  const cleanupStaleAgents = useCallback(
    (validAgentIds: string[]) => {
      const valid = new Set(validAgentIds);
      setState((prev) => {
        const cleaned = prev.folders.map((f) => ({
          ...f,
          agentIds: f.agentIds.filter((id) => valid.has(id)),
        }));
        const surviving = cleaned.filter((f) => f.agentIds.length > 1);
        const changed =
          surviving.length !== prev.folders.length ||
          prev.folders.some(
            (f) => f.agentIds.some((id) => !valid.has(id))
          );
        return changed ? { folders: surviving } : prev;
      });
    },
    [setState]
  );

  const getTopLevelItems = useCallback(
    (agentIds: string[]): TopLevelItem[] => {
      const agentToFolder = new Map<string, AgentFolder>();
      for (const f of folders) {
        for (const aid of f.agentIds) {
          agentToFolder.set(aid, f);
        }
      }

      const seen = new Set<string>();
      const items: TopLevelItem[] = [];

      for (const agentId of agentIds) {
        const folder = agentToFolder.get(agentId);
        if (folder) {
          if (!seen.has(folder.id)) {
            seen.add(folder.id);
            items.push({ type: "folder", folder });
          }
        } else {
          items.push({ type: "agent", id: agentId });
        }
      }

      return items;
    },
    [folders]
  );

  const mergeFolders = useCallback(
    (sourceFolderId: string, targetFolderId: string) => {
      setState((prev) => {
        const source = prev.folders.find((f) => f.id === sourceFolderId);
        if (!source) return prev;
        return {
          folders: prev.folders
            .map((f) =>
              f.id === targetFolderId
                ? { ...f, agentIds: [...f.agentIds, ...source.agentIds] }
                : f
            )
            .filter((f) => f.id !== sourceFolderId),
        };
      });
    },
    [setState]
  );

  const removeAgentFromAnyFolder = useCallback(
    (agentId: string) => {
      setState((prev) => {
        const folder = prev.folders.find((f) => f.agentIds.includes(agentId));
        if (!folder) return prev;
        const updated = prev.folders.map((f) =>
          f.id === folder.id
            ? { ...f, agentIds: f.agentIds.filter((id) => id !== agentId) }
            : f
        );
        return { folders: updated.filter((f) => f.agentIds.length > 1) };
      });
    },
    [setState]
  );

  return {
    folders,
    expandedFolderId,
    setExpandedFolderId,
    createFolder,
    addToFolder,
    removeFromFolder,
    dissolveFolder,
    reorderInFolder,
    cleanupStaleAgents,
    getFolderForAgent,
    getTopLevelItems,
    removeAgentFromAnyFolder,
    mergeFolders,
  };
}

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Message } from "@alook/shared";
import { getCachedMessages, mergeCachedMessages, openCacheDB } from "@/lib/chat-cache";

interface UseCachedMessagesResult {
  cachedMessages: Message[] | null;
  isFromCache: boolean;
  writeToCache: (messages: Message[], hasMore: boolean) => Promise<void>;
}

export function useCachedMessages(
  conversationId: string | null,
  workspaceId: string | null
): UseCachedMessagesResult {
  const [cachedMessages, setCachedMessages] = useState<Message[] | null>(null);
  const [isFromCache, setIsFromCache] = useState(false);
  const conversationIdRef = useRef(conversationId);

  useEffect(() => {
    conversationIdRef.current = conversationId;
    if (!conversationId || !workspaceId) {
      setCachedMessages(null);
      setIsFromCache(false);
      return;
    }

    openCacheDB(workspaceId);

    let cancelled = false;
    getCachedMessages(conversationId, workspaceId).then((messages) => {
      if (cancelled || conversationIdRef.current !== conversationId) return;
      if (messages && messages.length > 0) {
        setCachedMessages(messages);
        setIsFromCache(true);
      } else {
        setCachedMessages(null);
        setIsFromCache(false);
      }
    });

    return () => { cancelled = true; };
  }, [conversationId, workspaceId]);

  const writeToCache = useCallback(
    async (messages: Message[], hasMore: boolean) => {
      if (!conversationIdRef.current || !workspaceId) return;
      await mergeCachedMessages(conversationIdRef.current, messages, hasMore, workspaceId);
    },
    [workspaceId]
  );

  return { cachedMessages, isFromCache, writeToCache };
}

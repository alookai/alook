"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Message } from "@alook/shared";
import {
  getCachedMessages,
  mergeCachedMessages,
  openAgentChatPersistence,
  type AgentChatPersistenceScope,
} from "@/lib/agent-chat-persistence";

interface UseCachedMessagesResult {
  cachedMessages: Message[] | null;
  isFromCache: boolean;
  writeToCache: (messages: Message[], hasMore: boolean, serverMessageCount?: number) => Promise<void>;
}

export function useCachedMessages(
  conversationId: string | null,
  scope: AgentChatPersistenceScope | null,
): UseCachedMessagesResult {
  const [cachedMessages, setCachedMessages] = useState<Message[] | null>(null);
  const [isFromCache, setIsFromCache] = useState(false);
  const conversationIdRef = useRef(conversationId);

  useEffect(() => {
    conversationIdRef.current = conversationId;
    if (!conversationId || !scope) {
      setCachedMessages(null);
      setIsFromCache(false);
      return;
    }

    void openAgentChatPersistence(scope);

    let cancelled = false;
    getCachedMessages(conversationId, scope).then((messages) => {
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
  }, [conversationId, scope]);

  const writeToCache = useCallback(
    async (messages: Message[], hasMore: boolean, serverMessageCount?: number) => {
      if (!conversationIdRef.current || !scope) return;
      await mergeCachedMessages(conversationIdRef.current, messages, hasMore, scope, serverMessageCount);
    },
    [scope]
  );

  return { cachedMessages, isFromCache, writeToCache };
}

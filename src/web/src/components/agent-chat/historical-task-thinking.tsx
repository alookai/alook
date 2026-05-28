"use client";

import { useState, useCallback } from "react";
import { TaskStream } from "@/components/task-stream";
import { getTaskMessages } from "@/lib/api";
import type { TaskMessageResponse, TaskApi } from "@alook/shared";

const COMPLETED_STUB: TaskApi = {
  id: "",
  agent_id: "",
  runtime_id: "",
  conversation_id: "",
  workspace_id: "",
  prompt: "",
  status: "completed",
  priority: 0,
  dispatched_at: null,
  started_at: null,
  completed_at: null,
  result: null,
  error: null,
  created_at: "",
  type: "",
};

export function HistoricalTaskThinking({
  taskId,
  thinkingCount,
  workspaceId,
}: {
  taskId: string;
  thinkingCount: number;
  workspaceId: string;
}) {
  const [messages, setMessages] = useState<TaskMessageResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const fetchMessages = useCallback(async () => {
    if (fetched || loading) return;
    setLoading(true);
    try {
      const msgs = await getTaskMessages(taskId, workspaceId);
      setMessages(msgs);
    } catch {
      setMessages([]);
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, [fetched, loading, taskId, workspaceId]);

  return (
    <TaskStream
      task={COMPLETED_STUB}
      messages={messages}
      thinkingCountHint={thinkingCount}
      onExpandThinking={fetchMessages}
      thinkingLoading={loading}
    />
  );
}

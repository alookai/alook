"use client";

import { useState, useCallback } from "react";
import { TaskStream } from "@/components/task-stream";
import { getTaskMessages } from "@/lib/api";
import type { TaskMessage, TaskApi } from "@alook/shared";

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

export function HistoricalTaskSteps({
  taskId,
  stepCount,
  workspaceId,
}: {
  taskId: string;
  stepCount: number;
  workspaceId: string;
}) {
  const [messages, setMessages] = useState<TaskMessage[]>([]);
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
      stepCountHint={stepCount}
      onExpandSteps={fetchMessages}
      stepsLoading={loading}
    />
  );
}

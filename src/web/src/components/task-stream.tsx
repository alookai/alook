"use client";

import { useMemo } from "react";
import type { TaskMessageResponse } from "@alook/shared";
import type { TaskApi as Task } from "@alook/shared";
import { RuntimeErrorBlock } from "@/components/agent-chat/runtime-error-block";

/* ── Grouped stream items ── */

interface TextItem {
  kind: "text";
  id: string;
  content: string;
}

interface ErrorItem {
  kind: "error";
  id: string;
  content: string;
}

type StreamItem = TextItem | ErrorItem;

function itemKey(msg: TaskMessageResponse): string {
  return msg.id || `seq-${msg.seq}`;
}

function groupMessages(messages: TaskMessageResponse[]): StreamItem[] {
  const items: StreamItem[] = [];

  for (const msg of messages) {
    const key = itemKey(msg);
    if (msg.type === "text") {
      items.push({ kind: "text", id: key, content: msg.content });
    } else if (msg.type === "error") {
      items.push({ kind: "error", id: key, content: msg.content || msg.output });
    }
  }

  return items;
}

/* ── TaskStream ──
 *
 * The chat no longer surfaces intermediate reasoning/tool steps ("thinking")
 * or a live status badge — the reply lands as one clean bubble (rendered by
 * message-list once the task settles). TaskStream only renders FAILURES while
 * a task is live: a runtime error is a real message, not thinking, and going
 * silent on failure is worse. Both RuntimeErrorBlock paths are kept.
 */

export function TaskStream({
  task,
  messages,
  connectionLost,
  onRetry,
  provider,
}: {
  task: Task;
  messages: TaskMessageResponse[];
  connectionLost?: boolean;
  onRetry?: () => void;
  /** Provider of the conversation's agent runtime, used to attribute runtime errors (issue #236). */
  provider?: string | null;
}) {
  const allItems = useMemo(() => groupMessages(messages), [messages]);
  const errorItems = allItems.filter((i): i is ErrorItem => i.kind === "error");

  // Nothing to show unless the stream surfaced an error, the task failed, or
  // the connection dropped — the successful reply is rendered as a bubble.
  if (
    errorItems.length === 0 &&
    !(task.status === "failed" && task.error) &&
    !connectionLost
  ) {
    return null;
  }

  return (
    <div className="space-y-3 min-w-0 max-w-full">
      {/* Stream error messages — attributed to the agent runtime (issue #236) */}
      {errorItems.length > 0 && (
        <div className="space-y-1 mt-1">
          {errorItems.map((item) => (
            <RuntimeErrorBlock key={item.id} provider={provider} message={item.content} />
          ))}
        </div>
      )}

      {/* Task-level error display — attributed to the agent runtime (issue #236) */}
      {task.status === "failed" && task.error && (
        <div className="mt-2">
          <RuntimeErrorBlock
            provider={provider}
            message={task.error}
            onRetry={onRetry}
          />
        </div>
      )}

      {connectionLost && (
        <p className="text-sm text-muted-foreground animate-pulse mt-1">
          Connection lost — retrying...
        </p>
      )}
    </div>
  );
}

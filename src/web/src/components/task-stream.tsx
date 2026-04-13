"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TaskMessage } from "@alook/shared";
import type { Task } from "@/lib/api";
import {
  Terminal,
  FileText,
  Search,
  Pencil,
  Play,
  ChevronRight,
  Brain,
  AlertCircle,
} from "lucide-react";
import { Streamdown } from "streamdown";

/* ── Tool icon mapping ── */

const TOOL_ICONS: Record<string, React.ElementType> = {
  read_file: FileText,
  write_file: Pencil,
  edit_file: Pencil,
  search: Search,
  grep: Search,
  find: Search,
  bash: Terminal,
  execute: Terminal,
  run: Play,
};

function getToolIcon(tool: string): React.ElementType {
  const lower = tool.toLowerCase();
  for (const [key, icon] of Object.entries(TOOL_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return Terminal;
}

function formatToolName(tool: string): string {
  return tool
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── Grouped stream items ── */

interface ToolCallGroup {
  kind: "tool-call";
  id: string;
  tool: string;
  input?: Record<string, unknown>;
  output?: string;
}

interface TextItem {
  kind: "text";
  id: string;
  content: string;
}

interface ThinkingItem {
  kind: "thinking";
  id: string;
  content: string;
}

interface StatusItem {
  kind: "status";
  id: string;
  content: string;
  type: string;
}

type StreamItem = ToolCallGroup | TextItem | ThinkingItem | StatusItem;

/** Types that are agent-internal lifecycle events, never user-facing. */
const HIDDEN_TYPES = new Set(["status", "log"]);

function groupMessages(messages: TaskMessage[]): StreamItem[] {
  const items: StreamItem[] = [];
  const toolCalls = new Map<string, ToolCallGroup>();

  for (const msg of messages) {
    if (HIDDEN_TYPES.has(msg.type)) continue;
    switch (msg.type) {
      case "tool-use": {
        const callId = msg.call_id;
        const group: ToolCallGroup = {
          kind: "tool-call",
          id: msg.id,
          tool: msg.tool,
          input: msg.input,
        };
        if (callId) toolCalls.set(callId, group);
        items.push(group);
        break;
      }
      case "tool-result": {
        const callId = msg.call_id;
        const existing = callId ? toolCalls.get(callId) : undefined;
        if (existing) {
          existing.output = msg.output || msg.content;
        } else {
          // Standalone result — attach to most recent tool-call without output
          const lastTool = [...items]
            .reverse()
            .find((i): i is ToolCallGroup => i.kind === "tool-call" && !i.output);
          if (lastTool) {
            lastTool.output = msg.output || msg.content;
          } else {
            items.push({
              kind: "status",
              id: msg.id,
              content: msg.output || msg.content,
              type: "tool-result",
            });
          }
        }
        break;
      }
      case "text":
        items.push({ kind: "text", id: msg.id, content: msg.content });
        break;
      case "thinking":
        items.push({ kind: "thinking", id: msg.id, content: msg.content });
        break;
      case "error":
        items.push({
          kind: "status",
          id: msg.id,
          content: msg.content || msg.output,
          type: "error",
        });
        break;
      default:
        // Unknown types (e.g. future agent lifecycle events) — skip silently
        break;
    }
  }

  return items;
}

/* ── ToolCallBlock ── */

function ToolCallBlock({ item, isRunning }: { item: ToolCallGroup; isRunning: boolean }) {
  const Icon = getToolIcon(item.tool);
  const hasDetails = item.input || item.output;

  const inputStr = useMemo(() => {
    if (!item.input) return null;
    try {
      return JSON.stringify(item.input, null, 2);
    } catch {
      return String(item.input);
    }
  }, [item.input]);

  return (
    <details className="group/tool animate-[fade-up_200ms_ease-out_both]">
      <summary
        className={cn(
          "flex items-center gap-2 py-1.5 px-2 -mx-2 rounded-md cursor-pointer select-none",
          "text-sm text-muted-foreground transition-colors duration-150",
          "hover:bg-muted/60 hover:text-foreground",
          "[&::-webkit-details-marker]:hidden [&::marker]:hidden"
        )}
      >
        {hasDetails && (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/tool:rotate-90" />
        )}
        <Icon className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground/80">
          {formatToolName(item.tool)}
        </span>
        {!item.output && isRunning && (
          <span className="ml-auto size-1.5 rounded-full bg-primary/60 animate-pulse" />
        )}
      </summary>

      {hasDetails && (
        <div className="mt-1 mb-2 space-y-2">
          {inputStr && (
            <pre className="task-stream-pre overflow-x-auto rounded-md bg-muted/40 p-2.5 font-mono text-xs leading-relaxed text-muted-foreground max-h-48 overflow-y-auto">
              {inputStr}
            </pre>
          )}
          {item.output && (
            <pre className="task-stream-pre overflow-x-auto rounded-md bg-muted/30 border border-border/50 p-2.5 font-mono text-xs leading-relaxed text-foreground/70 max-h-48 overflow-y-auto">
              {item.output}
            </pre>
          )}
        </div>
      )}
    </details>
  );
}

/* ── TaskStream ── */

export function TaskStream({
  task,
  messages,
  connectionLost,
  hideText,
}: {
  task: Task;
  messages: TaskMessage[];
  connectionLost?: boolean;
  /** Hide text items (final answer is rendered separately as the assistant message). */
  hideText?: boolean;
}) {
  const allItems = useMemo(() => groupMessages(messages), [messages]);
  const items = hideText ? allItems.filter((i) => i.kind !== "text") : allItems;
  const isRunning = task.status !== "completed" && task.status !== "failed";

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 mb-1">
        {task.status === "running" ? (
          <Badge variant="secondary" className="gap-1.5">
            <span className="size-1.5 rounded-full bg-primary animate-pulse" />
            Working
          </Badge>
        ) : (
          <Badge variant="secondary">{task.status}</Badge>
        )}
      </div>

      {items.length > 0 && (
        <div className="space-y-0.5">
          {items.map((item) => {
            switch (item.kind) {
              case "tool-call":
                return <ToolCallBlock key={item.id} item={item} isRunning={isRunning} />;
              case "text":
                return (
                  <div
                    key={item.id}
                    className="markdown text-sm px-1 animate-[fade-up_200ms_ease-out_both]"
                  >
                    <Streamdown controls={{ code: { copy: true, download: false } }}>{item.content}</Streamdown>
                  </div>
                );
              case "thinking":
                return (
                  <p
                    key={item.id}
                    className="text-sm italic text-muted-foreground/60 px-1 animate-[fade-up_200ms_ease-out_both]"
                  >
                    <Brain className="inline size-3 mr-1 -mt-0.5" />
                    {item.content}
                  </p>
                );
              case "status":
                return (
                  <p
                    key={item.id}
                    className="text-xs text-muted-foreground px-1 animate-[fade-up_200ms_ease-out_both]"
                  >
                    {item.type === "error" && (
                      <AlertCircle className="inline size-3 mr-1 -mt-0.5 text-destructive" />
                    )}
                    {item.content}
                  </p>
                );
            }
          })}
        </div>
      )}

      {task.status === "failed" && task.error && (
        <p className="text-sm text-destructive flex items-center gap-1.5 mt-2">
          <AlertCircle className="size-3.5 shrink-0" />
          {task.error}
        </p>
      )}

      {connectionLost && (
        <p className="text-xs text-muted-foreground animate-pulse mt-1">
          Connection lost — retrying...
        </p>
      )}
    </div>
  );
}

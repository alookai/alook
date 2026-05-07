"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TaskMessage } from "@alook/shared";
import type { TaskApi as Task } from "@alook/shared";
import {
  ChevronRight,
  Brain,
  AlertCircle,
  RotateCw,
  Loader2,
} from "lucide-react";
import { Streamdown } from "streamdown";

/* ── Helpers ── */

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

function itemKey(msg: TaskMessage): string {
  return msg.id || `seq-${msg.seq}`;
}

function groupMessages(messages: TaskMessage[]): StreamItem[] {
  const items: StreamItem[] = [];
  const toolCalls = new Map<string, ToolCallGroup>();

  for (const msg of messages) {
    if (HIDDEN_TYPES.has(msg.type)) continue;
    const key = itemKey(msg);
    switch (msg.type) {
      case "tool-use": {
        const callId = msg.call_id;
        const group: ToolCallGroup = {
          kind: "tool-call",
          id: key,
          tool: msg.tool,
          input: msg.input,
        };
        if (callId) toolCalls.set(callId, group);
        items.push(group);
        break;
      }
      case "tool-result":
        break;
      case "text":
        items.push({ kind: "text", id: key, content: msg.content });
        break;
      case "thinking":
        items.push({ kind: "thinking", id: key, content: msg.content });
        break;
      case "error":
        items.push({
          kind: "status",
          id: key,
          content: msg.content || msg.output,
          type: "error",
        });
        break;
      default:
        break;
    }
  }

  return items;
}

/* ── ToolCallBlock ── */

function ToolCallBlock({ item, isRunning }: { item: ToolCallGroup; isRunning: boolean }) {
  const inputStr = useMemo(() => {
    if (!item.input) return null;
    try {
      return JSON.stringify(item.input, null, 2);
    } catch {
      return String(item.input);
    }
  }, [item.input]);

  if (!inputStr) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 py-1 px-2 -mx-2 rounded-md",
          "text-sm text-muted-foreground"
        )}
      >
        <span className="font-medium text-foreground/80">
          {formatToolName(item.tool)}
        </span>
        {isRunning && (
          <span className="ml-auto size-1.5 rounded-full bg-primary/60 animate-pulse" />
        )}
      </div>
    );
  }

  return (
    <details className="group/tool">
      <summary
        className={cn(
          "flex items-center gap-2 py-1 px-2 -mx-2 rounded-md cursor-pointer select-none",
          "text-sm text-muted-foreground transition-colors duration-150",
          "hover:bg-muted/60 hover:text-foreground",
          "[&::-webkit-details-marker]:hidden [&::marker]:hidden"
        )}
      >
        <ChevronRight className="size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/tool:rotate-90" />
        <span className="font-medium text-foreground/80">
          {formatToolName(item.tool)}
        </span>
        {isRunning && (
          <span className="ml-auto size-1.5 rounded-full bg-primary/60 animate-pulse" />
        )}
      </summary>

      <div className="mt-1 mb-2 ml-5">
        <pre className="task-stream-pre overflow-x-auto rounded-md bg-muted/40 p-2.5 font-mono text-xs leading-relaxed text-muted-foreground max-h-48 max-w-full min-w-0 overflow-y-auto">
          {inputStr}
        </pre>
      </div>
    </details>
  );
}

/* ── ThinkingBlock ── */

function ThinkingBlock({ item }: { item: ThinkingItem }) {
  if (!item.content) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 py-1 px-2 -mx-2 rounded-md",
          "text-sm text-muted-foreground/60 italic"
        )}
      >
        <Brain className="size-3 shrink-0" />
        <span>Thinking...</span>
      </div>
    );
  }

  return (
    <details className="group/think">
      <summary
        className={cn(
          "flex items-center gap-2 py-1 px-2 -mx-2 rounded-md cursor-pointer select-none",
          "text-sm text-muted-foreground/60 italic transition-colors duration-150",
          "hover:bg-muted/60 hover:text-muted-foreground",
          "[&::-webkit-details-marker]:hidden [&::marker]:hidden"
        )}
      >
        <ChevronRight className="size-3 shrink-0 text-muted-foreground/40 transition-transform duration-150 group-open/think:rotate-90" />
        <Brain className="size-3 shrink-0" />
        <span>Thinking...</span>
      </summary>
      <div className="mt-1 mb-2 ml-5">
        <p className="text-sm italic text-muted-foreground/60 whitespace-pre-wrap">
          {item.content}
        </p>
      </div>
    </details>
  );
}

/* ── AnimatedNumber (slot-style slide) ── */

function AnimatedNumber({ value }: { value: number }) {
  const prevRef = useRef(value);
  const [display, setDisplay] = useState({ current: value, previous: null as number | null });
  const [phase, setPhase] = useState<"idle" | "animating">("idle");

  useEffect(() => {
    if (value === prevRef.current) return;
    const prev = prevRef.current;
    prevRef.current = value;

    // Start animation: show both old (will slide up) and new (will slide in from below)
    setDisplay({ current: value, previous: prev });
    // Force a frame so the initial position renders before transition kicks in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setPhase("animating");
      });
    });

    const timer = setTimeout(() => {
      setPhase("idle");
      setDisplay((d) => ({ ...d, previous: null }));
    }, 300);
    return () => clearTimeout(timer);
  }, [value]);

  return (
    <span
      style={{
        display: "inline-block",
        position: "relative",
        overflow: "hidden",
        height: "1.2em",
        lineHeight: "1.2em",
        verticalAlign: "bottom",
      }}
    >
      {/* Old number — starts at 0, slides to -100% */}
      {display.previous !== null && (
        <span
          style={{
            display: "block",
            position: "absolute",
            inset: "0",
            transition: phase === "animating" ? "transform 250ms ease-out, opacity 250ms ease-out" : "none",
            transform: phase === "animating" ? "translateY(-100%)" : "translateY(0)",
            opacity: phase === "animating" ? 0 : 1,
          }}
        >
          {display.previous}
        </span>
      )}
      {/* New number — starts at +100%, slides to 0 */}
      <span
        style={{
          display: "block",
          transition: phase === "animating" ? "transform 250ms ease-out, opacity 250ms ease-out" : "none",
          transform: display.previous !== null && phase !== "animating" ? "translateY(100%)" : "translateY(0)",
          opacity: display.previous !== null && phase !== "animating" ? 0 : 1,
        }}
      >
        {display.current}
      </span>
    </span>
  );
}

/* ── TaskStream ── */

export function TaskStream({
  task,
  messages,
  connectionLost,
  onRetry,
  stepCountHint,
  onExpandSteps,
  stepsLoading,
}: {
  task: Task;
  messages: TaskMessage[];
  connectionLost?: boolean;
  onRetry?: () => void;
  stepCountHint?: number;
  onExpandSteps?: () => void;
  stepsLoading?: boolean;
}) {
  const [retrying, setRetrying] = useState(false);
  const allItems = useMemo(() => groupMessages(messages), [messages]);
  const isRunning = task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled" && task.status !== "superseded";

  const toolItems = allItems.filter((i) => i.kind !== "text");
  const textItems = allItems.filter((i): i is TextItem => i.kind === "text");

  const finalTextItem = textItems.length > 0 ? textItems[textItems.length - 1] : null;

  const toolScrollRef = useRef<HTMLDivElement>(null);
  const textScrollRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(false);

  // Auto-scroll tool area to bottom while running
  useEffect(() => {
    if (isRunning && toolScrollRef.current) {
      toolScrollRef.current.scrollTop = toolScrollRef.current.scrollHeight;
    }
  }, [toolItems.length, isRunning]);

  // Auto-scroll text area to bottom while running
  useEffect(() => {
    if (isRunning && textScrollRef.current) {
      textScrollRef.current.scrollTop = textScrollRef.current.scrollHeight;
    }
  }, [textItems.length, isRunning]);

  const intermediateTextItems = isRunning ? textItems : textItems.slice(0, -1);
  const hasFinalText = !isRunning && finalTextItem !== null;
  const displayStepCount = toolItems.length > 0 ? toolItems.length : stepCountHint ?? 0;
  const showStepsSection = toolItems.length > 0 || (stepCountHint && stepCountHint > 0);

  const handleStepsToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if ((e.currentTarget as HTMLDetailsElement).open && !expandedRef.current && onExpandSteps) {
      expandedRef.current = true;
      onExpandSteps();
    }
  };

  return (
    <div className="space-y-3">
      {/* Status badge */}
      <div className="flex items-center gap-2">
        {task.status === "running" ? (
          <Badge variant="secondary" className="gap-1.5 relative overflow-hidden">
            <span className="size-1.5 rounded-full bg-primary animate-pulse" />
            Working
            <div
              className="pointer-events-none absolute inset-0 -translate-x-full animate-[shimmer_2s_ease-in-out_infinite]"
              style={{
                background: "linear-gradient(90deg, transparent 0%, var(--shimmer) 40%, var(--shimmer-peak) 50%, var(--shimmer) 60%, transparent 100%)",
              }}
            />
          </Badge>
        ) : isRunning ? (
          <Badge variant="secondary" className="relative overflow-hidden">
            {task.status}
            <div
              className="pointer-events-none absolute inset-0 -translate-x-full animate-[shimmer_2s_ease-in-out_infinite]"
              style={{
                background: "linear-gradient(90deg, transparent 0%, var(--shimmer) 40%, var(--shimmer-peak) 50%, var(--shimmer) 60%, transparent 100%)",
              }}
            />
          </Badge>
        ) : (
          <Badge variant="secondary">{task.status}</Badge>
        )}
      </div>

      {/* Tool stream zone — foldable, height-limited, scrollable */}
      {showStepsSection && (
        <details className="group/stream pl-1" onToggle={handleStepsToggle}>
          <summary
            className={cn(
              "flex items-center gap-1.5 py-1 cursor-pointer select-none",
              "text-xs text-muted-foreground transition-colors duration-150",
              "hover:text-foreground",
              "[&::-webkit-details-marker]:hidden [&::marker]:hidden"
            )}
          >
            <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/stream:rotate-90", isRunning && "animate-pulse text-primary")} />
            <span><AnimatedNumber value={displayStepCount} /> {displayStepCount === 1 ? "step" : "steps"}</span>
          </summary>
          <div
            ref={toolScrollRef}
            className="mt-1 max-h-80 overflow-y-auto overflow-x-hidden thin-scrollbar space-y-0.5 pl-1"
          >
            {stepsLoading && toolItems.length === 0 && (
              <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                <span>Loading steps...</span>
              </div>
            )}
            {toolItems.map((item) => {
              switch (item.kind) {
                case "tool-call":
                  return <ToolCallBlock key={item.id} item={item} isRunning={isRunning} />;
                case "thinking":
                  return <ThinkingBlock key={item.id} item={item as ThinkingItem} />;
                case "status":
                  return (
                    <p
                      key={item.id}
                      className="text-xs text-muted-foreground px-1"
                    >
                      {item.type === "error" && (
                        <AlertCircle className="inline size-3 mr-1 -mt-0.5 text-destructive" />
                      )}
                      {(item as StatusItem).content}
                    </p>
                  );
                default:
                  return null;
              }
            })}
          </div>
        </details>
      )}

      {/* Thinking section — intermediate text, open while running or when no final text */}
      {intermediateTextItems.length > 0 && (
        <details className="group/midtext pl-1" open={!hasFinalText || undefined}>
          <summary
            className={cn(
              "flex items-center gap-1.5 py-1 cursor-pointer select-none",
              "text-xs text-muted-foreground transition-colors duration-150",
              "hover:text-foreground",
              "[&::-webkit-details-marker]:hidden [&::marker]:hidden"
            )}
          >
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/midtext:rotate-90" />
            <span><AnimatedNumber value={intermediateTextItems.length} /> thinking</span>
          </summary>
          <div ref={textScrollRef} className="mt-1 space-y-2 pl-1">
            {intermediateTextItems.map((item) => (
              <div key={item.id} className="markdown max-w-full min-w-0 px-1 py-0.5 text-sm text-muted-foreground">
                <Streamdown controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: true } }} linkSafety={{ enabled: false }}>{item.content}</Streamdown>
              </div>
            ))}
          </div>
        </details>
      )}
      {/* Final text — shown after completion (not for historical tasks which render it as a message) */}
      {hasFinalText && !onExpandSteps && (
        <div className="markdown max-w-full min-w-0 px-1 py-1 text-base text-foreground">
          <Streamdown controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: true } }} linkSafety={{ enabled: false }}>{finalTextItem.content}</Streamdown>
        </div>
      )}

      {/* Error display */}
      {task.status === "failed" && task.error && (
        <div className="flex items-center gap-2 mt-2">
          <p className="text-sm text-destructive flex items-center gap-1.5">
            <AlertCircle className="size-3.5 shrink-0" />
            {task.error}
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={async () => {
                setRetrying(true);
                try { await onRetry(); } finally { setRetrying(false); }
              }}
              disabled={retrying}
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1"
            >
              {retrying ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />}
              Retry
            </button>
          )}
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

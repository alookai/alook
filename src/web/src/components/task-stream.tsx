"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TaskMessageResponse } from "@alook/shared";
import type { TaskApi as Task } from "@alook/shared";
import {
  ChevronRight,
  Loader2,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { mermaid, cjk } from "@/lib/streamdown-plugins";
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
  thinkingCountHint,
  onExpandThinking,
  thinkingLoading,
  provider,
}: {
  task: Task;
  messages: TaskMessageResponse[];
  connectionLost?: boolean;
  onRetry?: () => void;
  thinkingCountHint?: number;
  onExpandThinking?: () => void;
  thinkingLoading?: boolean;
  /** Provider of the conversation's agent runtime, used to attribute runtime errors (issue #236). */
  provider?: string | null;
}) {
  const allItems = useMemo(() => groupMessages(messages), [messages]);
  const isRunning = task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled" && task.status !== "superseded";

  const textItems = allItems.filter((i): i is TextItem => i.kind === "text");
  const errorItems = allItems.filter((i): i is ErrorItem => i.kind === "error");
  const finalTextItem = textItems.length > 0 ? textItems[textItems.length - 1] : null;

  const textScrollRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(false);

  useEffect(() => {
    if (isRunning && textScrollRef.current) {
      textScrollRef.current.scrollTop = textScrollRef.current.scrollHeight;
    }
  }, [textItems.length, isRunning]);

  const intermediateTextItems = isRunning ? textItems : textItems.slice(0, -1);
  const hasFinalText = !isRunning && finalTextItem !== null;
  const showThinkingSection = intermediateTextItems.length > 0 || (thinkingCountHint && thinkingCountHint > 0);
  const displayThinkingCount = intermediateTextItems.length > 0 ? intermediateTextItems.length : thinkingCountHint ?? 0;

  const handleThinkingToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if ((e.currentTarget as HTMLDetailsElement).open && !expandedRef.current && onExpandThinking) {
      expandedRef.current = true;
      onExpandThinking();
    }
  };

  return (
    <div className="space-y-3 min-w-0 max-w-full">
      {/* Status badge — only for live tasks, not historical */}
      {!onExpandThinking && (
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
      )}

      {/* Thinking section — intermediate text, open while running or when no final text */}
      {showThinkingSection && (
        <details className="group/midtext pl-1" open={!hasFinalText && !onExpandThinking || undefined} onToggle={handleThinkingToggle}>
          <summary
            className={cn(
              "flex items-center gap-1.5 py-1 cursor-pointer select-none",
              "text-xs text-muted-foreground transition-colors duration-150",
              "hover:text-foreground",
              "[&::-webkit-details-marker]:hidden [&::marker]:hidden"
            )}
          >
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/midtext:rotate-90" />
            <span><AnimatedNumber value={displayThinkingCount} /> thinking</span>
          </summary>
          <div ref={textScrollRef} className="mt-1 pl-1">
            {thinkingLoading && intermediateTextItems.length === 0 && (
              <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                <span>Loading...</span>
              </div>
            )}
            {intermediateTextItems.map((item) => (
              <div key={item.id} className="markdown max-w-full min-w-0 px-1 text-sm text-muted-foreground">
                <Streamdown plugins={{ mermaid, cjk }} controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: true } }} linkSafety={{ enabled: false }}>{item.content}</Streamdown>
              </div>
            ))}
          </div>
        </details>
      )}
      {/* Final text — shown after completion (not for historical tasks which render it as a message) */}
      {hasFinalText && !onExpandThinking && (
        <div className="markdown max-w-full min-w-0 px-1 py-1 text-base text-foreground">
          <Streamdown plugins={{ mermaid, cjk }} controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: true } }} linkSafety={{ enabled: false }}>{finalTextItem.content}</Streamdown>
        </div>
      )}

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

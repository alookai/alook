"use client";

import { cn } from "@/lib/utils";

interface TerminalSpan {
  text: string;
  color?: "dim" | "info" | "highlight" | "success" | "keyword" | "string" | "muted";
}

export interface TerminalLine {
  text?: string;
  spans?: TerminalSpan[];
  level?: "info" | "success" | "dim" | "highlight";
}

export function DemoTerminal({
  lines,
  visibleCount,
  className,
}: {
  lines: TerminalLine[];
  visibleCount: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col h-full bg-neutral-950 text-[11.5px] leading-relaxed font-mono overflow-hidden",
        className,
      )}
    >
      {/* Terminal output */}
      <div className="flex-1 px-4 py-3 space-y-1 overflow-hidden flex flex-col justify-end">
        {lines.slice(0, visibleCount).map((line, i) => {
          const level = line.level ?? "info";
          return (
            <div
              key={i}
              className={cn(
                "animate-[fade-up_200ms_ease-out_both] whitespace-nowrap",
                !line.spans && level === "info" && "text-neutral-400",
                !line.spans && level === "dim" && "text-neutral-600",
                !line.spans && level === "success" && "text-green-400",
                !line.spans && level === "highlight" && "text-white",
              )}
            >
              {line.spans ? (
                line.spans.map((span, j) => (
                  <span
                    key={j}
                    className={cn(
                      span.color === "dim" && "text-neutral-600",
                      span.color === "info" && "text-neutral-400",
                      span.color === "highlight" && "text-white",
                      span.color === "success" && "text-green-400",
                      span.color === "keyword" && "text-blue-400",
                      span.color === "string" && "text-amber-300",
                      span.color === "muted" && "text-neutral-500",
                      !span.color && "text-neutral-400",
                    )}
                  >
                    {span.text}
                  </span>
                ))
              ) : (
                line.text
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom status */}
      <div className="px-4 py-2 border-t border-neutral-800 flex items-center gap-2 text-[10px] text-neutral-500">
        <span className="text-green-400">●</span>
        <span className="text-neutral-400">alook daemon</span>
        <span className="text-neutral-700">·</span>
        <span>1 workspace · 3 runtimes</span>
      </div>
    </div>
  );
}
